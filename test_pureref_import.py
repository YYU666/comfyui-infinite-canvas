"""Fresh synthetic fixtures; native local fixtures are opt-in and never published."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import struct
import unittest
from unittest.mock import patch

from PIL import Image
import pureref_import as pur
from workbench_security import valid_content_type


def raster(color='red', size=(12, 8), kind='PNG'):
    stream = io.BytesIO()
    Image.new('RGB', size, color).save(stream, format=kind)
    return stream.getvalue()


def pack(database, version='2.1', app='synthetic', thumbnail=b''):
    def string(value):
        raw = value.encode('utf-16-be')
        return struct.pack('>I', len(raw)) + raw
    prefix = string(version) + struct.pack('>IQ', 0, len(database)) + string(app)
    header_size = len(prefix) + len(string('0' * 32)) + 4 + len(thumbnail)
    tail = struct.pack('>I', len(thumbnail)) + thumbnail + database[header_size:] + database[:header_size]
    return prefix + string(hashlib.md5(tail).hexdigest()) + tail


def fixture(resources=None, instances=None, version=200101, extra_sql=''):
    resources = resources if resources is not None else [(0, 1, raster(), 12, 8)]
    instances = instances if instances is not None else [(i, r[0]) for i, r in enumerate(resources)]
    connection = sqlite3.connect(':memory:')
    connection.execute('PRAGMA application_id=940753918')
    connection.execute(f'PRAGMA user_version={version}')
    # Minimal independent schema from the required native column facts.
    connection.execute('CREATE TABLE images(id INTEGER PRIMARY KEY, source_type INTEGER, data BLOB, width INTEGER, height INTEGER, source TEXT)')
    connection.execute('CREATE TABLE items(id INTEGER PRIMARY KEY)')
    connection.execute('CREATE TABLE items_images(id INTEGER PRIMARY KEY, image INTEGER)')
    connection.executemany('INSERT INTO images VALUES(?,?,?,?,?,?)', [(*r, 'file:///PRIVATE-PATH-NOT-TO-BE-READ') for r in resources])
    connection.executemany('INSERT INTO items VALUES(?)', [(item_id,) for item_id, _ in instances])
    connection.executemany('INSERT INTO items_images VALUES(?,?)', instances)
    if extra_sql:
        connection.executescript(extra_sql)
    connection.commit()
    database = connection.serialize()
    connection.close()
    return pack(database)


class PureRefTests(unittest.TestCase):
    def rejected(self, raw, code=None):
        with self.assertRaises(pur.PureRefError) as caught:
            pur.parse_pureref(raw)
        if code:
            self.assertEqual(caught.exception.code, code)
        self.assertNotIn('PRIVATE-PATH', str(caught.exception))
        return caught.exception

    def test_original_raster_bytes_and_dedupe(self):
        red, blue = raster(), raster('blue', kind='JPEG')
        result = pur.parse_pureref(fixture([(4, 1, red, 12, 8), (9, 1, blue, 12, 8), (11, 1, red, 12, 8)], [(0, 4), (1, 4), (2, 9), (3, 11)]))
        self.assertEqual([image['data'] for image in result['images']], [red, blue])
        self.assertEqual(result['duplicates'], 2)
        self.assertEqual(result['skippedExternal'], 0)
        self.assertEqual(result['images'][1]['mime'], 'image/jpeg')
        self.assertNotIn('PRIVATE-PATH', repr(result))

    def test_external_paths_never_opened_and_orphans_ignored(self):
        resources = [(0, 1, raster(), 12, 8), (1, 2, None, 12, 8), (2, 1, b'bad orphan', 12, 8)]
        with patch('builtins.open', side_effect=AssertionError('No filesystem reads')):
            result = pur.parse_pureref(fixture(resources, [(0, 0), (1, 1), (2, 1)]))
        self.assertEqual(len(result['images']), 1)
        self.assertEqual(result['skippedExternal'], 2)
        self.rejected(fixture(resources, [(0, 1)]), 'PUREREF_EMPTY')
        self.rejected(fixture(resources, []), 'PUREREF_EMPTY')

    def test_header_checksum_truncation_and_legacy(self):
        original = fixture()
        for raw in [b'', original[:20], original[:-1], original + b'x', original[:14] + b'\xff' * 8 + original[22:]]:
            self.rejected(raw)
        corrupted = bytearray(original); corrupted[-1] ^= 1
        self.rejected(bytes(corrupted), 'PUREREF_CHECKSUM')
        database = pur.unpack_container(original)
        self.rejected(pack(database, version='1.11'), 'UNSUPPORTED_PUREREF')
        self.rejected(pack(database, version='2.2'), 'UNSUPPORTED_PUREREF')
        huge_string = bytearray(original); huge_string[:4] = b'\xff' * 4
        self.rejected(bytes(huge_string))
        self.assertEqual(pur.unpack_container(pack(database, app='x', thumbnail=b'x' * 5000)), database)

    def test_sqlite_versions_tables_and_types(self):
        self.rejected(fixture(version=200102), 'UNSUPPORTED_PUREREF')
        self.rejected(fixture(extra_sql='ALTER TABLE images RENAME TO hidden; CREATE VIEW images AS SELECT * FROM hidden;'))
        self.rejected(fixture(extra_sql='DROP TABLE images; CREATE VIRTUAL TABLE images USING fts5(data);'))
        self.rejected(fixture(extra_sql='DROP TABLE items_images; CREATE TABLE items_images(id TEXT PRIMARY KEY,image TEXT);'))
        self.rejected(fixture(extra_sql="UPDATE images SET data='not a blob';"))
        self.rejected(fixture(extra_sql='UPDATE items_images SET image=999;'))
        self.rejected(fixture(extra_sql='UPDATE images SET width=12.5;'))
        self.rejected(pack(b'not sqlite' * 1000))
        database = bytearray(pur.unpack_container(fixture())); database[28:32] = b'\xff' * 4
        self.rejected(pack(bytes(database)))
        database = bytearray(pur.unpack_container(fixture())); database[4096:4100] = b'\xff' * 4
        self.rejected(pack(bytes(database)))

    def test_base_items_integrity(self):
        for sql in [
            'DROP TABLE items;',
            'ALTER TABLE items RENAME TO hidden_items; CREATE VIEW items AS SELECT id FROM hidden_items;',
            'DROP TABLE items; CREATE VIRTUAL TABLE items USING fts5(id);',
            'DROP TABLE items; CREATE TABLE items(id TEXT PRIMARY KEY); INSERT INTO items VALUES(\'0\');',
            'DROP TABLE items; CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(0);',
            'DROP TABLE items; CREATE TABLE items(id INTEGER, other INTEGER, PRIMARY KEY(id,other)); INSERT INTO items VALUES(0,0);',
            'UPDATE items SET id=999;',
            'DELETE FROM items;',
        ]:
            with self.subTest(sql=sql):
                self.rejected(fixture(extra_sql=sql))

    def test_raster_decode_dimensions_and_animation(self):
        self.rejected(fixture([(0, 1, b'not an image', 12, 8)]))
        self.rejected(fixture([(0, 1, raster()[:45], 12, 8)]))
        self.rejected(fixture([(0, 1, raster(), 13, 8)]))
        self.rejected(fixture([(0, 1, raster(), 0, 8)]), 'PUREREF_LIMIT')
        stream = io.BytesIO()
        Image.new('RGBA', (12, 8), 'red').save(stream, format='PNG', save_all=True, append_images=[Image.new('RGBA', (12, 8), 'blue')], duration=10)
        self.rejected(fixture([(0, 1, stream.getvalue(), 12, 8)]), 'UNSUPPORTED_PUREREF')
        stream = io.BytesIO(); Image.new('RGBA', (12, 8), (12, 34, 56, 70)).save(stream, format='PNG')
        result = pur.parse_pureref(fixture([(0, 1, stream.getvalue(), 12, 8)]))
        self.assertEqual(result['images'][0]['data'], stream.getvalue())

    def test_limits_before_large_allocations(self):
        for constant, value in [('MAX_FILE_BYTES', 100), ('MAX_IMAGE_BYTES', 10), ('MAX_TOTAL_BYTES', 10), ('MAX_IMAGES', 0), ('MAX_INSTANCES', 0), ('MAX_PIXELS', 10), ('MAX_TOTAL_PIXELS', 10), ('MAX_DIMENSION', 1)]:
            raw = fixture()
            with self.subTest(constant=constant), patch.object(pur, constant, value):
                self.rejected(raw, 'PUREREF_LIMIT')
        with patch.object(pur.time, 'monotonic', side_effect=[0, 100] + [100] * 20):
            self.rejected(fixture())

    def test_readonly_authorizer_and_schema_no_side_effects(self):
        raw = fixture(extra_sql="CREATE TRIGGER cannot_run AFTER UPDATE ON images BEGIN SELECT load_extension('PRIVATE-PATH'); END;")
        self.assertEqual(len(pur.parse_pureref(raw)['images']), 1)
        actions = []
        original_connect = sqlite3.connect

        class CapturingConnection(sqlite3.Connection):
            def set_authorizer(self, callback):
                actions.append(callback)
                return super().set_authorizer(callback)

        with patch.object(pur.sqlite3, 'connect', side_effect=lambda *a, **kw: original_connect(*a, **kw, factory=CapturingConnection)):
            pur.parse_pureref(raw)
        authorize = actions[0]
        for action, first, second in [(sqlite3.SQLITE_ATTACH, 'private', None), (sqlite3.SQLITE_FUNCTION, None, 'load_extension'), (sqlite3.SQLITE_UPDATE, 'images', 'data'), (sqlite3.SQLITE_READ, 'images', 'source'), (sqlite3.SQLITE_READ, 'items', 'comment')]:
            self.assertEqual(authorize(action, first, second, 'main', None), sqlite3.SQLITE_DENY)

    def test_chunk_type_guard(self):
        route = '/api/pureref/sessions/' + 'a'*32 + '/upload'
        self.assertTrue(valid_content_type('PUT', route, {'Content-Length':'5','Content-Type':'application/octet-stream'}))
        self.assertFalse(valid_content_type('PUT', route, {'Content-Length':'5','Content-Type':'text/plain'}))
        self.assertFalse(valid_content_type('POST', '/api/pureref/inspect', {'Content-Length':'5','Content-Type':'application/octet-stream'}))

    @unittest.skipUnless(os.environ.get('PUREREF_NATIVE_FIXTURES'), 'native fixtures are private local evidence')
    def test_native_203_original_bytes(self):
        root = Path(os.environ['PUREREF_NATIVE_FIXTURES'])
        for filename, names, duplicates in [('native-2.0.3.pur', ['warm.png', 'cool.png'], 0), ('native-mixed-2.0.3.pur', ['warm.png', 'gold.jpg', 'alpha.png'], 1)]:
            result = pur.parse_pureref((root / filename).read_bytes())
            self.assertEqual({image['data'] for image in result['images']}, {(root / name).read_bytes() for name in names})
            self.assertEqual(result['duplicates'], duplicates)

    @unittest.skipUnless(os.environ.get('PUREREF_NATIVE_FIXTURES'), 'native fixtures are private local evidence')
    def test_native_checksum_valid_orphan_subtypes_rejected(self):
        root = Path(os.environ['PUREREF_NATIVE_FIXTURES'])
        for filename in ['native-2.0.3.pur', 'native-mixed-2.0.3.pur']:
            original = (root / filename).read_bytes()
            connection = sqlite3.connect(':memory:')
            try:
                connection.deserialize(pur.unpack_container(original))
                before = connection.execute('SELECT count(*) FROM items_images').fetchone()[0]
                connection.execute('DELETE FROM items')
                connection.commit()
                self.assertGreater(before, 0)
                self.assertEqual(connection.execute('SELECT count(*) FROM items_images').fetchone()[0], before)
                tampered = pack(connection.serialize())  # Fresh valid physical checksum.
            finally:
                connection.close()
            self.assertTrue(pur.unpack_container(tampered).startswith(b'SQLite format 3'))
            self.rejected(tampered)
            self.assertEqual((root / filename).read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
