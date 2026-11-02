import importlib.util
import os
import socket
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from video_download_worker import public_address


class PublicDownloadTests(unittest.TestCase):
    def test_private_literal_and_dns_redirect_addresses_are_rejected(self):
        for address in ("127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "224.0.0.1"):
            records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 80))]
            with self.subTest(address=address), mock.patch("video_download_worker.socket.getaddrinfo", return_value=records), self.assertRaises(PermissionError):
                public_address(("redirect.test", 80))

    def test_checked_address_is_numeric_and_mixed_dns_is_rejected(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with mock.patch("video_download_worker.socket.getaddrinfo", return_value=records):
            self.assertEqual(public_address(("public.test", 443)), ("8.8.8.8", 443))
        records.append((socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)))
        with mock.patch("video_download_worker.socket.getaddrinfo", return_value=records), self.assertRaises(PermissionError):
            public_address(("mixed.test", 443))

    def test_private_mapped_ipv6_and_scoped_hosts_are_rejected(self):
        records = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:127.0.0.1", 80, 0, 0))]
        with mock.patch("video_download_worker.socket.getaddrinfo", return_value=records), self.assertRaises(PermissionError):
            public_address(("mapped.test", 80), socket.AF_INET6)
        with self.assertRaises(PermissionError):
            public_address(("fe80::1%eth0", 80), socket.AF_INET6)

    @unittest.skipUnless(importlib.util.find_spec("yt_dlp"), "requires installed locked yt-dlp")
    def test_worker_uses_guarded_transport_without_running_a_download(self):
        root = Path(__file__).resolve().parent
        script = """import sys; sys.path.insert(0, sys.argv[1])
import socket
from video_download_worker import configure_downloader, PublicSocket
configure_downloader()
from yt_dlp.networking.common import _REQUEST_HANDLERS
from yt_dlp.downloader.external import ExternalFD
from yt_dlp.utils import DownloadError
assert list(_REQUEST_HANDLERS) == ['Urllib']
assert socket.socket is PublicSocket
try: ExternalFD.real_download(None, None, None)
except DownloadError: pass
else: raise AssertionError('external downloader allowed')
print('guarded')
"""
        result = subprocess.run([sys.executable, "-X", "utf8", "-c", script, str(root)], cwd=root, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("guarded", result.stdout)


if __name__ == "__main__":
    unittest.main()
