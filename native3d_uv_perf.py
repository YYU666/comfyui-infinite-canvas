"""Per-call exact geometry metric reuse and observable UV stage timing."""
import time
import numpy as np

class ExactGeometryMetrics:
    def __init__(self, checker):
        self.checker=checker;self.snapshot=None;self.metrics=None;self.calls=0;self.hits=0
    def evaluate(self,mesh,uv,resolution,padding):
        arrays=(np.asarray(mesh.vertices),np.asarray(mesh.faces),np.asarray(uv))
        if self.snapshot is not None:
            old,res,pad=self.snapshot
            if res==resolution and pad==padding and all(a.dtype==b.dtype and a.shape==b.shape and np.array_equal(a,b) for a,b in zip(arrays,old)):
                self.hits+=1
                return dict(self.metrics)
        metrics=self.checker(mesh,uv,resolution,padding)
        self.calls+=1;self.snapshot=(tuple(a.copy() for a in arrays),resolution,padding);self.metrics=dict(metrics)
        return dict(metrics)

class UVStageTimer:
    def __init__(self,progress=None):
        self.progress=progress;self.seconds={};self.stage=None;self.started=None
    def enter(self,stage):
        self.finish()
        self.stage=stage;self.started=time.perf_counter()
        if self.progress:self.progress(stage,'start',0.)
    def finish(self):
        if self.stage is None:return
        stage=self.stage;elapsed=time.perf_counter()-self.started
        self.seconds[stage]=self.seconds.get(stage,0.)+elapsed
        self.stage=None
        if self.progress:self.progress(stage,'complete',elapsed)
