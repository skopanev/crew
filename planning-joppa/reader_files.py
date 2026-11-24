"""Read explicitly granted UTF-8 files through the existing MCP reader."""
import hashlib
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
        raw = file.read_bytes()
        text = raw.decode("utf-8")
        end = min(offset + length, len(text))
        return {"path": str(file.resolve()), "text": text[offset:end], "offset": offset,
                "next_offset": end if end < len(text) else None, "total_chars": len(text),
                "sha256": hashlib.sha256(raw).hexdigest()}
