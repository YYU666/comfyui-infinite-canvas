"""HTTP adapter; launcher enforces its normal origin/token guard first."""
import json
import re
import urllib.parse
from project_store import StoreError

class Native3DAPI:
    def __init__(self, jobs):
        self.jobs = jobs

    def _error(self, handler, error):
        handler.send_json(error.status, {'code':error.code, 'message':error.message, 'details':error.details})

    def handle_get(self, handler, path):
        if not path.startswith('/api/native3d/'):
            return False
        try:
            if path == '/api/native3d/capabilities':
                handler.send_json(200, self.jobs.capabilities())
            elif path == '/api/native3d/pixal3d-readiness':
                from scripts.check_pixal3d import check_readiness
                server = handler.server
                if server.native3d_only:
                    handler.send_json(200, {'ready': False, 'reason': '仅 3D 模式未启用 ComfyUI。'})
                else:
                    try:
                        report = check_readiness(server.extension_api.object_info())
                    except (StoreError, OSError, ValueError):
                        report = {'ready': False, 'reason': '当前 ComfyUI 不可用。'}
                    handler.send_json(200, report)
            elif path == '/api/native3d/jobs':
                query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
                handler.send_json(200, {'jobs':self.jobs.list(query.get('projectId', [''])[0])})
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})', path):
                handler.send_json(200, self.jobs.get(match[1]))
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})/diagnostic-preview/(layout|checker)', path):
                query=urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
                file=self.jobs.diagnostic_preview(match[1],match[2],query.get('projectId',[''])[0],query.get('nodeId',[''])[0])
                data=file.read_bytes()
                handler.send_response(200)
                handler.send_header('Content-Type','image/png')
                handler.send_header('Content-Length',str(len(data)))
                handler.send_header('Cache-Control','no-store')
                handler.end_headers();handler.wfile.write(data)
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})/issues/(lod[0-4])(/image)?', path):
                if match[3]:
                    data=self.jobs.lod_issues(match[1],match[2],image=True).read_bytes()
                    handler.send_response(200);handler.send_header('Content-Type','image/png');handler.send_header('Content-Length',str(len(data)));handler.send_header('Cache-Control','no-store');handler.end_headers();handler.wfile.write(data)
                else:handler.send_json(200,self.jobs.lod_issues(match[1],match[2]))
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})/repair-preview/(lod[0-4])(/image)?', path):
                if match[3]:
                    data=self.jobs.lod_repair_preview(match[1],match[2],image=True).read_bytes()
                    handler.send_response(200);handler.send_header('Content-Type','image/png');handler.send_header('Content-Length',str(len(data)));handler.send_header('Cache-Control','no-store');handler.end_headers();handler.wfile.write(data)
                else:handler.send_json(200,self.jobs.lod_repair_preview(match[1],match[2]))
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})/stage-preview/(fit|lod_[1-9][0-9]{0,5}|lod[0-4])', path):
                query=urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
                diagnostic=query.get('diagnostic',['false'])
                if diagnostic not in (['true'],['false']):
                    raise StoreError('BAD_REQUEST','Invalid diagnostic preview flag')
                file = self.jobs.stage_preview(match[1], match[2],diagnostic=diagnostic==['true'])
                data = file.read_bytes()
                handler.send_response(200)
                handler.send_header('Content-Type', 'image/png')
                handler.send_header('Content-Length', str(len(data)))
                handler.send_header('Cache-Control', 'private, max-age=3600')
                handler.end_headers()
                handler.wfile.write(data)
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})/uv-preview/(seams|checker|ao|ao-seams)', path):
                file = self.jobs.uv_preview(match[1], match[2])
                data = file.read_bytes()
                handler.send_response(200)
                handler.send_header('Content-Type', 'image/png')
                handler.send_header('Content-Length', str(len(data)))
                handler.send_header('Cache-Control', 'private, max-age=3600')
                handler.end_headers()
                handler.wfile.write(data)
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})/files/(.+)', path):
                file = self.jobs.output_file(match[1], urllib.parse.unquote(match[2]))
                status, headers, start, length = self.jobs.store.range_response(file, handler.headers.get('Range'))
                handler.send_response(status)
                for key, value in headers.items():
                    handler.send_header(key, value)
                handler.end_headers()
                with file.open('rb') as stream:
                    stream.seek(start)
                    while length:
                        chunk = stream.read(min(length, 1024*1024))
                        if not chunk:
                            break
                        handler.wfile.write(chunk)
                        length -= len(chunk)
            else:
                raise StoreError('NOT_FOUND', 'Native3D route not found', 404)
        except StoreError as exc:
            self._error(handler, exc)
        return True

    def handle_post(self, handler, path):
        if not path.startswith('/api/native3d/'):
            return False
        try:
            if path == '/api/native3d/jobs':
                try:
                    length = int(handler.headers.get('Content-Length', '0'))
                    if not 0 < length <= 65536:
                        raise ValueError()
                    payload = json.loads(handler.rfile.read(length).decode('utf-8'))
                except (ValueError, UnicodeError):
                    raise StoreError('BAD_REQUEST', 'Expected JSON object up to 64 KiB')
                handler.send_json(200, self.jobs.submit(payload))
            elif match := re.fullmatch(r'/api/native3d/jobs/(n3d_[a-f0-9]{32})/cancel', path):
                handler.send_json(200, self.jobs.cancel(match[1]))
            else:
                raise StoreError('NOT_FOUND', 'Native3D route not found', 404)
        except StoreError as exc:
            self._error(handler, exc)
        return True
