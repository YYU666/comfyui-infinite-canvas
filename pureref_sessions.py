"""Capability-scoped, bounded disk sessions for local PureRef imports."""
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid

import psutil
from art_director_credentials import private_acl, CredentialError
from project_api import ProjectAPI
from project_store import StoreError
from pureref_import import PureRefError
from pureref_worker import MAX_SOURCE
from workbench_lifecycle import runtime_dir, atomic_write_json

CHUNK = 4 * 1024**2
SESSION_TTL = 3600
WORKER_TIMEOUT = 1800
WORKER_RSS = 768 * 1024**2
HEADROOM = 512 * 1024**2
ROOT_MARKER = '.pureref-cache-v1'
ROOT_IDENTITY = 'Refmuse.PureRef.private-cache.v1\n'
LOGGER = logging.getLogger(__name__)


class PureRefSessions:
    def __init__(self, store, directory=None):
        self.store = store
        self.root = Path(directory or os.environ.get('H3_PUREREF_CACHE_DIR') or runtime_dir()/'pureref-import').absolute()
        self.instance = uuid.uuid4().hex
        self.sessions = {}
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.thread = None
        self.scanned = False

    def _roots(self):
        return [Path(__file__).resolve().parent,self.store.root.resolve(),*[p.resolve().parent for p in self.store._opened_paths.values()]]

    def _safe_root(self):
        # Windows TEMP may use an 8.3 alias. Resolve legitimate aliases only
        # after rejecting linked/reparse components, before changing any ACL.
        for component in (self.root, *self.root.parents):
            try:
                info = component.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
                raise PureRefError('PUREREF_STORAGE','PureRef 缓存目录不能使用链接或重解析目录。',503)
        self.root = self.root.resolve()
        if any(self.root.is_relative_to(p) or p.is_relative_to(self.root) for p in self._roots()):
            raise PureRefError('PUREREF_STORAGE','PureRef 缓存目录必须位于项目和程序目录之外。',503)
        marker = self.root/ROOT_MARKER
        # Validate a dedicated cache BEFORE changing any existing directory ACL.
        if self.root.exists():
            if marker.is_symlink() or marker.resolve().parent != self.root:
                raise PureRefError('PUREREF_STORAGE','PureRef 缓存目录标记不安全。',503)
            if marker.exists():
                if not marker.is_file() or marker.read_text() != ROOT_IDENTITY:
                    raise PureRefError('PUREREF_STORAGE','PureRef 缓存目录标记无效。',503)
            elif any(self.root.iterdir()):
                raise PureRefError('PUREREF_STORAGE','PureRef 缓存必须使用新的或空的专用目录。',503)
        self.root.mkdir(parents=True,exist_ok=True)
        if os.name == 'nt':
            private_acl(self.root)
            # private_acl deliberately has no inheritance for credential files.
            # Add an inheritable current-user grant only after it removed all ACEs.
            import csv
            identity = subprocess.run(['whoami','/user','/fo','csv','/nh'],capture_output=True,text=True,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
            sid = next(csv.reader([identity.stdout.strip()]))[1]
            if not re.fullmatch(r'S-1-[0-9-]+',sid): raise CredentialError()
            subprocess.run(['icacls',str(self.root),'/grant:r',f'*{sid}:(OI)(CI)F'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
        else: self.root.chmod(0o700)
        if not marker.exists():
            with marker.open('x') as target: target.write(ROOT_IDENTITY)
        if not self.scanned:
            self.scanned = True
            self._recover_stale()

    def _recover_stale(self):
        # Only our exact owner-marked, flat, non-linked directories are eligible.
        for path in self.root.iterdir():
            if not re.fullmatch(r'pur-[0-9a-f]{32}',path.name) or path.is_symlink() or not path.is_dir(): continue
            try:
                owner = path/'owner.json'
                if owner.is_symlink() or owner.resolve().parent != path or not owner.is_file(): continue
                marker = owner.read_text()
                data = json.loads(marker)
                if set(data) != {'instance','id','pid','processCreated','created'} or data['id'] != path.name[4:] or not re.fullmatch('[0-9a-f]{32}',data['instance']): continue
                try:
                    alive = psutil.Process(data['pid']).create_time() == data['processCreated']
                except psutil.NoSuchProcess: alive = False
                if alive: continue
                # A previous worker observes its dead parent once a second. Let
                # it release Windows file handles before reclaiming its spool.
                time.sleep(1.2)
                session = dict(path=path,marker=marker,cancel=threading.Event(),lock=threading.RLock())
                self._cleanup(session)
            except (OSError,ValueError,TypeError,psutil.Error,PureRefError): continue

    @staticmethod
    def _json(handler):
        try:
            length = int(handler.headers.get('Content-Length','0'))
            if not 0 < length <= 4096: raise ValueError()
            value = json.loads(handler.rfile.read(length))
            if not isinstance(value,dict): raise ValueError()
            return value
        except (ValueError,UnicodeError): raise PureRefError('BAD_REQUEST','PureRef 请求格式无效。')

    def _owned(self, session, scan=False):
        path = session['path']
        if self.root.resolve() != self.root or path.resolve() != path or path.parent != self.root or not re.fullmatch(r'pur-[0-9a-f]{32}',path.name):
            raise PureRefError('PUREREF_STORAGE','PureRef 缓存路径不安全。',503)
        root_marker = self.root/ROOT_MARKER
        owner = path/'owner.json'
        for fixed in [root_marker,owner]:
            if fixed.is_symlink() or fixed.resolve().parent != fixed.parent or not fixed.is_file() or fixed.stat().st_nlink != 1:
                raise PureRefError('PUREREF_STORAGE','PureRef 缓存所有权路径无效。',503)
        if root_marker.read_text() != ROOT_IDENTITY or owner.read_text() != session['marker']:
            raise PureRefError('PUREREF_STORAGE','PureRef 缓存所有权无效。',503)
        if scan and any(p.is_symlink() or p.resolve().parent != path or not p.is_file() or p.stat().st_nlink != 1 for p in path.iterdir()):
            raise PureRefError('PUREREF_STORAGE','PureRef 缓存中出现不安全路径。',503)
        return path

    def _file(self, session, name, missing=False):
        directory = self._owned(session)
        if not re.fullmatch(r'(?:upload\.pur|status\.json|resources\.json|[0-9a-f]{32}\.(?:original|preview))',name):
            raise PureRefError('PUREREF_STORAGE','PureRef 暂存文件名无效。',503)
        path = directory/name
        if path.is_symlink() or path.resolve().parent != directory or (path.exists() and (not path.is_file() or path.stat().st_nlink != 1)) or (not missing and not path.exists()):
            raise PureRefError('PUREREF_STORAGE','PureRef 暂存文件路径无效。',503)
        return path

    def _cleanup(self, session):
        session['cancel'].set()
        with session['lock']:
            # finish may have installed a worker while cleanup waited for this
            # lock. Stop that worker before removing its working directory.
            process = session.get('process')
            if process and process.poll() is None:
                process.kill(); process.wait(timeout=10)
            path = self._owned(session,scan=True)
            shutil.rmtree(path)

    def _monitor(self):
        while not self.closed.wait(.25):
            with self.lock: sessions = list(self.sessions.items())
            for key, session in sessions:
                try:
                    process = session.get('process')
                    if process and process.poll() is None:
                        rss = psutil.Process(process.pid).memory_info().rss
                        session['peakRss'] = max(session.get('peakRss',0),rss)
                        if rss > WORKER_RSS or time.monotonic()-session['started'] > WORKER_TIMEOUT:
                            process.kill(); process.wait(timeout=10)
                            atomic_write_json(self._owned(session)/'status.json',dict(phase='error',code='PUREREF_LIMIT',message='PureRef 解析超过内存或时间上限。'))
                    if time.monotonic()-session['touched'] > SESSION_TTL:
                        self._cleanup(session)
                        with self.lock: self.sessions.pop(key,None)
                except (OSError,psutil.Error,PureRefError,subprocess.TimeoutExpired): pass

    def close(self):
        self.closed.set()
        with self.lock: sessions = list(self.sessions.values())
        for session in sessions:
            try: self._cleanup(session)
            except (OSError,PureRefError): pass
        if self.thread: self.thread.join(timeout=2)

    def _create(self, handler):
        data = self._json(handler)
        size, project = data.get('size'),data.get('projectId')
        if type(size) is not int or not 32 <= size <= MAX_SOURCE: raise PureRefError('PUREREF_LIMIT','PureRef 文件上限 8 GiB。')
        if not isinstance(project,str): raise PureRefError('BAD_REQUEST','请选择当前项目。')
        project_path = self.store._project_path(project).resolve()
        self.store.get(project)
        self.store._require_writable(project_path)
        with self.lock:
            self._safe_root()
            if len(self.sessions) >= 2: raise PureRefError('PUREREF_BUSY','最多同时保留两个 PureRef 导入。',409)
            reserve = 2*size + HEADROOM
            reserved = sum(s['reserve'] for s in self.sessions.values())
            if reserve + reserved > 24*1024**3 or shutil.disk_usage(self.root).free < reserve + reserved:
                raise PureRefError('PUREREF_DISK','PureRef 暂存磁盘空间不足；需要源文件两倍加 512 MiB。',507)
            key,capability = uuid.uuid4().hex,secrets.token_urlsafe(32)
            path = self.root/('pur-'+key); path.mkdir()
            marker = json.dumps(dict(instance=self.instance,id=key,pid=os.getpid(),processCreated=psutil.Process().create_time(),created=time.time()))
            (path/'owner.json').write_text(marker)
            session = dict(path=path,marker=marker,capability=capability,project=project,projectPath=project_path,size=size,offset=0,reserve=reserve,touched=time.monotonic(),lock=threading.RLock(),cancel=threading.Event(),phase='uploading')
            (path/'upload.pur').touch()
            self.sessions[key] = session
            if self.thread is None:
                self.thread = threading.Thread(target=self._monitor,daemon=True); self.thread.start()
        handler.send_json(201,dict(id=key,capability=capability,chunkBytes=CHUNK))

    def _session(self, key, handler):
        with self.lock: session = self.sessions.get(key)
        supplied = handler.headers.get('X-PureRef-Session','')
        if not session or not hmac.compare_digest(session['capability'],supplied):
            raise PureRefError('NOT_FOUND','PureRef 会话不存在或已失效。',404)
        if session['cancel'].is_set(): raise PureRefError('PUREREF_CANCELLED','PureRef 导入已取消。',409)
        if self.store._project_path(session['project']).resolve() != session['projectPath']:
            raise PureRefError('PUREREF_OWNER','PureRef 当前项目身份已改变。',409)
        self._owned(session); session['touched'] = time.monotonic()
        return session

    def _status(self, session):
        # Windows AV / atomic replacement can briefly deny opening the status
        # file. Retry only sharing/missing-file races, never ownership failures.
        for attempt in range(20):
            try:
                path = self._file(session,'status.json',missing=True)
                if not path.exists():
                    if session['phase'] == 'uploading': return dict(phase='uploading',bytes=session['offset'],total=session['size'])
                    raise FileNotFoundError('PureRef status temporarily unavailable')
                status = json.loads(path.read_text(encoding='utf-8'))
                break
            except (FileNotFoundError,PermissionError):
                if attempt == 19: raise
                time.sleep(.025)
        process = session.get('process')
        if process and process.poll() is not None and status['phase'] not in {'ready','error'}:
            status = dict(phase='error',code='PUREREF_WORKER',message='PureRef 解析进程意外结束。')
        return dict(status,peakWorkerRss=session.get('peakRss',0))

    def _handle(self, handler, method, path):
        if method == 'POST' and path == '/api/pureref/sessions': return self._create(handler)
        match = re.fullmatch(r'/api/pureref/sessions/([0-9a-f]{32})(?:/(.*))?',path)
        if not match: raise PureRefError('NOT_FOUND','PureRef 接口不存在。',404)
        key,route = match.groups(); session = self._session(key,handler)
        if method == 'DELETE' and not route:
            self._cleanup(session)
            with self.lock: self.sessions.pop(key,None)
            return handler.send_json(200,dict(cancelled=True))
        with session['lock']:
            directory = self._owned(session)
            if method == 'PUT' and route == 'upload':
                length = int(handler.headers.get('Content-Length','0')); offset = int(handler.headers.get('X-Upload-Offset','-1'))
                if session['phase'] != 'uploading' or not 0 < length <= CHUNK or offset != session['offset'] or offset+length > session['size']:
                    raise PureRefError('PUREREF_OFFSET','上传位置不匹配，请读取进度后重试。',409)
                if shutil.disk_usage(directory).free < length+HEADROOM: raise PureRefError('PUREREF_DISK','暂存磁盘空间不足。',507)
                old = handler.connection.gettimeout(); handler.connection.settimeout(60)
                try:
                    with self._file(session,'upload.pur').open('r+b') as target:
                        target.seek(offset); remaining = length
                        try:
                            while remaining:
                                if session['cancel'].is_set(): raise OSError()
                                chunk = handler.rfile.read(min(1024**2,remaining))
                                if not chunk: raise OSError()
                                target.write(chunk); remaining -= len(chunk)
                            target.flush(); os.fsync(target.fileno())
                        except BaseException:
                            target.truncate(offset); raise
                    session['offset'] += length
                finally: handler.connection.settimeout(old)
                return handler.send_json(200,dict(bytes=session['offset'],total=session['size']))
            if method == 'POST' and route == 'finish':
                self._json(handler)
                if session['phase'] == 'parsing': return handler.send_json(202,self._status(session))
                if session['phase'] != 'uploading' or session['offset'] != session['size']: raise PureRefError('PUREREF_OFFSET','文件尚未上传完成。',409)
                with self.lock:
                    if any(s.get('process') and s['process'].poll() is None for s in self.sessions.values()): raise PureRefError('PUREREF_BUSY','另一个 PureRef 正在解析。',409)
                    if session['cancel'].is_set(): raise PureRefError('PUREREF_CANCELLED','PureRef 导入已取消。',409)
                    atomic_write_json(directory/'status.json',dict(phase='verifying'))
                    session['process'] = subprocess.Popen([sys.executable,str(Path(__file__).with_name('pureref_worker.py')),str(directory),str(os.getpid()),str(psutil.Process().create_time())],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                    session['started'] = time.monotonic(); session['phase'] = 'parsing'
                return handler.send_json(202,dict(phase='verifying'))
            if method == 'GET' and route == 'status': return handler.send_json(200,self._status(session))
            if self._status(session)['phase'] != 'ready': raise PureRefError('PUREREF_NOT_READY','PureRef 图片尚未准备好。',409)
            manifest = json.loads(self._file(session,'resources.json').read_text(encoding='utf-8'))
            if method == 'GET' and route == 'resources':
                query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
                offset = int(query.get('offset',['0'])[0]); count = int(query.get('limit',['64'])[0])
                if offset < 0 or not 1 <= count <= 64: raise ValueError()
                return handler.send_json(200,dict(images=manifest['images'][offset:offset+count],count=len(manifest['images'])))
            resource = re.fullmatch(r'resources/([0-9a-f]{32})/(preview|copy)',route or '')
            if not resource: raise PureRefError('NOT_FOUND','PureRef 接口不存在。',404)
            handle,action = resource.groups()
            image = next((i for i in manifest['images'] if i['handle'] == handle),None)
            if not image: raise PureRefError('NOT_FOUND','PureRef 图片不存在。',404)
            if method == 'GET' and action == 'preview':
                preview = self._file(session,handle+'.preview')
                handler.send_response(200); handler.send_header('Content-Type','image/webp'); handler.send_header('Content-Length',str(preview.stat().st_size)); handler.send_header('Cache-Control','no-store'); handler.end_headers()
                with preview.open('rb') as source: shutil.copyfileobj(source,handler.wfile,64*1024)
                return
            if method == 'POST' and action == 'copy':
                data = self._json(handler)
                if data.get('projectId') != session['project']: raise PureRefError('PUREREF_OWNER','PureRef 会话不属于此项目。',409)
                document = self.store.get(session['project'])
                if len(document['canvas']['nodes'])+len(manifest['images']) > 4096: raise PureRefError('PUREREF_LIMIT','导入后画布节点不能超过 4096 个。',409)
                pending = manifest['totalBytes'] - session.get('copiedBytes',0)
                if shutil.disk_usage(session['projectPath'].parent).free < pending+image['bytes']+HEADROOM: raise PureRefError('PUREREF_DISK','项目磁盘空间不足；需要全部待复制图片与单图临时空间。',507)
                expected = ProjectAPI._revision(handler)
                receipt = session.setdefault('receipts',{}).get(handle)
                if receipt:
                    if expected not in {receipt['before'],receipt['result']['revision']} or document['revision'] != receipt['result']['revision']:
                        raise PureRefError('REVISION_CONFLICT','素材已保存但当前版本改变；请保留本页处理保存状态。',409)
                    return handler.send_json(200,receipt['result'])
                class Source:
                    def __init__(self, stream): self.stream=stream
                    def read(self,n):
                        if session['cancel'].is_set(): raise PureRefError('PUREREF_CANCELLED','PureRef 导入已取消。',409)
                        return self.stream.read(n)
                with self._file(session,handle+'.original').open('rb') as source:
                    result = self.store.put_asset(session['project'],image['name'],Source(source),image['mime'],expected_revision=expected)
                session['receipts'][handle] = dict(before=expected,result=result)
                session['copiedBytes'] = session.get('copiedBytes',0)+image['bytes']
                return handler.send_json(200,result)
            raise PureRefError('NOT_FOUND','PureRef 接口不存在。',404)

    def handle(self, handler, method, path):
        if not path.startswith('/api/pureref/'): return False
        try: self._handle(handler,method,path)
        except PureRefError as error: handler.send_json(error.status,dict(code=error.code,message=str(error)))
        except StoreError as error: ProjectAPI._error(handler,error)
        except (CredentialError,subprocess.SubprocessError): handler.send_json(503,dict(code='PUREREF_STORAGE',message='无法限制 PureRef 暂存目录为当前用户，导入已停止。'))
        except (ValueError,TypeError,OSError) as error:
            LOGGER.warning('PureRef local IO: %s winerror=%s',type(error).__name__,getattr(error,'winerror',None))
            handler.send_json(400,dict(code='PUREREF_IO',message='PureRef 请求失败、缓存无效或磁盘不可用。'))
        return True
