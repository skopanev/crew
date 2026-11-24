"""Read complete document text and bind it to the original file bytes."""
import hashlib
from io import BytesIO
import os
from pathlib import Path
import re
import subprocess
from http.client import HTTPException
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, build_opener
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


def research_roots(config):
    roots = {name: Path(config['vars'][key]).resolve(strict=True)
             for name, key in [('brain', 'BRAIN_ROOT'), ('manuals', 'MANUALS_ROOT')]}
    for name, root in roots.items():
        if not root.is_dir():
            raise ValueError('SEARCH_UNAVAILABLE: ' + name + ' root is not a directory')
        with os.scandir(root) as entries:
            next(entries, None)
    return roots


def docx_text(raw):
    word = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    parts = []
    with ZipFile(BytesIO(raw)) as archive:
        names = ['word/document.xml'] + sorted(name for name in archive.namelist()
            if re.fullmatch(r'word/(?:header\d+|footer\d+|footnotes|endnotes|comments)\.xml', name))
        for name in names:
            tokens = []
            def collect(node):
                if node.tag == word + 't':
                    tokens.append(node.text or '')
                elif node.tag == word + 'tab':
                    tokens.append('\t')
                elif node.tag in (word + 'br', word + 'cr'):
                    tokens.append('\n')
                else:
                    for child in node:
                        collect(child)
                if node.tag in (word + 'p', word + 'tr'):
                    tokens.append('\n')
            collect(ElementTree.fromstring(archive.read(name)))
            parts.append(''.join(tokens))
    return '\n'.join(parts)


def read_document(path, config):
    roots = research_roots(config)
    file = Path(path).resolve(strict=True)
    route = next((name for name, root in roots.items() if file.is_relative_to(root)), None)
    if not route:
        raise ValueError('Evidence file is outside the approved roots')
    excluded = (roots['brain'] / config['vars']['BRAIN_EXCLUDE']).resolve()
    if file.is_relative_to(excluded):
        raise ValueError('The obsolete Brain folder is excluded')
    raw = file.read_bytes()
    return {'path': str(file), 'route': route, 'text': document_text(raw, file.suffix.lower(), str(file)),
            'sha256': hashlib.sha256(raw).hexdigest()}


def document_text(raw, suffix, label):
    try:
        if suffix == '.pdf':
            text = subprocess.run(['pdftotext', '-layout', '-enc', 'UTF-8', '-', '-'], input=raw,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout.decode('utf-8')
        elif suffix == '.docx':
            text = docx_text(raw)
        else:
            text = raw.decode('utf-8')
    except (subprocess.CalledProcessError, BadZipFile, ElementTree.ParseError) as error:
        detail = (getattr(error, 'stderr', b'') or b'').decode('utf-8', errors='replace')
        raise ValueError('SEARCH_UNAVAILABLE: ' + label + ': ' + (detail or str(error))) from error
    if not text.strip():
        raise ValueError('SEARCH_UNAVAILABLE: the document has no extractable text')
    return text


class HttpsRedirects(HTTPRedirectHandler):
    # An attachment download follows a redirect only to another HTTPS url.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith('https://'):
            raise URLError('redirect to a non-HTTPS url')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def urlopen(url, timeout):
    return build_opener(HttpsRedirects).open(url, timeout=timeout)


def read_attachment(api, config, path):
    # A file attached to a Source: path source:<id>/<file name>. The Joppa hash is the SHA256 of the stored bytes.
    # A wrong path or file name is an author mistake (LookupError). A failed download is technical (ValueError).
    match = re.fullmatch(r'(source:[A-Za-z0-9_-]+)/(.+)', path) if isinstance(path, str) else None
    if not match:
        raise LookupError('use source:<id>/<file name> for a Source attachment')
    address, name = match.groups()
    listed = api.call('joppa_attachments', {'workspace': config['workspace'], 'target': address})
    file = next((row for row in listed.get('files', []) if row.get('name') == name and not row.get('removed')), None)
    if not file:
        raise LookupError('the Source ' + address + ' has no attachment ' + name)
    if not str(file.get('url', '')).startswith('https://'):
        raise ValueError('SEARCH_UNAVAILABLE: ' + path + ': no HTTPS download url')
    try:
        with urlopen(file['url'], timeout=60) as response:
            raw = response.read()
    except (OSError, HTTPException) as error:
        raise ValueError('SEARCH_UNAVAILABLE: ' + path + ': ' + type(error).__name__) from error
    digest = hashlib.sha256(raw).hexdigest()
    if digest != file.get('hash'):
        raise ValueError('SEARCH_UNAVAILABLE: ' + path + ': the downloaded bytes differ from the Joppa hash')
    return {'path': path, 'route': 'attachment', 'text': document_text(raw, Path(name).suffix.lower(), path), 'sha256': digest}
