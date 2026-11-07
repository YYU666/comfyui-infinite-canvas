import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_METRICS, LOCAL_RECONNECTED, probeLocalConnection, requestLocalStart } from './local-connection';

export function useLocalConnection({ onReconnect } = {}) {
  const [server, setServer] = useState({ online: false, backendOnline: null, label: '正在连接' });
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [notice, setNotice] = useState('');
  const [starting, setStarting] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const current = useRef(server);
  const pending = useRef(null);
  const deadline = useRef(0);
  const lastLaunch = useRef(-Infinity);
  const mounted = useRef(true);
  const recoveryNeeded = useRef(false);
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;

  const checkServer = useCallback(() => {
    if (pending.current) return pending.current.promise;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new DOMException('连接检查超时', 'TimeoutError')), 8000);
    const promise = probeLocalConnection({ signal: abort.signal }).then(async (next) => {
      if (!mounted.current || abort.signal.aborted) return next;
      const previous = current.current;
      current.current = next;
      setServer(next); setMetrics(next.metrics);
      if (next.sessionRefreshed || (next.online && !previous.online) || (next.backendOnline && recoveryNeeded.current)) {
        recoveryNeeded.current = true;
        try { await reconnect.current?.({ signal: abort.signal }); recoveryNeeded.current = false; } catch { /* Retry only the read-only access check on the next healthy probe. */ }
        if (!mounted.current || abort.signal.aborted) return next;
        // Preserve the bridge session and its op-id dedup set; only reopen
        // progress transports, including EventSource closed permanently by 401.
        setConnectionEpoch((value) => value + 1);
        window.dispatchEvent(new Event(LOCAL_RECONNECTED));
      }
      if (next.online) {
        if (deadline.current) setNotice('本地服务已连接。当前画布已保留；若有保存失败，请在项目菜单重试保存。');
        deadline.current = 0; setStarting(false);
      } else if (deadline.current && Date.now() >= deadline.current) {
        deadline.current = 0; setStarting(false);
        setNotice(next.backendOnline ? next.label : '尚未连接。请允许浏览器打开 Refmuse；若未安装启动入口，请运行安装目录中的“启动.vbs”，本页会继续检查。');
      }
      return next;
    }).finally(() => { clearTimeout(timeout); if (pending.current?.abort === abort) pending.current = null; });
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
    } else if (!latest.online && latest.backendOnline) setNotice(latest.label);
    void checkServer();
  }, [checkServer]);

  useEffect(() => {
    mounted.current = true;
    void checkServer();
    const interval = setInterval(checkServer, 3000);
    window.addEventListener('focus', checkServer);
    return () => { mounted.current = false; clearInterval(interval); window.removeEventListener('focus', checkServer); pending.current?.abort.abort(); pending.current = null; };
  }, [checkServer]);
  return { server, metrics, checkServer, onStatusClick, starting, notice, dismissNotice: () => setNotice(''), connectionEpoch };
}
