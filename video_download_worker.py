"""Run yt-dlp in a separate process with public-network-only native downloads.

The guard is intentionally process-local: it must never replace sockets in the
workbench, whose ComfyUI and browser bridge legitimately use loopback addresses.
"""
from __future__ import annotations

import errno
import importlib
import ipaddress
import socket
import sys


def public_address(address, family=socket.AF_INET, sock_type=socket.SOCK_STREAM, proto=0):
    if family not in (socket.AF_INET, socket.AF_INET6) or not isinstance(address, tuple) or len(address) < 2:
        raise PermissionError("视频下载不允许访问本机套接字。")
    host, port = address[:2]
    if not isinstance(host, str) or "%" in host:
        raise PermissionError("视频下载地址无效。")
    records = socket.getaddrinfo(host, port, family, sock_type, proto)
    if not records:
        raise PermissionError("视频下载地址无法解析。")
    for record in records:
        ip = ipaddress.ip_address(record[4][0])
        if not ip.is_global or ip.is_multicast or (ip.version == 6 and (
                ip not in ipaddress.ip_network("2000::/3") or ip.sixtofour is not None or ip.teredo is not None)):
            raise PermissionError("为保护本机安全，视频下载及跳转不能访问内网或本机地址。")
    # Connect to the checked numeric address, not the hostname, so the OS cannot
    # perform a second DNS lookup between validation and connection.
    return records[0][4]


class PublicSocket(socket.socket):
    def connect(self, address):
        return super().connect(public_address(address, self.family, self.type, self.proto))

    def connect_ex(self, address):
        try:
            return super().connect_ex(public_address(address, self.family, self.type, self.proto))
        except PermissionError:
            return errno.EACCES

    def sendto(self, *args, **kwargs):
        raise PermissionError("视频下载不支持 UDP 或未连接的套接字。")


def configure_downloader():
    import yt_dlp
    from yt_dlp.downloader.external import ExternalFD
    from yt_dlp.networking.common import _REQUEST_HANDLERS
    from yt_dlp.utils import DownloadError

    # curl_cffi connects in native code and bypasses Python's socket guard.
    # Pin the installed, locked yt-dlp transport to its stdlib implementation.
    urllib_handler = _REQUEST_HANDLERS.get("Urllib")
    if urllib_handler is None:
        raise RuntimeError("当前 yt-dlp 缺少安全下载所需的 Urllib 网络实现。")
    _REQUEST_HANDLERS.clear()
    _REQUEST_HANDLERS["Urllib"] = urllib_handler
    module = importlib.import_module("yt_dlp.YoutubeDL")
    original = module.get_suitable_downloader

    def native_downloader(*args, **kwargs):
        chosen = original(*args, **kwargs)
        if chosen is not None and chosen.__name__ not in {"HttpFD", "HlsFD", "DashSegmentsFD"}:
            raise DownloadError("该视频需要外部网络下载器，暂不支持；请下载后手动上传。")
        return chosen

    def reject_external(*args, **kwargs):
        raise DownloadError("该视频需要外部网络下载器，暂不支持；请下载后手动上传。")

    module.get_suitable_downloader = native_downloader
    ExternalFD.real_download = reject_external
    socket.socket = PublicSocket
    return yt_dlp


def main(args=None):
    yt_dlp = configure_downloader()
    yt_dlp.main([
        "--ignore-config", "--no-plugin-dirs", "--proxy", "", "--downloader", "native",
        "--no-js-runtimes", "--no-remote-components",
        # FFmpeg remains available for merging local audio/video files only.
        "--postprocessor-args", "ffmpeg_i:-protocol_whitelist file,pipe",
        *(sys.argv[1:] if args is None else args),
    ])


if __name__ == "__main__":
    main()
