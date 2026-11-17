"""Independent loopback-only read-only geometry demo and stateless MCP transport."""
from __future__ import annotations
import argparse
import copy
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import signal
import sys
import threading
import time
import urllib.parse
import uuid

BASE = Path(__file__).resolve().parent
if str(BASE) not in sys.path: sys.path.insert(0, str(BASE))
from pcg_contracts import PCGError, canonical, exact, parse_json, require, safe_components, validate_parameters, validate_schema
from pcg_demo_session import DemoSession, MAX_ASSET_BYTES, MAX_CACHE_BYTES, MAX_CATALOG

TOOL_FILE = BASE / 'pcg' / 'demo-tools.json'
STATIC = {'/': ('index.html', 'text/html; charset=utf-8'),
          '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
          '/glb.js': ('glb.js', 'text/javascript; charset=utf-8'),
          '/renderer.js': ('renderer.js', 'text/javascript; charset=utf-8'),
          '/preview-stream.js': ('preview-stream.js', 'text/javascript; charset=utf-8'),
          '/style.css': ('style.css', 'text/css; charset=utf-8')}


class DemoApplication:
    def __init__(self, root, samples_root=None):
        require(not str(root).startswith(('\\\\', '//')), 'Network runtime roots are forbidden.', 'ASSET_PATH_FORBIDDEN')
        self.root = Path(root).absolute()
        for part in (self.root, *self.root.parents):
            if os.path.lexists(part): safe_components(part)
        self.root.mkdir(parents=True, exist_ok=True)
        safe_components(self.root)
        # One service owns its runtime directory; never overwrite a live marker.
        self.marker = self.root / 'demo-owner.json'
        if self.marker.exists():
            raise PCGError('RUNTIME_IN_USE', 'Use a new dedicated demo runtime directory.', 409)
        with self.marker.open('x', encoding='utf-8') as stream:
            json.dump({'owner': 'pcg-readonly-demo', 'pid': os.getpid()}, stream)
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.viewer = {'loaded': False, 'displayed': None, 'error': None, 'metrics': None}
        self.reports = {}
        self.url = None
        self.tools = parse_json(TOOL_FILE.read_bytes())
        for tool in self.tools['tools']: validate_schema(tool['inputSchema'])
        try: self.session = DemoSession(self.root, samples_root)
        except BaseException:
            self.marker.unlink(missing_ok=True)
            raise

    def state(self):
        state = self.session.snapshot()
        with self.lock: state['viewer'] = copy.deepcopy(self.viewer)
        state['url'] = self.url
        state['readOnly'] = True
        return state

    def call(self, name, arguments):
        descriptor = next((tool for tool in self.tools['tools'] if tool['name'] == name), None)
        require(descriptor is not None, 'Unknown demo tool.', 'TOOL_NOT_FOUND', 404)
        args = validate_parameters({'parameters': descriptor['inputSchema']}, arguments)
        if name == 'pcg_demo_describe':
            return {'schema': self.tools, 'instanceId': self.session.snapshot()['instanceId'],
                    'url': self.url, 'mcpUrl': self.url + 'mcp', 'localRendering': True,
                    'aiCallsPerFrame': 0, 'readOnly': True,
                    'budgets': {'maxAssetBytes':MAX_ASSET_BYTES, 'maxCacheBytes':MAX_CACHE_BYTES, 'maxCatalog':MAX_CATALOG, 'maxViewerClients':32},
                    'capabilities': {'geometryTypes':['Mesh','PointSet','InstanceSet'], 'autoFrame':True, 'autoTurntable':True,
                                     'liveM2Stages':True, 'modelEditing':False, 'externalResources':False}}
        if name == 'pcg_demo_open': return {'url': self.url, 'instanceId': self.session.snapshot()['instanceId'], 'readOnly': True}
        if name == 'pcg_demo_read_state': return self.state()
        if name == 'pcg_demo_wait':
            result = self.session.wait(**args)
            result['state'] = result.pop('snapshot')
            with self.lock: result['state']['viewer'] = copy.deepcopy(self.viewer)
            result['state'].update(url=self.url, readOnly=True)
            return result
        if name == 'pcg_demo_preview': return self.session.preview(**args)
        if name == 'pcg_demo_select': self.session.select(args['assetId'])
        elif name == 'pcg_demo_run': self.session.start(**args)
        elif name == 'pcg_demo_tune': self.session.tune(**args)
        elif name == 'pcg_demo_cancel': self.session.cancel(args['runId'])
        return self.state()

    def acknowledge(self, value):
        exact(value, {'clientId', 'reportSequence', 'selectionEpoch', 'assetId', 'status'}, {'metrics', 'error'})
        require(isinstance(value['clientId'], str) and 1 <= len(value['clientId']) <= 64, 'Invalid viewer identity.')
        require(type(value['selectionEpoch']) is int and value['status'] in {'loaded', 'error', 'context-lost'}, 'Invalid viewer status.')
        require(isinstance(value['assetId'], str), 'Invalid asset identity.')
        require(type(value['reportSequence']) is int and 0 < value['reportSequence'] <= 9007199254740991, 'Invalid report sequence.')
        metrics = value.get('metrics', {})
        require(isinstance(metrics, dict) and len(canonical(metrics)) <= 4096, 'Viewer metrics exceed budget.')
        allowed = {'status', 'frameCount', 'yaw', 'angle', 'cameraFramed', 'rotating', 'visible', 'meshCount', 'instanceCount', 'triangleCount', 'pointCount', 'vertexCount', 'drawCalls', 'gpuBytes', 'width', 'height'}
        require(set(metrics) <= allowed, 'Unknown viewer metrics.')
        for entry in metrics.values():
            require(type(entry) in (str, bool, int, float) and (not isinstance(entry, str) or len(entry) <= 64), 'Invalid viewer metric.')
            if type(entry) in (int, float): require(math.isfinite(entry) and abs(entry) <= 1e12, 'Invalid viewer metric range.')
        state = self.session.snapshot()
        desired = state.get('desired')
        require(desired and state['selectionEpoch'] == value['selectionEpoch'] and desired['assetId'] == value['assetId'], 'Discard stale viewer acknowledgement.', 'STALE_SELECTION', 409)
        with self.session.lock, self.lock:
            # Recheck after acquiring the publication lock to avoid delayed acks.
            fresh = self.session.snapshot()
            require(fresh['selectionEpoch'] == value['selectionEpoch'] and fresh['desired']['assetId'] == value['assetId'], 'Selection changed.', 'STALE_SELECTION', 409)
            previous = self.reports.get(value['clientId'])
            require(previous is None or value['reportSequence'] >= previous['reportSequence'], 'Discard older viewer report.', 'STALE_REPORT', 409)
            if previous and value['reportSequence'] == previous['reportSequence']:
                require(value == previous, 'A report identity cannot change content.', 'REPORT_CONFLICT', 409)
                return copy.deepcopy(self.viewer)
            require(previous is not None or len(self.reports) < 32, 'Viewer client capacity reached.', 'VIEWER_CAPACITY', 409)
            if value['status'] == 'loaded':
                require(metrics.get('cameraFramed') is True and type(metrics.get('frameCount')) is int and metrics['frameCount'] >= 1, 'The viewer has not drawn a framed model.', 'VIEWER_NOT_READY', 409)
                self.viewer.update(loaded=True, displayed=copy.deepcopy(desired), error=None)
            elif value['status'] == 'context-lost': self.viewer.update(loaded=False, displayed=None, error='WEBGL_CONTEXT_LOST')
            else:
                message = value.get('error', 'MODEL_LOAD_FAILED')
                require(isinstance(message, str) and len(message) <= 300, 'Invalid viewer error.')
                self.viewer['error'] = message
            self.viewer.update(clientId=value['clientId'], selectionEpoch=value['selectionEpoch'],
                               reportSequence=value['reportSequence'], metrics=copy.deepcopy(metrics), reportedAt=time.time())
            self.reports[value['clientId']] = copy.deepcopy(value)
            return copy.deepcopy(self.viewer)

    def close(self):
        try: self.session.close()
        finally: self.marker.unlink(missing_ok=True)


class DemoHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    def __init__(self, app, port=0):
        require(type(port) is int and 0 <= port <= 65535 and port not in {8188, 8189, 8790}, 'Protected or invalid port.', 'PORT_FORBIDDEN')
        self.app = app
        super().__init__(('127.0.0.1', port), DemoHandler)
        self.origin = f'http://127.0.0.1:{self.server_port}'
        app.url = self.origin + '/'


class DemoHandler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send(self, code, body, mime='application/json; charset=utf-8', cookie=False):
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        if cookie: self.send_header('Set-Cookie', f'pcg_demo_{self.server.server_port}={self.server.app.token}; HttpOnly; SameSite=Strict; Path=/')
        self.end_headers()
        self.wfile.write(body)

    def guard(self, authenticate=True, bootstrap=False):
        require(self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}', 'Host is not this isolated service.', 'HOST_FORBIDDEN', 403)
        origin = self.headers.get('Origin')
        require(origin is None or origin == self.server.origin, 'Cross-origin requests are forbidden.', 'ORIGIN_FORBIDDEN', 403)
        navigation = bootstrap and self.command == 'GET' and self.headers.get('Sec-Fetch-Mode') == 'navigate' and self.headers.get('Sec-Fetch-Dest') == 'document'
        require(self.headers.get('Sec-Fetch-Site') != 'cross-site' or navigation, 'Cross-site requests are forbidden.', 'ORIGIN_FORBIDDEN', 403)
        if authenticate:
            cookie = SimpleCookie()
            try: cookie.load(self.headers.get('Cookie', ''))
            except Exception: raise PCGError('UNAUTHORIZED', 'Invalid session.', 401)
            name = f'pcg_demo_{self.server.server_port}'
            raw = cookie[name].value if name in cookie else ''
            bearer = self.headers.get('Authorization', '').removeprefix('Bearer ')
            require(secrets.compare_digest(raw, self.server.app.token) or secrets.compare_digest(bearer, self.server.app.token), 'Open this demo page or use its local bearer credential.', 'UNAUTHORIZED', 401)

    def body(self):
        require(self.headers.get_content_type() == 'application/json', 'Expected application/json.', 'BAD_REQUEST')
        length = int(self.headers.get('Content-Length', '0'))
        require(0 < length <= 32768, 'Request exceeds budget.', 'BAD_REQUEST')
        return parse_json(self.rfile.read(length))

    def execute_request(self, post=False):
        try:
            path = urllib.parse.urlsplit(self.path).path
            self.guard(authenticate=path not in STATIC, bootstrap=not post and path == '/')
            app = self.server.app
            if not post and path in STATIC:
                name, mime = STATIC[path]
                self.send(200, (BASE / 'pcg_demo_viewer' / name).read_bytes(), mime, cookie=path == '/')
            elif not post and path == '/api/state': self.send(200, canonical(app.state()))
            elif not post and path == '/api/tools': self.send(200, canonical(app.tools))
            elif not post and path.startswith('/api/previews/') and path.endswith('.json'):
                body = app.session.read_preview(path[len('/api/previews/'):-5])
                self.send(200, body)
            elif not post and path.startswith('/api/assets/') and path.endswith('.glb'):
                asset_id = path[len('/api/assets/'):-4]
                body, _ = app.session.read_asset(asset_id)
                self.send(200, body, 'model/gltf-binary')
            elif post and path == '/api/tool':
                value = self.body(); exact(value, {'name', 'arguments'})
                self.send(200, canonical({'ok': True, 'result': app.call(value['name'], value['arguments'])}))
            elif post and path == '/api/viewer': self.send(200, canonical({'ok': True, 'viewer': app.acknowledge(self.body())}))
            elif post and path == '/mcp': self.mcp(self.body())
            else: self.send(404, canonical({'code': 'NOT_FOUND', 'message': 'Unknown demo route.'}))
        except PCGError as exc: self.send(exc.status, canonical({'code': exc.code, 'message': exc.message}))
        except (ValueError, TypeError, KeyError, OSError, RecursionError): self.send(400, canonical({'code': 'BAD_REQUEST', 'message': 'Invalid demo request.'}))

    def mcp(self, value):
        exact(value, {'jsonrpc', 'method'}, {'id', 'params'})
        require(value['jsonrpc'] == '2.0', 'Invalid JSON-RPC version.')
        method, params = value['method'], value.get('params', {})
        if method == 'notifications/initialized':
            self.send(202, b''); return
        require('id' in value and type(value['id']) in (str, int), 'MCP request requires an identity.')
        if method == 'initialize': result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {'listChanged': False}}, 'serverInfo': {'name': 'pcg-readonly-demo', 'version': '1.0.0'}}
        elif method == 'ping': result = {}
        elif method == 'tools/list': result = {'tools': [{k: item[k] for k in ('name', 'description', 'inputSchema')} for item in self.server.app.tools['tools']]}
        elif method == 'tools/call':
            exact(params, {'name'}, {'arguments'})
            try:
                answer = self.server.app.call(params['name'], params.get('arguments', {}))
                result = {'content': [{'type': 'text', 'text': canonical(answer).decode('utf-8')}], 'isError': False}
            except PCGError as exc: result = {'content': [{'type': 'text', 'text': canonical({'code': exc.code, 'message': exc.message}).decode('utf-8')}], 'isError': True}
        else:
            self.send(200, canonical({'jsonrpc': '2.0', 'id': value['id'], 'error': {'code': -32601, 'message': 'Unknown MCP method.'}})); return
        self.send(200, canonical({'jsonrpc': '2.0', 'id': value['id'], 'result': result}))

    def do_GET(self): self.execute_request()
    def do_POST(self): self.execute_request(post=True)


def main():
    parser = argparse.ArgumentParser(description='Start an independent local read-only geometry demo.')
    parser.add_argument('--runtime-dir', required=True, type=Path)
    parser.add_argument('--samples-root', type=Path)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--exit-on-stdin-close', action='store_true', help='Owned test harness only: gracefully close when its stdin pipe ends.')
    args = parser.parse_args()
    app = DemoApplication(args.runtime_dir, args.samples_root)
    try: server = DemoHTTPServer(app, args.port)
    except BaseException:
        app.close(); raise
    instance = {'instanceId': app.session.snapshot()['instanceId'], 'pid': os.getpid(), 'port': server.server_port,
                'url': app.url, 'mcpUrl': app.url + 'mcp', 'token': app.token, 'readOnly': True}
    marker = args.runtime_dir / 'instance.json'
    try:
        with marker.open('xb') as stream: stream.write(canonical(instance))
    except BaseException:
        server.server_close(); app.close(); raise
    print(canonical({k: v for k, v in instance.items() if k != 'token'}).decode('utf-8'), flush=True)
    def terminate(*_): threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    if args.exit_on_stdin_close:
        def monitor_parent():
            while sys.stdin.buffer.read(1): pass
            server.shutdown()
        threading.Thread(target=monitor_parent, daemon=True).start()
    try: server.serve_forever(poll_interval=.1)
    finally:
        server.server_close(); app.close(); marker.unlink(missing_ok=True)


if __name__ == '__main__': main()
