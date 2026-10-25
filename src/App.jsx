import React, { useState } from 'react';
import LegacyWorkbench from './LegacyWorkbench';
import CanvasWorkbench from './CanvasWorkbench';

export default function App() {
  const [mode, setMode] = useState(() => localStorage.getItem('h3-workbench-mode') || 'canvas');
  const changeMode = (next) => {
    localStorage.setItem('h3-workbench-mode', next);
    setMode(next);
  };
  return mode === 'canvas'
    ? <CanvasWorkbench onSimpleMode={() => changeMode('simple')} />
    : <LegacyWorkbench onCanvasMode={() => changeMode('canvas')} />;
}
