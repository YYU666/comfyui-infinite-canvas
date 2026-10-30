import React, { useState } from 'react';
import LegacyWorkbench from './LegacyWorkbench';
import CanvasWorkbench from './CanvasWorkbench';
import ProjectLauncher from './ProjectLauncher';
import QueueNotificationCenter from './QueueNotificationCenter';
import UpdateCenter from './UpdateCenter';

export default function App() {
  const [project, setProject] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem('h3-workbench-mode') || 'canvas');
  const changeMode = (next) => {
    localStorage.setItem('h3-workbench-mode', next);
    setMode(next);
  };
  const content = !project ? <ProjectLauncher onOpen={setProject} /> : mode === 'canvas'
    ? <CanvasWorkbench initialProject={project} onLauncher={() => setProject(null)} onSimpleMode={() => changeMode('simple')} />
    : <LegacyWorkbench onCanvasMode={() => changeMode('canvas')} />;
  return <><QueueNotificationCenter /><UpdateCenter projectOpen={Boolean(project)} />{content}</>;
}
