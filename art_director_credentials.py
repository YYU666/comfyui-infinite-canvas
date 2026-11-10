"""Windows current-user protected credentials, never part of a project/export.

Only synthetic values belong in tests. No plaintext fallback, OS credential dialogs,
raw OS exception text, external URLs or caller-controlled credential paths.
"""
import base64
import ctypes
import json
import os
import threading
import uuid
from pathlib import Path
from ctypes import wintypes
from workbench_lifecycle import runtime_dir

BASENAME = 'art-director-credentials.dpapi'
MAGIC = b'H3-ART-DPAPI-V1\n'
MAX_FILE = 64 * 1024


class CredentialError(RuntimeError):
    def __init__(self):
        super().__init__('本机安全凭据存储不可用；未写入明文。可使用本次会话或后端环境配置。')


def _dpapi(value, decrypt=False):
    if os.name != 'nt':
        raise CredentialError()
    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]
    raw = ctypes.create_string_buffer(value)
    incoming = Blob(len(value), ctypes.cast(raw, ctypes.POINTER(ctypes.c_ubyte)))
    entropy_raw = ctypes.create_string_buffer(b'Refmuse.ArtDirector.Credentials.v1')
    entropy = Blob(len(entropy_raw.value), ctypes.cast(entropy_raw, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p if decrypt else wintypes.LPCWSTR, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    ok = function(ctypes.byref(incoming), None if decrypt else 'Refmuse art director credentials', ctypes.byref(entropy), None, None, 1, ctypes.byref(outgoing))
    if not ok:
        raise CredentialError()
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        local_free = ctypes.WinDLL('kernel32').LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free(ctypes.cast(outgoing.pbData, ctypes.c_void_p))


def private_acl(path):
    """Replace DACL, not merely add a grant (which could retain broad explicit ACEs)."""
    if os.name != 'nt':
        raise CredentialError()
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    token = wintypes.HANDLE()
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_uint, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.GetTokenInformation.restype = wintypes.BOOL
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    advapi.SetFileSecurityW.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise CredentialError()
    sid_text = wintypes.LPWSTR()
    descriptor = ctypes.c_void_p()
    try:
        needed = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
            raise CredentialError()
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)):
            raise CredentialError()
        sddl = f'D:P(A;;FA;;;{sid_text.value})'
        if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise CredentialError()
        if not advapi.SetFileSecurityW(str(path), 0x80000004, descriptor):
            raise CredentialError()
    finally:
        if descriptor: kernel.LocalFree(descriptor)
        if sid_text: kernel.LocalFree(ctypes.cast(sid_text, ctypes.c_void_p))
        kernel.CloseHandle(token)


class ArtCredentialStore:
    def __init__(self, forbidden_roots=(), directory=None, protect=None, unprotect=None, secure=None):
        self.directory = Path(directory) if directory is not None else runtime_dir() / 'credentials'
        self.path = self.directory / BASENAME
        self.forbidden_roots = [Path(__file__).resolve().parent, *map(Path, forbidden_roots)]
        self.protect = protect or (lambda data: _dpapi(data))
        self.unprotect = unprotect or (lambda data: _dpapi(data, decrypt=True))
        self.secure = secure or private_acl
        self.lock = threading.RLock()

    def _safe(self):
        try:
            resolved = self.path.resolve()
            for root in self.forbidden_roots:
                if resolved.is_relative_to(root.resolve()): raise CredentialError()
            for path in [self.path, self.directory]:
                if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()): raise CredentialError()
            if self.path.exists() and (not self.path.is_file() or self.path.stat().st_size > MAX_FILE): raise CredentialError()
        except CredentialError:
            raise
        except Exception:
            raise CredentialError() from None

    def available(self):
        try:
            self._safe()
            return os.name == 'nt'
        except CredentialError:
            return False

    def _load(self):
        self._safe()
        if not self.path.exists(): return {}
        try:
            self.secure(self.directory); self.secure(self.path)
            raw = self.path.read_bytes()
            if not raw.startswith(MAGIC): raise CredentialError()
            plain = self.unprotect(base64.b64decode(raw[len(MAGIC):], validate=True))
            body = json.loads(plain.decode('utf-8'))
            if not isinstance(body, dict) or body.get('version') != 1 or not isinstance(body.get('keys'), dict): raise CredentialError()
            for name, key in body['keys'].items():
                if name not in ('qwen','kimi','doubao','deepseek') or not isinstance(key,str) or not 8 <= len(key) <= 4096 or any(c.isspace() for c in key): raise CredentialError()
            return body['keys']
        except Exception:
            raise CredentialError() from None

    def get(self, provider):
        with self.lock: return self._load().get(provider, '')

    def set(self, provider, key):
        if provider not in ('qwen','kimi','doubao','deepseek') or not isinstance(key,str) or len(key)>4096 or key and (len(key)<8 or any(c.isspace() for c in key)): raise CredentialError()
        with self.lock:
            self._safe()
            keys = self._load()
            if key: keys[provider] = key
            else: keys.pop(provider,None)
            temporary = self.directory / f'.{BASENAME}.{uuid.uuid4().hex}.tmp'
            try:
                # Encrypt before creating or changing any on-disk content.
                encrypted = self.protect(json.dumps({'version':1,'keys':keys}).encode('utf-8'))
                if not isinstance(encrypted,bytes) or not encrypted: raise CredentialError()
                self.directory.mkdir(parents=True,exist_ok=True)
                self.secure(self.directory)
                with temporary.open('xb') as handle:
                    self.secure(temporary)
                    handle.write(MAGIC+base64.b64encode(encrypted));handle.flush();os.fsync(handle.fileno())
                self._safe()
                os.replace(temporary,self.path)
                self.secure(self.path)
            except Exception:
                raise CredentialError() from None
            finally:
                temporary.unlink(missing_ok=True)
