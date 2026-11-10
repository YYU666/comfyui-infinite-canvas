import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_METRICS, LOCAL_RECONNECTED, probeLocalConnection, requestLocalStart, requestComfyStart, boundedRead } from './local-connection';

export function useLocalConnection({ onReconnect } = {}) {
  const [server, setServer] = useState({ online: false, backendOnline: null, label: '正在连接' });
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [notice, setNotice] = useState('');
  const [starting, setStarting] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const current = useRef(server);
  const pending = useRef(null);
  const startPending = useRef(false);
  const deadline = useRef(0);
  const lastLaunch = useRef(-Infinity);
  const mounted = useRef(true);
  const recoveryNeeded = useRef(false);
  const shownDiagnostic = useRef('');
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;

  const checkServer = useCallback((force = false) => {
    if (pending.current && force !== true) return pending.current.promise;
    pending.current?.abort.abort();
    const abort = new AbortController();
    const publish = (next) => {
      if (!mounted.current || abort.signal.aborted) return;
      const previous = current.current;
      if (next.sessionRefreshed || (next.online && !previous.online)) recoveryNeeded.current = true;
      current.current = next;
      const failed = ['exited', 'failed', 'timeout', 'port_conflict', 'session_error', 'connection_timeout'].includes(next.state);
      const diagnostic = next.online && next.comfy?.warning ? next.comfy.warning
        : failed ? next.label + (Number.isInteger(next.comfy?.exitCode) ? `（退出码：${next.comfy.exitCode}）` : '') : '';
      if (diagnostic) {
        const key = `${next.state}:${diagnostic}`;
        if (shownDiagnostic.current !== key) { shownDiagnostic.current = key; setNotice(diagnostic); }
      } else if (next.online) {
        if (shownDiagnostic.current) setNotice('本地服务已恢复连接。');
        shownDiagnostic.current = '';
      }
      setServer(next); setMetrics({ ...next.metrics });
    };
    const promise = probeLocalConnection({ signal: abort.signal, onStatus: publish }).then(async (next) => {
      if (!mounted.current || abort.signal.aborted) return next;
      publish(next);
      if (next.backendOnline && recoveryNeeded.current) {
        recoveryNeeded.current = true;
        try { await boundedRead(signal => reconnect.current?.({ signal }), { signal: abort.signal, timeoutMs: 3000 }); recoveryNeeded.current = false; } catch { /* Retry only the read-only access check on the next healthy probe. */ }
        if (!mounted.current || abort.signal.aborted) return next;
        // Preserve the bridge session and its op-id dedup set; only reopen
        // progress transports, including EventSource closed permanently by 401.
        setConnectionEpoch((value) => value + 1);
        window.dispatchEvent(new Event(LOCAL_RECONNECTED));
      }
      if (force === true) setNotice(next.online ? (next.comfy?.warning || '检查完成，本地服务已连接。') : next.label);
      if (next.online) {
        if (deadline.current) setNotice('本地服务已连接。当前画布已保留；若有保存失败，请在项目菜单重试保存。');
        deadline.current = 0; setStarting(false);
      } else if (deadline.current && Date.now() >= deadline.current) {
        deadline.current = 0; setStarting(false);
        setNotice(next.backendOnline ? next.label : '尚未连接。请允许浏览器打开 Refmuse；若未安装启动入口，请运行安装目录中的“启动.vbs”，本页会继续检查。');
      }
      return next;
    }).finally(() => { if (pending.current?.abort === abort) pending.current = null; });
    pending.current = { promise, abort };
    return promise;
  }, []);

  const onStatusClick = useCallback(() => {
    const latest = current.current;
    if (latest.backendOnline === false && !deadline.current && Date.now() - lastLaunch.current >= 30000) {
      lastLaunch.current = Date.now();
      deadline.current = Date.now() + 90000;
      setStarting(true);
      setNotice('已请求启动本地服务，请允许浏览器打开 Refmuse。正在当前页面等待连接…');
      try { requestLocalStart(); }
      catch { deadline.current = 0; setStarting(false); setNotice('浏览器未能打开启动入口，请运行安装目录中的“启动.vbs”，本页会继续检查。'); }
    } else {
      setNotice('正在检查连接…');
      if (!latest.online && latest.backendOnline && latest.state !== 'session_error' && !startPending.current) {
        startPending.current = true;
        setStarting(true);
        void requestComfyStart().then(result => {
          if (mounted.current) setNotice(result.error || result.warning || '已请求启动 ComfyUI，正在检查服务…');
        }).catch(error => { if (mounted.current) setNotice(error.message); }).finally(() => {
          startPending.current = false;
          if (mounted.current) { setStarting(false); void checkServer(true); }
        });
      }
    }
    void checkServer(true);
  }, [checkServer]);

  useEffect(() => {
    mounted.current = true;
    void checkServer();
    const interval = setInterval(checkServer, 3000);
    window.addEventListener('focus', checkServer);
    return () => { mounted.current = false; clearInterval(interval); window.removeEventListener('focus', checkServer); pending.current?.abort.abort(); pending.current = null; };
  }, [checkServer]);
  return { server, metrics, checkServer, onStatusClick, starting, notice, setConnectionNotice: setNotice, dismissNotice: () => setNotice(''), connectionEpoch };
}
