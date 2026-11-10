import { validateAnalysis } from './art-director.js';
const COLORS = ['#f9c76c', '#86e2e0', '#e8a2ff', '#c0e78c', '#ffa3a5'];
const abort = signal => signal?.throwIfAborted();
export async function loadArtBitmap(url, signal) {
  const parsed = new URL(url, location.href);
  if (!['data:', 'blob:'].includes(parsed.protocol) && parsed.origin !== location.origin) throw new Error('请先把图片导入本地项目。');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('图片读取失败。');
  const blob = await response.blob();
  if (blob.size > 32 * 1024 * 1024) throw new Error('图片文件超过 32MB，请先缩小。');
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width * bitmap.height > 32_000_000 || Math.max(bitmap.width, bitmap.height) > 16384) { bitmap.close(); throw new Error('图片超过 32MP 或单边 16384 像素。'); }
  abort(signal); return bitmap;
}
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
export function imageFit(width, height, x, y, w, h) { const scale = Math.min(w / width, h / height); return { x: x + (w - width * scale) / 2, y: y + (h - height * scale) / 2, width: width * scale, height: height * scale }; }
export function measurePixels(image) {
  const histogram = Array(32).fill(0), buckets = new Map(); let weight = 0, total = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r,g,b,a] = image.data.subarray(i, i + 4), alpha = a / 255;
    if (!alpha) continue;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    histogram[Math.min(31, Math.floor(luma / 8))] += alpha; total += luma * alpha; weight += alpha;
    const key = [r,g,b].map(v => Math.min(224, Math.floor(v / 32) * 32) + 16).join(','); buckets.set(key, (buckets.get(key) || 0) + alpha);
  }
  return { meanLuma: weight ? total / weight : 0, histogram, palette: [...buckets].sort((a,b) => b[1] - a[1]).slice(0,6).map(([rgb,count]) => ({ rgb, share: weight ? count / weight : 0 })), samples: image.width * image.height };
}
function wrap(ctx, value, width) {
  const lines = []; let line = '';
  for (const char of String(value)) { if (char === '\n') { lines.push(line); line = ''; continue; } if (ctx.measureText(line + char).width > width && line) { lines.push(line); line = char; } else line += char; }
  if (line) lines.push(line); return lines;
}
function paragraph(ctx, value, x, y, width, color = '#c7d1df', size = 24) { ctx.font = `${size}px "Microsoft YaHei", sans-serif`; ctx.fillStyle = color; const lines = wrap(ctx, value, width); for (const line of lines) { ctx.fillText(line, x, y); y += size * 1.5; } return y; }
function guideDraw(ctx, guide, fit, color) {
  if (guide.hidden) return;
  const [[ax,ay],[bx,by]] = guide.points, x = fit.x + ax * fit.width, y = fit.y + ay * fit.height, xx = fit.x + bx * fit.width, yy = fit.y + by * fit.height;
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath();
  if (guide.kind === 'rect') ctx.rect(x,y,xx-x,yy-y); else { ctx.moveTo(x,y); ctx.lineTo(xx,yy); } ctx.stroke();
  ctx.font = 'bold 22px "Microsoft YaHei", sans-serif'; let visibleLabel=guide.label;const maxLabelWidth=Math.max(20,fit.width-20);while(visibleLabel.length>1&&ctx.measureText(visibleLabel+'…').width+16>maxLabelWidth)visibleLabel=visibleLabel.slice(0,-1);if(visibleLabel!==guide.label)visibleLabel+='…';const labelW = Math.min(maxLabelWidth,ctx.measureText(visibleLabel).width + 16); const lx = Math.max(fit.x, Math.min(x, fit.x + fit.width - labelW)); const ly = Math.max(fit.y + 30, y);
  ctx.fillStyle = '#111923e8'; ctx.fillRect(lx,ly-29,labelW,30); ctx.fillStyle = color; ctx.save();ctx.beginPath();ctx.rect(fit.x,fit.y,fit.width,fit.height);ctx.clip();ctx.fillText(visibleLabel,lx+8,ly-7);ctx.restore();
}
export async function imageForProvider(url, signal) {
  const bitmap = await loadArtBitmap(url, signal);
  try { const s = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height)), c = canvas(Math.max(1,Math.round(bitmap.width*s)), Math.max(1,Math.round(bitmap.height*s))); c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height); abort(signal); return c.toDataURL('image/jpeg',0.88); } finally { bitmap.close(); }
}
export async function requestArtAnalysis(snapshot, signal) {
  const images = [];
  for (const ref of snapshot.refs) images.push({ slot: ref.data.slot, purpose: ref.data.slot === 'artwork' ? '作品' : ref.data.purpose, image: await imageForProvider(ref.data.url, signal) });
  const response = await fetch('/api/art-director/analyze', { method: 'POST', headers: {'Content-Type':'application/json'}, signal, body: JSON.stringify({ projectId: snapshot.projectId, provider: snapshot.node.data.artProvider || 'qwen', ...(snapshot.node.data.artModel?{model:snapshot.node.data.artModel}:{}), sourceVersion: snapshot.signature, brief: snapshot.node.data.brief || '', preserve: snapshot.node.data.preserve || '', images }) });
  const body = await response.json(); if (!response.ok) throw new Error(body.message || '视觉分析失败。');
  return {analysis:validateAnalysis(body.analysis,snapshot.signature),provider:body.provider || snapshot.node.data.artProvider || 'qwen',model:body.model || snapshot.node.data.artModel || 'qwen3-vl-plus'};
}
export async function renderArtBoard(url, input, { signal, provenance = 'import', brief = '', preserve = '', references = [], model = '' } = {}) {
  const analysis = validateAnalysis(input, input.sourceVersion); abort(signal);
  const bitmap = await loadArtBitmap(url, signal);
  try {
    const sampleScale = Math.min(1,512 / Math.max(bitmap.width,bitmap.height)), sample = canvas(Math.max(1,Math.round(bitmap.width*sampleScale)),Math.max(1,Math.round(bitmap.height*sampleScale))), sc = sample.getContext('2d', {willReadFrequently:true}); sc.drawImage(bitmap,0,0,sample.width,sample.height);
    const pixels = sc.getImageData(0,0,sample.width,sample.height), measured = measurePixels(pixels);
    const scratch = canvas(1,1).getContext('2d'); scratch.font = '24px "Microsoft YaHei", sans-serif';
    const issueRows = analysis.issues.map(issue => Math.max(355, 100 + ['observation','impact','action','preserve','uncertainty'].reduce((h,key) => h + wrap(scratch, `${{observation:'观察',impact:'影响 / 为什么',action:'修改动作',preserve:'必须保留',uncertainty:'不确定性'}[key]}：${issue[key]}`, 1160).length * 36 + 8, 0)));
    const topText = [`创作目标：${brief || '整体可读性（目标未提供）'}`,`必须保留：${preserve || '沿用作品风格，具体保留项未提供'}`,`结论：${analysis.summary}`,`已有优点：${analysis.strengths}`,`证据限制：${analysis.limitations}`];
    const topHeight = 150 + topText.reduce((h,t) => h + wrap(scratch,t,1680).length*36+12,0);
    const referenceHeight = references.length ? 320 : 0;
    const height = topHeight + 870 + referenceHeight + issueRows.reduce((a,b)=>a+b+24,0) + 100;
    if (height > 16000) throw new Error('解析文字过长，请缩短后再导出。');
    const board = canvas(1800,height), ctx=board.getContext('2d'); ctx.fillStyle='#101723';ctx.fillRect(0,0,board.width,board.height);
    paragraph(ctx,'REFMUSE / 电子主美 · 图解分析板',60,70,1680,'#f2f5fa',36);
    const badge = provenance === 'demo' ? '操作示例 · 未进行模型视觉审查' : ['qwen','kimi','doubao','deepseek'].includes(provenance) ? `${({qwen:'Qwen',kimi:'Kimi',doubao:'豆包',deepseek:'DeepSeek Flash'})[provenance]} 云端判断 · ${model} · 几何为估计 · 本机图板` : '导入的结构化判断 · 来源由用户确认';
    paragraph(ctx,badge,60,115,1680,provenance==='demo'?'#ffcc76':'#83d6cf',23);
    let y=163;for(const t of topText)y=paragraph(ctx,t,60,y,1680)+12;
    const mainY=topHeight+10;ctx.fillStyle='#1b2636';ctx.fillRect(60,mainY,1120,630);
    const fit=imageFit(bitmap.width,bitmap.height,70,mainY+10,1100,610);ctx.drawImage(bitmap,fit.x,fit.y,fit.width,fit.height);
    analysis.guides.forEach((guide,i)=>guideDraw(ctx,guide,fit,COLORS[i%COLORS.length]));
    analysis.issues.forEach((issue,i)=>{const locator=analysis.guides.find(g=>g.kind==='rect'&&g.issueId===issue.id);if(issue.hidden||locator?.hidden)return;const [x,y,w,h]=issue.box;ctx.strokeStyle=COLORS[i%5];ctx.lineWidth=2;ctx.setLineDash([8,6]);ctx.strokeRect(fit.x+x*fit.width,fit.y+y*fit.height,w*fit.width,h*fit.height);ctx.setLineDash([]);ctx.fillStyle=COLORS[i%5];ctx.beginPath();ctx.arc(fit.x+x*fit.width+15,fit.y+y*fit.height+15,17,0,Math.PI*2);ctx.fill();ctx.fillStyle='#111923';ctx.font='bold 23px sans-serif';ctx.fillText(String(i+1),fit.x+x*fit.width+8,fit.y+y*fit.height+23);});
    paragraph(ctx,'本机像素工具 / 灰度与采色',1220,mainY+30,500,'#f2f5fa',25);
    const gray=sc.getImageData(0,0,sample.width,sample.height);for(let i=0;i<gray.data.length;i+=4){const l=Math.round(.2126*gray.data[i]+.7152*gray.data[i+1]+.0722*gray.data[i+2]);gray.data[i]=gray.data[i+1]=gray.data[i+2]=l;}sc.putImageData(gray,0,0);
    const gf=imageFit(sample.width,sample.height,1220,mainY+55,520,235);ctx.drawImage(sample,gf.x,gf.y,gf.width,gf.height);
    const max=Math.max(1,...measured.histogram);ctx.fillStyle='#83d6cf';measured.histogram.forEach((v,i)=>ctx.fillRect(1220+i*16,mainY+425-v/max*100,13,v/max*100));
    paragraph(ctx,`采样 ${sample.width}×${sample.height} · Alpha 加权`,1220,mainY+465,520,'#aab9ca',21);
    paragraph(ctx,`sRGB 加权灰度均值 ${measured.meanLuma.toFixed(1)} / 255`,1220,mainY+500,520,'#aab9ca',21);
    measured.palette.forEach((p,i)=>{ctx.fillStyle=`rgb(${p.rgb})`;ctx.fillRect(1220+i*86,mainY+530,78,42);paragraph(ctx,`${(p.share*100).toFixed(1)}%`,1220+i*86,mainY+600,83,'#bdcada',18);});
    y=mainY+680;y=paragraph(ctx,`原图 ${bitmap.width}×${bitmap.height} · 辅助线为可编辑估计；虚线编号框对应下方局部。`,60,y,1680,'#99adbf',23);
    y=paragraph(ctx,'灰度来自 sRGB 通道加权（非物理亮度）；色板为 32 级 RGB 量化高频色，比例为透明度加权采样占比。',60,y+10,1680,'#99adbf',22)+42;
    if (references.length) {
      paragraph(ctx,'参考对照 / 每张仅用于所注明的用途',60,y,1680,'#a9dbd5',25);
      for(let i=0;i<Math.min(3,references.length);i++){const ref=references[i],rb=await loadArtBitmap(ref.data.url,signal);try{const rf=imageFit(rb.width,rb.height,60+i*560,y+25,510,210);ctx.drawImage(rb,rf.x,rf.y,rf.width,rf.height);paragraph(ctx,`参考 ${i+1} · 用途：${ref.data.purpose}`,60+i*560,y+273,520,'#b5c8d9',23);}finally{rb.close();}}
      y+=320;
    }
    if(!analysis.issues.length)y=paragraph(ctx,'本次没有列出需要修改的重点问题。可保留现有视觉决策。',60,y,1680,'#c0e78c',26)+50;
    for(let i=0;i<analysis.issues.length;i++){
      abort(signal);const issue=analysis.issues[i],rowH=issueRows[i];ctx.fillStyle='#192333';ctx.fillRect(60,y-25,1680,rowH);
      paragraph(ctx,`${i+1} / ${issue.priority}优先级 · ${issue.evidence}`,90,y+12,1610,COLORS[i%5],25);
      const [x,yy,w,h]=issue.box,cf=imageFit(w*bitmap.width,h*bitmap.height,90,y+42,390,220);ctx.drawImage(bitmap,x*bitmap.width,yy*bitmap.height,w*bitmap.width,h*bitmap.height,cf.x,cf.y,cf.width,cf.height);
      paragraph(ctx,'原图局部 · 区域由判断者估计',90,y+291,400,'#9babbe',19);
      let ty=y+55;for(const key of ['observation','impact','action','preserve','uncertainty'])ty=paragraph(ctx,`${{observation:'观察',impact:'影响 / 为什么',action:'修改动作',preserve:'必须保留',uncertainty:'不确定性'}[key]}：${issue[key]}`,530,ty,1160,key==='action'?'#f0e5c7':key==='preserve'?'#b9dfc9':'#c7d1df')+8;
      y+=rowH+24;
    }
    paragraph(ctx,'静态衍生 PNG · 原图未改动 · 可编辑辅助线随节点和原图版本保存在项目中',60,height-35,1680,'#8397ac',21);
    abort(signal);const blob=await new Promise((resolve,reject)=>board.toBlob(b=>b?resolve(b):reject(new Error('PNG 编码失败。')),'image/png'));abort(signal);
    return {blob,width:board.width,height:board.height,measured};
  } finally { bitmap.close(); }
}
