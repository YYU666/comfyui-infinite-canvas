import React, { useState } from 'react';
import LegacyWorkbench from './LegacyWorkbench';
import CanvasWorkbench from './CanvasWorkbench';
import ProjectLauncher from './ProjectLauncher';

export default function App() {
  const [project, setProject] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem('h3-workbench-mode') || 'canvas');
  const changeMode = (next) => {
    localStorage.setItem('h3-workbench-mode', next);
    setMode(next);
  };
  if (!project) return <ProjectLauncher onOpen={setProject} />;
  return mode === 'canvas'
    ? <CanvasWorkbench initialProject={project} onLauncher={() => setProject(null)} onSimpleMode={() => changeMode('simple')} />
    : <LegacyWorkbench onCanvasMode={() => changeMode('canvas')} />;
}
