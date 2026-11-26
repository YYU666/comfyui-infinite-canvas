"""Isolated legacy-torch worker. No Blender or ComfyUI imports."""
from native3d_presets import AI_LOWPOLY_DEFAULTS

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time


def decoder_to_source(triangles, center, radius):
    """Official decoder(-.5,.5) -> original coordinate system."""
    return triangles * (2 * radius) + center


def official_batch(pc, torch):
    """Official batch1/no-shuffle DataLoader lifecycle consumes CPU RNG before encoding."""
    loader = torch.utils.data.DataLoader([{'pc_normal': pc}], batch_size=1, drop_last=False, shuffle=False)
    return next(iter(loader))['pc_normal']


def observe_generate(original, out, np):
    """Best-effort observation; original return/exception always takes priority."""
    def observed(*args, **kwargs):
        started = time.monotonic()
        record = {'status': 'running', 'maxNewTokens': kwargs.get('max_new_tokens'),
                  'numBeams': kwargs.get('num_beams'), 'doSample': kwargs.get('do_sample', False),
                  'eosTokenId': kwargs.get('eos_token_id')}
        def best_effort(action, operation):
            try:
                action()
            except Exception as exc:
                warning = {'operation': operation, 'errorType': type(exc).__name__}
                record.setdefault('observationErrors', []).append(warning)
                try:
                    print(json.dumps({'stage': 'ai_observation_warning', **warning}), flush=True)
                except Exception:
                    pass
        def publish(stage, progress):
            best_effort(lambda: (Path(out) / 'ai_generation_receipt.json').write_text(
                json.dumps(record), encoding='utf-8'), 'receipt_write')
            best_effort(lambda: print(json.dumps({'stage': stage, 'progress': progress, **record}),
                                     flush=True), 'stage_log')
        publish('ai_token_generation', .35)
        try:
            result = original(*args, **kwargs)
        except Exception as exc:
            record.update(status='failed', seconds=time.monotonic()-started, errorType=type(exc).__name__)
            publish('ai_token_generation_failed', .35)
            raise
        record.update(status='completed', seconds=time.monotonic()-started)
        def capture_tokens():
            tokens = result.detach().cpu().numpy().copy()
            token_path = Path(out) / 'ai_token_ids.npy'
            np.save(token_path, tokens, allow_pickle=False)
            eos = kwargs.get('eos_token_id')
            record.update(status='completed', seconds=time.monotonic()-started,
                tokenShape=list(tokens.shape), rows=[{'length': len(row),
                    'firstEosIndex': int(np.flatnonzero(row == eos)[0]) if eos is not None and np.any(row == eos) else None,
                    'lastToken': int(row[-1]) if len(row) else None} for row in tokens],
                tokenIdsSha256=hashlib.sha256(token_path.read_bytes()).hexdigest())
        best_effort(capture_tokens, 'token_capture')
        publish('ai_token_generation_completed', .65)
        return result
    return observed


def prepare_legacy_batch(pc, model, torch, accelerator):
    loader = torch.utils.data.DataLoader([{'pc_normal': pc}], batch_size=1, drop_last=False, shuffle=False)
    loader, model = accelerator.prepare(loader, model)
    model.eval()
    return next(iter(loader))['pc_normal'], model


def advance_legacy_sampling_rng(np, count):
    """Replay only official area/barycentric RNG draws; conditioning is frozen."""
    np.random.random(count)
    np.random.random((count, 2, 1))
    name, keys, position, gaussian, cached = np.random.get_state()
    return hashlib.sha256(keys.tobytes()+repr((name, position, gaussian, cached)).encode()).hexdigest()


def inference_heartbeat(stop):
    started = time.monotonic()
    while not stop.wait(30):
        print(json.dumps({'stage': 'ai_inference_running', 'progress': .35,
                          'elapsedSeconds': round(time.monotonic()-started, 1),
                          'note': 'Worker alive; token count unavailable until original generate returns'}), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--request', required=True)
    p.add_argument('--output', required=True)
    args = p.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8-sig'))
    from gpu_lease import WORKER_LEASE_ENV, adopt_worker_lease
    if not os.environ.get(WORKER_LEASE_ENV):
        raise ValueError('MeshAnything shared GPU resource reservation required')
    adopt_worker_lease()
    cfg = request['adapterConfig']
    for key in ('meshanythingRuntime', 'checkpoint'):
        if not Path(cfg[key]).is_absolute() or not Path(cfg[key]).exists():
            raise ValueError('Missing absolute adapter path: ' + key)
    digest = cfg.get('checkpointSha256', '')
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest.lower()):
        raise ValueError('checkpointSha256 must contain64 hexadecimal characters')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    sys.dont_write_bytecode = True
    sys.path.insert(0, cfg['meshanythingRuntime'])
    import numpy as np
    import torch
    from load_cpu import load_cpu_model
    out = Path(args.output)
    profile = request.get('parameters', {}).get('conditioningProfile', AI_LOWPOLY_DEFAULTS['conditioningProfile'])
    if profile not in ('canonical_safe', 'legacy_world_fp16'):
        raise ValueError('Unsupported conditioningProfile')
    legacy = profile == 'legacy_world_fp16'
    torch.set_num_threads(8)
    accelerator = None
    if legacy:
        from accelerate import Accelerator
        from accelerate.utils import set_seed, DistributedDataParallelKwargs
        accelerator = Accelerator(mixed_precision='fp16', kwargs_handlers=[DistributedDataParallelKwargs(find_unused_parameters=True)])
        if accelerator.num_processes != 1:
            raise RuntimeError('Legacy replay requires one Accelerator process')
    runtime = {'conditioningProfile': profile, 'torchThreads': torch.get_num_threads(),
               'torchInteropThreads': torch.get_num_interop_threads(), 'cpuCount': os.cpu_count(),
               'torchVersion': torch.__version__, 'numpyVersion': np.__version__,
               'execution': 'Accelerator prepare + FP16 autocast' if legacy else 'direct CUDA + FP16 autocast',
               'generationObserver': 'one delegated call; unchanged kwargs/result; no token budget or timeout overrides'}
    (out / 'ai_runtime_receipt.json').write_text(json.dumps(runtime), encoding='utf-8')
    print(json.dumps({'stage': 'ai_runtime_ready', 'progress': .25, **runtime}), flush=True)
    data = np.load(out / 'ai_input.npz', allow_pickle=False)
    pc = data['pc']
    center, radius = data['center'], float(data['radius'])
    if not torch.cuda.is_available():
        raise RuntimeError('MeshAnything pilot requires an available CUDA device')
    free, total = torch.cuda.mem_get_info()
    baseline = 8 * 1024**3
    headroom = max(1024**3, int(total * .15))
    if free < baseline + headroom:
        raise RuntimeError('GPU memory gate: need8GiB estimated baseline plus max(1GiB,15%total) headroom')
    model, receipt = load_cpu_model(Path(cfg['checkpoint']), digest)
    seed = int(request.get('parameters', {}).get('seed', AI_LOWPOLY_DEFAULTS['seed']))
    if legacy:
        set_seed(seed)
        runtime['numpyRngAfterSamplingReplay'] = advance_legacy_sampling_rng(np, len(pc))
    else:
        torch.manual_seed(seed)
        np.random.seed(seed)
    torch.cuda.reset_peak_memory_stats()
    model.transformer.generate = observe_generate(model.transformer.generate, out, np)
    before_loader = hashlib.sha256(torch.get_rng_state().numpy().tobytes()).hexdigest()
    if legacy:
        tensor, model = prepare_legacy_batch(pc, model, torch, accelerator)
    else:
        model = model.to('cuda').eval()
        tensor = official_batch(pc, torch).to('cuda')
    after_loader = hashlib.sha256(torch.get_rng_state().numpy().tobytes()).hexdigest()
    runtime.update(seed=seed, rngBefore=before_loader, rngAfter=after_loader,
                   conditioningSha256=hashlib.sha256(pc.tobytes()).hexdigest())
    (out / 'ai_runtime_receipt.json').write_text(json.dumps(runtime), encoding='utf-8')
    print(json.dumps({'stage': 'ai_inference', 'progress': .35}), flush=True)
    stop = threading.Event()
    heartbeat = threading.Thread(target=inference_heartbeat, args=(stop,), daemon=True)
    heartbeat.start()
    inference_started = time.monotonic()
    try:
        context = accelerator.autocast() if legacy else torch.autocast(device_type='cuda', dtype=torch.float16)
        with torch.inference_mode(), context:
            raw = model(tensor, sampling=bool(request.get('parameters', {}).get('sampling', AI_LOWPOLY_DEFAULTS['sampling'])))
    finally:
        stop.set()
        heartbeat.join(timeout=1)
    torch.cuda.synchronize()
    triangles = raw[0].float().cpu().numpy()
    triangles = triangles[np.isfinite(triangles).all(axis=(1, 2))]
    if not len(triangles):
        raise RuntimeError('MeshAnything returned no finite triangles')
    # Decoder outputs(-.5,.5), while conditioning positions occupy(-.9995,.9995).
    # Match official CLI's explicit2*sample_radius output mapping.
    np.savez_compressed(out / 'ai_output.npz', vertices=decoder_to_source(triangles.reshape(-1, 3), center, radius),
                        faces=np.arange(triangles.size // 3).reshape(-1, 3))
    (out / 'ai_receipt.json').write_text(json.dumps({'seed': seed, 'sampling': bool(request.get('parameters', {}).get('sampling', AI_LOWPOLY_DEFAULTS['sampling'])), 'load': receipt,
        'preprocessing': ('official MC256 unsigned shell; legacy area-weighted sampling; official FP16 Dataset normalization in '
            + ('source-world coordinates (legacy_world_fp16)' if request.get('parameters', {}).get('conditioningProfile', AI_LOWPOLY_DEFAULTS['conditioningProfile']) == 'legacy_world_fp16'
               else 'canonical coordinates (canonical_safe)')), 'rawTriangles': len(triangles),
        'dataLoader': {'batchSize': 1, 'shuffle': False, 'dropLast': False, 'rngBefore': before_loader, 'rngAfter': after_loader},
        'runtime': runtime, 'inferenceSeconds': time.monotonic()-inference_started,
        'peakGpuAllocatedBytes': int(torch.cuda.max_memory_allocated()),
        'peakGpuReservedBytes': int(torch.cuda.max_memory_reserved()),
        'inverseMapping': 'decoder_xyz*(2*sample_radius)+sample_bbox_center',
        'gpuMemoryGate': {'estimatedBaselineBytes': baseline, 'headroomBytes': headroom, 'freeBytes': free}}, default=str), encoding='utf-8')


if __name__ == '__main__':
    main()
