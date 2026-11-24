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
import reader_files


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
            self.assertEqual([tool['name'] for tool in reader.tools()], ['read_context', 'read_file', 'read_attachment'])
            self.assertEqual(reader.call('read_context', {})['files'], [str(file.resolve())])
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

    def test_a_symlink_swap_after_authorization_cannot_read_outside_the_grant(self):
        with tempfile.TemporaryDirectory() as folder:
            file, other = Path(folder) / 'allowed.txt', Path(folder) / 'outside.txt'
            file.write_text('allowed'); other.write_text('outside-grant-marker')
            with patch.dict(os.environ, CREW_READER_FILES=json.dumps([str(file)]), CREW_READER_ROOTS='[]'):
                reader = Reader(API(), 'example', None)
            original = Path.resolve
            def swap(item, *args, **kwargs):
                result = original(item, *args, **kwargs)
                if item == file and not file.is_symlink():
                    file.unlink(); file.symlink_to(other)
                return result
            with patch.object(Path, 'resolve', swap), self.assertRaises(OSError):
                reader.call('read_file', {'path': str(file)})


class ReaderAttachmentTest(unittest.TestCase):
    def setUp(self):
        self.raw = ('α🙂 attachment line\n' * 3000).encode()
        self.row = {'name': 'attachment.txt', 'hash': hashlib.sha256(self.raw).hexdigest(),
                    'url': 'https://storage.example/signed?token=private', 'removed': False}
        self.calls = []
        owner = self
        class Backend(API):
            def tools(self):
                return [{'name': 'joppa_attachments'}, {'name': 'joppa_batch'}]
            def call(self, name, args):
                owner.calls.append((name, args))
                return {'files': [owner.row]}
        self.environment = patch.dict(os.environ, CREW_READER_FILES='[]', CREW_READER_ROOTS='[]')
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.reader = Reader(Backend(), 'fixed-workspace', None)
        helper = reader_files.attachment_reader()
        self.download = patch.dict(helper.__globals__, urlopen=lambda url, timeout: io.BytesIO(self.raw))
        self.download.start()
        self.addCleanup(self.download.stop)

    def test_pages_preserve_full_text_raw_hash_and_fixed_workspace_without_urls(self):
        tools = self.reader.tools()
        self.assertEqual([tool['name'] for tool in tools], ['read_attachment'])
        self.assertTrue(tools[0]['annotations']['readOnlyHint'])
        self.assertFalse(tools[0]['inputSchema']['additionalProperties'])
        text, offset = '', 0
        while True:
            page = self.reader.call('read_attachment', {'path': 'source:policy/attachment.txt', 'offset': offset})
            text += page['text']
            self.assertEqual(page['sha256'], self.row['hash'])
            self.assertEqual(page['total_chars'], len(self.raw.decode()))
            self.assertNotIn('url', page)
            self.assertNotIn('token=private', json.dumps(page))
            if page['next_offset'] is None:
                break
            offset = page['next_offset']
        self.assertEqual(text, self.raw.decode())
        self.assertGreater(len(self.calls), 1)
        self.assertTrue(all(call == ('joppa_attachments', {'workspace': 'fixed-workspace', 'target': 'source:policy'})
                            for call in self.calls))

    def test_invalid_paths_paging_or_workspace_fail_before_upstream_reads(self):
        for args in ({'path': '/etc/passwd'}, {'path': 'attachment.txt'}, {'path': 'ac:policy/attachment.txt'},
                     {'path': 'source:policy/attachment.txt', 'workspace': 'foreign'},
                     {'path': 'source:policy/attachment.txt', 'offset': -1},
                     {'path': 'source:policy/attachment.txt', 'length': True},
                     {'path': 'source:policy/attachment.txt', 'length': 100001},
                     {'path': 'source:policy/attachment.txt', 'length': 0}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.reader.call('read_attachment', args)
        self.assertEqual(self.calls, [])
        with self.assertRaises(MCPError):
            self.reader.call('joppa_attachments', {'workspace': 'foreign', 'target': 'source:policy'})
        with self.assertRaises(MCPError):
            self.reader.call('joppa_batch', {})

    def test_removed_missing_or_wrong_bytes_fail_without_widening_local_file_grants(self):
        with self.assertRaisesRegex(ValueError, 'no attachment missing.txt'):
            self.reader.call('read_attachment', {'path': 'source:policy/missing.txt'})
        self.row['removed'] = True
        with self.assertRaisesRegex(ValueError, 'no attachment attachment.txt'):
            self.reader.call('read_attachment', {'path': 'source:policy/attachment.txt'})
        self.row['removed'] = False
        self.row['hash'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'differ from the Joppa hash'):
            self.reader.call('read_attachment', {'path': 'source:policy/attachment.txt'})
        with self.assertRaises(ValueError):
            self.reader.call('read_file', {'path': 'attachment.txt'})
        self.assertEqual(self.reader.call('read_context', {})['roots'], [])
        self.assertEqual(self.reader.call('read_context', {})['files'], [])

    def test_download_and_lookup_errors_return_tool_errors_and_keep_stdio_running(self):
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
             'params': {'name': 'read_attachment', 'arguments': {'path': 'source:policy/missing.txt'}}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
             'params': {'name': 'read_attachment', 'arguments': {'path': 'source:policy/attachment.txt'}}},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'ping'}]
        helper = reader_files.attachment_reader()
        def refused(*args, **kwargs):
            raise TimeoutError('download failed at https://storage.example/signed?token=private')
        output = io.StringIO()
        with patch.dict(helper.__globals__, urlopen=refused):
            serve(self.reader, io.StringIO(''.join(json.dumps(row) + '\n' for row in requests)), output)
        missing, failed, ping = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(missing['result']['isError'])
        self.assertTrue(failed['result']['isError'])
        self.assertIn('SEARCH_UNAVAILABLE', failed['result']['content'][0]['text'])
        self.assertNotIn('token=private', output.getvalue())
        self.assertEqual(ping['result'], {})
