"""Explicit macro hard boundaries and retained soft structural evidence."""
import numpy as np

PLANNER_VERSION = 'ai-structural-ao-v2-macro-uvatlas1'

def macro_groups(mesh, base_groups, groups, reasons, minimum_area_fraction=.002):
    n=len(mesh.faces);base=np.empty(n,int);owner=np.empty(n,int)
    for i,g in enumerate(base_groups):base[g]=i
    for i,g in enumerate(groups):owner[g]=i
    parent=np.arange(len(groups));area=np.asarray(mesh.area_faces)
    mass=np.bincount(owner,weights=area);threshold=float(area.sum())*minimum_area_fraction
    adj=np.asarray(mesh.face_adjacency);edges=np.asarray(mesh.face_adjacency_edges)
    lengths=np.linalg.norm(mesh.vertices[edges[:,0]]-mesh.vertices[edges[:,1]],axis=1)
    protected={'manual_locked','high_surface_region_boundary'}
    def root(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=int(parent[i])
        return int(i)
    initial={};initial_blocked=set()
    for (a,b),edge,length in zip(adj,edges,lengths):
        x,y=int(owner[a]),int(owner[b])
        if x==y:continue
        key=tuple(sorted((x,y)))
        if base[a]!=base[b] or reasons.get(tuple(sorted(map(int,edge)))) in protected:initial_blocked.add(key)
        initial[key]=initial.get(key,0.)+float(length)
    merges=[]
    for _ in range(len(groups)):
        boundary={};blocked=set()
        for (a,b),length in initial.items():
            x,y=root(a),root(b)
            if x==y:continue
            key=tuple(sorted((x,y)))
            if (a,b) in initial_blocked:blocked.add(key);continue
            boundary[key]=boundary.get(key,0.)+float(length)
        small=sorted((i for i in range(len(groups)) if root(i)==i and mass[i]<threshold),key=lambda i:(mass[i],i))
        choice=None
        for i in small:
            options=[(length,b if a==i else a) for (a,b),length in boundary.items() if i in (a,b) and (a,b) not in blocked]
            if options:choice=(i,max(options,key=lambda v:(v[0],mass[v[1]],-v[1]))[1]);break
        if choice is None:break
        i,j=choice;merges.append({'from':i,'to':j,'areaFraction':float(mass[i]/area.sum())});parent[i]=j;mass[j]+=mass[i]
    current=np.array([root(i) for i in owner]);result=[np.flatnonzero(current==i) for i in np.unique(current)]
    hard={};soft=[]
    for pair,edge in zip(adj,edges):
        key=tuple(sorted(map(int,edge)));reason=reasons.get(key)
        if current[pair[0]]!=current[pair[1]]:hard[key]=reason or 'coherent_constrained_group_boundary'
        elif reason in protected:raise ValueError('Protected open seam requires explicit supported topology closure')
        elif reason:soft.append({'vertices':list(key),'reason':reason,'disposition':'soft_internal_or_absorbed_micro_region'})
    # Mesh boundary constraints remain valid and need no inter-group split.
    interior=set(map(tuple,np.sort(edges,axis=1)))
    for edge,reason in reasons.items():
        if edge not in interior:hard[edge]=reason
    def distribution(parts):
        return sorted([{'faces':len(g),'areaFraction':float(area[g].sum()/area.sum())} for g in parts],key=lambda r:-r['areaFraction'])
    return hard,result,{'policyVersion':PLANNER_VERSION,'minimumMacroAreaFraction':minimum_area_fraction,
        'softEvidenceUse':'Review diagnostics only; soft edges are not UVAtlas constraints or weights.',
        'policy':'AI/manual boundaries protected; structural regions below area threshold merge only within their AI base region, by longest shared boundary; internal structural slits retained as soft evidence.',
        'before':distribution(groups),'after':distribution(result),'merges':merges,'softEdges':soft,
        'retainedHardReasonCounts':{r:sum(v==r for v in hard.values()) for r in sorted(set(reasons.values()))},
        'softReasonCounts':{r:sum(v['reason']==r for v in soft) for r in sorted(set(reasons.values()))}}
