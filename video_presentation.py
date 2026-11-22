"""Native presentation pages composited onto the exact E1 output frame grid."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from video_edit_document import EditDocumentError

BACKGROUND = "#101a2b"
ACCENT = "#54d5bd"
TITLE = "#f3f7ff"
BULLET = "#c7d5e8"


def _font_candidates():
    windows = Path(os.environ.get("SystemRoot", "C:/Windows")) / "Fonts"
    for regular, bold in (("msyh.ttc", "msyhbd.ttc"), ("Deng.ttf", "Dengb.ttf"), ("segoeui.ttf", "segoeuib.ttf")):
        if (windows / regular).is_file():
            yield str(windows / regular), str(windows / (bold if (windows / bold).is_file() else regular))
    for candidate in (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    ):
        if Path(candidate).is_file():
            yield candidate, candidate
    yield "DejaVuSans.ttf", "DejaVuSans-Bold.ttf"
    yield None, None


def _font(face, size):
    return ImageFont.truetype(face, size) if face is not None else ImageFont.load_default(size=size)


def _supports(font, text):
    missing = font.getmask("\U0010ffff")
    missing_pixels = bytes(missing)
    for char in set(text):
        if char.isspace():
            continue
        glyph = font.getmask(char)
        if glyph.size == missing.size and bytes(glyph) == missing_pixels:
            return False
    return True


def _faces(title, bullets):
    for body_face, title_face in _font_candidates():
        try:
            body = _font(body_face, 18)
            heading = _font(title_face, 24)
        except OSError:
            continue
        if _supports(heading, title) and _supports(body, " ".join(bullets)):
            return body_face, title_face
    raise EditDocumentError("演示页文字缺少可用字体。中文需要微软雅黑、苹方或 Noto Sans CJK。")


def _wrap(text, font, width):
    lines = []
    while text:
        if font.getlength(text) <= width:
            return [*lines, text]
        limit = 0
        for index in range(1, len(text) + 1):
            if font.getlength(text[:index]) > width:
                break
            limit = index
        if not limit:
            return None
        gap = text.rfind(" ", 0, limit + 1)
        stop = gap if gap > 0 else limit
        lines.append(text[:stop])
        text = text[stop:].lstrip()
    return lines


class _Page:
    def __init__(self, page, frame_width, height):
        self.start, self.end = page["startFrame"], page["endFrame"]
        self.motion = page["motion"]
        self.height = height
        self.width = frame_width if page["layout"] == "fullscreen" else max(2, frame_width * 42 // 200 * 2)
        self.left = frame_width - self.width
        title = " ".join(page["title"].split())
        bullets = [" ".join(text.split()) for text in page["bullets"]]
        regular, bold = _faces(title, bullets)

        self._gutter = max(4, self.width // 11)
        self._top = max(6, height // 7)
        self._bullet_inset = max(4, self.width // 32)
        self._gap = max(2, height // 46)
        title_space = self.width - 2 * self._gutter
        bullet_space = title_space - self._bullet_inset
        initial_title = min(max(8, height // 11), max(8, self.width // 8))
        initial_body = min(max(7, height // 19), max(7, self.width // 13))
        for scale in range(100, 39, -8):
            heading_size = max(7, initial_title * scale // 100)
            body_size = max(6, initial_body * scale // 100)
            heading_font, body_font = _font(bold, heading_size), _font(regular, body_size)
            heading = _wrap(title, heading_font, title_space)
            rows = [_wrap(text, body_font, bullet_space) for text in bullets]
            if not heading or any(row is None for row in rows):
                continue
            heading_line, body_line = (heading_size * 5 + 3) // 4, (body_size * 5 + 3) // 4
            body_top = self._top + len(heading) * heading_line + 2 * self._gap
            bottom = body_top + sum(len(row) * body_line + self._gap for row in rows)
            if bottom <= height - self._gutter // 2:
                self._heading, self._rows = heading, rows
                self._heading_font, self._body_font = heading_font, body_font
                self._heading_line, self._body_line, self._body_top = heading_line, body_line, body_top
                return
        raise EditDocumentError(f"演示页「{page['id']}」在当前画幅上排不下，请缩短文字或增大分辨率。")

    @property
    def bullet_count(self):
        return len(self._rows)

    def raster(self, shown):
        image = Image.new("RGB", (self.width, self.height), BACKGROUND)
        draw = ImageDraw.Draw(image)
        x = self._gutter
        stripe = max(1, self.height // 240)
        stripe_y = max(1, self._top - 3 * self._gap)
        draw.rectangle((x, stripe_y, min(self.width - 1, x + max(5, self.width // 8)), stripe_y + stripe), fill=ACCENT)
        for index, text in enumerate(self._heading):
            draw.text((x, self._top + index * self._heading_line), text, font=self._heading_font, fill=TITLE, anchor="lt")
        y = self._body_top
        dot = max(1, self._bullet_inset // 6)
        for row in self._rows[:shown]:
            dot_top = y + max(0, self._body_line // 3 - dot)
            draw.ellipse((x, dot_top, x + 2 * dot, dot_top + 2 * dot), fill=ACCENT)
            for text in row:
                draw.text((x + self._bullet_inset, y), text, font=self._body_font, fill=BULLET, anchor="lt")
                y += self._body_line
            y += self._gap
        y, u, v = image.convert("YCbCr").split()
        chroma_size = (self.width // 2, self.height // 2)
        # Pillow emits full-range YCbCr; E1's yuv420p stream uses studio range.
        return (_limited(y, 219), _limited(u.resize(chroma_size, Image.Resampling.BOX), 224),
                _limited(v.resize(chroma_size, Image.Resampling.BOX), 224))


def _limited(plane, span):
    return ((np.asarray(plane, dtype=np.uint16) * span + 127) // 255 + 16).astype(np.uint8)


def _blend(target, overlay, opacity):
    if opacity == 256:
        target[:] = overlay
        return
    # Keep per-frame working memory bounded even for large output dimensions.
    rows = max(1, 262144 // target.shape[1])
    for first in range(0, len(target), rows):
        region = target[first:first + rows]
        layer = overlay[first:first + rows]
        mixed = np.multiply(region, 256 - opacity, dtype=np.uint16)
        mixed += np.multiply(layer, opacity, dtype=np.uint16)
        mixed += 128
        region[:] = mixed >> 8


class PresentationRenderer:
    """Composites the active page and retains only its current raster."""

    def __init__(self, pages, width, height, fps):
        self.pages = [_Page(page, width, height) for page in pages]
        self.width, self.height = width, height
        self.motion_frames = max(1, round(fps / 4))
        self.index = 0
        self._cache_state = None
        self._layer = ()
        self._full_frame = None

    def frame(self, index, source):
        while self.index < len(self.pages) and index >= self.pages[self.index].end:
            self.index += 1
            self._layer = ()
            self._full_frame = None
        if self.index == len(self.pages):
            return source
        page = self.pages[self.index]
        if index < page.start:
            return source
        position, duration = index - page.start, page.end - page.start
        opacity = 256
        shown = page.bullet_count
        if page.motion == "fade":
            edge = min(self.motion_frames, (duration - 1) // 2)
            opacity = 256 * min(position + 1, duration - position, edge + 1) // (edge + 1)
        elif page.motion == "reveal" and shown:
            reveal_frames = min(self.motion_frames * shown, duration // 2)
            if reveal_frames:
                shown = min(shown, position * shown // reveal_frames)

        state = (self.index, shown)
        if state != self._cache_state:
            self._cache_state = state
            self._layer = page.raster(shown)
            self._full_frame = None
        if not page.left and opacity == 256:
            if self._full_frame is None:
                self._full_frame = b"".join(plane.tobytes() for plane in self._layer)
            return self._full_frame

        result = bytearray(source)
        offset = 0
        for scale, overlay in zip((1, 2, 2), self._layer):
            height, width = self.height // scale, self.width // scale
            count = height * width
            destination = np.frombuffer(result, np.uint8, count=count, offset=offset).reshape(height, width)
            _blend(destination[:, page.left // scale:], overlay, opacity)
            offset += count
        return result
