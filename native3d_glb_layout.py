"""Read the bounded GLB JSON chunk and check the Native3D layout contract."""
import json
import struct


def read_glb_document(path):
    with path.open('rb') as stream:
        header = stream.read(20)
        if len(header) != 20:
            raise ValueError('Invalid GLB2 header')
        magic, version, length, size, kind = struct.unpack('<4sIIII', header)
        if magic != b'glTF' or version != 2:
            raise ValueError('Invalid GLB2 header')
        if kind != 0x4e4f534a or size > 32 * 1024**2 or size > length - 20:
            raise ValueError('Invalid GLB JSON chunk')
        data = stream.read(size)
        if len(data) != size:
            raise ValueError('Truncated GLB JSON chunk')
        return json.loads(data)


class GLBLayoutError(ValueError):
    code = 'NATIVE3D_GLB_LAYOUT_UNSUPPORTED'

    def __init__(self, materials, counts):
        remediation = ('在 Blender 中将贴图烘焙到同一张 UV 图集，合并为一个材质槽，'
                       '再导出为单对象、单 primitive 的 GLB。请另存副本。')
        self.details = {'materialCount': materials, 'meshPrimitiveCounts': counts, 'remediation': remediation}
        summary = '、'.join(f'Mesh {i}: {count}' for i, count in enumerate(counts[:12]))
        if len(counts) > 12:
            summary += f'（共 {len(counts)} 个 mesh）'
        super().__init__(f'此 GLB 有 {materials} 个材质；primitive 数：{summary}。{remediation}')


def validate_glb_layout(document):
    materials = len(document.get('materials', []))
    counts = [len(mesh.get('primitives', [])) for mesh in document.get('meshes', [])]
    if materials > 1 or any(count != 1 for count in counts):
        raise GLBLayoutError(materials, counts)
