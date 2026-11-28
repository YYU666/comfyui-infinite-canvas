// Pointer policy for the paint stage. Coalesced samples live on the native event:
// React's synthetic event does not implement getCoalescedEvents.

export function coalescedPointerEvents(event) {
  const native = event?.nativeEvent;
  const samples = native?.getCoalescedEvents?.();
  if (samples?.length) return samples;
  return [native || event];
}

export function classifyPointerDown(event) {
  const eraserEnd = event.button === 5 || (event.buttons & 32) !== 0;
  if (event.button === 1) return 'pan';
  if (event.button === 2) return 'ignore';
  if (eraserEnd) return 'eraser';
  if (event.button !== 0 && event.button !== 5) return 'ignore';
  return 'draw';
}

export function isForeignPointer(activePointerId, pointerId) {
  return activePointerId != null && pointerId !== activePointerId;
}

export function isPalmTouch(palmReject, pointerType, drawing) {
  return Boolean(palmReject && pointerType === 'touch' && drawing);
}

export function hoverShouldFinish(kind, buttons) {
  if (buttons !== 0 || !kind) return false;
  return kind === 'pan' || kind === 'brush' || kind === 'eraser' || kind === 'smudge' || kind === 'move'
    || kind === 'geometry' || kind === 'select-offset' || kind.startsWith('select') || kind.startsWith('transform');
}

export function inputSourceLabel(event, eraserEnd = false) {
  if (eraserEnd || event?.button === 5 || (event?.buttons & 32)) return '橡皮端';
  if (event?.pointerType === 'pen') {
    const pressure = event.pressure > 0 ? Math.round(Math.min(1, event.pressure) * 100) : 0;
    return `笔 ${pressure}%`;
  }
  if (event?.pointerType === 'touch') return '触控';
  return '鼠标';
}
