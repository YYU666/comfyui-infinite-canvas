"""xatlas pack-only placement with exact double-precision chart reconstruction."""
import numpy as np

def pack_natural_charts(mesh,charts,resolution,padding):
    import xatlas
    atlas=xatlas.Atlas();face_sets=[]
    for used,local,_ in charts:
        lookup=np.full(len(mesh.vertices),-1,int);lookup[used]=np.arange(len(used))
        selected=np.all(lookup[np.asarray(mesh.faces)]>=0,axis=1)
        faces=lookup[np.asarray(mesh.faces)[selected]]
        atlas.add_uv_mesh(local.astype('f4'),faces.astype('u4'));face_sets.append(faces)
    options=xatlas.PackOptions();options.resolution=resolution-2*(padding+2)
    options.padding=2*padding+4;options.bilinear=True;options.rotate_charts=False;options.rotate_charts_to_axis=False
    atlas.generate(pack_options=options)
    if atlas.atlas_count!=1:raise ValueError('Natural pack-only requires one atlas')
    fits=[];numerator=0.;denominator=0.
    for i,(_,local,_) in enumerate(charts):
        xref,faces,uv=atlas[i]
        if not np.array_equal(xref[faces],face_sets[i]):raise ValueError('Pack-only changed chart topology')
        pixel=np.asarray(uv,float)*[atlas.width,atlas.height];original=local[xref]
        a=original-original.mean(0);b=pixel-pixel.mean(0)
        numerator+=float(np.sum(a*b));denominator+=float(np.sum(a*a))
        fits.append((original,pixel))
    common=numerator/denominator
    if common<=0:raise ValueError('Pack-only reversed chart direction')
    placements=[];deviations=[]
    for original,pixel in fits:
        translation=pixel.mean(0)-common*original.mean(0)
        deviation=float(np.max(np.linalg.norm(pixel-original*common-translation,axis=1)))
        # xatlas snaps chart dimensions independently to its raster. Only use
        # its placements. Reconstruct every chart from untouched double UVs
        # with ONE common scale. This bound concerns placement clearance,
        # never permission to distort output shapes or density.
        if deviation>2.:raise ValueError('Pack-only placement deviates beyond reserved raster-rounding clearance: '+str(deviation))
        placements.append(translation);deviations.append(deviation)
    border=padding+2;factor=min(1.,(resolution-2*border)/max(atlas.width,atlas.height))
    if factor*(options.padding-2*max(deviations)-2)<padding:raise ValueError('Pack-only atlas cannot preserve requested spacing at target resolution')
    result=np.empty((len(mesh.vertices),2))
    for (used,local,_),translation in zip(charts,placements):result[used]=((local*common+translation)*factor+border)/resolution
    return result,{'backend':'xatlas add_uv_mesh pack-only; double chart reconstruction','scale':common*factor,
        'packPaddingPixelsBeforeRescale':options.padding,'atlasRescale':factor,'tileBorderPixels':border,'rotationAllowed':False,
        'maximumPlacementReconstructionDeviationPixels':max(deviations)*factor,'placementDeviationPolicy':'Raw xatlas raster rounding is discarded; output reconstructs original double charts with one shared scale and unchanged orientation; final geometric gap is independently checked','chartScaleRatio':1.0}
