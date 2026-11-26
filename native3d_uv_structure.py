"""Ordered structural seam evidence with explicit physical-scale noise guards.

Geometry only; never edits positions, runs inference, unwraps or packs UVs.
"""
import numpy as np
import trimesh
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

MODE='ai_structure_ao_v2'
ALGORITHM_VERSION='geometric-hysteresis-v1'
HYSTERESIS_RATIO=.5
DEFAULTS={'seamPlanningMode':MODE,'convexAngleDegrees':45.,'concaveAngleDegrees':45.,
          'structureScaleFraction':.02,'structureMinChainLengthFraction':.04,
          'aoConcaveAngleDegrees':35.,'aoDarknessThreshold':.2}


def connected_open_seam_groups(mesh,base_groups,reasons):
    """True face components after cutting adjacency, within immutable AI groups.

    An open interior seam may reconnect around its endpoints. It remains an
    explicit frozen edge constraint for the parameterizer, not a fake island.
    """
    n=len(mesh.faces);joined=np.concatenate(base_groups) if base_groups else np.empty(0,np.int64)
    if not np.array_equal(np.sort(joined),np.arange(n)):raise ValueError('Invalid AI base partition')
    base_owner=np.empty(n,np.int64)
    for index,group in enumerate(base_groups):base_owner[group]=index
    adjacent=np.asarray(mesh.face_adjacency);edges=np.asarray(mesh.face_adjacency_edges)
    same=base_owner[adjacent[:,0]]==base_owner[adjacent[:,1]]
    cut=np.asarray([tuple(sorted(map(int,e))) in reasons for e in edges],bool)
    retained=adjacent[same&~cut]
    row=np.r_[retained[:,0],retained[:,1]];column=np.r_[retained[:,1],retained[:,0]]
    graph=coo_matrix((np.ones(len(row),bool),(row,column)),shape=(n,n)).tocsr()
    count,owner=connected_components(graph,directed=False,return_labels=True)
    order=np.argsort(owner,kind='stable');boundaries=np.flatnonzero(np.diff(owner[order]))+1
    groups=[part.astype(np.int64) for part in np.split(order,boundaries)]
    return groups,{'semanticsVersion':'connected-open-seams1','baseAIgroups':len(base_groups),'connectedGroups':int(count),
        'openInternalReasonEdges':int((cut&same&(owner[adjacent[:,0]]==owner[adjacent[:,1]])).sum()),
        'separatingReasonEdges':int((cut&(owner[adjacent[:,0]]!=owner[adjacent[:,1]])).sum()),
        'crossBaseAdjacencyProtected':int((~same).sum()),
        'policy':'Within each protected AI base group, remove actual reason adjacency and take ordinary face-connected components. Open internal seams remain explicit parameterizer constraints; no forbidden union or invented closure boundary.'}


def _macro_turn(mesh,selected,radius):
    """Area normals from opposite across-edge halfspaces, never one shared mean."""
    adjacency=np.asarray(mesh.face_adjacency);edges=np.asarray(mesh.face_adjacency_edges)
    centers=np.asarray(mesh.triangles_center);normal=np.asarray(mesh.face_normals);area=np.asarray(mesh.area_faces)
    tree=cKDTree(centers);angles=np.full(len(edges),np.nan);supported=np.zeros(len(edges),bool)
    neighbors=[[] for _ in mesh.faces]
    for a,b in adjacency:neighbors[a].append(int(b));neighbors[b].append(int(a))
    for start in range(0,len(selected),512):
        ids=selected[start:start+512];mid=np.asarray(mesh.vertices)[edges[ids]].mean(axis=1)
        neighborhoods=tree.query_ball_point(mid,radius)
        for index,point,near in zip(ids,mid,neighborhoods):
            a,b=adjacency[index];u=mesh.vertices[edges[index,1]]-mesh.vertices[edges[index,0]];u=u/np.linalg.norm(u)
            n=normal[a]+normal[b];norm=np.linalg.norm(n)
            if norm<=1e-12:continue
            n=n/norm;t=np.cross(u,n);t=t/np.linalg.norm(t)
            side=np.dot(centers[[a,b]]-point,t)
            if side[0]*side[1]>=0:continue
            # Spatial proximity alone must not borrow support from a nearby
            # shell or a different fold connected only outside this patch.
            allowed=set(map(int,near));allowed.update((int(a),int(b)))
            connected={int(a),int(b)};pending=list(connected)
            while pending:
                current=pending.pop()
                for other in neighbors[current]:
                    if other in allowed and other not in connected:connected.add(other);pending.append(other)
            faces=np.asarray(sorted(connected),np.int64)
            faces=faces[(normal[faces]@n)>0]
            projection=(centers[faces]-point)@t
            weights=np.minimum(area[faces],radius*radius)
            vectors=[]
            for positive in (True,False):
                mask=projection>0 if positive else projection<0
                if weights[mask].sum()<radius*radius*.05:break
                vector=np.sum(normal[faces[mask]]*weights[mask,None],axis=0);length=np.linalg.norm(vector)
                if length<=1e-12:break
                vectors.append(vector/length)
            if len(vectors)==2:
                angles[index]=np.degrees(np.arccos(np.clip(np.dot(vectors[0],vectors[1]),-1,1)));supported[index]=True
    return angles,supported


def _chains(mesh,selected,minimum_length,minimum_extent,*,seeds=None,region_labels=None):
    empty={'candidateChains':0,'seededChains':0,'retainedChains':0,'retainedEdges':0,'retainedStrongEdges':0,'retainedContinuationEdges':0,'largestRetainedChains':[]}
    if not len(selected):return np.empty(0,np.int64),empty
    edges=np.asarray(mesh.face_adjacency_edges)[selected]
    length=np.linalg.norm(mesh.vertices[edges[:,1]]-mesh.vertices[edges[:,0]],axis=1)
    seed_set=set(map(int,selected if seeds is None else seeds));partitions={}
    adjacent=np.asarray(mesh.face_adjacency)[selected]
    for position,pair in enumerate(adjacent):
        key=(0,0) if region_labels is None else tuple(sorted(map(int,region_labels[pair])))
        partitions.setdefault(key,[]).append(position)
    kept=[];records=[];component_count=seeded_count=strong_count=0
    for positions in partitions.values():
        positions=np.asarray(positions,np.int64);local_edges=edges[positions]
        components=trimesh.graph.connected_components(local_edges,nodes=np.unique(local_edges),min_len=1);component_count+=len(components)
        owner=np.full(len(mesh.vertices),-1,np.int64)
        for index,vertices in enumerate(components):owner[vertices]=index
        edge_owner=owner[local_edges[:,0]]
        for index,vertices in enumerate(components):
            local=positions[edge_owner==index];strong=sum(int(selected[i]) in seed_set for i in local)
            if not strong:continue
            seeded_count+=1;total=float(length[local].sum());extent=float(np.linalg.norm(np.ptp(mesh.vertices[vertices],axis=0)))
            if total>=minimum_length and extent>=minimum_extent:
                kept.extend(selected[local]);strong_count+=strong
                records.append({'edges':len(local),'strongEdges':strong,'continuationEdges':len(local)-strong,'length':total,'extent':extent})
    return np.asarray(sorted(kept),np.int64),{'candidateChains':component_count,'seededChains':seeded_count,'retainedChains':len(records),'retainedEdges':len(kept),
        'retainedStrongEdges':strong_count,'retainedContinuationEdges':len(kept)-strong_count,'largestRetainedChains':sorted(records,key=lambda x:(-x['length'],-x['extent']))[:16]}


def structural_stages(mesh,parameters,confidence,supported,darkness,protected_edges=(),diagnostics=False,region_labels=None):
    """Return convex/concave/AO edge sets plus compact, reproducible stage stats."""
    from native3d_uv import structural_edges
    structural_edges(mesh,{'orientationConfirmed':parameters['orientationConfirmed'],'concaveAngleDegrees':180.,'sharpAngleDegrees':180.})
    n=len(mesh.faces);confidence=np.asarray(confidence);supported=np.asarray(supported);darkness=np.asarray(darkness)
    if any(x.shape!=(n,) for x in (confidence,supported,darkness)) or supported.dtype!=np.dtype(bool) or not np.isfinite(confidence).all() or not np.isfinite(darkness).all():raise ValueError('Invalid structural evidence arrays')
    if np.any((confidence<0)|(confidence>1)) or np.any((darkness<0)|(darkness>1)):raise ValueError('Invalid structural evidence probabilities')
    if region_labels is not None:
        region_labels=np.asarray(region_labels)
        if region_labels.shape!=(n,) or not np.issubdtype(region_labels.dtype,np.integer):raise ValueError('Invalid structural region labels')
    adjacent=np.asarray(mesh.face_adjacency);edges=np.asarray(mesh.face_adjacency_edges);angle=np.degrees(mesh.face_adjacency_angles);convex=np.asarray(mesh.face_adjacency_convex)
    diagonal=float(np.linalg.norm(mesh.extents));radius=parameters['structureScaleFraction']*diagonal
    if not np.isfinite(diagonal) or diagonal<=0 or not np.isfinite(radius) or radius<=0:raise ValueError('Invalid structural physical scale')
    protected=set(protected_edges);available=np.array([tuple(sorted(map(int,e))) not in protected for e in edges],bool)
    minimum=min(parameters['convexAngleDegrees'],parameters['concaveAngleDegrees'],parameters['aoConcaveAngleDegrees'])*HYSTERESIS_RATIO
    macro,macro_supported=_macro_turn(mesh,np.flatnonzero(available&(angle>=minimum)),radius)
    ao_support=supported[adjacent].all(axis=1)&(confidence[adjacent]>=.65).all(axis=1)
    ao_darkness=darkness[adjacent].mean(axis=1)
    specifications=[('convex_structural',convex,parameters['convexAngleDegrees'],np.ones(len(edges),bool)),
                    ('concave_structural',~convex,parameters['concaveAngleDegrees'],np.ones(len(edges),bool)),
                    ('ao_supported_signed_concave',~convex,parameters['aoConcaveAngleDegrees'],ao_support&(ao_darkness>=parameters['aoDarknessThreshold']))]
    output={};stats=[]
    for reason,sign,threshold,evidence in specifications:
        raw=sign&(angle>=threshold);eligible=raw&available&evidence
        continuation=threshold*HYSTERESIS_RATIO
        weak=sign&(angle>=continuation)&available&evidence&macro_supported&(macro>=continuation)
        strong=weak&raw
        retained,chains=_chains(mesh,np.flatnonzero(weak),parameters['structureMinChainLengthFraction']*diagonal,
            parameters['structureMinChainLengthFraction']*diagonal*.5,seeds=np.flatnonzero(strong),region_labels=region_labels)
        output[reason]={tuple(sorted(map(int,e))) for e in edges[retained]}
        stats.append({'reason':reason,'angleDegrees':float(threshold),'rawAngleEdges':int(raw.sum()),'protectedByEarlierAI':int((raw&~available).sum()),
            'eligibleEvidenceEdges':int(eligible.sum()),'macroSupportedEdges':int(strong.sum()),'strongSeedEdges':int(strong.sum()),
            'weakContinuationEdges':int((weak&~strong).sum()),'continuationAngleDegrees':float(continuation),'minimumMacroAngleDegrees':float(continuation),**chains})
    summary={'mode':MODE,'algorithmVersion':ALGORITHM_VERSION,'hysteresisRatio':HYSTERESIS_RATIO,'physicalRadius':radius,'scaleFraction':parameters['structureScaleFraction'],'minimumChainLength':parameters['structureMinChainLengthFraction']*diagonal,
        'minimumChainExtent':parameters['structureMinChainLengthFraction']*diagonal*.5,'stages':stats,
        'macroPolicy':'Opposite across-edge halfspaces at the edge midpoint; centroid-radius neighborhoods plus exact incident faces, restricted to their induced face-connected patch; area-weighted outward-facing normals independently per side; minimum each-side area 5% of radius squared',
        'chainPolicy':'Same-sign, same AI region-pair weak-edge components must contain a strong seed; weak edges retain every macro and source-evidence gate; physical summed length and extent must both pass. No invented edge or free-space connection.',
        'limitations':['Configured angles are strong seed thresholds; fixed one-half-angle continuation requires a connected strong seed and the full physical-scale evidence. Gradual turns below the continuation angle are not nominated.',
            'Macro patches use centroid-radius neighborhoods, not an exhaustive geodesic neighborhood or every triangle intersecting the radius.',
            'Connected chains can branch; length alone is insufficient, so physical extent and two-sided normal evidence also apply.',
            'AO only adds high-supported signed concave edges; a dark planar or convex surface never nominates an AO seam.']}
    if diagnostics:summary['diagnosticArrays']={'rawAngleDegrees':angle,'macroAngleDegrees':macro,'macroSupported':macro_supported}
    return output,summary
