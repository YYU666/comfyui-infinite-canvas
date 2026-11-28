import { useLayoutEffect, useState } from 'react';

const drawers = new Map();
const listeners = new Map();

export function publishNative3DDrawer(id, element) {
  if (element) drawers.set(id, element);
  else drawers.delete(id);
  for (const listener of listeners.get(id) || []) listener(drawers.get(id) || null);
}

export function Native3DDrawerSlot({ id }) {
  const [element, setElement] = useState(() => drawers.get(id) || null);
  useLayoutEffect(() => {
    const set = listeners.get(id) || new Set();
    listeners.set(id, set);
    set.add(setElement);
    setElement(drawers.get(id) || null);
    return () => set.delete(setElement);
  }, [id]);
  return element;
}
