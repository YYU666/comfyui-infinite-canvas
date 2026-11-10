"""Independent, bounded reader for PureRef envelope 2.1/schema 200101.

Only embedded original raster resources are read. Paths, URLs, notes, transforms,
and thumbnails are never exported or followed. MD5 detects corruption, not trust.
Format facts: docs/pureref-import.md. No third-party parser code is used.
"""
import base64
import hashlib
import io
import re
import sqlite3
import struct
import threading
import time
import warnings

from PIL import Image

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 48 * 1024 * 1024
MAX_IMAGES = 128
MAX_INSTANCES = 4096
MAX_PIXELS = 24_000_000
MAX_TOTAL_PIXELS = 96_000_000
MAX_DIMENSION = 16384
FORMATS = {'PNG': ('png', 'image/png'), 'JPEG': ('jpg', 'image/jpeg'), 'WEBP': ('webp', 'image/webp')}
_BUSY = threading.BoundedSemaphore(1)


class PureRefError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


def reject(message='PureRef 文件损坏或结构无效。', code='INVALID_PUREREF'):
    raise PureRefError(code, message)


def limit(message):
    reject(message, 'PUREREF_LIMIT')


def unpack_container(raw):
    if not isinstance(raw, bytes) or not 32 <= len(raw) <= MAX_FILE_BYTES:
        limit('PureRef 文件为空、过短或超过 64 MiB。')
    offset = 0

    def take(size):
        nonlocal offset
        if size < 0 or size > len(raw) - offset:
            reject()
        value = raw[offset:offset + size]
        offset += size
        return value

    def number(size):
        return int.from_bytes(take(size), 'big')

    def string(maximum):
        size = number(4)
        if size > maximum or size % 2:
            reject()
        try:
            return take(size).decode('utf-16-be')
        except UnicodeError:
            reject()

    version = string(32)
    if version != '2.1':
        reject('仅支持 PureRef 容器 2.1 / 数据库 200101；旧版 1.x 与其他格式暂不支持。', 'UNSUPPORTED_PUREREF')
    if number(4) != 0:
        reject('PureRef 保留字段不受支持。', 'UNSUPPORTED_PUREREF')
    database_size = number(8)
    string(128)  # Application version is unrelated to envelope version.
    checksum = string(64)
    checksum_end = offset
    if not re.fullmatch('[0-9a-f]{32}', checksum):
        reject()
    thumbnail_size = number(4)
    if thumbnail_size == 0xffffffff:
        thumbnail_size = 0
    if thumbnail_size > 4 * 1024 * 1024:
        limit('PureRef 缩略图超过安全上限。')
    take(thumbnail_size)
    header_size = offset
    if not header_size < database_size or database_size + header_size != len(raw):
        reject()
    if hashlib.md5(memoryview(raw)[checksum_end:], usedforsecurity=False).hexdigest() != checksum:
        reject('PureRef 校验和不匹配；请重新保存文件后重试。', 'PUREREF_CHECKSUM')
    database = raw[database_size:] + raw[header_size:database_size]
    if database[:16] != b'SQLite format 3\x00' or len(database) < 100:
        reject()
    page_size = int.from_bytes(database[16:18], 'big')
    page_size = 65536 if page_size == 1 else page_size
    pages = int.from_bytes(database[28:32], 'big')
    if page_size not in {512, 1024, 2048, 4096, 8192, 16384, 32768, 65536} or pages * page_size != len(database):
        reject()
    if database[18:20] != b'\x01\x01':
        reject('暂不支持此 PureRef 数据库日志格式。', 'UNSUPPORTED_PUREREF')
    return database


def parse_pureref(raw):
    """Return safe metadata and original encoded bytes; make no filesystem reads."""
    database = unpack_container(raw)
    deadline = time.monotonic() + 8
    steps = 0

    def progress():
        nonlocal steps
        steps += 1000
        return steps > 2_000_000 or time.monotonic() > deadline

    connection = sqlite3.connect(':memory:')
    try:
        if not hasattr(connection, 'deserialize'):
            raise PureRefError('PUREREF_RUNTIME', '当前 Python SQLite 不支持安全内存解析，请使用 Python 3.12 或更新版本。', 503)
        if hasattr(connection, 'enable_load_extension'):
            connection.enable_load_extension(False)
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_IMAGE_BYTES + 65536)
        connection.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 4096)
        connection.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 64)
        connection.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
        connection.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 32)
        connection.set_progress_handler(progress, 1000)
        connection.deserialize(database)
        connection.execute('PRAGMA trusted_schema=OFF')
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA temp_store=MEMORY')
        connection.execute('PRAGMA cache_size=-4096')
        connection.execute('PRAGMA mmap_size=0')
        if connection.execute('PRAGMA user_version').fetchone()[0] != 200101 or connection.execute('PRAGMA application_id').fetchone()[0] != 940753918:
            reject('PureRef 数据库版本不受支持；仅支持 200101。', 'UNSUPPORTED_PUREREF')
        # Introspect only ordinary tables; no views, virtual tables, or user SQL.
        for table, required in [('images', {'id': 'INTEGER', 'source_type': 'INTEGER', 'data': 'BLOB', 'width': 'INTEGER', 'height': 'INTEGER'}), ('items', {'id': 'INTEGER'}), ('items_images', {'id': 'INTEGER', 'image': 'INTEGER'})]:
            row = connection.execute('SELECT type, sql FROM sqlite_schema WHERE name=?', (table,)).fetchone()
            if not row or row[0] != 'table' or not re.match(r'CREATE\s+TABLE\s', row[1] or '', re.I):
                reject()
            columns = {r[1]: (r[2].upper(), r[5]) for r in connection.execute(f'PRAGMA table_info("{table}")')}
            if any(columns.get(name, ('', 0))[0] != kind for name, kind in required.items()) or columns['id'][1] != 1 or sum(value[1] > 0 for value in columns.values()) != 1:
                reject()
        # After fixed introspection, SQL may only SELECT the required columns.
        # SQLite also reports an empty-column READ for an id-only rowid lookup;
        # it permits row existence, not access to other base-item fields.
        allowed_columns = {'images': {'id', 'source_type', 'data', 'width', 'height'}, 'items': {'id', ''}, 'items_images': {'id', 'image'}}

        def authorize(action, first, second, _database, trigger):
            if trigger:
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_SELECT:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and first in allowed_columns and second in allowed_columns[first]:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION and second in {'typeof', 'length'}:
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY

        connection.set_authorizer(authorize)
        instances = {}
        rows = connection.execute('SELECT id, image FROM items_images').fetchmany(MAX_INSTANCES + 1)
        if len(rows) > MAX_INSTANCES:
            limit('PureRef 图片实例超过 4096 个。')
        for item_id, image_id in rows:
            if type(item_id) is not int or type(image_id) is not int:
                reject()
            base = connection.execute('SELECT id FROM items WHERE id=?', (item_id,)).fetchone()
            if not base or type(base[0]) is not int or base[0] != item_id:
                reject()
            instances[image_id] = instances.get(image_id, 0) + 1
        resources = connection.execute('SELECT id, source_type, typeof(data), length(data), width, height FROM images').fetchmany(MAX_IMAGES + 1)
        if len(resources) > MAX_IMAGES:
            limit('PureRef 图片资源超过 128 个。')
        if set(instances) - {r[0] for r in resources}:
            reject()
        images, seen = [], {}
        skipped = duplicates = total_bytes = total_pixels = 0
        for resource_id, source_type, storage, size, width, height in resources:
            if type(resource_id) is not int or type(source_type) is not int:
                reject()
            copies = instances.get(resource_id, 0)
            if not copies:
                continue  # Deleted/unreferenced resources are not scene images.
            if source_type != 1:
                skipped += copies
                continue
            if storage != 'blob' or type(size) is not int or size < 1:
                reject('PureRef 内嵌图片数据无效。')
            if size > MAX_IMAGE_BYTES:
                limit('PureRef 单张图片超过 16 MiB。')
            total_bytes += size
            if total_bytes > MAX_TOTAL_BYTES:
                limit('PureRef 内嵌图片总量超过 48 MiB。')
            if type(width) is not int or type(height) is not int or not 0 < width <= MAX_DIMENSION or not 0 < height <= MAX_DIMENSION or width * height > MAX_PIXELS:
                limit('PureRef 图片尺寸超过安全上限（单边 16384，单图 2400 万像素）。')
            total_pixels += width * height
            if total_pixels > MAX_TOTAL_PIXELS:
                limit('PureRef 图片总像素超过 9600 万。')
            data = connection.execute('SELECT data FROM images WHERE id=?', (resource_id,)).fetchone()[0]
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen:
                if seen[digest] != (width, height):
                    reject('PureRef 重复图片的实际尺寸不一致。')
                duplicates += copies
                continue
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('error', Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(data), formats=list(FORMATS)) as image:
                        if image.format not in FORMATS or image.size != (width, height):
                            reject('PureRef 图片编码或实际尺寸不受支持；仅支持 PNG、JPEG 和 WebP。')
                        if getattr(image, 'n_frames', 1) != 1:
                            reject('PureRef 动画图片暂不支持。', 'UNSUPPORTED_PUREREF')
                        image.load()  # Decode pixels, not just a trusting header check.
                        extension, mime = FORMATS[image.format]
            except PureRefError:
                raise
            except Exception:
                reject('PureRef 内嵌图片无法完整解码。')
            if time.monotonic() > deadline:
                limit('PureRef 解析超过时间预算，请缩小画板后重试。')
            seen[digest] = (width, height)
            duplicates += copies - 1
            images.append({'name': f'PureRef-{len(images) + 1:03d}.{extension}', 'mime': mime, 'width': width, 'height': height, 'bytes': len(data), 'sha256': digest, 'data': data})
        if not images:
            reject(f'没有可导入的内嵌图片；已跳过 {skipped} 个外链或非内嵌实例。', 'PUREREF_EMPTY')
        return {'formatVersion': '2.1', 'schemaVersion': 200101, 'images': images, 'duplicates': duplicates, 'skippedExternal': skipped, 'totalBytes': sum(i['bytes'] for i in images)}
    except sqlite3.Error:
        reject('PureRef SQLite 数据损坏、查询受限或超过解析预算。')
    finally:
        connection.close()


def handle_pureref_post(handler, path):
    if path != '/api/pureref/inspect':
        return False
    acquired = False
    socket = getattr(handler, 'connection', None)
    old_timeout = socket.gettimeout() if socket else None
    try:
        length = int(handler.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_FILE_BYTES:
            limit('请选择不超过 64 MiB 的 PureRef 文件。')
        acquired = _BUSY.acquire(False)
        if not acquired:
            raise PureRefError('PUREREF_BUSY', '另一个 PureRef 文件正在解析，请稍后重试。', 409)
        if socket:
            socket.settimeout(15)
        raw = handler.rfile.read(length)
        if len(raw) != length:
            reject()
        result = parse_pureref(raw)
        for image in result['images']:
            image['base64'] = base64.b64encode(image.pop('data')).decode('ascii')
        handler.send_json(200, result)
    except PureRefError as error:
        handler.send_json(error.status, {'code': error.code, 'message': str(error)})
    except (ValueError, OSError):
        handler.send_json(400, {'code': 'INVALID_PUREREF', 'message': 'PureRef 文件读取失败。'})
    finally:
        if socket:
            socket.settimeout(old_timeout)
        if acquired:
            _BUSY.release()
    return True
