"""Shared empty mountpoints must survive a second lane's preflight."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class MountpointPreflightTests(unittest.TestCase):
    def test_shared_mountpoint_and_conflicting_content(self):
        source = (Path(__file__).resolve().parents[1] / 'run.sh').read_text()
        body = source.split('check_mountpoint() {', 1)[1].split('\n}\n', 1)[0]
        script = 'set -eu\nsay() { echo "$*" >&2; }\ncheck_mountpoint() {' + body + '\n}\ncheck_mountpoint "$1"\n'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            point = root / 'sources'
            point.mkdir()
            # Both launches see the same existing mountpoint; neither removes it.
            for _ in range(2):
                result = subprocess.run(['bash', '-c', script, '_', '/project/sources'],
                                        env={'TOOLING_ROOT': str(root)}, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(point.is_dir())
            (point / 'keep').write_text('source file')
            result = subprocess.run(['bash', '-c', script, '_', '/project/sources'],
                                    env={'TOOLING_ROOT': str(root)}, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual((point / 'keep').read_text(), 'source file')
            (root / 'link').symlink_to(point, target_is_directory=True)
            result = subprocess.run(['bash', '-c', script, '_', '/project/link'],
                                    env={'TOOLING_ROOT': str(root)}, capture_output=True)
            self.assertEqual(result.returncode, 2)
