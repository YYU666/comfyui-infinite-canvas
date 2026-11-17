"""PCG HTTP adapter. Called only after the host's authenticated origin guards."""
from __future__ import annotations

import json
import urllib.parse

from pcg_contracts import PCGError, exact, parse_json, require
from pcg_runtime import PCGRuntime, HANDLE
from project_store import StoreError


class PCGAPI:
    def __init__(self, store):
        self.runtime = PCGRuntime(store)

    @property
    def store(self):
        return self.runtime.store

    @store.setter
    def store(self, replacement):
        # Changing project roots invalidates all handles from the old store.
        self.runtime.close()
        self.runtime = PCGRuntime(replacement)

    def close(self):
        self.runtime.close()

    def active_count(self):
        return self.runtime.active_count()

    @staticmethod
    def _json(handler):
        try:
            length = int(handler.headers.get('Content-Length', '0'))
            require(0 < length <= 65536, 'PCG request must be 1 through 65536 bytes.', 'BAD_REQUEST')
            value = parse_json(handler.rfile.read(length))
            require(isinstance(value, dict), 'PCG request must be an object.', 'BAD_REQUEST')
            raw_revision = handler.headers.get('If-Match')
            if raw_revision is not None:
                require(raw_revision.strip('"') == str(value.get('revision')), 'If-Match and revision differ.', 'REVISION_CONFLICT', 409)
            return value
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise PCGError('BAD_REQUEST', 'Invalid PCG JSON request.') from exc

    def handle(self, handler, method, path):
        if not path.startswith('/api/pcg/'):
            return False
        try:
            if method == 'GET' and path == '/api/pcg/registry':
                handler.send_json(200, self.runtime.registry)
            elif method == 'GET' and path.startswith('/api/pcg/artifacts/'):
                pairs = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query, keep_blank_values=True, max_num_fields=16)
                require(all(len(v) == 1 for v in pairs.values()), 'Duplicate query fields.', 'BAD_REQUEST')
                query = {k: v[0] for k, v in pairs.items()}; exact(query, HANDLE)
                for name in ('revision', 'descriptorVersion', 'operationVersion'): query[name] = int(query[name])
                body, artifact = self.runtime.download(query, path.removeprefix('/api/pcg/artifacts/'))
                handler.send_response(200)
                handler.send_header('Content-Type', artifact['mime'])
                handler.send_header('Content-Length', str(len(body)))
                handler.send_header('Cache-Control', 'no-store')
                handler.send_header('X-Content-Type-Options', 'nosniff')
                if artifact['format'] != 'svg': handler.send_header('Content-Disposition', 'attachment; filename="' + artifact['artifactId'] + '.' + artifact['format'] + '"')
                handler.end_headers(); handler.wfile.write(body)
            elif method == 'GET' and path.startswith('/api/pcg/tasks'):
                pairs = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query, keep_blank_values=True, max_num_fields=16)
                require(all(len(v) == 1 for v in pairs.values()), 'Duplicate query fields.', 'BAD_REQUEST')
                query = {k: v[0] for k, v in pairs.items()}
                if path == '/api/pcg/tasks':
                    exact(query, {'projectId', 'nodeId'})
                    result = self.runtime.list_tasks(query['projectId'], query['nodeId'])
                else:
                    job_id = path.removeprefix('/api/pcg/tasks/')
                    exact(query, HANDLE - {'jobId'})
                    for name in ('revision', 'descriptorVersion', 'operationVersion'):
                        try: query[name] = int(query[name])
                        except ValueError as exc: raise PCGError('BAD_REQUEST', 'Invalid task query version.') from exc
                    result = self.runtime.read({**query, 'jobId': job_id})
                handler.send_json(200, result)
            elif method == 'POST' and path in {'/api/pcg/preflight', '/api/pcg/run', '/api/pcg/wait', '/api/pcg/read', '/api/pcg/verify', '/api/pcg/cancel', '/api/pcg/export'}:
                payload = self._json(handler)
                operation = path.rsplit('/', 1)[-1]
                if operation == 'run':
                    task = self.runtime.run(payload)
                    if task['error']:
                        handler.send_json(409, {**task['error'], 'task': task})
                    else: handler.send_json(202, {'task': task})
                else:
                    result = getattr(self.runtime, operation)(payload)
                    handler.send_json(200, result)
            else:
                handler.send_json(404, {'code': 'NOT_FOUND', 'message': 'PCG route not found.'})
        except (PCGError, StoreError) as exc:
            handler.send_json(exc.status, {'code': exc.code, 'message': exc.message, 'details': exc.details})
        except (ValueError, TypeError, KeyError, OSError, RecursionError):
            handler.send_json(400, {'code': 'BAD_REQUEST', 'message': 'Invalid PCG request or project contract.'})
        return True
