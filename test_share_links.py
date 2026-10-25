import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_workbench_launcher import extract_share_url


class ShareLinkTests(unittest.TestCase):
    def test_douyin_share_text(self):
        text = "5.84 复制打开抖音，看看【作者的作品】巴西烤肉 https://v.douyin.com/abcDEF123/ 复制此链接，打开Dou音搜索"
        self.assertEqual(extract_share_url(text), "https://v.douyin.com/abcDEF123/")

    def test_xiaohongshu_share_text(self):
        text = "87 小红书推荐笔记 http://xhslink.com/a/AbCdEf?xsec_token=AB123&xsec_source=pc_feed 复制后打开小红书"
        self.assertEqual(extract_share_url(text), "http://xhslink.com/a/AbCdEf?xsec_token=AB123&xsec_source=pc_feed")

    def test_plain_url_with_trailing_punctuation(self):
        self.assertEqual(extract_share_url("https://example.com/video.mp4。"), "https://example.com/video.mp4")

    def test_missing_url(self):
        with self.assertRaisesRegex(ValueError, "没有检测到视频链接"):
            extract_share_url("只有分享标题，没有链接")


if __name__ == "__main__":
    unittest.main()
