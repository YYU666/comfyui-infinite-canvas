"""Read-only Open-H3 IC preflight; never converts weights or runs inference.

The published up3/up4/hf8 recipe requires the HyperFlow two-time runtime.
A filename/layout conversion cannot provide that runtime. This checker reports
facts and stays closed until a separate runtime implementation is validated.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
from pathlib import Path
import struct


MAX_HEADER = 16 * 1024 * 1024


def read_header(path):
    """Read bounded metadata, not tensors. Full-content hashes are separate."""
    path = Path(path)
    with path.open('rb') as stream:
        prefix = stream.read(8)
        if len(prefix) != 8:
            raise ValueError('Truncated safetensors header')
        length = struct.unpack('<Q', prefix)[0]
        if not 2 <= length <= MAX_HEADER:
            raise ValueError('Invalid safetensors header size')
        raw = stream.read(length)
        if len(raw) != length:
            raise ValueError('Truncated safetensors header')
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError('Safetensors header must be an object')
    return result


def _pairs(header):
    pairs = {}
    for key, item in header.items():
        if key == '__metadata__':
            continue
        if not isinstance(item, dict):
            raise ValueError('Invalid tensor descriptor')
        if key.endswith('.lora_A.weight'):
            stem = key[:-len('.lora_A.weight')]
            other = header.get(stem + '.lora_B.weight')
            a, b = item.get('shape'), other.get('shape') if isinstance(other, dict) else None
            if not (isinstance(a, list) and isinstance(b, list) and len(a) == len(b) == 2
                    and all(type(n) is int and n > 0 for n in a + b) and a[0] == b[1]):
                raise ValueError('Missing or dimensionally incompatible LoRA pair: ' + stem)
            pairs[stem] = (a, b)
        elif key.endswith('.lora_B.weight') and key[:-len('.lora_B.weight')] + '.lora_A.weight' not in header:
            raise ValueError('Orphan LoRA B tensor: ' + key)
    if not pairs:
        raise ValueError('No LoRA pairs found')
    return pairs


def inspect(hyperflow, sharp, base, model_source):
    """A source member name is evidence of structure, never proof of a runtime."""
    metadata = hyperflow.get('__metadata__', {})
    if metadata.get('hyperflow') != 'true':
        raise ValueError('Source is not an official-layout HyperFlow adapter')
    hpairs, spairs = _pairs(hyperflow), _pairs(sharp)
    endpoint = sorted(k for k in hpairs if '.endpoint_time_embedder.' in k)
    current_time = sorted(k for k in hpairs if '.time_embedder.' in k)
    if len(endpoint) != 2 or len(current_time) != 2:
        raise ValueError('Expected both linear layers for current and endpoint time conditioning')
    gate = float(metadata['hyperflow_gate'])
    sigmas = json.loads(metadata['hyperflow_sigmas'])
    if not math.isfinite(gate) or not 0 <= gate <= 1:
        raise ValueError('Invalid HyperFlow gate')
    if not (isinstance(sigmas, list) and len(sigmas) == 9
            and all(type(s) in (int, float) and math.isfinite(s) and 0 <= s <= 1 for s in sigmas)
            and sigmas[0] == 1 and sigmas[-1] == 0
            and all(a > b for a, b in zip(sigmas, sigmas[1:]))):
        raise ValueError('Invalid HyperFlow 8-step raw sigma schedule')
    tree = ast.parse(model_source)
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'MiniMaxH3Model']
    if len(classes) != 1:
        raise ValueError('Expected one native MiniMaxH3Model definition')
    members = {n.attr for n in ast.walk(classes[0]) if isinstance(n, ast.Attribute)}
    curve_pairs = sorted(k for k, (a, _) in spairs.items() if '.adaln_proj.linear' in k and a[1] == 8)
    base_time = {
        key: item['shape'] for key, item in base.items()
        if 'time_embedder' in key and isinstance(item, dict) and 'shape' in item
    }
    base_curve = base.get('adaln_t_table', {})
    blockers = [
        {'code': 'HYPERFLOW_TWO_TIME_RUNTIME_UNVERIFIED',
         'detail': 'Must preserve all current/endpoint LoRA pairs, clone the unpatched base time embedder, '
                   'blend emb_t(t) + gate * (emb_r(r) - emb_t(t)), supply each next sigma, and pin conditioning rows. '
                   'Native source structure alone cannot verify these semantics.'},
        {'code': 'LMS_SHARP_CURVE_RUNTIME_UNVERIFIED',
         'detail': 'LMS Sharp has 8-D AdaLN curve branches. The unpruned base uses full time embeddings; '
                   'ordinary additive LoRA merging cannot bridge those dimensions. '
                   'A checked local curve table and explicit time-driven branch implementation are required.'},
        {'code': 'IC_EXECUTION_NOT_VALIDATED',
         'detail': 'Must validate per-job clone isolation, quantized weights, low-VRAM offload, reference/audio pinning, '
                   'the 124-frame recipe, portrait handling and full-clip segmentation before enabling inference.'},
    ]
    return {
        'compatible': False,
        'status': 'blocked-runtime-adapter',
        'hyperflowRequiredForPublishedRecipe': True,
        'renamingOrLayoutConversionSufficient': False,
        'conversionWritten': False,
        'generationSubmitted': False,
        'hyperflow': {'linearPairs': len(hpairs), 'endpointPairs': endpoint, 'currentTimePairs': current_time,
                      'gate': gate, 'rawSigmas': sigmas},
        'sharp': {'linearPairs': len(spairs), 'curvePairs': curve_pairs,
                  'curveTableInAdapter': 'adaln_t_table' in sharp},
        'nativeModel': {'endpointMemberPresent': 'endpoint_time_embedder' in members,
                        'baseTimeTensors': base_time,
                        'baseCurveTableShape': base_curve.get('shape') if isinstance(base_curve, dict) else None},
        'blockers': blockers,
        'limitation': 'This is a header/source preflight, not an execution or full-file-integrity test. '
                      'It deliberately cannot certify compatibility merely from names or pair counts.',
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hyperflow', type=Path, required=True)
    parser.add_argument('--sharp', type=Path, required=True)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--model-source', type=Path, required=True)
    parser.add_argument('--report', type=Path, help='Create a new JSON evidence file; never overwrites')
    args = parser.parse_args(argv)
    try:
        source = args.model_source.read_text(encoding='utf-8-sig')
        report = inspect(read_header(args.hyperflow), read_header(args.sharp), read_header(args.base), source)
        report['modelSourceSha256'] = hashlib.sha256(source.encode()).hexdigest()
        text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
        if args.report:
            with args.report.open('x', encoding='utf-8') as stream:
                stream.write(text)
        print(text)
        return 2
    except (OSError, ValueError, KeyError, TypeError, SyntaxError) as exc:
        print(json.dumps({'compatible': False, 'status': 'invalid-or-missing-input', 'error': str(exc)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
