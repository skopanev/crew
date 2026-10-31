import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLANNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLANNING))
from common import validate_input, fingerprint


class FingerprintTests(unittest.TestCase):
    def test_fingerprint_streams_untracked_bytes_and_detects_content_changes(self):
        with tempfile.TemporaryDirectory(prefix="crew-planning-test-") as temp:
            repo = Path(temp) / "repo"
            (repo / "src").mkdir(parents=True)
            (repo / "src/main.py").write_text("value = 1\n")
            for args in (["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]):
                subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
            path = repo / "src/artifact.bin"
            path.write_bytes(b"a" * (3 * 1024 * 1024))
            source = {"id": "test", "path": str(repo), "cbm_project": "test-project",
                      "modules": [{"name": "src", "path": "src"}]}
            with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
                before = fingerprint(source)
                self.assertEqual(before, fingerprint(source))
                with path.open("r+b") as file:
                    file.seek(2 * 1024 * 1024)
                    file.write(b"b")
                self.assertNotEqual(before, fingerprint(source))


class ValidationTests(unittest.TestCase):
    def test_requires_domain_and_capability_meaning(self):
        original = json.loads((PLANNING / "tests/input.example.json").read_text())
        for level in ("domain", "capability"):
            for invalid in (None, {}, {"id": "present", "text": " "}):
                with self.subTest(level=level, invalid=invalid):
                    data = copy.deepcopy(original)
                    data[level] = invalid
                    with self.assertRaisesRegex(ValueError, level):
                        validate_input(data)

    def test_rejects_path_traversal_and_duplicate_repositories(self):
        data = json.loads((PLANNING / "tests/input.example.json").read_text())
        data["repositories"][0]["modules"][0]["path"] = "../outside"
        with self.assertRaisesRegex(ValueError, "relative path"):
            validate_input(data)
        data["repositories"][0]["modules"][0]["path"] = "."
        data["repositories"].append(copy.deepcopy(data["repositories"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate repository"):
            validate_input(data)


if __name__ == "__main__":
    unittest.main()
