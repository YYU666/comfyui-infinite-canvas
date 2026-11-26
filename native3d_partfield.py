"""Fixed local research PartField runner and verified high-surface cache.

No GPU inference occurs without an explicit server-owned resource reservation.
Browser settings never select Python, modules, checkpoint or cache paths.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import os
import numpy as np

CHECKPOINT_SHA='463efc8a3afd3913142aa025e0125c00f16ef452b8de6a132ebe32bbe7877ee4'
ADAPTER_SHA='baa102f37faf5ac13909f05a8bc57a449cee5f3424deaf5ec5781ff1834a96e3'
COMMIT='373025dbd283bb44cc4a6dc78c99994dbc91de32'
LICENSE='NVIDIA non-commercial research and education only; source LICENSE section 3.3'
SAMPLE_VERSION='area-weighted-high-100k-32768-seed01-v1'
CORE_SOURCE={
 'partfield/model_trainer_pvcnn_only_demo.py':'0a91b0bcbb5e9d2dd4dc5ce7227367eefb4f6969e60312856785a568031b1b7e',
 'partfield/config/defaults.py':'db51dfc6afbe667528465ae2fcb5b7f3f96c1247989561bce5b17d106ebfc258',
 'configs/final/demo.yaml':'020c8e2df1796b4d22c1c87afca410c94c4265c9261299d9d26ded35d1003688',
 'partfield/model/UNet/model.py':'1a94e8727234a55e8d7f36297e9160775a857a2623faf5dfce27bcee87fbaf09',
 'partfield/model/triplane.py':'0427d5f91f484dfcfe9b071b2ab8e607628986a9350feb95dfb358db15d63cc3',
 'partfield/model/PVCNN/encoder_pc.py':'1bcc6cfe7ddd30d4e2858561cbfa67705e8a50ce65d8fe77c9a903a651eae84c',
 'partfield/model/model_utils.py':'c2fee14c10d7812a98b63081d53babc6a434467df698ea2c52ec99673143cff3'}

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda:stream.read(8*1024**2),b''):h.update(chunk)
    return h.hexdigest()

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)

def _paths(config):
    config=config or {};config=config.get('partfieldConfig',config)
    result={}
    for key in ('runtimePath','pythonExecutable','checkpointPath'):
        value=config.get(key)
        if not isinstance(value,str) or not Path(value).is_absolute():raise ValueError('Configure server-only partfieldConfig.'+key)
        result[key]=Path(value)
    return result

def readiness(config=None):
    try:paths=_paths(config)
    except ValueError as exc:return {'ready':False,'reason':str(exc),'license':LICENSE,'inferenceExecuted':False}
    runtime=paths['runtimePath']
    missing=[]
    for path in (paths['pythonExecutable'],runtime/'partfield_adapter.py',runtime/'source/partfield/model_trainer_pvcnn_only_demo.py',paths['checkpointPath']):
        if not path.is_file():missing.append(str(path.name)+' unavailable')
    if not missing and sha(runtime/'partfield_adapter.py')!=ADAPTER_SHA:missing.append('Pinned PartField adapter changed')
    for name,expected in CORE_SOURCE.items():
        path=runtime/'source'/name
        if not path.is_file() or sha(path)!=expected:missing.append('Pinned PartField core source changed: '+name)
    return {'ready':not missing,'reason':'; '.join(missing),'license':LICENSE,'sourceCommit':COMMIT,
            'checkpointSha256':CHECKPOINT_SHA,'adapterSha256':ADAPTER_SHA,'inferenceExecuted':False}

def _sample(mesh,count,seed):
    rng=np.random.default_rng(seed);areas=np.asarray(mesh.area_faces,float)
    if not np.isfinite(areas).all() or np.any(areas<0) or areas.sum()<=0:raise ValueError('High source has no valid sampleable surface')
    allocation=rng.multinomial(count,areas/areas.sum());ids=np.repeat(np.arange(len(areas)),allocation);rng.shuffle(ids)
    a=np.sqrt(rng.random(count));b=rng.random(count);bary=np.column_stack((1-a,a*(1-b),a*b))
    return np.einsum('ni,nij->nj',bary,np.asarray(mesh.vertices)[mesh.faces[ids]]),ids,bary

def prepare_samples(high,path,high_sha):
    if not 1<=len(high.faces)<=3000000:raise ValueError('High source triangle limit is 3000000')
    center=np.asarray(high.bounds).mean(0);scale=1.8/max(float(np.ptp(high.vertices,axis=0).max()),1e-30)
    encoder,_,_=_sample(high,100000,0);points,ids,bary=_sample(high,32768,1)
    np.savez_compressed(path,encoder=((encoder-center)*scale).astype('f4'),query=((points-center)*scale).astype('f4'),
        querySourceFace=ids.astype('i4'),queryBarycentric=bary.astype('f4'),queryNormal=np.asarray(high.face_normals)[ids].astype('f4'),center=center,scale=scale)
    return {'sourceSha256':high_sha,'sampleVersion':SAMPLE_VERSION,'sampleCacheSha256':sha(path),'queryCount':32768,
            'sourceFaceOrderPreserved':True,'highFaceCount':len(high.faces)}

def verify_samples(high,path,receipt,high_sha):
    if receipt.get('sourceSha256')!=high_sha or receipt.get('sampleCacheSha256')!=sha(path):raise ValueError('High sample cache identity mismatch')
    data=np.load(path,allow_pickle=False);ids=data['querySourceFace'];bary=data['queryBarycentric'].astype(float)
    if data['query'].shape!=(32768,3) or data['encoder'].shape!=(100000,3) or ids.shape!=(32768,) or bary.shape!=(32768,3):raise ValueError('Invalid high sample shape')
    if ids.min()<0 or ids.max()>=len(high.faces):raise ValueError('High sample face order invalid')
    points=data['query'].astype(float)/float(data['scale'])+data['center']
    reconstructed=np.einsum('ni,nij->nj',bary,np.asarray(high.vertices)[high.faces[ids]])
    normal=data['queryNormal'].astype(float)
    if not np.allclose(points,reconstructed,atol=1e-5,rtol=0) or not np.allclose(normal,np.asarray(high.face_normals)[ids],atol=1e-5,rtol=0):raise ValueError('High sample original-face correspondence mismatch')
    if not all(np.isfinite(data[key]).all() for key in data.files):raise ValueError('Nonfinite high sample cache')
    return {key:data[key].copy() for key in data.files}

def feature_cache_path(root, high_sha):
    key = {'high': high_sha, 'sample': SAMPLE_VERSION, 'checkpoint': CHECKPOINT_SHA}
    return Path(root) / hashlib.sha256(canonical(key).encode()).hexdigest()


def has_feature_candidate(config, high_sha):
    # Queue classification reads receipts and file sizes only. The worker
    # still verifies samples, feature hashes and tensor contents before reuse.
    if not high_sha or not config.get('cacheRoot'):
        return False
    if config.get('verifiedHighCache'):
        candidates = [Path(config['verifiedHighCache']), feature_cache_path(config['cacheRoot'], high_sha)]
    else:
        candidates = [feature_cache_path(config['cacheRoot'], high_sha)]
    for folder in candidates:
        try:
            receipt = folder / 'high-inference.json'
            if not 0 < receipt.stat().st_size <= 16384:
                continue
            record = json.loads(receipt.read_text(encoding='utf-8'))
            if (record.get('sourceSha256') == high_sha and record.get('checkpointSha256') == CHECKPOINT_SHA
                    and record.get('officialCommit') == COMMIT
                    and all((folder / name).stat().st_size > 0 for name in (
                        'high-input.json', 'high-samples.npz', 'high-query-features.npy'))):
                return True
        except (OSError, ValueError, AttributeError):
            continue
    return False


def infer_features(samples,output,*,gpu_authorized=False,config=None,worker_lease=None):
    from gpu_lease import WORKER_LEASE_ENV

    if not gpu_authorized or not worker_lease:
        raise ValueError('PartField shared GPU resource reservation required; resubmit if the verified cache was removed')
    ready=readiness(config)
    if not ready['ready']:raise ValueError(ready['reason'])
    paths=_paths(config)
    if sha(paths['checkpointPath'])!=CHECKPOINT_SHA:raise ValueError('PartField checkpoint identity changed')
    runtime_config=Path(output).parent/'partfield-runtime.json'
    runtime_config.write_text(canonical({k:str(v) for k,v in paths.items()}),encoding='utf-8')
    command=[str(paths['pythonExecutable']),'-u',str(Path(__file__).resolve()),'--infer',str(Path(samples).resolve()),str(Path(output).resolve()),str(runtime_config.resolve())]
    environment = {**os.environ, WORKER_LEASE_ENV: worker_lease}
    with (Path(output).parent/'partfield-worker.log').open('w',encoding='utf-8') as log:
        result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=900,env=environment,
                              creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode:
        path = Path(output).parent / 'partfield-worker.log'
        with path.open('rb') as stream:
            stream.seek(max(0, path.stat().st_size - 8192))
            detail = stream.read().decode('utf-8', errors='replace').splitlines()
        for line in reversed(detail):
            if line.startswith('ValueError: PartField blocked:'):
                raise RuntimeError(line.removeprefix('ValueError: '))
        raise RuntimeError('PartField worker failed; private job log retained')

def _check_gpu_idle():
    """Advisory headroom check; never claims exclusive GPU/Comfy reservation."""
    import urllib.request,urllib.error,urllib.parse,shutil
    import re,time,xml.etree.ElementTree as ET
    from gpu_lease import comfy_process
    origin = os.environ.get('H3_COMFY_URL', 'http://127.0.0.1:8188').rstrip('/')
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1','::1','localhost')
            or not parsed.port or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ValueError('Cannot verify ComfyUI availability through a non-loopback endpoint')
    def check_comfy():
        try:
            with urllib.request.urlopen(origin + '/queue',timeout=3) as response:queue=json.load(response)
            if not isinstance(queue,dict) or not all(isinstance(queue.get(key),list) for key in ('queue_running','queue_pending')):raise ValueError('Cannot verify ComfyUI queue')
            if queue['queue_running'] or queue['queue_pending']:raise ValueError('PartField blocked: ComfyUI has running/pending work')
        except urllib.error.URLError as exc:
            reason=exc.reason
            if not isinstance(reason,ConnectionRefusedError) and getattr(reason,'winerror',None)!=10061 and getattr(reason,'errno',None) not in (61,111,10061):raise ValueError('Cannot verify ComfyUI availability') from exc
            return None
        try:
            return comfy_process(origin)['pid']
        except (OSError, ValueError, RuntimeError, KeyError):
            return None
    comfy_pid = check_comfy()
    executable=shutil.which('nvidia-smi')
    if not executable:raise ValueError('Cannot verify NVIDIA GPU occupancy')
    def run(arguments):
        result=subprocess.run([executable,*arguments],capture_output=True,text=True,timeout=10,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode:raise ValueError('Cannot verify NVIDIA GPU occupancy')
        return result.stdout.strip()
    def query(field):return run([field,'--format=csv,noheader,nounits'])
    def external_pids(text):
        if not text or text.lower()=='no running processes found':return set()
        lines=text.splitlines()
        if any(not re.fullmatch(r'[1-9][0-9]*',line.strip()) for line in lines):raise ValueError('Cannot parse NVIDIA process identity')
        return {int(line) for line in lines}-{os.getpid()}
    external=external_pids(query('--query-compute-apps=pid'))
    if external:
        samples=[]
        for index in range(2):
            if index:
                time.sleep(.2)
                comfy_pid = check_comfy()
                external=external_pids(query('--query-compute-apps=pid'))
            try:root=ET.fromstring(run(['-q','-x']))
            except ET.ParseError as exc:raise ValueError('Cannot parse NVIDIA occupancy report') from exc
            gpus=root.findall('gpu')
            if len(gpus)!=1:raise ValueError('PartField blocked: ambiguous GPU selection for WDDM headroom check')
            gpu=gpus[0]
            if gpu.findtext('driver_model/current_dm','').strip()!='WDDM':raise ValueError('PartField blocked: another GPU compute process is present; driver is not verified WDDM')
            processes=gpu.find('processes')
            if processes is None:raise ValueError('Cannot verify WDDM process records')
            observed=set()
            managed_idle = comfy_pid in external
            for process in processes.findall('process_info'):
                pid=process.findtext('pid','').strip()
                if not re.fullmatch(r'[1-9][0-9]*',pid):raise ValueError('Cannot parse WDDM process identity')
                pid = int(pid)
                if pid not in external:
                    continue  # The full XML includes graphics-only desktop rows.
                observed.add(pid)
                if pid == comfy_pid:
                    continue  # The exact listening process has an empty queue; cached tensors may remain.
                if process.findtext('type','').strip()!='C+G' or process.findtext('used_memory','').strip()!='N/A':
                    raise ValueError('PartField blocked: another GPU compute process is present; not an ambiguous WDDM C+G/N/A record')
            if not external<=observed:raise ValueError('Cannot reconcile NVIDIA compute identities with WDDM report')
            def number(path,unit):
                text=gpu.findtext(path,'').strip();match=re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)\s*'+re.escape(unit),text)
                if not match:raise ValueError('Cannot parse WDDM resource metric '+path)
                value=float(match.group(1))
                if not np.isfinite(value):raise ValueError('Cannot verify finite WDDM resource metric')
                return value
            used=number('fb_memory_usage/used','MiB');free=number('fb_memory_usage/free','MiB');util=number('utilization/gpu_util','%')
            if free < 6144 or util > 50 or (not managed_idle and used > 2048):
                raise ValueError('PartField blocked: WDDM desktop headroom requires free>=6GiB and utilization<=50%; without a verified idle Comfy backend it also requires used<=2GiB')
            samples.append({'driverModel':'WDDM','externalAmbiguousProcesses':len(observed)-int(managed_idle),
                            'verifiedIdleComfyResident':managed_idle,'usedMiB':used,'freeMiB':free,'utilizationPercent':util})
        check_comfy()
        return {'mode':'wddm_ambiguous_desktop_headroom','exclusiveGPU':False,'samples':samples,'comfyQueue':'empty_or_connection_refused','sampleIntervalSeconds':.2}
    free=query('--query-gpu=memory.free')
    try:first_free=float(free.splitlines()[0])
    except (ValueError,IndexError) as exc:raise ValueError('Cannot verify GPU free memory') from exc
    if not np.isfinite(first_free) or first_free<2048:raise ValueError('PartField requires 2GiB free GPU memory with bounded sampled profile')
    return {'mode':'no_external_compute_reported','exclusiveGPU':False,'freeMiB':first_free,'comfyQueue':'empty_or_connection_refused'}

def cluster_features(features,output,count,config):
    if count not in (4,8,12):raise ValueError('Unsupported partition count')
    paths=_paths(config)
    command=[str(paths['pythonExecutable']),'-u',str(Path(__file__).resolve()),'--cluster',str(Path(features).resolve()),str(Path(output).resolve()),str(count)]
    with (Path(output).parent/'partfield-cluster.log').open('w',encoding='utf-8') as log:
        result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=180,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode:raise RuntimeError('PartField CPU clustering failed; private job log retained')
    labels=np.load(output,allow_pickle=False)
    if labels.shape!=(32768,) or not np.issubdtype(labels.dtype,np.integer) or labels.min()<0 or labels.max()>=count:raise ValueError('Invalid high partition cache')
    return labels.astype(np.int32)

def high_evidence(high,high_sha,cache_root,*,gpu_authorized=False,verified_cache=None,progress=None,config=None,worker_lease=None):
    """Return verified samples/features. verified_cache is trusted server config only."""
    cache=Path(cache_root);cache.mkdir(parents=True,exist_ok=True)
    samples=cache/'high-samples.npz';features=cache/'high-query-features.npy';receipt_path=cache/'high-input.json'
    feature_receipt=cache/'high-inference.json'
    reused=False
    if verified_cache is not None:
        # Import an existing local genuine result only after checking all actual
        # source/sample/feature/checkpoint bindings. Never receive this from UI.
        import shutil
        previous=Path(verified_cache);r=json.loads((previous/'high-input.json').read_text());f=json.loads((previous/'high-inference.json').read_text())
        if r.get('sourceSha256')!=high_sha:
            return high_evidence(high,high_sha,cache_root,gpu_authorized=gpu_authorized,progress=progress,config=config,worker_lease=worker_lease)
        verify_samples(high,previous/'high-samples.npz',r,high_sha)
        if f.get('sourceSha256')!=high_sha or f.get('checkpointSha256')!=CHECKPOINT_SHA or f.get('officialCommit')!=COMMIT or f.get('sampleCacheSha256')!=r['sampleCacheSha256'] or f.get('featuresSha256')!=sha(previous/'high-query-features.npy'):raise ValueError('Unverified PartField cache provenance')
        for name in ('high-samples.npz','high-query-features.npy'):shutil.copyfile(previous/name,cache/name)
        receipt_path.write_text(canonical(r));feature_receipt.write_text(canonical(f));reused=True
    if samples.is_file() and receipt_path.is_file():
        receipt=json.loads(receipt_path.read_text());data=verify_samples(high,samples,receipt,high_sha)
    else:
        if progress:progress('sample_original_high',10)
        receipt=prepare_samples(high,samples,high_sha);receipt_path.write_text(canonical(receipt));data=verify_samples(high,samples,receipt,high_sha)
    valid_features=False
    if features.is_file() and feature_receipt.is_file():
        r=json.loads(feature_receipt.read_text())
        valid_features=(r.get('sourceSha256')==high_sha and r.get('sampleCacheSha256')==sha(samples) and r.get('checkpointSha256')==CHECKPOINT_SHA and r.get('officialCommit')==COMMIT and r.get('featuresSha256')==sha(features))
        if not valid_features:raise ValueError('PartField feature cache changed')
    if not valid_features:
        if progress:progress('partfield_features',25)
        infer_features(samples,features,gpu_authorized=gpu_authorized,config=config,worker_lease=worker_lease)
        r={**receipt,'checkpointSha256':CHECKPOINT_SHA,'officialCommit':COMMIT,'featuresSha256':sha(features)}
        feature_receipt.write_text(canonical(r))
    values=np.load(features,allow_pickle=False)
    if values.shape!=(32768,448) or not np.isfinite(values).all():raise ValueError('Invalid genuine PartField feature array')
    return data,values,{'sourceSha256':high_sha,'sampleCacheSha256':sha(samples),'featuresSha256':sha(features),
        'checkpointSha256':CHECKPOINT_SHA,'officialCommit':COMMIT,'adapterSha256':ADAPTER_SHA,'queryCount':32768,
        'cacheReused':bool(reused or valid_features),'license':LICENSE,'method':'original high surface sampled neural448D; not every-face inference'}

def _worker(samples,output,config_path):
    # CLI is reached only by the fixed server-owned launcher above.
    paths=_paths(json.loads(Path(config_path).read_text()));runtime=paths['runtimePath']
    if not readiness({k:str(v) for k,v in paths.items()})['ready']:raise ValueError('Pinned runtime changed before inference')
    if sha(runtime/'partfield_adapter.py')!=ADAPTER_SHA or sha(paths['checkpointPath'])!=CHECKPOINT_SHA:raise ValueError('Pinned inference identity changed')
    sys.path.insert(0,str(runtime));sys.path.insert(0,str(runtime/'source'))
    import partfield_adapter
    partfield_adapter.SOURCE=runtime/'source';partfield_adapter.CHECKPOINT=paths['checkpointPath']
    sys.path.insert(0,str(runtime/'source'))
    private_cache=Path(output).parent/'runtime-cache';private_cache.mkdir(exist_ok=True)
    for key in ('TEMP','TMP','TORCH_HOME','HF_HOME','PIP_CACHE_DIR'):os.environ[key]=str(private_cache)
    load_model=partfield_adapter.load_model
    _check_gpu_idle()
    import torch
    import threading,time,psutil
    started=time.monotonic();process=psutil.Process()
    def monitor():
        while True:
            if time.monotonic()-started>900 or process.memory_info().rss>12*1024**3:os._exit(74)
            time.sleep(.25)
    threading.Thread(target=monitor,daemon=True).start()
    torch.set_num_threads(8);torch.manual_seed(0);np.random.seed(0)
    data=np.load(samples,allow_pickle=False);model,_,ns=load_model('cpu');model=model.to('cuda').eval()
    with torch.inference_mode(),torch.autocast(device_type='cuda',dtype=torch.float16):
        pc=torch.tensor(data['encoder'][None],device='cuda');query=torch.tensor(data['query'][None],device='cuda')
        planes=model.triplane_transformer(model.pvcnn(pc,pc));_,part=torch.split(planes,[64,planes.shape[2]-64],dim=2)
        features=np.concatenate([ns['sample_triplane_feat'](part,query[:,start:start+10000])[0].float().cpu().numpy() for start in range(0,32768,10000)])
    if features.shape!=(32768,448) or not np.isfinite(features).all():raise ValueError('Invalid PartField inference')
    np.save(output,features,allow_pickle=False)

if __name__=='__main__':
    if len(sys.argv)==5 and sys.argv[1]=='--cluster':
        from sklearn.cluster import MiniBatchKMeans
        count=int(sys.argv[4])
        if count not in (4,8,12):raise SystemExit('Invalid cluster count')
        features=np.load(sys.argv[2],allow_pickle=False)
        if features.shape!=(32768,448) or not np.isfinite(features).all():raise SystemExit('Invalid cluster features')
        normalized=features/np.maximum(np.linalg.norm(features,axis=1,keepdims=True),1e-30)
        labels=MiniBatchKMeans(n_clusters=count,random_state=0,batch_size=4096,n_init=3,max_iter=100,reassignment_ratio=0).fit_predict(normalized)
        np.save(sys.argv[3],labels.astype('i4'),allow_pickle=False);raise SystemExit(0)
    if len(sys.argv)!=5 or sys.argv[1]!='--infer':raise SystemExit('Fixed inference worker arguments required')
    from gpu_lease import WORKER_LEASE_ENV, adopt_worker_lease
    if not os.environ.get(WORKER_LEASE_ENV):
        raise SystemExit('PartField shared GPU resource reservation required')
    adopt_worker_lease()
    _worker(sys.argv[2],sys.argv[3],sys.argv[4])
