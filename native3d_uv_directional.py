"""Experimental natural directional charts preserving the exact source mesh."""
import numpy as np
import trimesh

def directional_parts(mesh,face_ids,min_dot=.35):
    face_ids=np.asarray(face_ids,np.int64);normals=np.asarray(mesh.face_normals);areas=np.asarray(mesh.area_faces)
    adjacency=np.asarray(mesh.face_adjacency);mask=np.zeros(len(mesh.faces),bool);mask[face_ids]=True
    adjacency=adjacency[mask[adjacency].all(1)]
    remaining=set(map(int,face_ids));parts=[]
    while remaining:
        ids=np.array(sorted(remaining));axis=(normals[ids]*areas[ids,None]).sum(0)
        if np.linalg.norm(axis)<1e-12:axis=normals[ids[np.argmax(areas[ids])]].copy()
        axis/=np.linalg.norm(axis);eligible=ids[normals[ids]@axis>=min_dot]
        if not len(eligible):
            axis=normals[ids[np.argmax(areas[ids])]].copy();eligible=ids[normals[ids]@axis>=min_dot]
        active=np.zeros(len(mesh.faces),bool);active[eligible]=True
        links=adjacency[active[adjacency].all(1)]
        for component in trimesh.graph.connected_components(links,nodes=eligible,min_len=1):parts.append((np.asarray(sorted(component)),axis.copy()))
        remaining.difference_update(map(int,eligible))
    return parts

def projected_uv(vertices,axis):
    ref=np.eye(3)[np.argmin(abs(axis))];x=np.cross(ref,axis);x/=np.linalg.norm(x);y=np.cross(axis,x)
    return np.column_stack((vertices@x,vertices@y))
