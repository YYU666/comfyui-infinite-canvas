"""Local bounded FBX interchange via pinned, BSD-licensed Assimp 5.4.3.

Internal interchange is GLB, Y-up right-handed metres. This adapter accepts
one static mesh/material only. Hierarchy transforms are baked; compressed
embedded PNG/JPEG base color and normal maps are retained. External texture
references, skinning, animation and additional UV/color channels are rejected.
No Blender, ComfyUI, network or shell is involved in conversion.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import hashlib
import shutil
import tarfile
import struct
import tempfile

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.cache/native3d/fbx'
MAX_BYTES = 512 * 1024 * 1024
SOURCE_URL = 'https://codeload.github.com/assimp/assimp/tar.gz/refs/tags/v5.4.3'
SOURCE_SHA256 = '66dfbaee288f2bc43172440a55d0235dfc7bf885dda6435c038e8000e79582cb'

CXX_SOURCE = r'''
#include <assimp/Importer.hpp>
#include <assimp/Exporter.hpp>
#include <assimp/scene.h>
#include <assimp/postprocess.h>
#include <assimp/config.h>
#include <assimp/material.h>
#include <assimp/DefaultIOSystem.h>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
class PrimaryOnlyIO : public Assimp::DefaultIOSystem {
 std::filesystem::path primary;
 public:
 explicit PrimaryOnlyIO(const char* p):primary(std::filesystem::weakly_canonical(p)){}
 bool Exists(const char* p) const override { return std::filesystem::weakly_canonical(p)==primary && Assimp::DefaultIOSystem::Exists(p); }
 Assimp::IOStream* Open(const char* p,const char* mode="rb") override {
  if(std::filesystem::weakly_canonical(p)!=primary || mode[0]!='r') return nullptr;
  return Assimp::DefaultIOSystem::Open(p,mode);
 }
};
static void require(bool ok, const char* msg) { if (!ok) throw std::runtime_error(msg); }
static void nodes(const aiNode* n, unsigned& refs, unsigned depth=0) {
 require(depth<64,"Hierarchy exceeds depth limit"); refs+=n->mNumMeshes;
 require(std::isfinite(n->mTransformation.Determinant()) && std::abs(n->mTransformation.Determinant())>1e-12,"Singular/nonfinite transform");
 for(unsigned i=0;i<n->mNumChildren;i++) nodes(n->mChildren[i],refs,depth+1);
}
static int metaInt(const aiScene* s,const char* k,int fallback) { int v=fallback; if(s->mMetaData) s->mMetaData->Get(k,v); return v; }
static double metaDouble(const aiScene* s,const char* k,double fallback) {
 double v; float f;
 if(s->mMetaData && s->mMetaData->Get(k,v)) return v;
 if(s->mMetaData && s->mMetaData->Get(k,f)) return f;
 return fallback;
}
int main(int argc,char** argv) { try {
 require(argc==4,"Expected mode input output");
 const bool fromFbx=std::string(argv[1])=="import";
 require(fromFbx || std::string(argv[1])=="export","Unknown mode");
 Assimp::Importer importer;
 importer.SetIOHandler(new PrimaryOnlyIO(argv[2]));
 importer.SetPropertyBool(AI_CONFIG_IMPORT_FBX_PRESERVE_PIVOTS,true);
 const aiScene* scene=importer.ReadFile(argv[2],aiProcess_Triangulate|aiProcess_ValidateDataStructure);
 if(!scene) throw std::runtime_error(importer.GetErrorString());
 require(scene->mNumMeshes==1,"Only a single mesh/material primitive is supported");
 require(!scene->mNumAnimations && !scene->mNumCameras && !scene->mNumLights,"Animation/cameras/lights unsupported");
 require(scene->mNumTextures<=2,"At most two embedded textures supported");
 for(unsigned i=0;i<scene->mNumTextures;i++) {
  aiTexture* t=scene->mTextures[i];
  require(t->mHeight==0 && t->mWidth>8 && t->mWidth<=64*1024*1024,"Only compressed embedded PNG/JPEG textures up to 64 MiB supported");
  const auto* bytes=reinterpret_cast<const unsigned char*>(t->pcData);
  bool png=bytes[0]==137 && bytes[1]==80 && bytes[2]==78 && bytes[3]==71;
  bool jpg=bytes[0]==255 && bytes[1]==216 && bytes[2]==255;
  require(png||jpg,"Embedded texture is not PNG/JPEG");
  t->mFilename=aiString("native3d_texture_"+std::to_string(i)+(png?".png":".jpg"));
 }
 unsigned refs=0; nodes(scene->mRootNode,refs); require(refs==1,"Instanced meshes unsupported");
 aiMesh* m=scene->mMeshes[0];
 require(!m->mNumBones && !m->mNumAnimMeshes,"Skinning/morph targets unsupported");
 require(m->mNumVertices>0 && m->mNumVertices<=9000000 && m->mNumFaces>0 && m->mNumFaces<=3000000,"Mesh exceeds bounded limits or is empty");
 for(unsigned c=1;c<AI_MAX_NUMBER_OF_TEXTURECOORDS;c++) require(!m->HasTextureCoords(c),"Multiple UV channels unsupported");
 for(unsigned c=0;c<AI_MAX_NUMBER_OF_COLOR_SETS;c++) require(!m->HasVertexColors(c),"Vertex colors unsupported");
 require(!m->HasTextureCoords(0) || m->mNumUVComponents[0]==2,"Only 2D UV coordinates supported");
 for(unsigned i=0;i<scene->mNumMaterials;i++) {
  aiMaterial* mat=scene->mMaterials[i];
  for(unsigned p=0;p<mat->mNumProperties;p++) {
   const aiMaterialProperty* prop=mat->mProperties[p];
   if(std::string(prop->mKey.C_Str()).find("$tex.")==0) require(prop->mSemantic==aiTextureType_DIFFUSE || prop->mSemantic==aiTextureType_BASE_COLOR || prop->mSemantic==aiTextureType_NORMALS,"Only base color and normal textures supported; PBR texture channels unsupported");
  }
  for(auto type:{aiTextureType_DIFFUSE,aiTextureType_BASE_COLOR,aiTextureType_NORMALS}) {
   require(mat->GetTextureCount(type)<=1,"Layered textures unsupported");
   if(mat->GetTextureCount(type)) {
    aiString path; unsigned uv=0; mat->GetTexture(type,0,&path,nullptr,&uv);
    require(uv==0,"Only UV channel zero supported");
    require(scene->GetEmbeddedTexture(path.C_Str())!=nullptr,"External texture references unsupported; embed PNG/JPEG first");
    aiUVTransform tr;
    if(mat->Get(AI_MATKEY_UVTRANSFORM(type,0),tr)==AI_SUCCESS) require(tr.mTranslation.SquareLength()<1e-12 && std::abs(tr.mScaling.x-1)<1e-6 && std::abs(tr.mScaling.y-1)<1e-6 && std::abs(tr.mRotation)<1e-6,"Texture coordinate transforms unsupported");
   }
  }
  if(mat->GetTextureCount(aiTextureType_BASE_COLOR)) {
   aiString base,diffuse; mat->GetTexture(aiTextureType_BASE_COLOR,0,&base); mat->GetTexture(aiTextureType_DIFFUSE,0,&diffuse);
   require(base==diffuse,"Base color texture must have a matching diffuse FBX mapping");
  }
 }
 for(unsigned i=0;i<m->mNumVertices;i++) {
  const auto& p=m->mVertices[i]; require(std::isfinite(p.x)&&std::isfinite(p.y)&&std::isfinite(p.z),"Nonfinite vertex");
  if(m->HasNormals()) { const auto& n=m->mNormals[i]; require(std::isfinite(n.x)&&std::isfinite(n.y)&&std::isfinite(n.z)&&n.SquareLength()>1e-20,"Invalid normal"); }
  if(m->HasTextureCoords(0)) { const auto& u=m->mTextureCoords[0][i]; require(std::isfinite(u.x)&&std::isfinite(u.y),"Invalid UV"); }
 }
 for(unsigned i=0;i<m->mNumFaces;i++) require(m->mFaces[i].mNumIndices==3,"Nontriangle primitive unsupported");
 double unit=1;
 if(fromFbx) {
  unit=metaDouble(scene,"UnitScaleFactor",1)*.01;
  require(std::isfinite(unit)&&unit>1e-9&&unit<1e9,"Invalid unit scale");
  int up=metaInt(scene,"UpAxis",1), right=metaInt(scene,"CoordAxis",0), front=metaInt(scene,"FrontAxis",2);
  int us=metaInt(scene,"UpAxisSign",1), rs=metaInt(scene,"CoordAxisSign",1), fs=metaInt(scene,"FrontAxisSign",1);
  require(up>=0&&up<3&&right>=0&&right<3&&front>=0&&front<3&&up!=right&&up!=front&&front!=right,"Invalid coordinate axes");
  require(std::abs(us)==1&&std::abs(rs)==1&&std::abs(fs)==1,"Invalid coordinate axis signs");
  aiMatrix4x4 basis; for(int r=0;r<3;r++) for(int c=0;c<3;c++) basis[r][c]=0;
  basis[0][right]=ai_real(rs*unit); basis[1][up]=ai_real(us*unit); basis[2][front]=ai_real(fs*unit);
  scene->mRootNode->mTransformation=basis*scene->mRootNode->mTransformation;
 }
 scene=importer.ApplyPostProcessing(aiProcess_PreTransformVertices);
 require(scene!=nullptr,"Transform baking failed");
 // After PreTransformVertices the mesh already contains the baked world
 // transforms. Emit both the coordinates and the metadata in centimetres:
 // importers assuming default Unreal units receive the correct physical size.
 if(!fromFbx) {
  aiMesh* baked=scene->mMeshes[0];
  for(unsigned i=0;i<baked->mNumVertices;i++) {
   auto& p=baked->mVertices[i]; p*=ai_real(100);
   require(std::isfinite(p.x)&&std::isfinite(p.y)&&std::isfinite(p.z),"Centimetre conversion overflow");
  }
  unit=.01;
  aiScene* writable=const_cast<aiScene*>(scene);
  delete writable->mMetaData; writable->mMetaData=new aiMetadata();
  writable->mMetaData->Add("UnitScaleFactor",1.0);
  writable->mMetaData->Add("OriginalUnitScaleFactor",1.0);
  writable->mMetaData->Add("UpAxis",1); writable->mMetaData->Add("UpAxisSign",1);
  writable->mMetaData->Add("CoordAxis",0); writable->mMetaData->Add("CoordAxisSign",1);
  writable->mMetaData->Add("FrontAxis",2); writable->mMetaData->Add("FrontAxisSign",1);
 }
 Assimp::Exporter exporter;
 if(exporter.Export(scene,fromFbx?"glb2":"fbx",argv[3])!=AI_SUCCESS) throw std::runtime_error(exporter.GetErrorString());
 std::cout<<"{\"converter\":\"Assimp 5.4.3\",\"unitMeters\":"<<unit<<",\"transformsBaked\":true,\"meshes\":1,\"faces\":"<<scene->mMeshes[0]->mNumFaces<<",\"hasUV\":"<<(scene->mMeshes[0]->HasTextureCoords(0)?"true":"false")<<",\"hasNormals\":"<<(scene->mMeshes[0]->HasNormals()?"true":"false")<<"}";
 return 0;
 } catch(const std::exception& e) { std::cerr<<e.what(); return 1; }
}
'''


ADAPTER_SOURCE_SHA256 = hashlib.sha256(CXX_SOURCE.encode('utf-8')).hexdigest()


def converter_path():
    configured = os.environ.get('NATIVE3D_FBX_CONVERTER')
    if configured:
        path = Path(configured)
        if not path.is_absolute():
            raise ValueError('NATIVE3D_FBX_CONVERTER must be an absolute path')
        return path
    return CACHE / 'tool/build/Release/native3d_fbx_tool.exe'


def _binary_digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def verified_converter():
    tool = converter_path()
    dependencies = (tool, tool.parent / 'assimp-vc143-mt.dll')
    if not all(path.is_file() and 0 < path.stat().st_size <= 64 * 1024**2 for path in dependencies):
        raise RuntimeError('Pinned local FBX converter executable or Assimp DLL is missing')
    receipt = tool.parent / 'receipt.json'
    if not receipt.is_file() and tool.parent.name == 'Release' and tool.parents[1].name == 'build' and tool.parents[2].name == 'tool':
        # Existing pinned builds wrote the installer receipt at the cache root.
        receipt = tool.parents[3] / 'receipt.json'
    try:
        if not 0 < receipt.stat().st_size <= 65536:
            raise ValueError('Missing or oversized FBX provisioning receipt')
        record = json.loads(receipt.read_text(encoding='utf-8'))
        declared = record['binaries']
        if ((record.get('sourceURL'), record.get('sourceSHA256'), record.get('version'), record.get('license'))
                != (SOURCE_URL, SOURCE_SHA256, '5.4.3', 'BSD-3-Clause')):
            raise ValueError('Unexpected FBX build source, version or license')
        if record.get('adapterSourceSHA256') != ADAPTER_SOURCE_SHA256:
            raise ValueError('FBX adapter revision changed; provision the signed-off centimetre build')
        for binary in dependencies:
            digest = declared.get(binary.name)
            if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest) or _binary_digest(binary) != digest:
                raise ValueError('FBX dependency digest mismatch: ' + binary.name)
    except (OSError, ValueError, AttributeError, KeyError, TypeError) as exc:
        raise RuntimeError('Pinned FBX dependency validation failed: ' + str(exc)) from exc
    return tool, {name: declared[name] for name in (dependencies[0].name, dependencies[1].name)}


def capabilities():
    try:
        _, binaries = verified_converter()
        reason = ''
    except (OSError, RuntimeError, ValueError) as exc:
        binaries, reason = {}, str(exc)
    available = not reason
    return {'available': available, 'ready': available,
            'reason': reason, 'sourceSHA256': SOURCE_SHA256, 'binarySHA256': binaries,
            'converter': 'Assimp 5.4.3',
            'license': 'BSD-3-Clause', 'scope': 'static single mesh, one material, one UV channel; embedded PNG/JPEG base color and normal maps; no external/PBR texture channels',
            'units': 'metres in GLB; centimetre coordinates and UnitScaleFactor=1 in newly exported FBX',
            'axes': 'right handed Y up', 'transforms': 'baked',
            'adapterSourceSHA256': ADAPTER_SOURCE_SHA256,
            'fullMaterialFidelity': False, 'defaultMaterialPolicy': 'reject_lossy',
            'materialLimitation': 'FBX material scalar/shader semantics are not preserved. Default export rejects materials; geometry_only explicitly strips them.'}


def provision(source_archive):
    """Build a predownloaded, pinned official archive locally; never downloads.

    Requires Windows x64, CMake and Visual Studio 2022 C++ build tools. Does
    not modify Python or install system packages. All build products stay in
    the adapter cache. Installation failures are recorded in build.log.
    """
    archive = Path(source_archive).resolve()
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Assimp source archive SHA256 mismatch')
    source_root = CACHE / 'source'
    source_root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        if sum(item.size for item in members) > 1024**3:
            raise ValueError('Source archive exceeds extraction bound')
        for item in members:
            target = (source_root / item.name).resolve()
            if not target.is_relative_to(source_root.resolve()) or not (item.isfile() or item.isdir()):
                raise ValueError('Unsafe source archive entry')
        bundle.extractall(source_root)
    source = source_root / 'assimp-5.4.3'
    build, tool = CACHE / 'build', CACHE / 'tool'
    tool.mkdir(exist_ok=True)
    (tool / 'main.cpp').write_text(CXX_SOURCE, encoding='utf-8')
    (tool / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.18)
project(native3d_fbx_tool CXX)
add_executable(native3d_fbx_tool main.cpp)
target_compile_features(native3d_fbx_tool PRIVATE cxx_std_17)
target_include_directories(native3d_fbx_tool PRIVATE "../source/assimp-5.4.3/include" "../build/include")
target_link_libraries(native3d_fbx_tool PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../build/lib/Release/assimp-vc143-mt.lib")
''', encoding='utf-8')
    commands = [
        ['cmake', '-S', str(source), '-B', str(build), '-G', 'Visual Studio 17 2022', '-A', 'x64',
         '-DASSIMP_BUILD_TESTS=OFF', '-DASSIMP_BUILD_ASSIMP_TOOLS=OFF',
         '-DASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT=OFF', '-DASSIMP_BUILD_FBX_IMPORTER=ON', '-DASSIMP_BUILD_GLTF_IMPORTER=ON',
         '-DASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT=OFF', '-DASSIMP_BUILD_FBX_EXPORTER=ON', '-DASSIMP_BUILD_GLTF_EXPORTER=ON',
         '-DBUILD_SHARED_LIBS=ON', '-DASSIMP_BUILD_ZLIB=ON', '-DASSIMP_WARNINGS_AS_ERRORS=OFF'],
        ['cmake', '--build', str(build), '--config', 'Release', '--target', 'assimp', '--parallel', '4'],
        ['cmake', '-S', str(tool), '-B', str(tool / 'build'), '-G', 'Visual Studio 17 2022', '-A', 'x64'],
        ['cmake', '--build', str(tool / 'build'), '--config', 'Release', '--parallel', '2'],
    ]
    with (CACHE / 'build.log').open('w', encoding='utf-8') as log:
        for command in commands:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
    output = tool / 'build/Release'
    shutil.copy2(build / 'bin/Release/assimp-vc143-mt.dll', output)
    shutil.copy2(source / 'LICENSE', CACHE / 'ASSIMP-LICENSE.txt')
    receipt = {'sourceURL': SOURCE_URL, 'sourceSHA256': SOURCE_SHA256, 'version': '5.4.3',
               'license': 'BSD-3-Clause', 'commands': commands, 'adapterSourceSHA256': ADAPTER_SOURCE_SHA256,
               'binaries': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in
                            [output / 'native3d_fbx_tool.exe', output / 'assimp-vc143-mt.dll']}}
    encoded = json.dumps(receipt, indent=2)
    (CACHE / 'receipt.json').write_text(encoded, encoding='utf-8')
    (output / 'receipt.json').write_text(encoded, encoding='utf-8')
    return receipt


def _convert(source, destination, mode, timeout=120):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or destination.exists():
        raise ValueError('FBX conversion requires a new destination; source is immutable')
    expected = '.fbx' if mode == 'import' else '.glb'
    if source.suffix.lower() != expected:
        raise ValueError('Expected ' + expected + ' input')
    if destination.suffix.lower() != ('.glb' if mode == 'import' else '.fbx'):
        raise ValueError('Unexpected conversion output extension')
    if not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
        raise ValueError('FBX conversion input missing, empty or above 512 MiB')
    tool, binary_digests = verified_converter()
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Restrict plugin/DLL lookup to the pinned local converter and Windows.
    env = dict(os.environ)
    env['PATH'] = str(tool.parent) + os.pathsep + env.get('SystemRoot', r'C:\Windows') + r'\System32'
    # Assimp's Windows CLI uses narrow argv/file APIs. Pass ASCII relative
    # names only; Python's Unicode filesystem APIs stage both sides safely.
    # Never let a failed converter create/delete the caller's destination.
    with tempfile.TemporaryDirectory(prefix='native3d-fbx-io-') as temporary:
        work=Path(temporary);staged_source=work/('input'+source.suffix.lower())
        staged_output=work/('output'+destination.suffix.lower())
        shutil.copyfile(source,staged_source)
        result = subprocess.run([str(tool.resolve()), mode, staged_source.name, staged_output.name],
                                cwd=str(work),capture_output=True,text=True,timeout=min(max(timeout,1),300),env=env)
        if result.returncode:
            raise ValueError('FBX conversion rejected: ' + result.stderr.strip()[:2000])
        if not staged_output.is_file() or not 0 < staged_output.stat().st_size <= MAX_BYTES:
            raise ValueError('FBX conversion output missing or above limit')
        with staged_output.open('rb') as handle:
            header = handle.read(27)
        if mode == 'export' and not header.startswith(b'Kaydara FBX Binary  \x00\x1a\x00'):
            raise ValueError('Converter did not emit genuine binary FBX')
        if mode == 'import' and not header.startswith(b'glTF\x02\x00\x00\x00'):
            raise ValueError('Converter did not emit GLB 2')
        receipt=json.loads(result.stdout)
        if not isinstance(receipt,dict):raise ValueError('Invalid converter receipt')
        # Publish a complete validated file atomically, without replacing an
        # existing target even if it appeared while conversion was running.
        fd,name=tempfile.mkstemp(prefix='.native3d-fbx-',suffix='.tmp',dir=destination.parent)
        publication=Path(name)
        try:
            with os.fdopen(fd,'wb') as target,staged_output.open('rb') as converted:
                shutil.copyfileobj(converted,target,1024*1024);target.flush();os.fsync(target.fileno())
            if os.name=='nt':os.rename(publication,destination)  # Windows rename refuses overwrite.
            else:os.link(publication,destination)  # POSIX rename would replace an existing file.
        finally:
            publication.unlink(missing_ok=True)
        receipt['pathHandling']='Unicode-safe Python staging; ASCII relative converter filenames; atomic no-overwrite publication'
        receipt['dependencySHA256'] = binary_digests
        return receipt



def import_fbx(source, destination_glb, timeout=120):
    receipt = _convert(source, destination_glb, 'import', timeout)
    receipt.update(materialSemanticStatus='mapped_unverified', fullMaterialFidelity=False,
                   materialWarnings=['FBX material shaders/scalars are mapped by Assimp; original material fidelity is unverified.'])
    return receipt


def _glb_document(source):
    with Path(source).open('rb') as handle:
        header = handle.read(20)
        if len(header) != 20:
            raise ValueError('Invalid GLB header')
        magic, version, total, size, kind = struct.unpack('<4sIIII', header)
        if magic != b'glTF' or version != 2 or total != Path(source).stat().st_size or kind != 0x4E4F534A or size > 16 * 1024**2 or size + 20 > total:
            raise ValueError('Invalid or oversized GLB JSON chunk')
        document = json.loads(handle.read(size), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite GLB JSON')))
    if not isinstance(document, dict):
        raise ValueError('Invalid GLB document')
    return document, size, total


def export_fbx(source_glb, destination_fbx, timeout=120, *, material_policy='reject_lossy'):
    """Export geometry by default, rejecting materials whose FBX fidelity is unknown.

    geometry_only strips all source materials/maps and requires an unmistakable
    new ``*.geometry-only.fbx`` name. allow_lossy is an explicit diagnostic or
    caller-approved mapping; its receipt never claims complete material parity.
    """
    if material_policy not in {'reject_lossy', 'geometry_only', 'allow_lossy'}:
        raise ValueError('Unknown FBX material policy')
    source = Path(source_glb).resolve()
    if source.suffix.lower() != '.glb' or not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
        raise ValueError('Expected bounded GLB input')
    document, chunk_size, total = _glb_document(source)
    materials = document.get('materials', [])
    if not isinstance(materials, list):
        raise ValueError('Invalid GLB materials')
    has_materials = bool(materials)
    scalars = [{'metallicFactor': m.get('pbrMetallicRoughness', {}).get('metallicFactor', 1),
                'roughnessFactor': m.get('pbrMetallicRoughness', {}).get('roughnessFactor', 1)}
               for m in materials if isinstance(m, dict)]
    if has_materials and material_policy == 'reject_lossy':
        raise ValueError('FBX material semantic preservation is unverified: metallic/roughness/shader mappings can be lossy. Export rejected; choose explicit geometry_only with a .geometry-only.fbx filename.')
    if material_policy == 'geometry_only':
        if not str(destination_fbx).lower().endswith('.geometry-only.fbx'):
            raise ValueError('Geometry-only export requires a new .geometry-only.fbx filename')
        for mesh in document.get('meshes', []):
            for primitive in mesh.get('primitives', []):
                primitive.pop('material', None)
                primitive.get('extensions', {}).pop('KHR_materials_variants', None)
        for key in ('materials', 'textures', 'images', 'samplers'):
            document.pop(key, None)
        for key in ('extensionsUsed', 'extensionsRequired'):
            if key in document:
                document[key] = [name for name in document[key] if not name.startswith('KHR_materials_') and name not in {'KHR_texture_transform', 'KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'}]
        payload = json.dumps(document, separators=(',', ':'), allow_nan=False).encode()
        payload += b' ' * (-len(payload) % 4)
        with tempfile.TemporaryDirectory(prefix='native3d-fbx-geometry-') as directory:
            stripped = Path(directory) / 'geometry.glb'
            with source.open('rb') as src, stripped.open('xb') as dst:
                dst.write(struct.pack('<4sIIII', b'glTF', 2, total - chunk_size + len(payload), len(payload), 0x4E4F534A))
                dst.write(payload)
                src.seek(20 + chunk_size)
                shutil.copyfileobj(src, dst, 1024 * 1024)
            receipt = _convert(stripped, destination_fbx, 'export', timeout)
        status = 'stripped_geometry_only'
    else:
        receipt = _convert(source, destination_fbx, 'export', timeout)
        status = 'lossy_unverified' if has_materials else 'not_applicable'
    receipt.update(materialPolicy=material_policy, materialSemanticStatus=status,
                   fullMaterialFidelity=False, sourceMaterialScalars=scalars,
                   materialWarnings=[] if not has_materials else [
                       'Source materials/maps were explicitly stripped.' if material_policy == 'geometry_only' else
                       'FBX material scalar/shader mapping is lossy or unverified; metallic and roughness values may change.'])
    return receipt
