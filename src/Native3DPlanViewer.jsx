import React,{useEffect,useRef,useState} from 'react';
import {nativeAssetUrl} from './native3d.js';
import {decodePlanOverlay,planEdgeLayers,planEdgeLayerVisible} from './native3d-plan.js';
import {createDemandRender} from './native3d-demand-render.js';
import {PLAN_PREVIEW_MODES,validPlanPreviews,supportsPlanPreviews} from './native3d-runtime.js';

export default function Native3DPlanViewer({asset,projectId,close,onLoaded,onConfirm,onPreviews}) {
  const host=useRef(null),modeControl=useRef(null);
  const [mode,setMode]=useState('regions'),[error,setError]=useState(''),[ready,setReady]=useState(false),[confirmed,setConfirmed]=useState(false);
  const [edgeInfo,setEdgeInfo]=useState(null);
  const modeRef=useRef(mode);modeRef.current=mode;
  useEffect(()=>{modeControl.current?.(mode);},[mode]);
  useEffect(()=>{
    let disposed=false,capturing=false,renderer,controls,model,resize,invalidate,changeMode,demand;
    const abort=new AbortController();setReady(false);setConfirmed(false);setError('');setEdgeInfo(null);setMode('regions');
    const release=()=>{demand?.dispose();resize?.disconnect();controls?.dispose();
      model?.traverse(o=>{o.geometry?.dispose();for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])m.dispose();});
      renderer?.dispose();renderer?.forceContextLoss();renderer?.domElement.remove();if(modeControl.current===changeMode)modeControl.current=null;};
    (async()=>{
      const THREE=await import('three');const {OrbitControls}=await import('three/addons/controls/OrbitControls.js');
      const response=await fetch(nativeAssetUrl(projectId,asset.plan.overlayAssetPath),{signal:abort.signal});
      if(!response.ok)throw Error('真实切缝方案读取失败。');
      const data=await decodePlanOverlay(await response.arrayBuffer(),asset.plan.overlay);
      if(disposed)return;
      const base=new THREE.BufferGeometry();base.setAttribute('position',new THREE.BufferAttribute(data.positions,3));base.setIndex(new THREE.BufferAttribute(data.faces,1));base.computeVertexNormals();
      const geometry=base.toNonIndexed();base.dispose();
      const regions=new Float32Array(data.faces.length*3),ao=new Float32Array(regions.length),color=new THREE.Color();
      for(let f=0;f<data.regions.length;f++){
        color.setHSL(((data.regions[f]*.61803398875)%1+1)%1,.5,.56);
        if(data.regions[f]<0 || data.supported?.[f]===0)color.set('#795d65');
        const grey=Math.max(.08,Math.min(1,1-data.darkness[f]));
        for(let c=0;c<3;c++){regions.set([color.r,color.g,color.b],f*9+c*3);ao.set([grey,grey,grey],f*9+c*3);}
      }
      const colors=new THREE.BufferAttribute(regions,3);geometry.setAttribute('color',colors);
      const material=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.85,metalness:0,vertexColors:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});
      const surface=new THREE.Mesh(geometry,material);model=new THREE.Group();model.add(surface);
      const edgeLayers=planEdgeLayers(data,asset.plan.edgeReasons);setEdgeInfo(edgeLayers);
      const lines=edgeLayers.layers.filter(layer=>layer.count).map(layer=>{
        const linePositions=new Float32Array(layer.edges.length*3);
        for(let i=0;i<layer.edges.length;i++)linePositions.set(data.positions.subarray(layer.edges[i]*3,layer.edges[i]*3+3),i*3);
        const lineGeometry=new THREE.BufferGeometry();lineGeometry.setAttribute('position',new THREE.BufferAttribute(linePositions,3));
        const object=new THREE.LineSegments(lineGeometry,new THREE.LineBasicMaterial({color:layer.color,depthTest:true}));model.add(object);return {key:layer.key,object};
      });
      let points;
      if(data.highPoints?.length){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(data.highPoints,3));
        const highColors=new Float32Array(data.highPoints.length);
        for(let i=0;i<data.highPoints.length/3;i++){const region=data.highRegions?.[i] ?? -1;color.setHSL(((region*.61803398875)%1+1)%1,.5,.56);if(region<0)color.set('#795d65');highColors.set([color.r,color.g,color.b],i*3);}
        g.setAttribute('color',new THREE.BufferAttribute(highColors,3));points=new THREE.Points(g,new THREE.PointsMaterial({vertexColors:true,size:2,sizeAttenuation:false}));points.visible=false;model.add(points);}
      const scene=new THREE.Scene();scene.background=new THREE.Color('#161b24');
      const box=new THREE.Box3().setFromObject(surface),center=box.getCenter(new THREE.Vector3()),size=Math.max(box.getSize(new THREE.Vector3()).length(),.01);
      model.position.sub(center);scene.add(model,new THREE.HemisphereLight(0xffffff,0x687080,2));
      const key=new THREE.DirectionalLight(0xffffff,3);key.position.set(size,size*2,size);scene.add(key);
      const camera=new THREE.PerspectiveCamera(45,4/3,Math.max(size/10000,.00001),size*100);camera.position.set(size,size*.6,size);
      renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1,1.5));host.current.appendChild(renderer.domElement);
      const initialWidth=Math.min(host.current.clientWidth,1066),initialHeight=Math.min(host.current.clientHeight,800);renderer.setSize(initialWidth,initialHeight);renderer.domElement.style.setProperty('height',initialHeight+'px','important');camera.aspect=initialWidth/Math.max(initialHeight,1);camera.updateProjectionMatrix();
      controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
      demand=createDemandRender({update:()=>controls.update(),render:()=>renderer.render(scene,camera)});invalidate=demand.invalidate;
      controls.addEventListener('change',invalidate);
      changeMode=value=>{material.vertexColors=value!=='grey';material.needsUpdate=true;
        colors.array=value==='ao'?ao:regions;colors.needsUpdate=true;for(const line of lines)line.object.visible=planEdgeLayerVisible(line.key,value);if(points)points.visible=value==='high';invalidate();};
      modeControl.current=changeMode;changeMode(modeRef.current);
      resize=new ResizeObserver(()=>{if(disposed||capturing)return;const width=Math.min(host.current.clientWidth,1066),height=Math.min(host.current.clientHeight,800);renderer.setSize(width,height);renderer.domElement.style.setProperty('height',height+'px','important');camera.aspect=width/Math.max(height,1);camera.updateProjectionMatrix();invalidate();});resize.observe(host.current);
      if(disposed){release();return;}
      invalidate();await onLoaded?.(asset.nodeId,asset.plan.planSha256);
      if(onPreviews&&supportsPlanPreviews(asset.plan)&&!validPlanPreviews(asset.planPreviews,asset.plan)){
        const originalSize=renderer.getSize(new THREE.Vector2()),originalAspect=camera.aspect,blobs={};controls.enabled=false;capturing=true;
        try{
          renderer.setSize(640,480,false);camera.aspect=4/3;camera.updateProjectionMatrix();
          for(const value of PLAN_PREVIEW_MODES){
            if(disposed)throw Error('方案面板已关闭，预览未交付。');
            changeMode(value);renderer.render(scene,camera);
            blobs[value]=await new Promise((resolve,reject)=>renderer.domElement.toBlob(blob=>blob?resolve(blob):reject(Error('方案预览捕获失败。')),'image/png'));
          }
          if(disposed)throw Error('方案面板已关闭，预览未交付。');
          await onPreviews(asset.nodeId,asset.plan.planSha256,blobs);
        }finally{capturing=false;if(!disposed){const width=Math.min(host.current.clientWidth,1066)||originalSize.x,height=Math.min(host.current.clientHeight,800)||originalSize.y;renderer.setSize(width,height);renderer.domElement.style.setProperty('height',height+'px','important');camera.aspect=width/height;camera.updateProjectionMatrix();controls.enabled=true;changeMode(modeRef.current);}}
      }
      if(!disposed)setReady(true);
    })().catch(e=>{if(!disposed){setError(e.message);release();}});
    return()=>{disposed=true;abort.abort();release();};
  },[asset.nodeId,asset.plan.planSha256,asset.plan.overlayAssetPath,projectId]);
  return <div className="native3d-overlay nodrag nowheel" role="dialog" aria-modal="true" aria-label="真实3D切缝方案" onPointerDown={e=>e.stopPropagation()}>
    <div className="native3d-plan-dialog"><header><strong>{asset.title} · 展开前3D审阅</strong><button onClick={close}>关闭</button></header>
    <div className="native3d-plan-toolbar">{[['regions','AI分区'],['convex','加凸角'],['details','加凹角/AO'],['seams','全部候选'],['ao','AO依据'],['grey','灰模'],['high','高模采样点']].map(([key,label])=><button key={key} aria-pressed={mode===key} disabled={['convex','details'].includes(key)&&(!edgeInfo?.categorized||!supportsPlanPreviews(asset.plan))} onClick={()=>setMode(key)}>{label}</button>)}</div>
    {!supportsPlanPreviews(asset.plan)&&<small>历史切缝方案 · 不含新版结构分层，不保存凸角/凹角卡片预览。</small>}
    <small>{edgeInfo?.layers.filter(layer=>layer.count&&planEdgeLayerVisible(layer.key,mode)).map(layer=><span key={layer.key} style={{color:layer.color,marginRight:14}}>━ {layer.label} {layer.count}</span>)}</small>
    {edgeInfo&&!edgeInfo.categorized&&<small>旧版方案未提供边理由表，保留原候选边；无法分层查看。</small>}
    {edgeInfo?.layers.some(layer=>layer.key==='unknown'&&layer.count>0)&&<small>未识别理由仅在“全部候选”中以紫色显示，不计入AI、凸角或凹角/AO层。</small>}
    <div ref={host} className="native3d-plan-viewport"/><small>真实低模表面与候选边 · 暗紫：证据不足面 · 高模仅显示采样点 · 尚未展开UV。旋转 / 平移 / 缩放检查所有侧面。</small>
    <p className="native3d-error">{error}</p><footer><small>方案 {asset.plan.planSha256.slice(0,12)} · 调整参数后必须重新预览</small><button disabled={!ready||confirmed||Boolean(error)} onClick={async()=>{try{await onConfirm(asset.nodeId,asset.plan.planSha256);setConfirmed(true);}catch(e){setError(e.message);}}}>{confirmed?'当前方案已确认':'确认当前切缝方案'}</button></footer></div>
  </div>;
}
