"""Read-only public publication preflight; never authenticates or uploads."""
from __future__ import annotations

import base64
import hashlib
import io
import re
import zipfile
import urllib.error
import urllib.parse
import urllib.request

from workflow_extensions import ExtensionError, read_json, require

ORIGIN = 'https://refmuse.cn'
MAX_RESPONSE = 1024 * 1024
TIMEOUT = 10


def unavailable():
    return ExtensionError('无法可靠核对公开节点库。请稍后重试状态检查；不要据此认定尚未发布或重复上传。', 'PUBLICATION_UNAVAILABLE', 503)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _public_json(path):
    request = urllib.request.Request(ORIGIN + path, headers={'Accept': 'application/json', 'Cache-Control': 'no-cache'}, method='GET')
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=TIMEOUT) as response:
            if response.status != 200:
                raise unavailable()
            data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise unavailable()
        result = read_json(data, 'public publication')
        if not isinstance(result, dict):
            raise unavailable()
        return result
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            exc.close()
            return None
        raise unavailable() from exc
    except (OSError, ValueError) as exc:
        raise unavailable() from exc


def _privacy_require(condition):
    require(condition, '包内含未清理的素材、路径、凭据或附件。请通过分享面板重新准备干净的包，再发布。', 'PUBLICATION_PRIVACY_REVIEW_REQUIRED')


def _check_text(value):
    _privacy_require(not re.search(
        r'data:(?:image|video|audio)/|(?:iVBORw0KGgo|/9j/)[A-Za-z0-9+/=]{32,}'
        r'|\bBearer\s+[A-Za-z0-9_.-]{16,}|\bsk-[A-Za-z0-9_-]{20,}'
        r'|(?:^|[\s\("\x27=])[A-Za-z]:[\\/]|file://|\\\\[^\s\\]+\\'
        r'|^[/\\]|(?:^|[\s\("\x27=])/(?!/)[A-Za-z0-9_.-]+/'
        r'|https?://[^\s]*[?&](?:token|key|signature|api_key|access_token|auth|authorization|password|secret)='
        r'|https?://[^/\s]+:[^/@\s]+@'
        r'|(?:api.?key|password|secret|access.?token|authorization|cookie)\s*[:=]\s*["\x27]?[A-Za-z0-9_./+=-]{8,}', value, re.I))


def _check_value(value):
    if isinstance(value, dict):
        for key, item in value.items():
            _check_text(key)
            if re.search(r'(?:api.?key|password|secret|access.?token|authorization|cookie)', key, re.I):
                _privacy_require(not item)
            _check_value(item)
    elif isinstance(value, list):
        for item in value:
            _check_value(item)
    elif isinstance(value, str):
        _check_text(value)


def _check_archive_privacy(store, digest, bundle):
    # Validate the bytes that the iframe will upload, not only visible defaults.
    # Nothing is rewritten: a different archive must receive a different digest.
    from extension_sharing import _sanitize, _thumbnail
    from PIL import Image
    archive = store.download(digest)
    require(hashlib.sha256(archive).hexdigest() == digest, '本地包摘要不一致。', 'DIGEST_MISMATCH')
    manifest = bundle['manifest']
    allowed = {'manifest.json', 'README.md', 'LICENSE'}
    for entry in manifest['nodes']:
        allowed.update((entry['definition'], entry['workflow']))
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            _privacy_require(set(package.namelist()) == allowed)
            for name in allowed:
                raw = package.read(name)
                if name in ('README.md', 'LICENSE'):
                    _check_text(raw.decode('utf-8'))
                    continue
                value = read_json(raw, name)
                if name == 'manifest.json' and 'preview' in value:
                    preview = value.pop('preview')
                    _thumbnail(preview)  # Sharing's size/type/dimension limits.
                    content = base64.b64decode(preview.split(',', 1)[1], validate=True)
                    with Image.open(io.BytesIO(content)) as image:
                        _privacy_require(not image.getexif() and set(image.info) <= {'jfif', 'jfif_version', 'jfif_unit', 'jfif_density'})
                    _privacy_require(content.endswith(b'\xff\xd9'))
                _check_value(value)
        for item in bundle['nodes']:
            graph = item['workflow']
            staged = 'execution' in item['definition']
            clean, _ = _sanitize(graph, True, {}, staged)
            for key, node in graph.items():
                if node['class_type'] == 'LoadImage':
                    _privacy_require(node['inputs'].get('image') == clean[key]['inputs'].get('image'))
                if node['class_type'] == 'SaveImage':
                    _privacy_require(not re.match(r'[/\\]|[A-Za-z]:', node['inputs'].get('filename_prefix', '')))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        if isinstance(exc, ExtensionError) and exc.code == 'PUBLICATION_PRIVACY_REVIEW_REQUIRED':
            raise
        raise ExtensionError('包未通过发布隐私检查，请重新准备分享包。', 'PUBLICATION_PRIVACY_REVIEW_REQUIRED') from exc


def _semver(value):
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError('invalid version')
    match = re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?', value)
    if not match:
        raise ValueError('invalid version')
    parts = []
    for token in (match[4].split('.') if match[4] else []):
        if token.isdigit():
            if len(token) > 1 and token.startswith('0'):
                raise ValueError('invalid prerelease')
            parts.append((0, int(token)))
        else:
            parts.append((1, token))
    return (*map(int, match.groups()[:3]), not bool(match[4]), tuple(parts))


def _record(value, package_id):
    if not isinstance(value, dict) or value.get('packageId') != package_id or value.get('status') != 'published' or value.get('revokedAt'):
        raise unavailable()
    try:
        _semver(value.get('version'))
    except ValueError as exc:
        raise unavailable() from exc
    digest = value.get('digest')
    if not isinstance(digest, str) or not re.fullmatch(r'(?:sha256:)?[0-9a-f]{64}', digest):
        raise unavailable()
    return {'packageId': package_id, 'version': value['version'], 'digest': digest.removeprefix('sha256:')}


def publication_status(store, digest, payload):
    require(isinstance(payload, dict) and set(payload) == {'packageId', 'version', 'mode'}, '发布预检参数无效。', 'BAD_REQUEST')
    package_id, version, mode = payload['packageId'], payload['version'], payload['mode']
    require(isinstance(package_id, str) and len(package_id) <= 256 and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', package_id), '发布包身份无效。', 'BAD_REQUEST')
    require(isinstance(mode, str) and mode in ('update', 'publish'), '请选择更新或发布模式。', 'BAD_REQUEST')
    try:
        wanted = _semver(version)
    except ValueError as exc:
        raise ExtensionError('发布版本必须是有效的语义版本号。', 'PUBLICATION_VERSION_INVALID') from exc
    bundle = store.get(digest)
    require(bundle['manifest']['packageId'] == package_id and bundle['manifest']['version'] == version,
            '请求身份或版本与本地固定包不一致。', 'PUBLICATION_IDENTITY_MISMATCH')
    require(bundle['digest'] == digest, '本地包摘要不一致。', 'DIGEST_MISMATCH')
    _check_archive_privacy(store, digest, bundle)
    base = '/api/open/items/' + package_id + '/versions'
    listing = _public_json(base)
    rows = []
    if listing is not None:
        if not isinstance(listing.get('items'), list) or len(listing['items']) > 1000 or any(listing.get(key) for key in ('nextCursor', 'next', 'hasMore')):
            raise unavailable()
        rows = [_record(row, package_id) for row in listing['items']]
        if len({row['version'] for row in rows}) != len(rows):
            raise unavailable()
    exact_raw = _public_json(base + '/' + urllib.parse.quote(version, safe='') + '/manifest')
    exact = _record(exact_raw, package_id) if exact_raw is not None else None
    listed_exact = next((row for row in rows if row['version'] == version), None)
    if exact is not None:
        if exact['version'] != version or (listed_exact and listed_exact['digest'] != exact['digest']):
            raise unavailable()
        if exact['digest'] != digest:
            raise ExtensionError('该版本已发布其他内容，请提高版本号后重新准备包。', 'PUBLICATION_DIGEST_CONFLICT', 409)
        return {'status': 'published', **exact, 'mode': mode, 'latestVersion': max(rows, key=lambda r: _semver(r['version']))['version'] if rows else version}
    if listed_exact:
        raise unavailable()
    latest = max(rows, key=lambda row: _semver(row['version'])) if rows else None
    if latest:
        require(mode == 'update', '该包已存在，请使用更新模式。', 'PUBLICATION_ALREADY_EXISTS')
        require(wanted > _semver(latest['version']), '更新版本必须高于公开节点库的最新版本。', 'PUBLICATION_VERSION_NOT_NEWER')
    else:
        require(mode == 'publish', '公开节点库中没有可更新的包，请核对包身份或明确选择首次发布。', 'PUBLICATION_PACKAGE_NOT_FOUND')
    return {'status': 'ready', 'packageId': package_id, 'version': version, 'digest': digest, 'mode': mode,
            'latestVersion': latest['version'] if latest else None, 'latestDigest': latest['digest'] if latest else None}
