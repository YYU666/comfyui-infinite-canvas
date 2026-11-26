"""Optional local-only protected LOD0 solver; never imports task scratch assets."""
import hashlib
import importlib
import math
import os
from pathlib import Path
import sys
import time
import zipfile
import numpy as np
from native3d_geometry import mesh_hash
from native3d_geometry_audit import audit_geometry
from native3d_lod_boundary import OriginalBoundaryReference

PROFILE='protected-lod0-v1'
VERSION='2025.7'
WHEEL_SHA256='8cbe599f6d14dfdf6422ebc5b6a1a955d8c231224a4756df436e6ea0c6484512'


def runtime_directory():
    return Path(__file__).resolve().parent/'.cache/native3d/pymeshlab'


def runtime_available():
    return os.environ.get('NATIVE3D_PROTECTED_LOD0','1')!='0' and runtime_directory().is_dir()


def load_runtime():
    root=runtime_directory().resolve();wheel=root/('pymeshlab-'+VERSION+'-cp310-cp310-win_amd64.whl')
    if not wheel.is_file():raise ValueError('Optional protected runtime wheel is missing')
    if hashlib.sha256(wheel.read_bytes()).hexdigest()!=WHEEL_SHA256:
        raise ValueError('Optional protected runtime wheel checksum mismatch')
    verified=0;runtime_files=0;verified_pyd=0
    with zipfile.ZipFile(wheel) as archive:
        for name in archive.namelist():
            if name.endswith(('/', '/RECORD')):continue
            # pip relocates wheel .data/purelib contents into --target itself.
            # The pinned Windows wheel stores all native code in this layout.
            installed_name=name.removeprefix('pymeshlab-'+VERSION+'.data/purelib/')
            if not installed_name.startswith(('pymeshlab/','pymeshlab-'+VERSION+'.dist-info/')):
                raise ValueError('Unrecognized optional runtime wheel installation layout: '+name)
            target=(root/installed_name).resolve()
            if not target.is_relative_to(root):raise ValueError('Invalid optional runtime wheel path')
            if not target.is_file() or hashlib.sha256(target.read_bytes()).digest()!=hashlib.sha256(archive.read(name)).digest():
                raise ValueError('Optional protected runtime installed file checksum mismatch: '+name)
            verified+=1
            runtime_files+=installed_name.startswith('pymeshlab/')
            verified_pyd+=installed_name.endswith('.pyd')
    if not runtime_files or not verified_pyd:raise ValueError('Optional runtime wheel lacks verified native implementation files')
    previous=list(sys.path)
    try:
        sys.path.insert(0,str(root));module=importlib.import_module('pymeshlab')
    finally:sys.path[:]=previous
    if not Path(module.__file__).resolve().is_relative_to(root):
        raise ValueError('Protected runtime imported from an unverified location')
    return module,{'name':'pymeshlab','version':VERSION,'wheelSha256':WHEEL_SHA256,'verifiedInstalledFiles':verified,
                   'verifiedRuntimeFiles':runtime_files,'verifiedNativePythonExtensions':verified_pyd,
                   'path':str(root),'license':'GPL3; optional research-local runtime, not a shipped dependency'}


def solve(source,target,deadline,progress=None):
    from native3d_lod_source import normalize_source_geometry,repair_source_local_patch,_local_repair_face_ids,_canonical_mesh,_Reference,_sample
    from native3d_lod_local import repair_candidates
    started=time.monotonic();candidate=None
    receipt={'profile':PROFILE,'status':'blocked','inputSourceMeshHash':mesh_hash(source.vertices,source.faces),
             'targetTriangles':int(target),'sourceRepairLimit':4,'sourceRemovedFaceLimit':512,
             'sourceRepairs':[],'qemPasses':[],'warnings':[],'candidateRole':'diagnostic_until_existing_export_gates_pass'}
    def check():
        if time.monotonic()>=deadline:raise ValueError('Shared source LOD wall-clock budget exhausted')
    def audit(v,f,complete=False):
        check();return audit_geometry(v,f,max_seconds=min(120.,deadline-time.monotonic()),
                                     allow_boundaries=bool(boundary.edge_count),collect_all_intersections=complete)
    def topology_clean(report):
        return all(report.get(k)==0 for k in ('duplicate_faces','degenerate_faces_count','nonmanifold_edges_count','nonmanifold_vertices_count','inconsistent_winding_edges'))
    try:
        check();runtime,receipt['runtime']=load_runtime();check()
        v,f,normalization=normalize_source_geometry(source.vertices,source.faces)
        boundary=OriginalBoundaryReference(v,f);original_v=v.copy();lineage=np.arange(len(f),dtype=np.int64)
        receipt.update(normalization=normalization,originalReferenceMeshHash=boundary.mesh_hash)
        report=audit(v,f);original_boundary=report['boundaryPositionHash'];removed_total=0
        for index in range(1,5):
            check()
            if report['status']=='accepted':break
            if not topology_clean(report) or report.get('intersectionStatus')!='defect_found_search_stopped':
                raise ValueError('Protected source is not topology-clean with proven intersections')
            selected,_=_local_repair_face_ids(f,report,report['intersection_pairs'])
            if np.any(lineage[selected]<0) or removed_total+len(selected)>512:
                receipt['sourceRepairStopReason']='bounded source repair scope exhausted';break
            try:nv,nf,local=repair_source_local_patch(v,f,report,report)
            except ValueError as error:
                receipt['sourceRepairStopReason']=str(error);break
            if not np.array_equal(nv,original_v):raise ValueError('Source repair moved original vertices')
            following=audit(nv,nf)
            if not topology_clean(following) or following['boundaryPositionHash']!=original_boundary:
                raise ValueError('Source repair changed original topology or boundary')
            local.update(index=index,removedOriginalFaceIds=lineage[selected].tolist(),geometry=following)
            keep=np.ones(len(f),bool);keep[selected]=False
            lineage=np.r_[lineage[keep],np.full(len(local['newFaces']),-index,dtype=np.int64)]
            removed_total+=len(selected);receipt['sourceRepairs'].append(local);v,f,report=nv,nf,following
        receipt['workingSourceAudit']=report;receipt['sourceRemovedFaces']=removed_total
        receipt['workingSourceRole']='explicitly uncertified solver input; original immutable high remains reference'
        receipt['workingSourceMeshHash']=mesh_hash(v,f)
        meshset=runtime.MeshSet();meshset.add_mesh(runtime.Mesh(vertex_matrix=v,face_matrix=f))
        if not np.array_equal(meshset.current_mesh().vertex_matrix(),v) or not np.array_equal(meshset.current_mesh().face_matrix(),f):
            raise ValueError('Optional QEM runtime changed float64 input arrays')
        parameters={'qualitythr':.3,'preserveboundary':True,'boundaryweight':1.,'preservenormal':True,
                    'preservetopology':True,'optimalplacement':False,'planarquadric':False,'planarweight':.001,
                    'qualityweight':False,'autoclean':False,'selected':False,'targetperc':0.}
        receipt['qemParameters']=parameters;available=meshset.filter_parameter_values('meshing_decimation_quadric_edge_collapse')
        if any(k not in available for k in parameters):raise ValueError('Optional QEM runtime parameter contract mismatch')
        for index in range(1,9):
            check()
            if len(f)<=target:break
            before=len(f);requested=max(target,math.ceil(before*.5));parent_hash=mesh_hash(v,f)
            if progress:progress('保护轮廓减面 '+str(index),10+index*5)
            meshset.apply_filter('meshing_decimation_quadric_edge_collapse',targetfacenum=requested,**parameters)
            check();v=meshset.current_mesh().vertex_matrix();f=meshset.current_mesh().face_matrix()
            if not max(1,math.ceil(before*.5)-1)<=len(f)<=requested or len(f)>=before:
                raise ValueError('Protected QEM stalled or violated bounded50percent reduction')
            receipt['qemPasses'].append({'index':index,'parentMeshHash':parent_hash,'candidateMeshHash':mesh_hash(v,f),
                                        'parentTriangles':before,'requestedTriangles':requested,'actualTriangles':len(f),
                                        'maxReductionFraction':.5,'faceParityTolerance':1})
        if len(f)>target:raise ValueError('Protected QEM exceeded8pass budget')
        candidate=_canonical_mesh(v,f);v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces)
        census=audit(v,f,True);receipt['initialCensus']=census
        if not topology_clean(census) or not census['intersectionComplete']:
            raise ValueError('Protected candidate lacks complete topology-clean census')
        if census['intersection_pairs_count']:
            v,f,local=repair_candidates(v,f,source,boundary,census,check,progress)
            receipt['localRepair']=local;candidate=_canonical_mesh(v,f)
            if local['status']!='complete':raise ValueError('Protected local search left unsupported clusters')
        v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces)
        final=audit(v,f,True);receipt['geometry']=final;receipt['boundaryPreservation']=boundary.compare(v,f)
        points,normals=_sample(v,f,4096,7321);forward=_Reference(source.vertices,source.faces).compare(points,normals,boundary.diagonal)
        points,normals=_sample(source.vertices,source.faces,4096,7321);backward=_Reference(v,f).compare(points,normals,boundary.diagonal)
        fidelity={'childToSource':forward,'sourceToChild':backward,'p95LimitFraction':.005,'sampledMaxLimitFraction':.02,'oppositeNormalFractionLimit':.25}
        fidelity['accepted']=all(x['distanceP95Fraction']<=.005 and x['sampledMaxDistanceFraction']<=.02 and x['oppositeNormalFraction']<=.25 for x in (forward,backward));receipt['fidelity']=fidelity
        if final['status']!='accepted' or not final['intersectionComplete'] or final['intersection_pairs_count']!=0 or not fidelity['accepted']:
            raise ValueError('Protected canonical candidate failed unchanged final geometry/fidelity gates')
        check();receipt.update(status='complete',candidateMeshHash=mesh_hash(v,f),actualTriangles=len(f))
    except (ValueError,ImportError,OSError,RuntimeError) as error:
        receipt.update(status='blocked',errorType=type(error).__name__,blocker=str(error))
    receipt['wallSeconds']=time.monotonic()-started
    return candidate,receipt


def child_runtime_available():
    return os.environ.get('NATIVE3D_PROTECTED_CHILD','1')!='0' and runtime_available()


def solve_child(parent, high, target, seed, deadline, progress=None):
    """One endpoint-QEM candidate from the accepted parent, never from failed LODs.

    Optional runtime and immutable references are identical to the LOD0 route;
    source repairs and topology-changing local repairs are deliberately absent.
    """
    from native3d_lod_source import normalize_source_geometry, _canonical_mesh, _Reference, _sample
    from native3d_lod_retry import seeded_order
    from native3d_lod_local import relocate_fixed_topology
    started=time.monotonic();candidate=None
    receipt={'profile':'protected-child-default-boundary-fixed-topology-v1','status':'blocked',
             'parentMeshHash':mesh_hash(parent.vertices,parent.faces),
             'originalHighMeshHash':mesh_hash(high.vertices,high.faces),'seed':seed,
             'targetTriangles':int(target),'qemPasses':[],
             'algorithm':'PyMeshLab quadric edge collapse, endpoint placement; not AI',
             'targetPolicy':'existing effective target/hard cap; adaptive soft targets not implemented'}
    def check():
        if time.monotonic()>=deadline:raise ValueError('Shared retry wall-clock budget exhausted')
    def audit(v,f):
        check();return audit_geometry(v,f,max_seconds=min(120.,deadline-time.monotonic()),
                                     allow_boundaries=True,collect_all_intersections=True)
    try:
        check()
        if type(target) is not int or not 4<=target<len(parent.faces):
            raise ValueError('Child fallback requires a reducing logical target')
        parent_audit=audit(parent.vertices,parent.faces)
        if parent_audit['status']!='accepted':raise ValueError('Child fallback parent must be accepted geometry')
        sv,sf,_=normalize_source_geometry(high.vertices,high.faces);boundary=OriginalBoundaryReference(sv,sf)
        boundary.compare(parent.vertices,parent.faces);check()
        runtime,receipt['runtime']=load_runtime();check()
        v,f,receipt['ordering']=seeded_order(parent.vertices,parent.faces,seed)
        meshset=runtime.MeshSet();meshset.add_mesh(runtime.Mesh(vertex_matrix=v,face_matrix=f))
        if not np.array_equal(meshset.current_mesh().vertex_matrix(),v) or not np.array_equal(meshset.current_mesh().face_matrix(),f):
            raise ValueError('Optional child runtime changed input arrays')
        parameters={'qualitythr':.3,'preserveboundary':False,'boundaryweight':1.,'preservenormal':True,
                    'preservetopology':True,'optimalplacement':False,'planarquadric':False,'planarweight':.001,
                    'qualityweight':False,'autoclean':False,'selected':False,'targetperc':0.}
        receipt['qemParameters']=parameters
        available=meshset.filter_parameter_values('meshing_decimation_quadric_edge_collapse')
        if any(k not in available for k in parameters):raise ValueError('Optional child runtime parameter contract mismatch')
        for index in range(1,9):
            check()
            if len(f)<=target:break
            before=len(f);requested=max(target,math.ceil(before*.5));parent_hash=mesh_hash(v,f)
            if progress:progress('传统边折叠单档回退 '+str(index),15+index*5)
            meshset.apply_filter('meshing_decimation_quadric_edge_collapse',targetfacenum=requested,**parameters)
            check();v=meshset.current_mesh().vertex_matrix();f=meshset.current_mesh().face_matrix()
            if not max(1,math.ceil(before*.5)-1)<=len(f)<=requested or len(f)>=before:
                raise ValueError('Child QEM stalled or violated bounded50percent reduction')
            receipt['qemPasses'].append({'index':index,'parentMeshHash':parent_hash,'candidateMeshHash':mesh_hash(v,f),
                                        'parentTriangles':before,'requestedTriangles':requested,'actualTriangles':len(f),
                                        'maxReductionFraction':.5,'faceParityTolerance':1})
        if len(f)>target:raise ValueError('Child QEM exceeded8pass budget')
        candidate=_canonical_mesh(v,f);v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces)
        census=audit(v,f);receipt['initialCensus']=census
        if not census.get('intersectionComplete') or any(census.get(k)!=0 for k in
                ('duplicate_faces','degenerate_faces_count','nonmanifold_edges_count','nonmanifold_vertices_count','inconsistent_winding_edges')):
            raise ValueError('Child candidate lacks complete topology-clean census')
        if census['intersection_pairs_count']:
            v,f,local=relocate_fixed_topology(v,f,high,boundary,census,check,progress)
            receipt['localRepair']=local;candidate=_canonical_mesh(v,f)
            if local['status']!='complete':raise ValueError('Child fixed-topology relocation left intersections')
        v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces)
        final=audit(v,f);receipt['geometry']=final
        if final['status']!='accepted' or not final['intersectionComplete'] or final['intersection_pairs_count']!=0:
            raise ValueError('Child canonical geometry gate failed')
        try:receipt['boundaryPreservation']=boundary.compare(v,f)
        except ValueError as error:
            from native3d_lod_boundary_retopo import CERTIFICATE_FAILURES,repair_boundary_certificate
            if str(error) not in CERTIFICATE_FAILURES:raise
            receipt['boundaryCertificationBlocker']=str(error)
            if progress:progress('局部边界重拓扑（传统算法）',75)
            repaired,retopo=repair_boundary_certificate(candidate,high,boundary,final,target,deadline,progress)
            receipt['boundaryRetopology']=retopo
            # Markers remain bound to the pre-repair hash, never reassigned to
            # post-repair face IDs. The reversible map preserves that diagnostic.
            if 'localization' in retopo:receipt['boundaryIssueMarkers']=retopo['localization']
            if retopo['status']!='complete':raise ValueError(retopo.get('blocker',str(error)))
            candidate=repaired;v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces)
            final=audit(v,f);receipt['geometry']=final
            if final['status']!='accepted' or not final['intersectionComplete'] or final['intersection_pairs_count']!=0:
                raise ValueError('Child retopology final canonical geometry gate failed')
            receipt['boundaryPreservation']=boundary.compare(v,f)
            receipt['algorithm']+=' + traditional local boundary retopology; not AI'
        if final['componentCount']!=parent_audit['componentCount'] or final['signedVolume']*parent_audit['signedVolume']<0:
            raise ValueError('Child changed components or orientation')
        check();points,normals=_sample(v,f,4096,7321);forward=_Reference(high.vertices,high.faces).compare(points,normals,boundary.diagonal)
        check();points,normals=_sample(high.vertices,high.faces,4096,7321);backward=_Reference(v,f).compare(points,normals,boundary.diagonal)
        receipt['fidelity']={'method':'bidirectional original-high surface samples','seed':7321,
                             'childToSource':forward,'sourceToChild':backward,
                             'p95LimitFraction':.005,'sampledMaxLimitFraction':.02,'oppositeNormalFractionLimit':.25,
                             'accepted':all(x['distanceP95Fraction']<=.005 and x['sampledMaxDistanceFraction']<=.02 and x['oppositeNormalFraction']<=.25 for x in (forward,backward))}
        if not receipt['fidelity']['accepted']:raise ValueError('Child original-high fidelity gate failed')
        check();receipt.update(status='complete',candidateMeshHash=mesh_hash(v,f),actualTriangles=len(f))
    except (ValueError,ImportError,OSError,RuntimeError) as error:
        receipt.update(status='blocked',errorType=type(error).__name__,blocker=str(error))
    receipt['wallSeconds']=time.monotonic()-started
    return candidate,receipt
