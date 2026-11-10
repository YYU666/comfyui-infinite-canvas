"""Disk-only PureRef extraction. Runs in a disposable, memory-watched process."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import sys
import time
import threading
import uuid
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image
from pureref_import import PureRefError, reject, limit, FORMATS
from workbench_lifecycle import atomic_write_json

MAX_SOURCE = 8 * 1024**3
MAX_IMAGE = 128 * 1024**2
MAX_PIXELS = 64 * 1024**2
MAX_RESOURCES = 2048
MAX_INSTANCES = 16384
BLOCK = 1024**2


def prepare_database(path, report):
    """Verify the physical envelope, then restore the displaced DB prefix in-place."""
    size = path.stat().st_size
    if not 32 <= size <= MAX_SOURCE:
        limit('PureRef 文件超过 8 GiB 或为空。')
    with path.open('r+b') as file:
        def take(n):
            if n < 0 or n > 4 * 1024**2 or file.tell() + n > size: reject()
            value = file.read(n)
            if len(value) != n: reject()
            return value
        def number(n): return int.from_bytes(take(n), 'big')
        def string(maximum):
            n = number(4)
            if n > maximum or n % 2: reject()
            try: return take(n).decode('utf-16-be')
            except UnicodeError: reject()
        if string(32) != '2.1' or number(4) != 0:
            reject('仅支持 PureRef 容器 2.1。', 'UNSUPPORTED_PUREREF')
        database_size = number(8)
        string(128)
        checksum = string(64)
        checksum_end = file.tell()
        if not re.fullmatch('[0-9a-f]{32}', checksum): reject()
        thumb_size = number(4)
        if thumb_size == 0xffffffff: thumb_size = 0
        take(thumb_size)
        header = file.tell()
        if not header < database_size or database_size + header != size: reject()
        file.seek(checksum_end)
        digest = hashlib.md5(usedforsecurity=False)
        checked = checksum_end
        while chunk := file.read(BLOCK):
            digest.update(chunk); checked += len(chunk)
            report('verifying', bytes=checked, total=size)
        if digest.hexdigest() != checksum:
            reject('PureRef 校验和不匹配。', 'PUREREF_CHECKSUM')
        # Only the owned staging copy is mutated; source bytes in the browser are untouched.
        moved = 0
        while moved < header:
            file.seek(database_size + moved)
            chunk = file.read(min(BLOCK, header - moved))
            if not chunk: reject()
            file.seek(moved); file.write(chunk); moved += len(chunk)
        file.truncate(database_size); file.flush(); os.fsync(file.fileno())
        file.seek(0); head = file.read(100)
        page = int.from_bytes(head[16:18], 'big'); page = 65536 if page == 1 else page
        if head[:16] != b'SQLite format 3\x00' or page not in {512,1024,2048,4096,8192,16384,32768,65536} or int.from_bytes(head[28:32], 'big') * page != database_size: reject()
        if head[18:20] != b'\x01\x01': reject()
    database = path.with_name('scene.sqlite')
    path.replace(database)
    return database


def extract(directory, report):
    database = prepare_database(directory / 'upload.pur', report)
    connection = sqlite3.connect(database.as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        connection.enable_load_extension(False)
        for category, value in [(sqlite3.SQLITE_LIMIT_LENGTH, MAX_IMAGE + 65536), (sqlite3.SQLITE_LIMIT_SQL_LENGTH,4096), (sqlite3.SQLITE_LIMIT_COLUMN,64), (sqlite3.SQLITE_LIMIT_ATTACHED,0), (sqlite3.SQLITE_LIMIT_EXPR_DEPTH,32)]:
            connection.setlimit(category, value)
        deadline = time.monotonic() + 1800
        connection.set_progress_handler(lambda: time.monotonic() > deadline, 1000)
        for pragma in ['trusted_schema=OFF','query_only=ON','temp_store=MEMORY','cache_size=-4096','mmap_size=0']:
            connection.execute('PRAGMA ' + pragma)
        if connection.execute('PRAGMA user_version').fetchone()[0] != 200101 or connection.execute('PRAGMA application_id').fetchone()[0] != 940753918:
            reject('PureRef 数据库版本不受支持。', 'UNSUPPORTED_PUREREF')
        for table, required in [('images', {'id':'INTEGER','source_type':'INTEGER','data':'BLOB','width':'INTEGER','height':'INTEGER'}),('items',{'id':'INTEGER'}),('items_images',{'id':'INTEGER','image':'INTEGER'})]:
            row = connection.execute('SELECT type, sql FROM sqlite_schema WHERE name=?',(table,)).fetchone()
            if not row or row[0] != 'table' or not re.match(r'CREATE\s+TABLE\s',row[1] or '',re.I): reject()
            cols = {r[1]:(r[2].upper(),r[5]) for r in connection.execute(f'PRAGMA table_info("{table}")')}
            if {'rowid','_rowid_','oid'} & {name.casefold() for name in cols}: reject()
            if any(cols.get(k,('',0))[0] != v for k,v in required.items()) or cols['id'][1] != 1 or sum(v[1] > 0 for v in cols.values()) != 1: reject()
        allowed = {'images':{'id','source_type','data','width','height','rowid'},'items':{'id',''},'items_images':{'id','image'}}
        def authorize(action, first, second, _db, trigger):
            if trigger: return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_SELECT: return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and (second or '').lower() in allowed.get(first,set()): return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION and second in {'typeof','length'}: return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        connection.set_authorizer(authorize)
        instances = {}
        # Declared INTEGER columns can contain huge BLOBs in SQLite. Project
        # only integers before Python fetches metadata, never those BLOB values.
        rows = connection.execute("SELECT CASE WHEN typeof(id)='integer' THEN id END, CASE WHEN typeof(image)='integer' THEN image END FROM items_images").fetchmany(MAX_INSTANCES+1)
        if len(rows) > MAX_INSTANCES: limit('PureRef 图片实例超过 16384 个。')
        for item, resource in rows:
            if type(item) is not int or type(resource) is not int or connection.execute('SELECT id FROM items WHERE id=?',(item,)).fetchone() != (item,): reject()
            instances[resource] = instances.get(resource,0)+1
        resources = connection.execute("SELECT rowid, CASE WHEN typeof(id)='integer' THEN id END, CASE WHEN typeof(source_type)='integer' THEN source_type END, typeof(data), length(data), CASE WHEN typeof(width)='integer' THEN width END, CASE WHEN typeof(height)='integer' THEN height END FROM images").fetchmany(MAX_RESOURCES+1)
        if len(resources) > MAX_RESOURCES: limit('PureRef 图片资源超过 2048 个。')
        if set(instances) - {r[1] for r in resources}: reject()
        images, seen = [], {}
        duplicates = skipped = total = logical_bytes = 0
        for rowid, resource, source, storage, size, width, height in resources:
            if rowid != resource: reject()
            if type(resource) is not int or type(source) is not int: reject()
            copies = instances.get(resource,0)
            if not copies: continue
            if source != 1: skipped += copies; continue
            if storage != 'blob' or type(size) is not int or size < 1: reject()
            if size > MAX_IMAGE: limit('PureRef 单图超过 128 MiB。')
            logical_bytes += size
            if logical_bytes > database.stat().st_size:
                limit('PureRef 图片逻辑总量超过容器，数据库可能损坏。')
            if shutil.disk_usage(directory).free < size + 512*1024**2:
                reject('PureRef 暂存磁盘空间不足。','PUREREF_DISK')
            if type(width) is not int or type(height) is not int or not 0 < width <= 16384 or not 0 < height <= 16384 or width*height > MAX_PIXELS: limit('PureRef 单图超过 64 MP 或单边 16384。')
            handle = uuid.uuid4().hex
            output = directory / (handle + '.original')
            digest = hashlib.sha256()
            with connection.blobopen('images','data',resource,readonly=True) as blob, output.open('xb') as target:
                remaining = size
                while remaining:
                    chunk = blob.read(min(BLOCK,remaining))
                    if not chunk: reject()
                    target.write(chunk); digest.update(chunk); remaining -= len(chunk)
            sha = digest.hexdigest()
            if sha in seen:
                if seen[sha] != (width,height): reject()
                output.unlink(); duplicates += copies; continue
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('error',Image.DecompressionBombWarning)
                    with Image.open(output,formats=list(FORMATS)) as image:
                        if image.size != (width,height) or getattr(image,'n_frames',1) != 1: reject()
                        extension,mime = FORMATS[image.format]
                        image.load()
                        image.thumbnail((160,160))
                        image.convert('RGB').save(directory / (handle+'.preview'),'WEBP',quality=72)
            except PureRefError: raise
            except Exception: reject('PureRef 内嵌图片无法完整解码。')
            seen[sha] = (width,height); duplicates += copies-1; total += size
            images.append(dict(handle=handle,name=f'PureRef-{len(images)+1:03d}.{extension}',mime=mime,width=width,height=height,bytes=size,sha256=sha))
            report('extracting',completed=len(images),total=len(resources))
        if not images: reject('没有可导入的内嵌图片。','PUREREF_EMPTY')
        result = dict(formatVersion='2.1',schemaVersion=200101,images=images,duplicates=duplicates,skippedExternal=skipped,totalBytes=total)
        atomic_write_json(directory/'resources.json',result)
        report('ready',count=len(images),totalBytes=total,duplicates=duplicates,skippedExternal=skipped)
    finally:
        connection.close()


def main(directory):
    last = 0
    def report(phase,**values):
        nonlocal last
        now = time.monotonic()
        if phase == 'verifying' and now-last < .3: return
        last = now
        atomic_write_json(directory/'status.json',dict(phase=phase,**values))
    try: extract(directory,report)
    except PureRefError as error: report('error',code=error.code,message=str(error))
    except Exception: report('error',code='INVALID_PUREREF',message='PureRef 解析失败、磁盘不足或数据库无效。')


if __name__ == '__main__':
    if len(sys.argv) > 3:
        import psutil
        def parent_watch():
            while True:
                try:
                    if psutil.Process(int(sys.argv[2])).create_time() != float(sys.argv[3]): os._exit(2)
                except psutil.Error: os._exit(2)
                time.sleep(1)
        threading.Thread(target=parent_watch,daemon=True).start()
    main(Path(sys.argv[1]).resolve())
