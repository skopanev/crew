"""Check document extraction, original bytes and the existing adapter boundary."""
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import documents
import context
import reader
import reader_files


def docx():
    raw = BytesIO()
    ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    with ZipFile(raw, 'w') as archive:
        archive.writestr('word/document.xml', f'<w:document xmlns:w="{ns}"><w:body>'
            '<w:p><w:r><w:t>First policy sentence.</w:t><w:tab/><w:t>Следующее правило.</w:t></w:r></w:p>'
            '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table rule.</w:t><w:br/><w:t>Final rule.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
            '</w:body></w:document>')
        for part in ('header1', 'footer1', 'footnotes', 'endnotes', 'comments'):
            archive.writestr('word/' + part + '.xml', f'<w:root xmlns:w="{ns}"><w:p><w:r><w:t>{part} rule.</w:t></w:r></w:p></w:root>')
    return raw.getvalue()


def pdf():
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
    for sentence in ('First policy sentence.', 'Final policy sentence.'):
        stream = ('BT /F1 12 Tf 40 150 Td (' + sentence + ') Tj ET').encode()
        objects.extend([b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 7 0 R >> >> /Contents '
                        + str(len(objects) + 2).encode() + b' 0 R >>',
                        b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream'])
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    raw = b'%PDF-1.4\n'; offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(raw)); raw += str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    start = len(raw)
    raw += b'xref\n0 8\n0000000000 65535 f \n' + b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return raw + f'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()


class DocumentsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name); self.brain = self.root / 'brain'; self.manuals = self.root / 'manuals'
        self.brain.mkdir(); self.manuals.mkdir()
        self.config = {'vars': {'BRAIN_ROOT': str(self.brain), 'MANUALS_ROOT': str(self.manuals), 'BRAIN_EXCLUDE': 'obsolete'}}

    def test_docx_full_parts_unicode_and_raw_hash_match_adapter_and_freeze(self):
        file = self.brain / 'policy.docx'; raw = docx(); file.write_bytes(raw)
        value = documents.read_document(file, self.config)
        for quote in ('First policy sentence.', 'Следующее правило.', 'Table rule.', 'Final rule.',
                      'header1 rule.', 'footer1 rule.', 'footnotes rule.', 'endnotes rule.', 'comments rule.'):
            self.assertIn(quote, value['text'])
        self.assertEqual(value['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(context.evidence_file({'path': str(file), 'quote': 'Table rule.'}, self.config), value)
        class Backend:
            def call(self, *args): raise AssertionError('Document reads must not call Joppa')
        adapter = reader.Sources(Backend(), 'fixture', None, self.config)
        self.assertEqual(adapter.call('read_document', {'path': str(file)}), value)
        for args in ({'path': str(file), 'command': 'write'}, {'path': str(file), 'workspace': 'foreign'}, {'path': []}):
            with self.assertRaises(ValueError): adapter.call('read_document', args)
        with self.assertRaisesRegex(ValueError, 'exact file quote'):
            context.evidence_file({'path': str(file), 'quote': 'Invented rule.'}, self.config)

    def test_pdf_all_pages_use_same_extraction_for_tool_freeze_and_verify(self):
        file = self.manuals / 'policy.pdf'; raw = pdf(); file.write_bytes(raw)
        value = documents.read_document(file, self.config)
        self.assertIn('First policy sentence.', value['text']); self.assertIn('Final policy sentence.', value['text'])
        self.assertEqual(value['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(context.evidence_file({'path': str(file), 'quote': value['text']}, self.config), value)
        file.write_bytes(raw + b'\n% changed original bytes\n')
        changed = context.evidence_file({'path': str(file), 'quote': value['text']}, self.config)
        self.assertNotEqual(changed['sha256'], value['sha256'])

    def test_pdf_converter_receives_the_same_bytes_that_the_host_hashes(self):
        file = self.brain / 'policy.pdf'; raw = b'original bytes'; file.write_bytes(raw)
        def convert(command, **args):
            self.assertEqual(command, ['pdftotext', '-layout', '-enc', 'UTF-8', '-', '-'])
            self.assertEqual(args['input'], raw); self.assertTrue(args['check']); self.assertNotIn('shell', args)
            self.assertEqual(args['stdout'], subprocess.PIPE); self.assertEqual(args['stderr'], subprocess.PIPE)
            file.write_bytes(b'replaced after read')
            return SimpleNamespace(stdout=b'Original policy text.')
        with patch.object(documents.subprocess, 'run', side_effect=convert):
            value = documents.read_document(file, self.config)
        self.assertEqual(value['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(value['text'], 'Original policy text.')

    def test_roots_exclusion_and_symlinks_refuse_before_conversion(self):
        outside = self.root / 'outside.pdf'; outside.write_bytes(b'outside')
        old = self.brain / 'obsolete'; old.mkdir(); excluded = old / 'old.pdf'; excluded.write_bytes(b'old')
        link = self.brain / 'escape.pdf'; link.symlink_to(outside)
        with patch.object(documents.subprocess, 'run') as convert:
            for file in (outside, excluded, link):
                with self.assertRaises(ValueError): documents.read_document(file, self.config)
            convert.assert_not_called()

    def test_empty_or_unreadable_documents_return_errors_without_gap_or_output_files(self):
        file = self.brain / 'policy.pdf'; file.write_bytes(b'bad PDF')
        for error, expected in ((FileNotFoundError('pdftotext'), FileNotFoundError),
                                (subprocess.CalledProcessError(1, ['pdftotext'], stderr=b'Invalid PDF'), ValueError)):
            with patch.object(documents.subprocess, 'run', side_effect=error):
                with self.assertRaises(expected): documents.read_document(file, self.config)
        text = self.brain / 'empty.txt'; text.write_text(' ')
        with self.assertRaisesRegex(ValueError, 'SEARCH_UNAVAILABLE'): documents.read_document(text, self.config)
        self.assertEqual(sorted(path.name for path in self.brain.iterdir()), ['empty.txt', 'policy.pdf'])

    def test_malformed_document_returns_an_mcp_tool_error_without_stopping_the_reader(self):
        file = self.brain / 'bad.docx'; file.write_bytes(b'not a ZIP')
        requests = StringIO(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
            'params': {'name': 'read_document', 'arguments': {'path': str(file)}}}) + '\n' +
            json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'ping'}) + '\n')
        output = StringIO()
        reader.serve(reader.Sources(None, 'fixture', None, self.config), requests, output)
        first, second = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(first['result']['isError']); self.assertIn('SEARCH_UNAVAILABLE', first['result']['content'][0]['text'])
        self.assertEqual(second['result'], {})


class AttachmentTest(unittest.TestCase):
    def setUp(self):
        self.raw = 'The fee is 1 percent.\n\nThe minimum is 2 USDT.'.encode()
        self.row = {'name': 'attachment.txt', 'removed': False, 'hash': hashlib.sha256(self.raw).hexdigest(),
                    'url': 'https://storage.example/attachment.txt'}
        self.calls = []
        test = self
        class Api:
            def call(self, tool, args):
                test.calls.append((tool, args)); return {'files': [test.row]}
        self.api, self.config = Api(), {'workspace': 'fixture'}
        self.urlopen = lambda raw: patch.object(documents, 'urlopen', side_effect=lambda url, timeout: type('R', (), {
            '__enter__': lambda self: SimpleNamespace(read=lambda: raw), '__exit__': lambda self, *a: False})())

    def test_a_source_attachment_is_evidence_with_its_joppa_hash(self):
        with self.urlopen(self.raw):
            value = documents.read_attachment(self.api, self.config, 'source:policy/attachment.txt')
        self.assertEqual(value, {'path': 'source:policy/attachment.txt', 'route': 'attachment',
                                 'text': self.raw.decode(), 'sha256': self.row['hash']})
        self.assertEqual(self.calls, [('joppa_attachments', {'workspace': 'fixture', 'target': 'source:policy'})])
        with self.urlopen(self.raw), self.assertRaisesRegex(LookupError, 'no attachment other.md'):
            documents.read_attachment(self.api, self.config, 'source:policy/other.md')
        for path in ('ac:x/attachment.txt', 'source:policy', None):
            with self.assertRaises(LookupError): documents.read_attachment(self.api, self.config, path)
        with self.urlopen(b'Changed bytes.'), self.assertRaisesRegex(ValueError, 'SEARCH_UNAVAILABLE: .*differ from the Joppa hash'):
            documents.read_attachment(self.api, self.config, 'source:policy/attachment.txt')
        self.row['url'] = 'http://storage.example/attachment.txt'
        with self.assertRaisesRegex(ValueError, 'no HTTPS download url'):
            documents.read_attachment(self.api, self.config, 'source:policy/attachment.txt')

    def test_pdf_and_docx_attachments_keep_complete_text_and_original_hash(self):
        for name, raw, final in [('policy.pdf', pdf(), 'Final policy sentence.'), ('policy.docx', docx(), 'Final rule.')]:
            with self.subTest(name=name):
                self.row.update(name=name, hash=hashlib.sha256(raw).hexdigest())
                with self.urlopen(raw):
                    value = documents.read_attachment(self.api, self.config, 'source:policy/' + name)
                self.assertIn('First policy sentence.', value['text'])
                self.assertIn(final, value['text'])
                self.assertEqual(value['sha256'], hashlib.sha256(raw).hexdigest())

    def test_the_download_refuses_a_non_https_redirect_and_wraps_transport_errors(self):
        handler = documents.HttpsRedirects()
        from urllib.request import Request
        source = Request('https://storage.example/attachment.txt')
        with self.assertRaisesRegex(documents.URLError, 'non-HTTPS'):
            handler.redirect_request(source, None, 302, 'Found', {}, 'http://storage.example/attachment.txt')
        self.assertEqual(handler.redirect_request(source, None, 302, 'Found', {}, 'https://cdn.example/attachment.txt').full_url,
                         'https://cdn.example/attachment.txt')
        for error in (documents.URLError('redirect to a non-HTTPS url'), TimeoutError('timed out'), documents.HTTPException('bad')):
            with patch.object(documents, 'urlopen', side_effect=error), self.assertRaisesRegex(ValueError, '^SEARCH_UNAVAILABLE: source:policy/attachment.txt: '):
                documents.read_attachment(self.api, self.config, 'source:policy/attachment.txt')

    def test_the_reader_reads_a_source_attachment_and_names_a_wrong_path(self):
        with patch.object(reader_files, 'attachment_reader', return_value=documents.read_attachment):
            adapter = reader.Sources(self.api, 'fixture', None, {})
            with self.urlopen(self.raw):
                self.assertEqual(adapter.call('read_attachment', {'path': 'source:policy/attachment.txt'})['route'], 'attachment')
            with self.assertRaisesRegex(Exception, 'no attachment missing.md'):
                adapter.call('read_attachment', {'path': 'source:policy/missing.md'})
            with self.assertRaises(Exception): adapter.call('read_attachment', {'path': 'source:policy/attachment.txt', 'extra': 1})


if __name__ == '__main__':
    unittest.main()
