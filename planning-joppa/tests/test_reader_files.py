"""The agent reader grants files without granting tracker writes."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mcp import MCPError, Reader, serve


class API:
    def tools(self):
        return []


class ReaderFilesTest(unittest.TestCase):
    def test_unicode_chunks_hash_and_protocol_keep_the_complete_file(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'draft.json'
            content = 'α🙂' * 15000
            file.write_text(content)
            with patch.dict(os.environ, CREW_READER_FILES=json.dumps([str(file)]), CREW_READER_ROOTS='[]'):
                reader = Reader(API(), 'example', None)
            first = reader.call('read_file', {'path': str(file), 'length': 17000})
            second = reader.call('read_file', {'path': str(file), 'offset': first['next_offset']})
            self.assertEqual(first['text'] + second['text'], content)
            self.assertIsNone(second['next_offset'])
            self.assertEqual(first['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertEqual([tool['name'] for tool in reader.tools()], ['read_file'])
            request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': 'read_file', 'arguments': {'path': str(file), 'length': 2}}}
            output = io.StringIO()
            serve(reader, io.StringIO(json.dumps(request) + '\n'), output)
            self.assertEqual(json.loads(output.getvalue())['result']['structuredContent']['text'], 'α🙂')
            self.assertEqual(file.read_text(), content)

    def test_roots_allow_source_files_but_not_escaping_symlinks_or_mutations(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'tree'; root.mkdir()
            file, other = root / 'code.ts', Path(folder) / 'private.txt'
            file.write_text('const value = 1;'); other.write_text('private')
            (root / 'escape').symlink_to(other)
            with patch.dict(os.environ, CREW_READER_FILES='[]', CREW_READER_ROOTS=json.dumps([str(root)])):
                reader = Reader(API(), 'example', None)
            self.assertEqual(reader.call('read_file', {'path': str(file)})['text'], file.read_text())
            for denied in (other, root / 'escape'):
                with self.assertRaisesRegex(ValueError, 'outside'):
                    reader.call('read_file', {'path': str(denied)})
            for args in ({'path': str(file), 'length': True}, {'path': str(file), 'offset': -1},
                         {'path': str(file), 'content': 'write'}, {'path': 'relative.txt'}):
                with self.assertRaises(ValueError): reader.call('read_file', args)
            for name in ('joppa_batch', 'joppa_record_results', 'write_file'):
                with self.assertRaisesRegex(MCPError, 'does not permit'): reader.call(name, {})
