"""Read granted local files and workspace Source attachments through the existing MCP reader."""
from functools import lru_cache
import hashlib
import importlib.util
import json
import os
from pathlib import Path


TOOL = {
    "name": "read_file", "description": "Read a granted UTF-8 file. Follow next_offset for the rest. No file writes.",
    "annotations": {"readOnlyHint": True, "destructiveHint": False},
    "inputSchema": {"type": "object", "properties": {
        "path": {"type": "string"}, "offset": {"type": "integer", "minimum": 0},
        "length": {"type": "integer", "minimum": 1, "maximum": 100000}},
        "required": ["path"], "additionalProperties": False}}
CONTEXT_TOOL = {
    "name": "read_context", "description": "Find this role's instructions, contracts, frozen input and feedback files. Read these before evidence.",
    "annotations": {"readOnlyHint": True, "destructiveHint": False},
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}
ATTACHMENT_TOOL = {**TOOL, "name": "read_attachment", "description":
    "Read Source attachment text at source:<id>/<file name>. Follow next_offset. sha256 covers the original file bytes."}


@lru_cache(maxsize=1)
def attachment_reader():
    spec = importlib.util.spec_from_file_location("crew_attachment_documents",
        Path(__file__).resolve().parent.parent / "decider/documents.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.read_attachment


def read_attachment(api, workspace, args):
    if not isinstance(args, dict) or set(args) - {"path", "offset", "length"} or not isinstance(args.get("path"), str):
        raise ValueError("Use path, offset and length for read_attachment")
    offset, length = args.get("offset", 0), args.get("length", 20000)
    if type(offset) is not int or offset < 0 or type(length) is not int or not 1 <= length <= 100000:
        raise ValueError("Use offset >= 0 and length 1..100000")
    try:
        value = attachment_reader()(api, {"workspace": workspace}, args["path"])
    except LookupError as error:
        raise ValueError(str(error)) from error
    text = value["text"]
    end = min(offset + length, len(text))
    return {**value, "text": text[offset:end], "offset": offset,
            "next_offset": end if end < len(text) else None, "total_chars": len(text)}


def read_bytes(file):
    # Open each component through its directory descriptor. A changed symlink never redirects the read.
    flags = os.O_RDONLY | os.O_NOFOLLOW
    directory = os.open(file.anchor, flags | os.O_DIRECTORY)
    try:
        for part in file.parts[1:-1]:
            child = os.open(part, flags | os.O_DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(file.name, flags, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as stream:
            return stream.read()
    finally:
        os.close(directory)


class Files:
    def __init__(self):
        names = json.loads(os.environ.get("CREW_READER_FILES", "[]"))
        if not isinstance(names, list) or any(not isinstance(name, str) or not Path(name).is_absolute() for name in names):
            raise ValueError("CREW_READER_FILES must list absolute file paths")
        self.paths = {str(Path(name).resolve()) for name in names}
        roots = json.loads(os.environ.get("CREW_READER_ROOTS", "[]"))
        if not isinstance(roots, list) or any(not isinstance(root, str) or not Path(root).is_absolute() for root in roots):
            raise ValueError("CREW_READER_ROOTS must list absolute directory paths")
        self.roots = [Path(root).resolve(strict=True) for root in roots]
        if any(not root.is_dir() for root in self.roots):
            raise ValueError("Reader roots must be directories")

    def read(self, args):
        if not isinstance(args, dict) or set(args) - {"path", "offset", "length"} or not isinstance(args.get("path"), str):
            raise ValueError("Use path, offset and length for read_file")
        file = Path(args["path"])
        resolved = file.resolve()
        if not file.is_absolute() or not (str(resolved) in self.paths or any(resolved.is_relative_to(root) for root in self.roots)):
            raise ValueError("The file is outside this agent's granted files")
        offset, length = args.get("offset", 0), args.get("length", 20000)
        if type(offset) is not int or offset < 0 or type(length) is not int or not 1 <= length <= 100000:
            raise ValueError("Use offset >= 0 and length 1..100000")
        raw = read_bytes(resolved)
        text = raw.decode("utf-8")
        end = min(offset + length, len(text))
        return {"path": str(file.resolve()), "text": text[offset:end], "offset": offset,
                "next_offset": end if end < len(text) else None, "total_chars": len(text),
                "sha256": hashlib.sha256(raw).hexdigest()}

    def context(self, args, workspace):
        if not isinstance(args, dict) or args:
            raise ValueError("read_context takes an empty object")
        return {"workspace": workspace, "profile": os.environ.get("CREW_READER_PROFILE", ""),
                "files": sorted(self.paths), "roots": [str(root) for root in self.roots]}
