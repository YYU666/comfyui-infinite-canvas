"""Finite directional cage projection shared by all baked surface channels."""
import numpy as np


def project_cage(points, normals, cage, cast):
    points=np.asarray(points,dtype=float);normals=np.asarray(normals,dtype=float)
    lengths=np.linalg.norm(normals,axis=1,keepdims=True)
    if points.shape!=normals.shape or points.ndim!=2 or points.shape[1]!=3 or not np.isfinite(points).all() or not np.isfinite(normals).all() or np.any(lengths<1e-12) or not np.isfinite(cage) or cage<=0:
        raise ValueError('Cage projection needs finite points, nonzero normals and positive distance')
    normals=normals/lengths;origins=points+normals*cage
    rays=np.column_stack([origins,-normals]).astype(np.float32)
    result={key:np.asarray(value) for key,value in cast(rays).items()}
    distance=result['t_hit'];within=np.isfinite(distance)&(distance>=0)&(distance<=2*cage)
    geometric=np.asarray(result['primitive_normals'],dtype=float)
    facing=np.sum(geometric*normals,axis=1)
    backface=within&(facing<=0)
    invalid_geometric=within&(~np.isfinite(geometric).all(axis=1)|(np.linalg.norm(geometric,axis=1)<1e-12))
    valid=within&~backface&~invalid_geometric
    result['backfaceRejectedMask']=backface
    result['nonOutwardRejectedMask']=backface
    result['invalidGeometricNormalMask']=invalid_geometric
    # Invalid points stay nonfinite: downstream taps must never interpolate
    # Open3D's UINT_MAX miss primitive identifier.
    found=np.full_like(points,np.nan)
    found[valid]=rays[valid,:3]+rays[valid,3:]*distance[valid,None]
    result['points']=found;result['valid']=valid
    result['projection_distance']=np.where(valid,distance-cage,np.nan)
    return result


class ExternalVisibleProjector:
    """Bounded candidate search; nearest geometry is never an unverified hit."""
    def __init__(self, vertices, faces, cast, diagonal, epsilon, chunk_size=2048):
        from scipy.spatial import cKDTree
        self.vertices=np.asarray(vertices);self.faces=np.asarray(faces);self.cast=cast
        self.diagonal=float(diagonal);self.cap=self.diagonal*.04;self.epsilon=epsilon
        self.chunk_size=min(2048,max(1,int(chunk_size)))
        self.triangles=self.vertices[self.faces]
        centers=self.triangles.mean(axis=1)
        radii=np.linalg.norm(self.triangles-centers[:,None,:],axis=2).max(axis=1)
        self.large=np.flatnonzero(radii>self.cap*.25)
        self.enabled=len(self.large)<=4096
        self.tree=cKDTree(centers) if self.enabled else None
        self.large_min=self.triangles[self.large].min(axis=1)
        self.large_max=self.triangles[self.large].max(axis=1)
        cross=np.cross(self.triangles[:,1]-self.triangles[:,0],self.triangles[:,2]-self.triangles[:,0])
        self.normals=cross/np.maximum(np.linalg.norm(cross,axis=1,keepdims=True),1e-30)
        self.report={'method':'k32 triangle-center candidates; unresolved samples only retry k64; both include relevant large-face bounding boxes and unchanged external first-hit certification',
            'cap':self.cap,'candidateCount':32,'queryChunkLimit':self.chunk_size,
            'largeFaceRadiusThreshold':self.cap*.25,'largeFaces':int(len(self.large)),
            'candidateTiers':[32,64],'maximumCenterCandidates':64,'tiers':{},
            'enabled':self.enabled,'disabledReason':None if self.enabled else 'more than4096 large-face supplements; refusing incomplete unbounded search',
            'certificationTolerance':4*epsilon,'scopes':{},
            'nearTiePolicy':'float64 candidate q distance; shared oriented manifold vertex-fan ties permitted; independent/nonmanifold sheets rejected',
            'limitations':['Finite candidate search is not globally optimal.','Visibility is certified along oriented candidate geometric normal; open/nonmanifold surfaces and smooth sampling across layers still require review.']}
        self._incident_faces=None;self._incident_offsets=None;self._fan_cache={}

    def _same_oriented_fan(self,a,b):
        if a==b:return True
        shared=set(self.faces[a])&set(self.faces[b])
        if not shared:return False
        if self._incident_faces is None:
            flat=self.faces.ravel()
            order=np.argsort(flat,kind='stable');order//=3
            self._incident_faces=order
            self._incident_offsets=np.r_[0,np.cumsum(np.bincount(flat,minlength=len(self.vertices)))]
        for vertex in shared:
            vertex=int(vertex)
            if vertex not in self._fan_cache:
                start,end=self._incident_offsets[vertex:vertex+2]
                fids=self._incident_faces[start:end];edges={};signs={}
                for fi in fids:
                    face=self.faces[fi];k=int(np.flatnonzero(face==vertex)[0])
                    for other,sign in [(int(face[(k+1)%3]),1),(int(face[(k+2)%3]),-1)]:
                        edges.setdefault(other,[]).append(int(fi));signs.setdefault(other,[]).append(sign)
                manifold=all(len(group)<=2 for group in edges.values())
                oriented=all(len(group)<2 or sum(signs[other])==0 for other,group in edges.items())
                labels={}
                if manifold and oriented:
                    adjacent={int(fi):set() for fi in fids}
                    for group in edges.values():
                        for fi in group:adjacent[fi].update(group)
                    for fi in fids:
                        fi=int(fi)
                        if fi in labels:continue
                        stack=[fi];labels[fi]=fi
                        while stack:
                            current=stack.pop()
                            for neighbor in adjacent[current]:
                                if neighbor not in labels:labels[neighbor]=fi;stack.append(neighbor)
                self._fan_cache[vertex]=labels
            labels=self._fan_cache[vertex]
            if a in labels and b in labels and labels[a]==labels[b]:return True
        return False

    def project(self, points, low_normals, scope='tap'):
        points=np.asarray(points,dtype=float);low_normals=np.asarray(low_normals,dtype=float)
        keys=('candidatePairs','certifiedPairs','ambiguousNearTies','topologyResolvedNearTies')
        tiers=self.report['tiers'].setdefault(scope,{})
        before={key:sum(tier.get(key,0) for tier in tiers.values()) for key in keys}
        result=self._project_tier(points,low_normals,scope,32)
        missing=~result['valid']
        # Accepted first-tier choices are immutable, including all barycentric,
        # point and primitive-normal data consumed by the material sampler.
        if missing.any() and self.enabled and len(self.faces)>32:
            extra=self._project_tier(points[missing],low_normals[missing],scope,64)
            for key in result:result[key][missing]=extra[key]
        row=self.report['scopes'].setdefault(scope,{'queries':0,'accepted':0,'remaining':0,**dict.fromkeys(keys,0)})
        row['queries']+=len(points);row['accepted']+=int(result['valid'].sum());row['remaining']+=int((~result['valid']).sum())
        for key in keys:row[key]+=sum(tier.get(key,0) for tier in tiers.values())-before[key]
        return result

    def _project_tier(self, points, low_normals, scope, candidate_count):
        if candidate_count not in (32,64):
            raise ValueError('External-visible candidate tier must be 32 or 64')
        import trimesh
        points=np.asarray(points,dtype=float);low_normals=np.asarray(low_normals,dtype=float)
        low_normals=low_normals/np.maximum(np.linalg.norm(low_normals,axis=1,keepdims=True),1e-30)
        n=len(points);result={'points':np.full((n,3),np.nan),'valid':np.zeros(n,bool),
            't_hit':np.full(n,np.inf,dtype=np.float32),'primitive_ids':np.full(n,2**32-1,dtype=np.uint32),
            'geometry_ids':np.full(n,2**32-1,dtype=np.uint32),'primitive_uvs':np.zeros((n,2),np.float32),
            'primitive_normals':np.zeros((n,3),np.float32),'projection_distance':np.full(n,np.nan)}
        row=self.report['tiers'].setdefault(scope,{}).setdefault(str(candidate_count),{'queries':0,'accepted':0,'remaining':0,'candidatePairs':0,'certifiedPairs':0,'ambiguousNearTies':0,'topologyResolvedNearTies':0})
        row['queries']+=n
        if not self.enabled or not n:
            row['remaining']+=n
            return result
        for start in range(0,n,self.chunk_size):
            p=points[start:start+self.chunk_size];ln=low_normals[start:start+self.chunk_size]
            _,candidate=self.tree.query(p,k=min(candidate_count,len(self.faces)))
            candidate=np.asarray(candidate).reshape(len(p),-1);sample=[];faces=[]
            for i in range(len(p)):
                separation=np.maximum(np.maximum(self.large_min-p[i],p[i]-self.large_max),0)
                more=self.large[(separation**2).sum(axis=1)<=self.cap**2]
                ids=np.unique(np.concatenate([candidate[i],more])).astype(np.int64)
                sample.extend([i]*len(ids));faces.extend(ids)
            si=np.asarray(sample);fi=np.asarray(faces)
            q=trimesh.triangles.closest_point(self.triangles[fi],p[si])
            distance=np.linalg.norm(q-p[si],axis=1);within=distance<=self.cap
            si=si[within];fi=fi[within];q=q[within];distance=distance[within]
            row['candidatePairs']+=len(q)
            if not len(q):continue
            direction=self.normals[fi].copy()
            direction*=np.where(np.sum(direction*ln[si],axis=1)>=0,1.,-1.)[:,None]
            offset=2*self.diagonal
            rays=np.column_stack([q+direction*offset,-direction]).astype(np.float32)
            found=self.cast(rays);finite=np.isfinite(found['t_hit'])
            landing=np.full_like(q,np.nan)
            landing[finite]=rays[finite,:3]+rays[finite,3:]*found['t_hit'][finite,None]
            actual_distance=np.linalg.norm(landing-p[si],axis=1)
            certified=finite&(np.linalg.norm(landing-q,axis=1)<=self.epsilon*4)&(actual_distance<=self.cap)
            certified&=(np.sum(found['primitive_normals']*ln[si],axis=1)>0)&(np.sum(found['primitive_normals']*direction,axis=1)>0)
            row['certifiedPairs']+=int(certified.sum())
            options_all=np.flatnonzero(certified)
            order=np.lexsort((fi[options_all],distance[options_all],si[options_all]));options_all=options_all[order]
            splits=np.flatnonzero(np.diff(si[options_all]))+1
            for options in np.split(options_all,splits):
                if not len(options):continue
                best=options[0];i=si[best]
                near=options[distance[options]<=distance[best]+self.epsilon*4]
                # Tied points on unrelated sheets are unresolved, not arbitrarily
                # selected by primitive index. Shared-edge ties are one point.
                conflicts=near[(np.linalg.norm(landing[near]-landing[best],axis=1)>self.epsilon*8)&
                    (np.sum(found['primitive_normals'][near]*found['primitive_normals'][best],axis=1)<.5)]
                ambiguous=any(not self._same_oriented_fan(int(found['primitive_ids'][best]),int(found['primitive_ids'][other])) for other in conflicts)
                if ambiguous:
                    row['ambiguousNearTies']+=1
                    continue
                if len(conflicts):row['topologyResolvedNearTies']+=1
                target=start+i;result['points'][target]=landing[best];result['valid'][target]=True
                for key in ('t_hit','primitive_ids','primitive_uvs','primitive_normals','geometry_ids'):
                    if key in found:result[key][target]=found[key][best]
                result['projection_distance'][target]=actual_distance[best]
        row['accepted']+=int(result['valid'].sum());row['remaining']+=int((~result['valid']).sum())
        return result
