"""Deterministic high-surface cosine AO, independent of low mesh UV frames."""
import numpy as np


def _unit(values):
    values=np.asarray(values,dtype=float);length=np.linalg.norm(values,axis=-1,keepdims=True)
    if not np.isfinite(values).all() or np.any(length<1e-12):
        raise ValueError('AO needs finite nonzero high-surface normals')
    return values/length


def cosine_hammersley(samples):
    if type(samples) is not int or samples<1 or samples>4096:
        raise ValueError('AO cosine sequence needs1..4096 samples')
    index=np.arange(samples,dtype=np.uint32);bits=index.copy()
    bits=(bits<<16)|(bits>>16)
    bits=((bits & 0x55555555)<<1)|((bits & 0xaaaaaaaa)>>1)
    bits=((bits & 0x33333333)<<2)|((bits & 0xcccccccc)>>2)
    bits=((bits & 0x0f0f0f0f)<<4)|((bits & 0xf0f0f0f0)>>4)
    bits=((bits & 0x00ff00ff)<<8)|((bits & 0xff00ff00)>>8)
    u=(np.arange(samples,dtype=float)+.5)/samples
    phi=2*np.pi*bits.astype(float)/2**32
    radius=np.sqrt(u)
    return np.column_stack([radius*np.cos(phi),radius*np.sin(phi),np.sqrt(1-u)])


def high_surface_frame(normals):
    """Frisvad/Duff ONB: no arbitrary low-triangle axes or per-face rotation."""
    n=_unit(normals);sign=np.where(n[:,2]>=0,1.,-1.);a=-1/(sign+n[:,2]);b=n[:,0]*n[:,1]*a
    t=np.column_stack([1+sign*n[:,0]**2*a,sign*b,-sign*n[:,0]])
    bt=np.column_stack([b,sign+n[:,1]**2*a,-n[:,1]])
    return n,t,bt


def sample_high_surface_ao(points,high_normals,samples,radius,epsilon,cast_distances,geometric_normals=None,attenuation='none'):
    points=np.asarray(points,dtype=float)
    if points.shape!=(len(points),3) or not np.isfinite(points).all() or not np.isfinite(radius) or not np.isfinite(epsilon) or radius<=0 or epsilon<=0:
        raise ValueError('AO points, radius and epsilon must be finite and positive')
    if type(attenuation) is not str or attenuation not in ('none','linear'):
        raise ValueError('AO attenuation must be none or linear')
    if not len(points):return np.empty(0)
    n,t,b=high_surface_frame(geometric_normals if geometric_normals is not None else high_normals)
    if len(n)!=len(points):raise ValueError('AO normals must match high-surface points')
    bias_n=_unit(geometric_normals) if geometric_normals is not None else n
    if bias_n.shape!=points.shape:raise ValueError('AO geometric normals must match points')
    origins=points+bias_n*epsilon;occluded=np.zeros(len(points),dtype=float)
    for x,y,z in cosine_hammersley(samples):
        direction=t*x+b*y+n*z
        distances=np.asarray(cast_distances(np.column_stack([origins,direction]).astype(np.float32)))
        if distances.shape!=(len(points),) or np.isnan(distances).any() or np.any(distances<0):raise ValueError('AO ray query returned invalid distances')
        occluded+=(distances<radius) if attenuation=='none' else np.maximum(1-distances/radius,0)
    return 1-occluded/samples
