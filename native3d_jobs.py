"""Durable isolated native 3D queue. Never writes a project document."""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import uuid
try:
    import psutil
except ImportError:
    psutil = None
from native3d_presets import AI_LOWPOLY_DEFAULTS, AI_LOWPOLY_PRESET
from project_store import StoreError
from native3d_canvas_submission import check_saved_submission
from native3d_fbx import capabilities as fbx_capabilities
from gpu_lease import GpuLeases, gpu_status, job_owner, physical_device
from local_worker import verified_result, worker_progress
from native3d_triposr import IMAGE_SUFFIXES, MAX_IMAGE_BYTES, MODULES as TRIPOSR_MODULES, configuration_errors, worker_env

TERMINAL = {'succeeded', 'failed', 'cancelled'}
OPERATIONS = ('analyze', 'ai_lowpoly', 'repair_lod', 'source_lod', 'uv_plan', 'uv', 'bake', 'image_to_3d', 'material_wear')
MAX_SOURCE = 512 * 1024**2
ADAPTER_ID = 'meshanything-v2-local'
SCHEMAS = {
    'analyze': {},
    'image_to_3d': {
        'gridResolution': {'type':'integer', 'enum':[96,128,160,192], 'default':128, 'title':'重建网格分辨率'},
        'background': {'type':'string','enum':['light','alpha','keep'],'default':'light','title':'参考图背景'},
        'foregroundRatio': {'type':'number','minimum':.5,'maximum':.95,'default':.85,'title':'主体在构图中的占比'},
    },
    'material_wear': {
        'bakeJobId': {'type':'string','pattern':'^n3d_[a-f0-9]{32}$'},
        'strength': {'type':'number','minimum':0,'maximum':1,'default':.7,'title':'磨损强度'},
        'threshold': {'type':'number','minimum':0,'maximum':.95,'default':.18,'title':'凸棱阈值'},
        'edgeLighten': {'type':'number','minimum':0,'maximum':1,'default':.32,'title':'棱边提亮'},
        'edgeRoughness': {'type':'number','minimum':0,'maximum':1,'default':.55,'title':'磨损粗糙度'},
        'metalExposure': {'type':'number','minimum':0,'maximum':1,'default':0,'title':'磨损露出金属量'},
    },
    'ai_lowpoly': {
        'conditioningProfile': {'type':'string', 'enum':['canonical_safe','legacy_world_fp16'], 'default':AI_LOWPOLY_DEFAULTS['conditioningProfile']},
        'inputSeed': {'type':'integer', 'minimum':0, 'maximum':4294967295, 'default':AI_LOWPOLY_DEFAULTS['inputSeed']},
        'seed': {'type':'integer', 'minimum':0, 'maximum':4294967295, 'default':AI_LOWPOLY_DEFAULTS['seed']},
        'sampling': {'type':'boolean', 'default':AI_LOWPOLY_DEFAULTS['sampling']},
        'targetFaces': {'type':'integer', 'minimum':4, 'maximum':100000, 'description':'Optional postprocessing target; not native model exact-face control'},
    },
    'repair_lod': {
        **{'lod'+str(i): {'type':'integer','minimum':4,'maximum':100000,'default':n} for i,n in enumerate((1200,800,500,300),1)},
        'selectedLod': {'type':'integer','minimum':4,'maximum':100000,'default':800},
        'reviewedBoundaryMeshHash': {'type':'string','pattern':'^[a-f0-9]{64}$'},
        'reviewedRepairPlan': {'type':'string','maxLength':16384,'description':'显式局部修复记录，绑定当前网格哈希；不会自动猜测补洞位置'},
        'fitBoundaryMode': {'type':'string','enum':['fixed','reviewed_bounded'],'default':'fixed','description':'固定外轮廓，或按已核对方案在贴合约束内移动外轮廓'},
    },
    'source_lod': {
        'localRepairJobId': {'type':'string','pattern':'^n3d_[a-f0-9]{32}$'},
        'localRepairStage': {'type':'string','enum':['lod0','lod1','lod2','lod3','lod4']},
        'localRepairMaxPatches': {'type':'integer','minimum':1,'maximum':4,'default':4,'title':'局部修复块数上限','description':'仅手动局部修复；最多增加对应面数，仍受显式面数上限和父级面数限制'},
        'localRepairDisplacementFraction': {'type':'number','minimum':0.0001,'maximum':0.01,'default':0.002,'title':'局部顶点位移上限（对角线比例）','description':'仅控制提案位移；最终局部误差0.002D、边界、法线与保真检查不变'},
        'localRepairCorrectionFraction': {'type':'number','minimum':0.1,'maximum':1,'default':0.375,'title':'每块向原边界校正比例','description':'仅手动局部修复；每个局部面向已定位原边界移动的比例'},
        'retryJobId': {'type':'string','pattern':'^n3d_[a-f0-9]{32}$'},
        'retryStage': {'type':'string','enum':['lod1','lod2','lod3','lod4']},
        'seed': {'type':'integer','minimum':0,'maximum':4294967295},
        'retryKeepPercent': {'type':'number','minimum':0.001,'maximum':100,
                             'title':'本次重试保留比例（%）',
                             'description':'仅单档重试可用；省略沿用冻结比例。基准沿用原任务，只覆盖当前档；原硬面数上限仍生效。'},
        'lodCount': {'type':'integer','minimum':1,'maximum':5,'default':5,'title':'输出 LOD 档数'},
        'lod0KeepPercent': {'type':'number','minimum':0.001,'maximum':100,'default':10},
        'lod0FaceCap': {'type':'integer','minimum':0,'maximum':100000,'default':100000},
        **{'lod'+str(i)+'KeepPercent': {'type':'number','minimum':0.001,'maximum':100,'default':n} for i,n in enumerate((50,25,12.5,6.25),1)},
        **{'lod'+str(i)+'FaceCap': {'type':'integer','minimum':0,'maximum':100000,'default':0} for i in range(1,5)},
        'selectedLodLevel': {'type':'integer','minimum':0,'maximum':4,'default':0},
    },
    'uv': {
        'planJobId': {'type':'string','pattern':'^n3d_[a-f0-9]{32}$'},
        'planSha256': {'type':'string','pattern':'^[a-f0-9]{64}$'},
        'seamPlanningMode': {'type':'string','enum':['ai_structure_ao_v2','ai_coarse_harmonic_v3']},
        'convexAngleDegrees': {'type':'number','minimum':5,'maximum':120},
        'structureScaleFraction': {'type':'number','minimum':0.001,'maximum':0.1},
        'structureMinChainLengthFraction': {'type':'number','minimum':0.001,'maximum':0.3},
        'seamStrategy': {'type':'string','enum':['structural','ao_geometry','coherent'],'default':'structural'},
        'annularSeamPlan': {'type':'string','maxLength':512,'description':'JSON for a closed annular shell: sourceSha256, unit axis, two rimCuts in model coordinates, and slitDirection. Keeps outer wall, inner wall and both rims as four UV islands.'},
        'packingMode': {'type':'string','enum':['efficient','legacy_fixed'],'default':'efficient'},
        'chartMergeCost': {'type':'number','minimum':2,'maximum':20,'default':8,'description':'合岛倾向；值越大越允许合并，不是拉伸上限，实际拉伸需看报告'},
        'alignDirection': {'type':'string','enum':['world_up','none'],'default':'world_up','description':'coherent 模式：每岛平均模型+Y朝向UV上方；水平面显式使用备用轴'},
        'aoRaySamples': {'type':'integer','minimum':8,'maximum':128,'default':32},
        'aoRadiusFraction': {'type':'number','minimum':0.01,'maximum':0.3,'default':0.08},
        'coarseAngleDegrees': {'type':'number','minimum':20,'maximum':100,'default':65},
        'aoConcaveAngleDegrees': {'type':'number','minimum':5,'maximum':120,'default':35},
        'aoDarknessThreshold': {'type':'number','minimum':0,'maximum':1,'default':0.2},
        'segmentationEvidence': {'type':'string','maxLength':48000,'description':'Optional face labels bound to exact source file SHA256; local research evidence only'},
        'highGuidedEvidence': {'type':'string','maxLength':28000,'description':'外部高模AO/分区映射证据，绑定高低模SHA256；不在UV阶段重算来源，限28KB'},
        'orientationConfirmed': {'type':'boolean', 'default':False, 'description':'Open surface orientation has been checked against its original reference; required for signed concave seams'},
        'concaveAngleDegrees': {'type':'number', 'minimum':5, 'maximum':90, 'default':25},
        'sharpAngleDegrees': {'type':'number', 'minimum':45, 'maximum':170, 'default':80},
        'externalGeometryReviewed': {'type':'boolean','default':False,'description':'Explicit manual UV permission for externally authored mesh with no known AI job provenance'},
        'resolution': {'type':'integer', 'enum':[1024,2048,4096], 'default':1024},
        'padding': {'type':'integer', 'minimum':1, 'maximum':32, 'default':8},
    },
    'bake': {
        'externalGeometryReviewed': {'type':'boolean','default':False,'description':'Explicit manual permission for externally authored mesh with no known AI job provenance'},
        'resolution': {'type':'integer', 'enum':[1024,2048,4096], 'default':2048, 'title':'输出分辨率'},
        'rayDistance': {'type':'number', 'minimum':0.0001, 'maximum':0.25, 'default':0.02, 'title':'投射距离占对角线比例'},
        'aoSamples': {'type':'integer', 'minimum':8, 'maximum':256, 'default':64, 'title':'AO半球样本数'},
        'aoRadiusFraction': {'type':'number', 'minimum':0.001, 'maximum':1, 'default':0.1, 'title':'AO最大距离占对角线比例'},
        'aoAttenuation': {'type':'string', 'enum':['none','linear'], 'default':'linear', 'title':'AO距离衰减'},
        'padding': {'type':'integer', 'minimum':0, 'maximum':64, 'default':0, 'title':'岛外扩边像素（0自动）'},
    },
}

# A plan freezes seam decisions before any unwrap/packing is executed.
SCHEMAS['uv_plan'] = {key: copy.deepcopy(SCHEMAS['uv'][key]) for key in (
    'resolution','padding','chartMergeCost','packingMode','alignDirection',
    'aoRaySamples','aoRadiusFraction','aoConcaveAngleDegrees','aoDarknessThreshold',
    'externalGeometryReviewed')}
SCHEMAS['uv_plan'].update({
    'seamPlanningMode': {'type':'string','enum':['ai_structure_ao_v2','ai_coarse_harmonic_v3'],'default':'ai_structure_ao_v2'},
    'convexAngleDegrees': {'type':'number','minimum':5,'maximum':120,'default':45,'title':'凸转折起始角度（度）','description':'强折角启动切缝；同方向相邻边可按半角延续，但仍须通过块面尺度与连续长度检查'},
    'concaveAngleDegrees': {'type':'number','minimum':5,'maximum':90,'default':45,'title':'凹转折起始角度（度）','description':'强凹角启动切缝；同方向相邻边可按半角延续，AO只补充有高模支持的凹槽'},
    'structureScaleFraction': {'type':'number','minimum':0.001,'maximum':0.1,'default':0.02,'title':'块面分析尺度','description':'占模型对角线的比例，过滤细碎表面起伏'},
    'structureMinChainLengthFraction': {'type':'number','minimum':0.001,'maximum':0.3,'default':0.04,'title':'最短连续切缝','description':'占模型对角线的比例，过滤孤立短边'},
    'partitionCount': {'type':'integer','enum':[4,8,12],'default':8},
    'regionMinAreaFraction': {'type':'number','minimum':0,'maximum':0.02,'default':0.002},
    'regionMergeAngleDegrees': {'type':'number','minimum':0,'maximum':60,'default':35},
    'orientationConfirmed': {'type':'boolean','default':False},
})
for _key,_default in {'resolution':4096,'padding':16,'chartMergeCost':12,'aoDarknessThreshold':0.2}.items():
    SCHEMAS['uv_plan'][_key]['default']=_default

for _operation in ('uv_plan','uv','bake'):
    SCHEMAS[_operation].update({
        'reviewedBoundaryJobId': {'type':'string','pattern':'^n3d_[a-f0-9]{32}$'},
        'reviewedBoundaryStage': {'type':'string','enum':['lod0','lod1','lod2','lod3','lod4']},
    })

SCHEMAS['bake']['reviewedBoundaryBakeHighSha256']={'type':'string','pattern':'^[a-f0-9]{64}$'}

def validate_parameters(operation, values):
    if not isinstance(values, dict) or set(values) - set(SCHEMAS[operation]):
        fail('Unknown parameters for ' + operation)
    result = {}
    for key, schema in SCHEMAS[operation].items():
        if key not in values and 'default' not in schema:
            continue
        value = values.get(key, schema.get('default'))
        kind = schema['type']
        valid = ((type(value) is int) if kind == 'integer' else
                 (type(value) is bool) if kind == 'boolean' else
                 (type(value) is str) if kind == 'string' else
                 (type(value) in (int, float)))
        if not valid or ('enum' in schema and value not in schema['enum']) or ('minimum' in schema and not schema['minimum'] <= value <= schema['maximum']) or ('pattern' in schema and not re.fullmatch(schema['pattern'],value)) or ('maxLength' in schema and len(value.encode('utf-8')) > schema['maxLength']):
            fail('Invalid parameter: ' + key)
        result[key] = value
    if operation == 'material_wear' and not result.get('bakeJobId'):
        fail('曲率磨损需要确切烘焙任务。')
    if operation == 'repair_lod':
        if result['fitBoundaryMode'] == 'reviewed_bounded' and not result.get('reviewedBoundaryMeshHash'):
            fail('Boundary fitting requires a reviewed source mesh hash')
        if 'reviewedRepairPlan' in result:
            try:
                plan = json.loads(result['reviewedRepairPlan'])
                if not isinstance(plan, dict) or type(plan.get('version')) is not int or plan['version'] != 1 or not re.fullmatch('[a-f0-9]{64}', str(plan.get('sourceMeshHash', ''))):
                    raise ValueError()
            except (ValueError, TypeError, RecursionError):
                fail('Invalid reviewed repair plan')
        budgets=[result['lod'+str(i)] for i in range(1,5)]
        if any(a<=b for a,b in zip(budgets,budgets[1:])) or result['selectedLod'] not in budgets:
            fail('LOD budgets must decrease and selectedLod must match a budget')
    if operation == 'source_lod':
        repair_options=('localRepairMaxPatches','localRepairDisplacementFraction','localRepairCorrectionFraction')
        if not result.get('localRepairJobId'):
            if any(k in values for k in repair_options):fail('Local repair settings require localRepairJobId')
            for key in repair_options:result.pop(key,None)
        if any(k in result for k in ('localRepairJobId','localRepairStage')):
            if not all(k in result for k in ('localRepairJobId','localRepairStage')):
                fail('Local repair requires localRepairJobId and localRepairStage together')
            if any(k in result for k in ('retryJobId','retryStage','seed','retryKeepPercent')):
                fail('Local repair cannot be combined with retry parameters')
        if any(k in result for k in ('retryJobId','retryStage','seed','retryKeepPercent')) and not all(k in result for k in ('retryJobId','retryStage','seed')):
            fail('Source LOD retry requires retryJobId, retryStage and seed together')
        percentages = [100] + [result['lod'+str(i)+'KeepPercent'] for i in range(1,5)]
        if any(a <= b for a,b in zip(percentages,percentages[1:])):
            fail('LOD retention percentages must strictly decrease relative to LOD0')
    if result.get('reviewedBoundaryBakeHighSha256') and not result.get('reviewedBoundaryJobId'):
        fail('Separate reviewed bake high requires explicit reviewed boundary lineage')
    if bool(result.get('reviewedBoundaryJobId')) != bool(result.get('reviewedBoundaryStage')):
        fail('Reviewed boundary continuation requires both job and stage')
    if operation == 'uv' and bool(result.get('planJobId')) != bool(result.get('planSha256')):
        fail('UV requires both planJobId and confirmed planSha256')
    if operation == 'uv' and result.get('annularSeamPlan') and (
            result['seamStrategy'] != 'coherent' or any(result.get(key) for key in
                ('planJobId', 'segmentationEvidence', 'highGuidedEvidence'))):
        fail('Annular seams require direct coherent UV without a second seam plan')
    return result

def preflight_glb_layout(path, role):
    if path.suffix.lower() != '.glb':
        return
    from native3d_glb_layout import GLBLayoutError, read_glb_document, validate_glb_layout
    try:
        validate_glb_layout(read_glb_document(path))
    except GLBLayoutError as exc:
        raise StoreError(exc.code, str(exc), 422, {**exc.details, 'inputRole': role}) from exc
    except (ValueError, TypeError, AttributeError) as exc:
        raise StoreError('NATIVE3D_GLB_INVALID', str(exc), 422, {'inputRole': role}) from exc


def fail(message, status=400, code='BAD_REQUEST'):
    raise StoreError(code, message, status)

def atomic(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)

def accepted_source_lod_stage(record):
    audit=record.get('receipt',{}).get('geometry',{})
    fidelity=record.get('receipt',{}).get('fidelity',{})
    return (record.get('status')=='accepted' and record.get('visible') is True and record.get('eligibleForDownstream') is True
            and audit.get('status')=='accepted' and audit.get('intersectionComplete') is True
            and audit.get('intersection_pairs_count')==0 and fidelity.get('accepted') is True
            and record.get('mesh_hash')==audit.get('mesh_hash'))

class Native3DJobs:
    def __init__(self, root, store, config_path=None, engine_path=None, autostart=True, gpu_leases=None, gpu_device=physical_device):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.store = store
        self.config_path = Path(config_path or self.root.parent / 'native3d-config.json')
        self.engine_path = Path(engine_path or Path(__file__).with_name('native3d_engine.py')).resolve()
        self.lock = threading.RLock()
        self.preview_lock = threading.Lock()
        self.gpu_leases = gpu_leases
        self.gpu_device = gpu_device
        self.wake = threading.Event()
        self.stopping = False
        self.process = None
        self.active = None
        self.jobs = {}
        self._probe_cache = {}
        self.recovery_warnings = []
        for manifest in self.root.glob('n3d_*/manifest.json'):
            try:
                if manifest.is_symlink() or manifest.parent.is_symlink() or manifest.stat().st_size > 4 * 1024**2:
                    raise ValueError('Unsafe manifest')
                job = json.loads(manifest.read_text(encoding='utf-8'))
                if not isinstance(job, dict) or job.get('id') != manifest.parent.name or not re.fullmatch(r'n3d_[a-f0-9]{32}', job['id']):
                    raise ValueError('Invalid job identity')
                if not all(isinstance(job.get(key), str) for key in ('projectId','nodeId','opId','fingerprint','status')) or not isinstance(job.get('source'), dict) or not isinstance(job.get('parameters'), dict):
                    raise ValueError('Invalid job manifest')
                if job['status'] not in TERMINAL:
                    if job.get('gpu', {}).get('state') == 'held':
                        job['gpu']['state'] = 'reconciling'
                    elif job.get('gpu', {}).get('state') == 'waiting':
                        job.pop('gpu')
                    job.update(status='failed', stage='interrupted', error='Service restarted; explicitly resubmit interrupted job with a new opId.')
                    atomic(manifest, job)
                self.jobs[job['id']] = job
            except (OSError, ValueError, KeyError, TypeError, RecursionError):
                # Preserve the original for manual recovery; never rerun unknown expensive work.
                self.recovery_warnings.append('Unreadable persisted job manifest retained for manual recovery: ' + manifest.parent.name[:80])
        self.thread = None
        if autostart:
            self.thread = threading.Thread(target=self._loop, daemon=True, name='native3d-queue')
            self.thread.start()

    def config(self):
        try:
            if self.config_path.is_file() and self.config_path.stat().st_size > 65536:
                raise ValueError('Oversized configuration')
            config = json.loads(self.config_path.read_text(encoding='utf-8')) if self.config_path.is_file() else {}
            if not isinstance(config, dict) or not isinstance(config.get('adapterConfig', {}), dict):
                raise ValueError('Invalid configuration object')
            python = os.environ.get('H3_NATIVE3D_PYTHON') or config.get('pythonExecutable', '')
            if not isinstance(python, str):
                raise ValueError('Invalid Python executable')
            timeout = config.get('timeoutSeconds', 900)
            if type(timeout) is not int or not 1 <= timeout <= 3600:
                raise ValueError('Invalid timeoutSeconds (expected 1..3600)')
            config['pythonExecutable'] = python
            return config
        except (OSError, ValueError, TypeError, RecursionError):
            return {'pythonExecutable':'', 'configurationError':'native3d-config.json is malformed; repair the local configuration object and absolute Python executable path.'}

    def _probe(self, python, modules, env=None):
        key = (python, tuple(modules), env.get('PYTHONPATH') if env else None)
        cached = self._probe_cache.get(key)
        if cached and time.monotonic() - cached[0] < 30:
            return cached[1]
        script = "import importlib.util,json; print(json.dumps([m for m in " + repr(list(modules)) + " if importlib.util.find_spec(m) is None]))"
        try:
            result = subprocess.run([python, '-c', script], capture_output=True, text=True,
                                    timeout=8, env=env, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            missing = json.loads(result.stdout) if result.returncode == 0 else ['Python dependency probe failed']
            missing = ['Missing dependency: ' + str(item) for item in missing]
        except (OSError, ValueError, subprocess.TimeoutExpired):
            missing = ['Independent Python dependency probe failed']
        self._probe_cache[key] = (time.monotonic(), missing)
        return missing

    @staticmethod
    def _comfy_python(python):
        path = python.resolve()
        # Match interpreter environments, never the name of an ancestor checkout.
        # A distinct venv can legitimately live inside a ComfyUI portable folder.
        environment = path.parent.parent if path.parent.name.lower() in {'scripts', 'bin'} else path.parent
        if path.parent.name.lower() in {'python_embeded', 'python_embedded'}:
            return True
        for marker in (environment, environment.parent):
            if (marker / 'main.py').is_file() and (marker / 'custom_nodes').is_dir():
                return True
        return False

    def capabilities(self):
        config = self.config()
        python = config['pythonExecutable']
        missing = [config['configurationError']] if config.get('configurationError') else []
        if not python or not Path(python).is_absolute() or not Path(python).is_file():
            missing.append('Configure independent Python via H3_NATIVE3D_PYTHON or native3d-config.json pythonExecutable')
        elif self._comfy_python(Path(python)):
            missing.append('ComfyUI Python is not an independent native3D environment')
        if not self.engine_path.is_file():
            missing.append('native3d_engine.py is missing')
        adapter = config.get('adapterConfig') or {}
        ai_missing = list(missing)
        for key in ('meshanythingRuntime', 'checkpoint', 'pythonExecutable', 'mesh2sdfPythonExecutable', 'mesh2sdfCorePath'):
            value = adapter.get(key)
            if not isinstance(value, str) or not Path(value).is_absolute() or not (Path(value).is_dir() if key == 'meshanythingRuntime' else Path(value).is_file()):
                ai_missing.append('MeshAnything adapterConfig.' + key + ' is missing')
        runtime = adapter.get('meshanythingRuntime')
        if isinstance(runtime, str) and not (Path(runtime) / 'load_cpu.py').is_file():
            ai_missing.append('MeshAnything runtime load_cpu.py is missing')
        if not re.fullmatch(r'[a-fA-F0-9]{64}', str(adapter.get('checkpointSha256', ''))):
            ai_missing.append('MeshAnything checkpointSha256 must identify trusted weights')
        if not re.fullmatch(r'[a-fA-F0-9]{64}', str(adapter.get('mesh2sdfCoreSha256', ''))):
            ai_missing.append('MeshAnything mesh2sdfCoreSha256 must identify the trusted official MC256 extension')
        image_cfg = config.get('imageTo3D')
        image_missing = configuration_errors(image_cfg)
        if not self.engine_path.is_file():
            image_missing.append('native3d_engine.py is missing')
        if not image_missing:
            image_python = image_cfg['pythonExecutable']
            if self._comfy_python(Path(image_python)):
                image_missing.append('请为 TripoSR 配置独立 Python。')
            else:
                image_missing.extend(self._probe(image_python, TRIPOSR_MODULES, worker_env(image_cfg)))
        dependency_missing = {}
        for op in OPERATIONS:
            if op == 'image_to_3d':
                dependency_missing[op] = image_missing
                continue
            modules = ['numpy','trimesh','PIL','fast_simplification','psutil']
            if op == 'ai_lowpoly': modules += ['skimage','open3d']
            if op == 'uv': modules += ['xatlas','open3d','scipy','igl']
            if op in ('bake','repair_lod','source_lod','uv_plan'): modules += ['open3d','scipy']
            dependency_missing[op] = list(ai_missing if op == 'ai_lowpoly' else missing)
            if not missing:
                dependency_missing[op] += self._probe(python, modules)
            if op == 'ai_lowpoly' and not ai_missing:
                dependency_missing[op] += self._probe(adapter['pythonExecutable'], ['torch','numpy','trimesh'])
                dependency_missing[op] += self._probe(adapter['mesh2sdfPythonExecutable'], ['numpy'])
        try:
            from native3d_partfield import readiness as partfield_readiness
            partfield = partfield_readiness(config.get('partfieldConfig', {}))
        except (ImportError, OSError, ValueError) as exc:
            partfield = {'ready':False, 'reason':str(exc)}
        if not partfield['ready']:
            dependency_missing['uv_plan'].append(partfield['reason'])
        ai_missing = dependency_missing['ai_lowpoly']
        operations = {op: {'ready': not dependency_missing[op],
                           'missing': dependency_missing[op],
                           'reason': '; '.join(dependency_missing[op]),
                           'parameters': {'type':'object','properties':SCHEMAS[op],'required':[], 'additionalProperties':False}}
                      for op in OPERATIONS}
        try:
            fbx = fbx_capabilities()
        except (ValueError, OSError) as exc:
            fbx = {'available': False, 'reason': str(exc)}
        return {'ready': operations['analyze']['ready'], 'missing': dependency_missing['analyze'], 'operations': operations,
                'adapters': [{'id': ADAPTER_ID, 'label':'MeshAnything V2 (local)', 'preset':copy.deepcopy(AI_LOWPOLY_PRESET), 'operation':'ai_lowpoly',
                              'ready':not ai_missing, 'reason':'; '.join(ai_missing), 'missing':ai_missing,
                              'parameters':operations['ai_lowpoly']['parameters']}],
                'partfield':partfield, 'recoveryWarnings': list(self.recovery_warnings), 'evidence': 'declared',
                'sourceFormats': ['.glb', '.obj'] + (['.fbx'] if fbx.get('available') else []),
                'formatCapabilities': {'fbx': fbx}, 'maxSourceBytes': MAX_SOURCE}

    def _persist(self, job):
        job['updatedAt'] = time.time()
        atomic(self.root / job['id'] / 'manifest.json', job)

    def _geometry_origin(self, sha, visited=None):
        """Resolve server-owned output hashes, independent of mutable canvas nodes."""
        visited=set() if visited is None else visited
        if sha in visited:return 'blocked'
        visited=visited|{sha}
        matches=[]
        for prior in self.jobs.values():
            if prior.get('status')!='succeeded':continue
            result=prior.get('result',{})
            for entry in result.get('files',[]):
                if entry.get('role') not in ('model','proxy','export') or Path(entry.get('name','')).suffix.lower() not in ('.glb','.obj','.fbx'):continue
                digest=entry.get('sha256')
                if not digest:
                    try:
                        file=self._safe_file(prior['id'],entry['name'])
                        if file.stat().st_size>MAX_SOURCE:continue
                        h=hashlib.sha256()
                        with file.open('rb') as stream:
                            while chunk:=stream.read(1024*1024):h.update(chunk)
                        digest=entry['sha256']=h.hexdigest()
                    except (OSError,ValueError,StoreError):continue
                if digest==sha:matches.append((prior,entry))
        # A byte-identical preview is the very same model artifact, not
        # contradictory negative evidence about its proven geometry.
        matches=[(prior,entry) for prior,entry in matches
                 if entry.get('role')!='proxy' or not any(p is prior and e.get('role')=='model' for p,e in matches)]
        decisions=[]
        for prior,entry in matches:
            operation=prior.get('operation');geometry=prior.get('result',{}).get('metadata',{}).get('geometry',{})
            if operation=='source_lod':
                stages=geometry.get('stages',[])
                selected=geometry.get('selectedLodLevel')
                name=entry.get('name','')
                stage_name=(geometry.get('selectedStage') or ('lod'+str(selected))) if entry.get('role')=='model' else Path(name).stem
                proven=(re.fullmatch(r'lod[0-4]',stage_name)
                        and any(s.get('stage')==stage_name and accepted_source_lod_stage(s) for s in stages)
                        and (entry.get('role')=='model' or (entry.get('role')=='export' and name==stage_name+'.glb')))
                # A historical whole-chain failure is not negative evidence
                # about an individually audited stage with identical bytes.
                decisions.append('accepted' if proven and geometry.get('status')=='accepted' else 'external' if proven else 'blocked')
            elif operation=='repair_lod':
                selected=geometry.get('selectedLod')
                stages=geometry.get('stages',[])
                valid=geometry.get('status')=='accepted' and type(selected) is int and any(s.get('stage')=='lod_'+str(selected) and s.get('mesh_hash') for s in stages)
                # Only fitted/LOD stages of an accepted chain qualify, never raw or repair previews.
                selected_file=entry.get('role')=='model' or entry.get('name')=='lod_'+str(selected)+'.glb'
                stage_name=Path(entry.get('name','')).stem
                accepted_stage=(entry.get('role')=='export' and entry.get('name')==stage_name+'.glb'
                    and re.fullmatch(r'fit|lod_[1-9][0-9]{0,5}',stage_name)
                    and any(s.get('stage')==stage_name and s.get('filename')==entry.get('name') and s.get('mesh_hash') for s in stages))
                decisions.append('accepted' if valid and (selected_file or accepted_stage) else 'blocked')
            elif operation=='ai_lowpoly':decisions.append('blocked')
            elif operation in ('uv','bake','analyze'):
                parent=prior.get('source',{}).get('sha256')
                origin=self._geometry_origin(parent,visited) if parent and parent!=sha else 'external'
                if origin=='external' and operation in ('uv','bake') and prior.get('parameters',{}).get('externalGeometryReviewed'):
                    origin='accepted'
                decisions.append(origin)
        if 'blocked' in decisions:return 'blocked'
        if 'accepted' in decisions:return 'accepted'
        return 'external'

    def get(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                fail('Native3D job not found', 404, 'NOT_FOUND')
            return copy.deepcopy(self.jobs[job_id])

    def list(self, project_id):
        self.store.get(project_id)
        with self.lock:
            return [copy.deepcopy(job) for job in self.jobs.values() if job['projectId'] == project_id]

    def submission_status(self, project_id, node_id, op_id, bridge):
        with self.lock:
            for job in self.jobs.values():
                if (job['projectId'], job['nodeId'], job['opId']) == (project_id, node_id, op_id):
                    return {'job': copy.deepcopy(job)}
            saved = self.store.get(project_id)
            node = next((n for n in saved['canvas']['nodes'] if n['id'] == node_id and n['type'] == 'native3d'), None)
            run = node['data'].get('nativeRun') if node else None
            proof = run.get('page') if isinstance(run, dict) and run.get('opId') == op_id else None
            if bridge is not None and isinstance(proof, dict) and isinstance(proof.get('sessionId'), str):
                with bridge.lock:
                    bridge._expire()
                    if proof.get('epoch') != bridge.epoch or proof['sessionId'] not in bridge.sessions:
                        return {'status': 'not_submitted'}
            return {'status': 'pending'}

    def _canvas_source_records(self, document, asset_path):
        """Include historical inline outputs; their canvas labels cannot grant quality."""
        for node in document.get('canvas', {}).get('nodes', document.get('nodes', [])):
            data = node.get('data', {})
            if asset_path in (data.get('assetPath'), data.get('resultAssetPath')):
                yield data
            records = data.get('nativeOutputRecords', [])
            if not isinstance(records, list):
                continue
            for record in records:
                output = record.get('data', {}) if isinstance(record, dict) else {}
                if not isinstance(output, dict) or asset_path not in (output.get('assetPath'), output.get('resultAssetPath')):
                    continue
                job_id = record.get('jobId')
                prior = self.jobs.get(job_id) if isinstance(job_id, str) else None
                if (type(record.get('schemaVersion')) is not int or record['schemaVersion'] != 1
                        or not isinstance(record.get('recordId'), str) or not record['recordId']
                        or record.get('jobId') != output.get('sourceJobId')
                        or output.get('sourceNodeId') != node.get('id') or output.get('operation') != 'analyze'
                        or not prior or prior.get('projectId') != document.get('id')
                        or prior.get('nodeId') != node.get('id') or prior.get('status') != 'succeeded'
                        or not isinstance(output.get('metadata'), dict)
                        or output['metadata'].get('operation') != prior.get('operation')):
                    fail('Inline source output identity is invalid', 409, 'GEOMETRY_BLOCKED')
                match = re.fullmatch(r'assets/([a-f0-9]{64})\.(glb|obj|fbx)', asset_path)
                if not match or not any(entry.get('sha256') == match[1]
                        and entry.get('role') in ('model', 'export')
                        and Path(entry.get('name', '')).suffix.lower() == '.' + match[2]
                        for entry in prior.get('result', {}).get('files', [])):
                    fail('Inline source is not a recorded job output', 409, 'GEOMETRY_BLOCKED')
                yield output

    def submit(self, payload, *, canvas_submission=None):
        if not isinstance(payload, dict) or set(payload) - {'opId','projectId','nodeId','operation','source','parameters','adapterId'}:
            fail('Unknown job fields')
        for key in ('opId','projectId','nodeId'):
            if not isinstance(payload.get(key), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', payload[key]):
                fail('Invalid ' + key)
        if payload.get('operation') not in OPERATIONS:
            fail('Unsupported operation')
        if payload.get('adapterId', ADAPTER_ID) != ADAPTER_ID:
            fail('Unsupported adapterId')
        source = payload.get('source')
        if not isinstance(source, dict) or set(source) - {'assetPath', 'sha256', 'highAssetPath', 'highSha256'} or not isinstance(source.get('assetPath'), str) or len(source['assetPath']) > 512:
            fail('Invalid source asset')
        parameters = validate_parameters(payload['operation'], payload.get('parameters', {}))
        try:
            encoded = json.dumps(payload, sort_keys=True, allow_nan=False)
        except (ValueError, TypeError):
            fail('Invalid JSON parameters')
        if len(encoded.encode()) > 65536:
            fail('Job request exceeds 64 KiB')
        fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
        page, proof, live_page = canvas_submission or (None, None, None)
        with self.lock:
            for job in self.jobs.values():
                if job['projectId'] == payload['projectId'] and job['opId'] == payload['opId']:
                    if job['fingerprint'] != fingerprint:
                        fail('opId already used with different payload', 409, 'OP_ID_CONFLICT')
                    if page is not None and job.get('canvasSubmission') != page:
                        fail('Job does not belong to this canvas submission', 409, 'NATIVE3D_CANVAS_MISMATCH')
                    return copy.deepcopy(job)
            document = self.store.get(payload['projectId'])
            if page is not None:
                check_saved_submission(document, payload, encoded, page, proof, self.jobs.get)
            if payload['operation'] in ('uv_plan','uv','bake'):
                for data in self._canvas_source_records(document, source['assetPath']):
                    geometry=data.get('metadata',{}).get('geometry',{})
                    if (data.get('nativeGeometryProvenance') or geometry) and geometry.get('status') != 'accepted' and not parameters.get('reviewedBoundaryJobId'):
                        fail('Geometry repair/LOD result is blocked or unaccepted',409,'GEOMETRY_BLOCKED')
            if not any(asset['path'] == source['assetPath'] for asset in document.get('assets', [])):
                fail('Source is not a registered project asset')
            path = self.store.asset_file(payload['projectId'], source['assetPath'])
            image_input = payload['operation'] == 'image_to_3d'
            if image_input:
                if source.get('highAssetPath') or path.suffix.lower() not in IMAGE_SUFFIXES or path.stat().st_size > MAX_IMAGE_BYTES:
                    fail('图生模型只接受小于 32 MiB 的 PNG、JPEG 或 WebP 项目素材。')
            else:
                if path.suffix.lower() not in {'.glb','.obj','.fbx'}:
                    fail('Only GLB, OBJ and bounded static FBX sources are supported')
                if path.stat().st_size > MAX_SOURCE:
                    fail('Source exceeds 512 MiB')
                preflight_glb_layout(path, "model")
            readiness = self.capabilities()
            if path.suffix.lower() == '.fbx' and '.fbx' not in readiness.get('sourceFormats', []):
                fail('Pinned local FBX converter is unavailable', 503, 'NATIVE3D_FBX_NOT_READY')
            operation_ready = readiness['operations'][payload['operation']]
            if not operation_ready['ready']:
                fail(operation_ready['reason'], 503, 'NATIVE3D_NOT_READY')
            job_id = 'n3d_' + uuid.uuid4().hex
            directory = self.root / job_id
            directory.mkdir()
            try:
                snapshot = directory / ('source' + path.suffix.lower())
                digest = hashlib.sha256()
                total = 0
                with path.open('rb') as src, snapshot.open('xb') as dst:
                    while chunk := src.read(1024 * 1024):
                        total += len(chunk)
                        if total > (MAX_IMAGE_BYTES if image_input else MAX_SOURCE):
                            fail('Source exceeds the configured size limit')
                        digest.update(chunk)
                        dst.write(chunk)
                sha = digest.hexdigest()
                if payload['operation'] in ('uv_plan','uv','bake'):
                    origin=self._geometry_origin(sha)
                    if not parameters.get('reviewedBoundaryJobId') and (origin=='blocked' or (origin=='external' and not parameters.get('externalGeometryReviewed'))):
                        fail('Known AI/stage geometry requires accepted selected-LOD provenance; external geometry requires explicit manual review',409,'GEOMETRY_BLOCKED')
                registered = next(asset for asset in document['assets'] if asset['path'] == source['assetPath'])
                if registered.get('sha256') != sha or (source.get('sha256') and source['sha256'] != sha):
                    fail('Source SHA256 mismatch', 409, 'SOURCE_CHANGED')
                job = {**copy.deepcopy(payload), 'parameters': parameters, 'id': job_id,
                       'fingerprint': fingerprint, 'status':'queued', 'stage':'queued', 'progress':0,
                       'source':{**source, 'sha256':sha}, 'createdAt':time.time()}
                if page is not None:
                    job['canvasSubmission'] = page.copy()
                config = self.config()
                request = {**copy.deepcopy(job), 'sourcePath':str(snapshot), 'adapterConfig':config.get('adapterConfig', {})}
                if parameters.get('reviewedBoundaryJobId') and not source.get('highAssetPath'):
                    fail('Reviewed geometry requires exact original high asset')
                high = source.get('highAssetPath')
                if payload['operation'] in ('bake','repair_lod','uv_plan') and not high:
                    fail(payload['operation']+' requires source.highAssetPath')
                if high:
                    if not isinstance(high, str) or len(high) > 512 or not any(asset['path'] == high for asset in document.get('assets', [])):
                        fail('High source is not a registered project asset')
                    high_path = self.store.asset_file(payload['projectId'], high)
                    if high_path.suffix.lower() not in set(readiness.get('sourceFormats', ['.glb','.obj'])) or high_path.stat().st_size > MAX_SOURCE:
                        fail('Invalid high source format or size')
                    if high_path != path:
                        preflight_glb_layout(high_path, 'high')
                    high_snapshot = directory / ('high-source' + high_path.suffix.lower())
                    high_digest = hashlib.sha256()
                    high_total = 0
                    with high_path.open('rb') as src, high_snapshot.open('xb') as dst:
                        while chunk := src.read(1024*1024):
                            high_total += len(chunk)
                            if high_total > MAX_SOURCE:
                                fail('High source exceeds 512 MiB')
                            high_digest.update(chunk)
                            dst.write(chunk)
                    high_registered = next(asset for asset in document['assets'] if asset['path'] == high)
                    if high_registered.get('sha256') != high_digest.hexdigest() or (source.get('highSha256') and source['highSha256'] != high_digest.hexdigest()):
                        fail('High source SHA256 mismatch', 409, 'SOURCE_CHANGED')
                    job['source']['highSha256'] = high_digest.hexdigest()
                    request['source'] = copy.deepcopy(job['source'])
                    request['highSourcePath'] = str(high_snapshot)
                if parameters.get('reviewedBoundaryJobId'):
                    from native3d_geometry_review import freeze_boundary_review
                    request['geometryReview']=freeze_boundary_review(self,payload['projectId'],job['source'],parameters,payload['operation'])
                if payload['operation'] == 'uv_plan':
                    request['partfieldConfig'] = copy.deepcopy(config.get('partfieldConfig', {}))
                    request['partfieldConfig']['cacheRoot'] = str(self.root.parent / 'partfield-cache' / job['source']['highSha256'])
                    # Submitting this operation is the execution intent; the fixed
                    # worker still checks its lock, queues, occupancy and memory.
                    request['partfieldConfig']['gpuAuthorized'] = True
                if payload['operation'] == 'uv' and parameters.get('planJobId'):
                    request['uvPlanPath'] = str(self._snapshot_plan(job, directory))
                if payload['operation']=='source_lod' and parameters.get('localRepairJobId'):
                    from native3d_lod_repair import freeze_repair_context
                    request['sourceLodLocalRepair'] = freeze_repair_context(self, job, directory)
                if payload['operation']=='source_lod' and parameters.get('retryJobId'):
                    from native3d_lod_retry import validate_retry_context
                    request['sourceLodRetry'] = validate_retry_context(self, job)
                if image_input:
                    config = {**config, 'pythonExecutable':config['imageTo3D']['pythonExecutable']}
                    request['imageTo3D'] = copy.deepcopy(config['imageTo3D'])
                if payload['operation'] == 'material_wear':
                    from native3d_material_wear import freeze_wear
                    request['materialWear'] = freeze_wear(self, job, directory)
                if payload['operation']=='bake' and parameters.get('padding',0)>0:
                    from native3d_bake_padding import freeze_padding_reuse
                    try:
                        reuse=freeze_padding_reuse(self,job,directory)
                    except ValueError as exc:
                        fail(str(exc),409,'BAKE_PADDING_REUSE_CHANGED')
                    if reuse is not None:request['bakePaddingReuse']=reuse
                atomic(directory / 'request.json', request)
                atomic(directory / 'runtime.json', config)
                if page is None:
                    self._admit(job)
                else:
                    project_id = payload['projectId']
                    project_path = self.store._project_path(project_id)
                    with self.store._guard(project_path):
                        self.store._require_writable(project_path)
                        check_saved_submission(self.store.get(project_id), payload, encoded, page, proof, self.jobs.get)
                        with live_page():
                            self._admit(job)
            except Exception:
                shutil.rmtree(directory)
                raise
            self.wake.set()
            return copy.deepcopy(job)

    def _admit(self, job):
        self._persist(job)
        self.jobs[job["id"]] = job

    def _snapshot_plan(self, job, directory):
        """Only immutable, same-project registered plan artifacts enter a worker."""
        params=job['parameters']
        prior=self.jobs.get(params['planJobId'])
        if not prior or prior.get('projectId')!=job['projectId'] or prior.get('operation')!='uv_plan' or prior.get('status')!='succeeded':
            fail('A completed same-project UV plan is required',409,'UV_PLAN_STALE')
        for key in ('sha256','highSha256'):
            if not job['source'].get(key) or prior.get('source',{}).get(key)!=job['source'][key]:
                fail('UV plan source changed; preview and confirm again',409,'UV_PLAN_STALE')
        summary=prior.get('result',{}).get('metadata',{}).get('uvPlan',{})
        if summary.get('planSha256')!=params['planSha256']:
            fail('Confirmed UV plan hash changed',409,'UV_PLAN_STALE')
        for key in (set(SCHEMAS['uv_plan']) & set(SCHEMAS['uv'])) - {'externalGeometryReviewed'}:
            # Historic plans lack the v2 structural settings. Their previously
            # implicit UV defaults remain compatible; new explicit settings
            # cannot silently alter an already-confirmed legacy plan.
            changed = (params.get(key)!=prior['parameters'][key]) if key in prior['parameters'] else (
                key in params and params[key]!=SCHEMAS['uv'][key].get('default'))
            if changed:
                fail('UV settings changed; preview and confirm again: '+key,409,'UV_PLAN_STALE')
        if params.get('segmentationEvidence') or params.get('highGuidedEvidence'):
            fail('Frozen plan cannot be combined with external seam evidence')
        folder=directory/'uv-plan'
        folder.mkdir()
        found=False
        for entry in prior['result'].get('files',[]):
            if entry.get('role') not in ('plan','evidence'):continue
            source=self.output_file(prior['id'],entry['name'])
            target=folder/source.name
            digest=hashlib.sha256()
            with source.open('rb') as src,target.open('xb') as dst:
                while chunk:=src.read(1024*1024):
                    digest.update(chunk);dst.write(chunk)
            if digest.hexdigest()!=entry.get('sha256'):
                fail('UV plan artifact changed',409,'UV_PLAN_STALE')
            found=found or source.name=='uv-plan.json'
        if not found:fail('UV plan manifest missing',409,'UV_PLAN_STALE')
        return folder/'uv-plan.json'

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                fail('Native3D job not found', 404, 'NOT_FOUND')
            if job['status'] not in TERMINAL:
                if job.get('gpu', {}).get('state') == 'waiting':
                    job.pop('gpu')
                job.update(status='cancelled', stage='cancelled')
                self._persist(job)
                if self.active == job_id and self.process and self.process.poll() is None:
                    self._terminate_owned(self.process)
            return copy.deepcopy(job)

    def _terminate_owned(self, process):
        # This Popen belongs exclusively to this queue; no process names/global scans.
        if process.poll() is not None:
            return
        try:
            children = psutil.Process(process.pid).children(recursive=True) if psutil else []
        except Exception:
            children = []
        for child in children:
            try:
                child.terminate()
            except Exception:
                pass
        if process.poll() is None:
            try:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=5, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                else:
                    process.terminate()
            except (OSError, subprocess.TimeoutExpired):
                if process.poll() is None:
                    process.kill()
        threading.Thread(target=self._reap_cancelled, args=(process, children), daemon=True).start()

    @staticmethod
    def _reap_cancelled(process, children):
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        _, alive = psutil.wait_procs(children, timeout=1) if psutil else ([], [])
        for child in alive:
            try:
                child.kill()
            except Exception:
                pass

    def output_file(self, job_id, name):
        job = self.get(job_id)
        if job['status'] != 'succeeded' or not any(f['name'] == name for f in job.get('result', {}).get('files', [])):
            fail('Result file not found', 404, 'NOT_FOUND')
        return self._safe_file(job_id, name)

    def diagnostic_preview(self, job_id, mode, project_id, node_id):
        """Read only named rejected-UV evidence; never register a model result."""
        if mode not in ('layout','checker'):
            fail('Invalid diagnostic preview mode')
        job=self.get(job_id)
        if (job.get('projectId')!=project_id or job.get('nodeId')!=node_id or
            job.get('operation')!='uv' or job.get('status')!='failed'):
            fail('Diagnostic requires the same project/node failed UV job',409,'UV_DIAGNOSTIC_BLOCKED')
        self.store.get(project_id)
        root=self.root/job_id/'output'
        if root.is_symlink() or root.parent.is_symlink() or root.resolve().parent!=(self.root/job_id).resolve():
            fail('Unsafe UV diagnostic path')
        report=self._safe_file(job_id,'uv-rejected-report.json')
        if report.stat().st_size>8*1024*1024:fail('UV diagnostic report too large')
        try:proof=json.loads(report.read_text(encoding='utf-8'))
        except (ValueError,UnicodeError,OSError):fail('Invalid rejected UV diagnostic report')
        if not isinstance(proof,dict) or proof.get('acceptedUV') is not False or proof.get('bakeAllowed') is not False or proof.get('status')!='rejected_needs_review':
            fail('UV diagnostic evidence must remain rejected',409,'UV_DIAGNOSTIC_BLOCKED')
        name={'layout':'uv-rejected-atlas.png','checker':'uv-rejected-checker.png'}[mode]
        if not (root/name).exists():fail('Diagnostic preview not available',404,'NOT_FOUND')
        image=self._safe_file(job_id,name)
        if not 67<=image.stat().st_size<=8*1024*1024:fail('Invalid UV diagnostic image size')
        with image.open('rb') as stream:
            signature=stream.read(8);stream.seek(-12,2);ending=stream.read(12)
        if signature!=b'\x89PNG\r\n\x1a\n' or ending!=b'\x00\x00\x00\x00IEND\xaeB`\x82':fail('Invalid UV diagnostic PNG')
        return image

    def stage_preview(self, job_id, stage, diagnostic=False):
        """Cache a bounded real-stage poster, never write a project document."""
        if not isinstance(stage, str) or not re.fullmatch(r'fit|lod_[1-9][0-9]{0,5}|lod[0-4]', stage):
            fail('Invalid preview stage')
        job = self.get(job_id)
        geometry = job.get('result', {}).get('metadata', {}).get('geometry', {})
        records = [s for s in geometry.get('stages', []) if s.get('stage') == stage]
        if type(diagnostic) is not bool:fail('Invalid diagnostic flag')
        record=records[0] if len(records)==1 else {}
        name = record.get('diagnosticFilename' if diagnostic else 'filename','')
        pattern=r'blocked_lod[0-4]\.glb' if diagnostic else r'(fit|lod_[1-9][0-9]{0,5}|lod[0-4])\.glb'
        if not isinstance(name,str) or not re.fullmatch(pattern,name):
            fail('Stage has no supported registered model',409,'GEOMETRY_BLOCKED')
        entries = [f for f in job.get('result', {}).get('files', []) if f.get('name') == name and f.get('role') == 'export']
        if (job.get('operation') not in ('repair_lod','source_lod') or len(records) != 1 or len(entries) != 1
                or (not diagnostic and geometry.get('status') != 'accepted')):
            fail('Preview requires an accepted recorded LOD stage', 409, 'GEOMETRY_BLOCKED')
        if diagnostic:
            if (job.get('operation')!='source_lod' or job.get('status')!='succeeded' or record.get('status')!='blocked'
                    or record.get('eligibleForDownstream') is not False or name!='blocked_'+stage+'.glb'):
                fail('Diagnostic preview requires a recorded blocked LOD',409,'GEOMETRY_BLOCKED')
        elif job.get('operation')=='source_lod' and not accepted_source_lod_stage(records[0]):
            fail('Preview requires complete accepted stage evidence',409,'GEOMETRY_BLOCKED')
        source = self.output_file(job_id, name)
        if source.stat().st_size > 16 * 1024**2:
            fail('LOD preview source exceeds bounded limit')
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if entries[0].get('sha256') != digest:
            fail('LOD preview source SHA256 changed', 409, 'SOURCE_CHANGED')
        if diagnostic and record.get('diagnosticFileSha256')!=digest:
            fail('Diagnostic LOD SHA256 changed',409,'SOURCE_CHANGED')
        with self.preview_lock:
            folder = self.root / job_id / 'stage-previews'
            if folder.is_symlink() or (folder.exists() and folder.resolve().parent != (self.root / job_id).resolve()):
                fail('Unsafe preview cache')
            folder.mkdir(exist_ok=True)
            detail=record.get('receipt',{}).get('geometry',{}) if diagnostic else None
            evidence_digest=hashlib.sha256(json.dumps(detail,sort_keys=True).encode()).hexdigest() if diagnostic else ''
            target = folder / (digest + ('-diagnostic-'+evidence_digest+'-v2.png' if diagnostic else '-v1.png'))
            if target.is_symlink(): fail('Unsafe preview cache')
            def cached_png_valid():
                if not target.is_file() or not 67 <= target.stat().st_size <= 8*1024**2: return False
                with target.open('rb') as stream:
                    signature = stream.read(8)
                    stream.seek(-12, 2)
                    ending = stream.read(12)
                return signature == b'\x89PNG\r\n\x1a\n' and ending == b'\x00\x00\x00\x00IEND\xaeB`\x82'
            if not cached_png_valid():
                python = self.config().get('pythonExecutable', '')
                if not Path(python).is_file(): fail('Native3D Python unavailable', 503, 'NATIVE3D_NOT_READY')
                try:
                    extra=['--max-faces','100000'] if job.get('operation')=='source_lod' else []
                    if diagnostic:
                        evidence_path=folder/(evidence_digest+'-diagnostic.json')
                        if evidence_path.is_symlink():fail('Unsafe diagnostic preview evidence')
                        atomic(evidence_path,{'stage':stage,'meshSha256':digest,'geometryHash':record.get('mesh_hash'),'triangles':detail.get('triangles'),
                            'intersection_pairs':detail.get('intersection_pairs',[]),
                            'intersectionComplete':detail.get('intersectionComplete',False)})
                        extra+=['--diagnostic',str(evidence_path)]
                    result = subprocess.run([python, str(Path(__file__).with_name('native3d_preview.py')), '--source', str(source), '--output', str(target)]+extra,
                        capture_output=True, text=True, timeout=120 if extra else 40, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                except (OSError, subprocess.TimeoutExpired) as exc:
                    fail('LOD preview renderer unavailable: ' + type(exc).__name__, 503, 'PREVIEW_FAILED')
                if result.returncode or not cached_png_valid():
                    fail('LOD preview rendering failed', 503, 'PREVIEW_FAILED')
            return target

    def lod_issues(self, job_id, stage, image=False):
        """Read immutable final-stage evidence; cache only a bounded static board."""
        from native3d_lod_issues import issue_summary
        if not isinstance(stage,str) or not re.fullmatch(r'lod[0-4]',stage):fail('Invalid issue stage')
        job=self.get(job_id)
        records=[r for r in job.get('result',{}).get('metadata',{}).get('geometry',{}).get('stages',[]) if r.get('stage')==stage]
        if job.get('operation')!='source_lod' or job.get('status')!='succeeded' or len(records)!=1:fail('No final diagnostic stage',409,'GEOMETRY_BLOCKED')
        record=records[0];name='blocked_'+stage+'.glb'
        if record.get('status')!='blocked' or record.get('eligibleForDownstream') is not False or record.get('diagnosticFilename')!=name:fail('No blocked diagnostic model',409,'GEOMETRY_BLOCKED')
        files=[f for f in job.get('result',{}).get('files',[]) if f.get('name')==name and f.get('role')=='export']
        source=self.output_file(job_id,name)
        if len(files)!=1 or source.stat().st_size>16*1024**2:fail('Invalid diagnostic model budget')
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        if digest!=files[0].get('sha256') or digest!=record.get('diagnosticFileSha256'):fail('Diagnostic model changed',409,'SOURCE_CHANGED')
        try:summary=issue_summary(job,stage,record,digest)
        except (ValueError,TypeError,KeyError):fail('Final diagnostic evidence mismatch',409,'SOURCE_CHANGED')
        summary['imageUrl']=f'/api/native3d/jobs/{job_id}/issues/{stage}/image'
        if not image:return summary
        evidence={'summary':summary,'geometry':record.get('receipt',{}).get('geometry',{}),'markers':record.get('receipt',{}).get('boundaryIssueMarkers')}
        key=hashlib.sha256(json.dumps(evidence,sort_keys=True).encode()).hexdigest()
        with self.preview_lock:
            folder=self.root/job_id/'issue-previews'
            if folder.is_symlink() or (folder.exists() and folder.resolve().parent!=(self.root/job_id).resolve()):fail('Unsafe issue cache')
            folder.mkdir(exist_ok=True);target=folder/(key+'.png');record_path=folder/(key+'.json')
            if target.is_symlink() or record_path.is_symlink():fail('Unsafe issue cache')
            if target.exists():
                cached=target.read_bytes()
                if not 67<=len(cached)<=8*1024**2 or cached[:8]!=b'\x89PNG\r\n\x1a\n' or cached[-12:]!=b'\x00\x00\x00\x00IEND\xaeB`\x82':target.unlink()
            if not target.exists():
                atomic(record_path,evidence)
                python=self.config().get('pythonExecutable','')
                if not Path(python).is_file():fail('Diagnostic renderer unavailable',503,'PREVIEW_FAILED')
                try:
                    result=subprocess.run([python,str(Path(__file__).with_name('native3d_lod_issues.py')),'--source',str(source),'--evidence',str(record_path),'--output',str(target)],capture_output=True,timeout=25,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                except (OSError,subprocess.TimeoutExpired):fail('诊断图生成超时或不可用；未修改模型。',503,'PREVIEW_FAILED')
                if result.returncode or not target.is_file():fail('诊断证据未通过校验，定位图未生成。',503,'PREVIEW_FAILED')
            if not 67<=target.stat().st_size<=8*1024**2 or target.read_bytes()[:8]!=b'\x89PNG\r\n\x1a\n':fail('Invalid issue image',503,'PREVIEW_FAILED')
            return target

    def lod_repair_preview(self, job_id, stage, image=False):
        """Bounded official accepted repair evidence; never mutate model or manifest."""
        from native3d_lod_repair_preview import official_evidence,VERSION
        if not isinstance(stage,str) or not re.fullmatch(r'lod[0-4]',stage):fail('Invalid repair preview stage')
        job=self.get(job_id);name=stage+'.glb'
        files=[f for f in job.get('result',{}).get('files',[]) if f.get('name')==name and f.get('role')=='export']
        if len(files)!=1:fail('No registered repaired stage file',409,'GEOMETRY_BLOCKED')
        source=self.output_file(job_id,name)
        if source.stat().st_size>16*1024**2:fail('Repair preview exceeds model budget')
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        if digest!=files[0].get('sha256'):fail('Final repaired model changed',409,'SOURCE_CHANGED')
        try:evidence=official_evidence(job,stage,digest)
        except (ValueError,TypeError,KeyError):fail('Official repair evidence unavailable or mismatched',409,'SOURCE_CHANGED')
        encoded=json.dumps(evidence,sort_keys=True,allow_nan=False).encode()
        if len(encoded)>2*1024**2:fail('Repair evidence exceeds budget')
        key=hashlib.sha256(encoded).hexdigest()
        with self.preview_lock:
            folder=self.root/job_id/'repair-previews'
            if folder.is_symlink() or (folder.exists() and folder.resolve().parent!=(self.root/job_id).resolve()):fail('Unsafe repair preview cache')
            folder.mkdir(exist_ok=True)
            target=folder/(key+'.png');record_path=folder/(key+'.json');summary_path=folder/(key+'-summary.json')
            if any(p.is_symlink() for p in (target,record_path,summary_path)):fail('Unsafe repair preview cache')
            def cached():
                if not target.is_file() or not summary_path.is_file() or not 67<=target.stat().st_size<=8*1024**2 or summary_path.stat().st_size>65536:return None
                raw=target.read_bytes()
                if raw[:8]!=b'\x89PNG\r\n\x1a\n' or raw[-12:]!=b'\x00\x00\x00\x00IEND\xaeB`\x82':return None
                try:value=json.loads(summary_path.read_text(encoding='utf-8'))
                except (ValueError,OSError):return None
                if not isinstance(value,dict) or any(value.get(k)!=evidence[k] for k in ('jobId','stage','finalFileSha256','beforeMeshHash','afterMeshHash')) or value.get('version')!=VERSION or value.get('imageSha256')!=hashlib.sha256(raw).hexdigest():return None
                return value
            summary=cached()
            if summary is None:
                # A failed child must not leave a stale image as a successful cache hit.
                for p in (target,summary_path):
                    if p.is_file():p.unlink()
                atomic(record_path,evidence);python=self.config().get('pythonExecutable','')
                if not Path(python).is_file():fail('Repair renderer unavailable',503,'PREVIEW_FAILED')
                try:
                    result=subprocess.run([python,str(Path(__file__).with_name('native3d_lod_repair_preview.py')),
                        '--source',str(source),'--evidence',str(record_path),'--output',str(target),'--summary',str(summary_path)],
                        capture_output=True,timeout=25,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                except (OSError,subprocess.TimeoutExpired):fail('局部修复对照生成超时或不可用；正式模型未修改。',503,'PREVIEW_FAILED')
                summary=cached()
                if result.returncode or summary is None:fail('修复前后身份验证失败，对照图未生成。',503,'PREVIEW_FAILED')
            summary['imageUrl']=f'/api/native3d/jobs/{job_id}/repair-preview/{stage}/image'
            return target if image else summary

    def uv_preview(self, job_id, mode):
        """Cache a bounded real-stage poster, never write a project document."""
        if mode not in ('seams', 'checker', 'ao', 'ao-seams'):
            fail('Invalid UV preview mode')
        job = self.get(job_id)
        params=job.get('parameters',{})
        meta=job.get('result',{}).get('metadata',{})
        plan_hash=params.get('planSha256')
        plan_verified=bool(re.fullmatch(r'[a-f0-9]{64}',str(plan_hash))
            and re.fullmatch(r'n3d_[a-f0-9]{32}',str(params.get('planJobId')))
            and meta.get('uv',{}).get('reviewedPlan',{}).get('planSha256')==plan_hash
            and meta.get('uvPlan',{}).get('planSha256')==plan_hash
            and meta.get('uvPlan',{}).get('planJobId')==params['planJobId'])
        name = 'model.glb'
        entries = [f for f in job.get('result', {}).get('files', []) if f.get('name') == name and f.get('role') == 'model']
        if job.get('operation') != 'uv' or job.get('status') != 'succeeded' or len(entries) != 1:
            fail('Preview requires a successful registered UV model', 409, 'UV_BLOCKED')
        source = self.output_file(job_id, name)
        if source.stat().st_size > (64 if plan_verified else 16) * 1024**2:
            fail('UV preview source exceeds bounded limit')
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if entries[0].get('sha256') != digest:
            fail('UV preview source SHA256 changed', 409, 'SOURCE_CHANGED')
        evidence = None
        evidence_digest = ''
        if mode in ('ao', 'ao-seams'):
            evidence = job.get('result', {}).get('metadata', {}).get('uv', {})
            ao = evidence.get('aoGeometry', {})
            high_guided = ((bool(job.get('parameters', {}).get('highGuidedEvidence')) or plan_verified)
                           and job.get('parameters', {}).get('seamStrategy') == 'coherent'
                           and ao.get('backend') == 'Open3D CPU high-surface samples projected to target'
                           and ao.get('referenceUsed') is True
                           and job.get('result', {}).get('metadata', {}).get('highSourceSha256') == job.get('source', {}).get('highSha256'))
            legacy_ao = (job.get('parameters', {}).get('seamStrategy') == 'ao_geometry'
                         and ao.get('backend') == 'Open3D CPU deterministic cosine hemisphere')
            if (not (high_guided or legacy_ao)
                    or not isinstance(ao.get('faceDarkness'), list) or not ao.get('darknessSha256')
                    or not evidence.get('geometrySha256') or not isinstance(evidence.get('seamReasons'), dict)):
                fail('Original ray AO diagnostics unavailable; run a new AO geometry UV task', 409, 'AO_DIAGNOSTIC_UNAVAILABLE')
            directory = self.root / job_id
            request_path = directory / 'request.json'
            if request_path.is_symlink() or not request_path.is_file() or request_path.stat().st_size > 2*1024**2:
                fail('Original AO request unavailable; new UV task required', 409, 'AO_DIAGNOSTIC_UNAVAILABLE')
            try:
                request = json.loads(request_path.read_text(encoding='utf-8'))
            except (ValueError, OSError):
                fail('Original AO request invalid; new UV task required', 409, 'AO_DIAGNOSTIC_UNAVAILABLE')
            if request.get('parameters') != job.get('parameters') or request.get('source') != job.get('source'):
                fail('Original AO request no longer matches job', 409, 'AO_DIAGNOSTIC_UNAVAILABLE')
            def verified_snapshot(key, stem, expected):
                file = Path(request.get(key, ''))
                if (file.is_symlink() or not file.is_file() or file.resolve().parent != directory.resolve()
                        or file.stem != stem or file.suffix.lower() not in ('.glb', '.obj')
                        or file.stat().st_size > (MAX_SOURCE if stem == 'high-source' else (64 if plan_verified else 16)*1024**2) or not expected):
                    fail('Original AO source cannot be verified; new UV task required', 409, 'AO_DIAGNOSTIC_UNAVAILABLE')
                digest = hashlib.sha256()
                with file.open('rb') as stream:
                    while chunk := stream.read(1024*1024): digest.update(chunk)
                if digest.hexdigest() != expected:
                    fail('Original AO source SHA256 changed; new UV task required', 409, 'AO_DIAGNOSTIC_UNAVAILABLE')
                return file
            source = verified_snapshot('sourcePath', 'source', job.get('source', {}).get('sha256'))
            if ao.get('referenceUsed'):
                verified_snapshot('highSourcePath', 'high-source', job.get('source', {}).get('highSha256'))
            evidence_digest = hashlib.sha256(json.dumps(evidence, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            digest = job['source']['sha256'] + '-' + evidence_digest
        with self.preview_lock:
            folder = self.root / job_id / 'uv-previews'
            if folder.is_symlink() or (folder.exists() and folder.resolve().parent != (self.root / job_id).resolve()):
                fail('Unsafe preview cache')
            folder.mkdir(exist_ok=True)
            target = folder / (digest + '-' + mode + '-v3.png')
            extra = ['--max-faces','100000'] if plan_verified else []
            if evidence is not None:
                evidence_path = folder / (evidence_digest + '.json')
                if evidence_path.is_symlink(): fail('Unsafe AO evidence cache')
                atomic(evidence_path, evidence)
                extra += ['--evidence', str(evidence_path)]
            if target.is_symlink(): fail('Unsafe preview cache')
            def cached_png_valid():
                if not target.is_file() or not 67 <= target.stat().st_size <= 8*1024**2: return False
                with target.open('rb') as stream:
                    signature = stream.read(8)
                    stream.seek(-12, 2)
                    ending = stream.read(12)
                return signature == b'\x89PNG\r\n\x1a\n' and ending == b'\x00\x00\x00\x00IEND\xaeB`\x82'
            if not cached_png_valid():
                python = self.config().get('pythonExecutable', '')
                if not Path(python).is_file(): fail('Native3D Python unavailable', 503, 'NATIVE3D_NOT_READY')
                try:
                    result = subprocess.run([python, str(Path(__file__).with_name('native3d_uv_preview.py')), '--source', str(source), '--output', str(target), '--mode', mode] + extra,
                        capture_output=True, text=True, timeout=120 if plan_verified else 40, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                except (OSError, subprocess.TimeoutExpired) as exc:
                    fail('UV preview renderer unavailable: ' + type(exc).__name__, 503, 'PREVIEW_FAILED')
                if result.returncode or not cached_png_valid():
                    if evidence is not None:
                        fail('Original AO geometry/signal cannot be verified; run a new AO geometry UV task', 409, 'AO_DIAGNOSTIC_UNAVAILABLE')
                    fail('UV preview rendering failed', 503, 'PREVIEW_FAILED')
            return target

    def _safe_file(self, job_id, name):
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,159}', name):
            fail('Invalid output filename')
        root = self.root / job_id / 'output'
        file = root / name
        if file.is_symlink() or not file.is_file() or file.resolve().parent != root.resolve() or file.stat().st_size > MAX_SOURCE:
            fail('Invalid worker output')
        return file

    def _uses_gpu(self, job):
        operation = job['operation']
        if operation in ('image_to_3d', 'ai_lowpoly'):
            return True
        if operation == 'uv_plan':
            from native3d_partfield import has_feature_candidate
            request = json.loads((self.root / job['id'] / 'request.json').read_text(encoding='utf-8'))
            return not has_feature_candidate(request['partfieldConfig'], job['source']['highSha256'])
        # UV application uses the frozen plan or a CPU unwrapper, never PartField.
        return False

    def _reconcile_gpu_releases(self):
        with self.lock:
            pending = [(job, job['gpu']['device']) for job in self.jobs.values()
                       if job.get('gpu', {}).get('state') == 'reconciling']
        for job, device in pending:
            try:
                if self.gpu_leases is None:
                    self.gpu_leases = GpuLeases()
                owner = job_owner('native3d', job)
                if self.gpu_leases.reconcile_worker_release(device, owner):
                    with self.lock:
                        job['gpu'] = gpu_status(device, 'released', owner)
                        self._persist(job)
            except (OSError, ValueError, RuntimeError, KeyError):
                # Keep the conservative receipt and retry as the broker recovers.
                continue

    def _loop(self):
        while not self.stopping:
            self._reconcile_gpu_releases()
            with self.lock:
                queued = [job for job in self.jobs.values() if job['status'] == 'queued']
            for job in queued:
                try:
                    if not self._uses_gpu(job):
                        with self.lock:
                            if job.get('gpu', {}).get('state') == 'waiting':
                                job.pop('gpu')
                        self._run(job)
                        break
                    device = self.gpu_device()
                    if self.gpu_leases is None:
                        self.gpu_leases = GpuLeases()
                    grant, blocker = self.gpu_leases.claim(device, job_owner('native3d', job))
                except (OSError, ValueError, RuntimeError, KeyError) as exc:
                    with self.lock:
                        if job['status'] == 'queued':
                            job.update(status='failed', stage='gpu_unavailable', error=str(exc)[:1000])
                            self._persist(job)
                    continue
                if grant:
                    self._run(job, grant)
                    break
                with self.lock:
                    status = gpu_status(device, 'waiting', blocker)
                    if job['status'] == 'queued' and job.get('gpu') != status:
                        job.update(stage='waiting_gpu', gpu=status)
                        self._persist(job)
            else:
                self.wake.wait(0.5)
                self.wake.clear()

    def _worker_error(self, directory, code):
        message = 'Native3D worker failed (exit %s); inspect private worker.log' % code
        try:
            with (directory / 'worker.log').open('rb') as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - 8192))
                tail = stream.read(8192).decode('utf-8', errors='replace')
            for line in reversed(tail.splitlines()):
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and isinstance(entry.get('error'), str):
                    message = 'Native3D worker: ' + entry['error'][:800]
                    break
        except OSError:
            pass
        # Preserve actionable diagnostics while hiding private local filesystem locations.
        message = message.replace(str(self.root), '<private jobs>').replace(str(self.engine_path.parent), '<application>')
        message = re.sub(r'[A-Za-z]:[\\/][^\s"\n]*', '<local path>', message)
        return ' '.join(message.split())[:1000]

    def _timeout(self, job_id):
        with self.lock:
            if self.active != job_id or self.jobs[job_id]['status'] != 'running':
                return
            self.cancel(job_id)
            self.jobs[job_id].update(status='failed', stage='timeout', error='Native3D worker exceeded configured execution timeout')
            self._persist(self.jobs[job_id])

    def _release_gpu(self, job, grant):
        if grant is None or job.get('gpu', {}).get('state') in ('released', 'reconciling'):
            return
        try:
            released = grant.release() or grant.manager.reconcile_worker_release(
                grant.device, grant.owner, token=grant.token)
        except (OSError, ValueError, RuntimeError):
            released = False
        with self.lock:
            job['gpu'] = gpu_status(grant.device, 'released' if released else 'reconciling', grant.owner)
            self._persist(job)

    def _run(self, job, grant=None):
        timer = None
        directory = self.root / job['id']
        output = directory / 'output'
        try:
            with self.lock:
                if self.stopping or job['status'] != 'queued':
                    return
                output.mkdir(exist_ok=True)
                config = json.loads((directory / 'runtime.json').read_text(encoding='utf-8'))
                command = [config['pythonExecutable'], '-u', str(self.engine_path), '--request', str(directory / 'request.json'), '--output', str(output)]
                env = worker_env(config['imageTo3D']) if job['operation'] == 'image_to_3d' else None
                if grant:
                    env = grant.worker_environment(env if env is not None else os.environ.copy())
                with (directory / 'worker.log').open('w', encoding='utf-8') as log:
                    self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8', errors='replace', cwd=directory, env=env, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                self.active = job['id']
                timeout = max(1, min(3600, int(config.get('timeoutSeconds', 900))))
                timer = threading.Timer(timeout, self._timeout, args=(job['id'],))
                timer.daemon = True
                timer.start()
                job.update(status='running', stage='starting')
                if grant:
                    job['gpu'] = gpu_status(grant.device, 'held', grant.owner)
                self._persist(job)
            try:
                for event in worker_progress(self.process.stdout):
                    with self.lock:
                        if job['status'] == 'running':
                            job.update(event)
                            self._persist(job)
                returncode = self.process.wait()
            finally:
                self.process.stdout.close()
            # A compute child may still hold the identity after an abnormal
            # engine exit. The broker then refuses to clear its live lease.
            self._release_gpu(job, grant)
            with self.lock:
                if job['status'] == 'cancelled':
                    return
                if job['stage'] == 'timeout':
                    return
                if returncode:
                    raise ValueError(self._worker_error(directory, returncode))
                result = verified_result(output / 'result.json', lambda name: (
                    self._safe_file(job['id'], name), '/api/native3d/jobs/%s/files/%s' % (job['id'], name)))
                job.update(status='succeeded', stage='completed', progress=1, result=result)
                self._persist(job)
        except Exception as exc:
            with self.lock:
                if self.process and self.process.poll() is None:
                    self._terminate_owned(self.process)
                    self.process.wait(timeout=5)
                self._release_gpu(job, grant)
                if job['status'] != 'cancelled':
                    job.update(status='failed', stage='failed', error=str(exc)[:1000])
                    self._persist(job)
        finally:
            if timer:
                timer.cancel()
            try:
                self._release_gpu(job, grant)
            finally:
                with self.lock:
                    self.active = None
                    self.process = None

    def close(self):
        self.stopping = True
        with self.lock:
            if self.active:
                self.cancel(self.active)
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=6)
