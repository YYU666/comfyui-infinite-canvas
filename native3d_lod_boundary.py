"""Original-source open boundary topology and certified polyline distance gate."""
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.optimize import linear_sum_assignment
from native3d_geometry import mesh_hash


def _boundary_topology(vertices,faces):
    v=np.asarray(vertices,float);f=np.asarray(faces,np.int64)
    used,local=np.unique(f,return_inverse=True);compact=local.reshape(-1,3)
    edges=np.sort(np.concatenate((compact[:,[0,1]],compact[:,[1,2]],compact[:,[2,0]])),axis=1)
    edges,counts=np.unique(edges,axis=0,return_counts=True)
    if np.any(counts>2):raise ValueError('Boundary proof requires manifold edges')
    graph=coo_matrix((np.ones(len(edges),np.uint8),(edges[:,0],edges[:,1])),shape=(len(used),len(used))).tocsr()
    number,labels=connected_components(graph,directed=False)
    if number>128:raise ValueError('Boundary proof exceeds128 connected components')
    coordinates=v[used];boundary=edges[counts==1];adj={}
    for a,b in boundary:adj.setdefault(int(a),[]).append(int(b));adj.setdefault(int(b),[]).append(int(a))
    if any(len(n)!=2 for n in adj.values()):raise ValueError('Boundary proof requires disjoint simple cycles with degree2')
    vertex_counts=np.bincount(labels,minlength=number)
    edge_counts=np.bincount(labels[edges[:,0]],minlength=number)
    face_counts=np.bincount(labels[compact[:,0]],minlength=number)
    centers=np.column_stack([np.bincount(labels,weights=coordinates[:,axis],minlength=number) for axis in range(3)])/vertex_counts[:,None]
    components=[{'euler':int(vertex_counts[i]-edge_counts[i]+face_counts[i]),'center':centers[i],'loops':[]} for i in range(number)]
    seen=set()
    for first in sorted(adj):
        if first in seen:continue
        cycle=[];previous=None;current=first
        while current not in seen:
            seen.add(current);cycle.append(current);neighbors=adj[current];following=neighbors[0] if neighbors[0]!=previous else neighbors[1];previous,current=current,following
        if current!=first or len(cycle)<3:raise ValueError('Boundary cycle branches or has fewer than3vertices')
        points=coordinates[cycle];segments=np.stack((points,np.roll(points,-1,axis=0)),axis=1)
        lengths=np.linalg.norm(segments[:,1]-segments[:,0],axis=1)
        if np.any(lengths<=0):raise ValueError('Zero-length boundary edge')
        components[int(labels[first])]['loops'].append({'segments':segments,'lengths':lengths,'perimeter':float(lengths.sum()),'center':points.mean(0)})
    if sum(len(c['loops']) for c in components)>128:raise ValueError('Boundary proof exceeds128 source loops')
    return components,len(boundary)


def _certified_distance(source,target,limit):
    """Distance-to-set is1-Lipschitz; finite subdivision covers every point."""
    segments=source['segments'];lengths=source['lengths'];target=target['segments']
    a=target[:,0];ab=target[:,1]-a;den=np.sum(ab*ab,axis=1)
    spacing=limit/4.;evaluations=0
    for refinement in range(5):
        steps=np.maximum(1,np.ceil(lengths/spacing).astype(int));count=int(sum(steps+1))
        if count>200000 or evaluations+count*len(target)>100000000:raise ValueError('Boundary distance proof exceeded bounded work budget')
        points=np.concatenate([edge[0]+np.linspace(0,1,int(n)+1)[:,None]*(edge[1]-edge[0]) for edge,n in zip(segments,steps)])
        maximum=0.
        for offset in range(0,len(points),64):
            delta=points[offset:offset+64,None,:]-a;t=np.clip(np.sum(delta*ab,axis=2)/den,0,1)
            distances=np.sqrt(np.sum((delta-t[:,:,None]*ab)**2,axis=2)).min(1);maximum=max(maximum,float(distances.max()))
        evaluations+=count*len(target);gap=float(np.max(lengths/steps));upper=maximum+gap/2
        receipt={'sampledMaxDistance':maximum,'certifiedMaxDistanceUpperBound':upper,'maximumSampleGap':gap,'samples':count,'refinements':refinement,'distanceEvaluations':evaluations}
        if upper<=limit:return receipt
        if maximum>limit:raise ValueError('Original boundary distance exceeds independent shape budget: '+str(maximum)+' > '+str(limit))
        spacing/=2
    raise ValueError('Boundary distance upper bound could not be certified within budget')


class OriginalBoundaryReference:
    def __init__(self,vertices,faces):
        self.components,self.edge_count=_boundary_topology(vertices,faces)
        self.mesh_hash=mesh_hash(vertices,faces)
        self.diagonal=float(np.linalg.norm(np.ptp(np.asarray(vertices),axis=0)))
        if self.diagonal<=0:raise ValueError('Original boundary reference extent invalid')

    def compare(self,vertices,faces):
        components,edges=_boundary_topology(vertices,faces)
        if len(components)!=len(self.components):raise ValueError('Boundary proof changed connected-component count')
        costs=np.linalg.norm(np.asarray([c['center'] for c in self.components])[:,None]-np.asarray([c['center'] for c in components])[None,:],axis=2)
        left,right=linear_sum_assignment(costs);rows=[]
        for i,j in zip(left,right):
            original,child=self.components[i],components[j]
            if original['euler']!=child['euler'] or len(original['loops'])!=len(child['loops']):raise ValueError('Original boundary component Euler characteristic or loop count changed')
            if not original['loops']:continue
            costs=np.linalg.norm(np.asarray([x['center'] for x in original['loops']])[:,None]-np.asarray([x['center'] for x in child['loops']])[None,:],axis=2)
            # Perimeter disambiguates concentric loops with identical centroids.
            original_perimeters=np.asarray([x['perimeter'] for x in original['loops']])
            child_perimeters=np.asarray([x['perimeter'] for x in child['loops']])
            costs=costs/self.diagonal+np.abs(np.log(original_perimeters[:,None]/child_perimeters[None,:]))
            a,b=linear_sum_assignment(costs)
            for x,y in zip(a,b):
                source,target=original['loops'][x],child['loops'][y];ratio=target['perimeter']/source['perimeter']
                if not .95<=ratio<=1.05:raise ValueError('Original boundary perimeter changed by more than5percent')
                limit=min(self.diagonal*.005,source['perimeter']*.01)
                rows.append({'originalComponent':int(i),'candidateComponent':int(j),'originalLoop':int(x),'candidateLoop':int(y),
                             'originalEdges':len(source['segments']),'candidateEdges':len(target['segments']),
                             'originalPerimeter':source['perimeter'],'candidatePerimeter':target['perimeter'],'perimeterRatio':ratio,
                             'maximumDistanceBudget':limit,'originalToCandidate':_certified_distance(source,target,limit),
                             'candidateToOriginal':_certified_distance(target,source,limit)})
        return {'accepted':True,'method':'original-source per-component Euler/cycle correspondence; bidirectional exact point-to-segment samples with1-Lipschitz full-polyline upper bounds',
                'referenceMeshHash':self.mesh_hash,'candidateMeshHash':mesh_hash(vertices,faces),
                'correspondencePolicy':'deterministic geometric centroid/perimeter candidates plus complete distance gates; no semantic loop identity claimed',
                'reference':'immutable normalized original source, not previous LOD','originalBoundaryEdges':self.edge_count,'candidateBoundaryEdges':edges,
                'maximumOriginalDiagonalFraction':.005,'maximumOriginalLoopPerimeterFraction':.01,'perimeterRatioLimits':[.95,1.05],
                'loopCount':len(rows),'componentCount':len(components),'loops':rows,'exactBoundaryCoordinatesRequired':False,
                'surfaceFidelityAndCompleteIntersectionAuditStillRequired':True}
