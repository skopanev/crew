"""Read complete document text and bind it to the original file bytes."""
import hashlib
from io import BytesIO
import os
from pathlib import Path
import re
import subprocess
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
    try:
        if file.suffix.lower() == '.pdf':
            text = subprocess.run(['pdftotext', '-layout', '-enc', 'UTF-8', '-', '-'], input=raw,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout.decode('utf-8')
        elif file.suffix.lower() == '.docx':
            text = docx_text(raw)
        else:
            text = raw.decode('utf-8')
    except (subprocess.CalledProcessError, BadZipFile, ElementTree.ParseError) as error:
        detail = (getattr(error, 'stderr', b'') or b'').decode('utf-8', errors='replace')
        raise ValueError('SEARCH_UNAVAILABLE: ' + str(file) + ': ' + (detail or str(error))) from error
    if not text.strip():
        raise ValueError('SEARCH_UNAVAILABLE: the document has no extractable text')
    return {'path': str(file), 'route': route, 'text': text, 'sha256': hashlib.sha256(raw).hexdigest()}
