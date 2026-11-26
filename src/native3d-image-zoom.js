export const imageZoomLimits={min:0.25,max:8};
export function zoomImageAt(view,point,factor) {
  const scale=Math.min(imageZoomLimits.max,Math.max(imageZoomLimits.min,view.scale*factor));
  const ratio=scale/view.scale;
  return {scale,x:point.x-(point.x-view.x)*ratio,y:point.y-(point.y-view.y)*ratio};
}
export function fitImageView(image,viewport,scale) {
  const fitted=scale ?? Math.min(viewport.width/image.width,viewport.height/image.height);
  const bounded=Math.min(imageZoomLimits.max,Math.max(imageZoomLimits.min,fitted));
  return {scale:bounded,x:(viewport.width-image.width*bounded)/2,y:(viewport.height-image.height*bounded)/2};
}
