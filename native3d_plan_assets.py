"""Bounded passive UV-plan uploads; never extract or execute uploaded data."""
import hashlib
import json
from pathlib import Path
import zipfile

LIMITS = {'uv-plan.json':32*1024**2, 'uv-plan-overlay.bin':64*1024**2,
          'uv-plan-evidence.npz':64*1024**2}

def validate(path, name):
    path=Path(path)
    if name not in LIMITS or not 0<path.stat().st_size<=LIMITS[name]:
        raise ValueError('Invalid bounded UV plan artifact')
    if name=='uv-plan.json':
        data=json.loads(path.read_text(encoding='utf-8'),parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        if not isinstance(data,dict) or data.get('kind')!='native3d_uv_plan' or data.get('version')!=1:
            raise ValueError('Unsupported UV plan structure')
        payload={k:v for k,v in data.items() if k!='planSha256'}
        digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        if data.get('planSha256')!=digest:raise ValueError('UV plan digest mismatch')
        for key in ('source','settings','overlay','evidence'):
            if not isinstance(data.get(key),dict):raise ValueError('Missing UV plan descriptor')
    elif name=='uv-plan-overlay.bin':
        if path.stat().st_size%4:raise ValueError('Invalid UV plan array alignment')
    else:
        names={key+'.npy' for key in ('regions','rawRegions','confidence','supported','darkness','groupOwner','highLabels')}
        with zipfile.ZipFile(path) as archive:
            entries=archive.infolist()
            if len(entries)!=len(names) or {e.filename for e in entries}!=names or sum(e.file_size for e in entries)>64*1024**2:
                raise ValueError('Unsupported UV evidence archive')
            for entry in entries:
                if entry.flag_bits&1:raise ValueError('Encrypted UV evidence unsupported')
                with archive.open(entry) as stream:
                    if stream.read(6)!=b'\x93NUMPY':raise ValueError('Invalid UV evidence array')
