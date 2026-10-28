from __future__ import annotations

import hmac
import urllib.parse
from http.cookies import SimpleCookie

LOOPBACK_HOSTS = {"127.0.0.1", "localhost"}
ARCHIVE_TYPES = {"application/zip", "application/x-zip-compressed", "application/octet-stream"}


def _endpoint(value):
    try:
        parsed = urllib.parse.urlsplit(value if "://" in value else f"//{value}")
        return parsed.hostname, parsed.port
    except ValueError:
        return None, None


def valid_host(value, port):
    hostname, requested_port = _endpoint(value or "")
    return hostname in LOOPBACK_HOSTS and requested_port == int(port)


def valid_origin(value, port):
    if not value:
        return True
    parsed = urllib.parse.urlsplit(value)
    hostname, requested_port = _endpoint(value)
    return parsed.scheme == "http" and hostname in LOOPBACK_HOSTS and requested_port == int(port) and not parsed.path and not parsed.query and not parsed.fragment


def valid_content_type(method, path, headers):
    try:
        length = int(headers.get("Content-Length", "0"))
    except ValueError:
        return False
    if length <= 0:
        return True
    content_type = headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if method == "PUT" and "/assets/" in path:
        return content_type == "application/octet-stream" or content_type.startswith(("image/", "video/", "audio/"))
    if path in {"/api/projects/import", "/api/projects/migration-backup"}:
        return content_type in ARCHIVE_TYPES or content_type == "application/json" and path == "/api/projects/import"
    return content_type == "application/json"


def valid_token(headers, expected):
    supplied = headers.get("X-H3-Token", "")
    if supplied and hmac.compare_digest(supplied, expected):
        return True
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get("Cookie", ""))
    except Exception:
        return False
    morsel = cookie.get("h3_session")
    return bool(morsel and hmac.compare_digest(morsel.value, expected))


def session_cookie(token):
    return f"h3_session={token}; Path=/; HttpOnly; SameSite=Strict"
