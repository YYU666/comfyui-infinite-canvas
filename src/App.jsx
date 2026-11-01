import React, { useCallback, useEffect, useState } from 'react';
import LegacyWorkbench from './LegacyWorkbench';
import CanvasWorkbench from './CanvasWorkbench';
import ProjectLauncher from './ProjectLauncher';
import QueueNotificationCenter from './QueueNotificationCenter';
import UpdateCenter from './UpdateCenter';
import { openProject } from './project-store-http';
import { projectSession } from './project-session';

export default function App() {
  const [project, setProject] = useState(null);
  const [restoring, setRestoring] = useState(() => Boolean(projectSession.read()));
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('h3-workbench-mode') || 'canvas'; }
    catch { return 'canvas'; }
  });
  const acceptProject = useCallback((next) => {
    projectSession.remember(next);
    setProject(next);
    setNotice('');
  }, []);
  useEffect(() => {
    let active = true;
    projectSession.restore(openProject).then((next) => {
      if (active && next) acceptProject(next);
    }).catch(() => {
      if (active) setNotice('未能恢复刚才的项目，它可能已被移动、删除或暂时无法访问。请从项目列表重新打开。');
    }).finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, [acceptProject]);
  const returnToLauncher = () => {
    projectSession.clear();
    setProject(null);
    setNotice('');
  };
  const changeMode = (next) => {
    try { localStorage.setItem('h3-workbench-mode', next); } catch { /* Optional preference. */ }
    setMode(next);
  };
  const content = restoring ? <div className="neo-app project-loading" role="status"><strong>正在恢复当前项目</strong><p>正在读取已保存的画布…</p></div>
    : !project ? <>{notice && <div className="launcher-notice error" role="alert">{notice}</div>}<ProjectLauncher onOpen={acceptProject} /></> : mode === 'canvas'
    ? <CanvasWorkbench initialProject={project} onActiveProjectChange={acceptProject} onLauncher={returnToLauncher} onSimpleMode={() => changeMode('simple')} />
    : <LegacyWorkbench onCanvasMode={() => changeMode('canvas')} />;
  return <><QueueNotificationCenter /><UpdateCenter projectOpen={Boolean(project)} />{content}</>;
}
