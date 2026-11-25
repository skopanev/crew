"""Repository setup must not time out while its preflight waits for capacity."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SETUP = Path(__file__).resolve().parents[1] / "bin/setup-worktree.sh"


class SetupPreflightTests(unittest.TestCase):
    def test_preflight_survives_a_queue_wait_longer_than_600_seconds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout, run, commands = root / "checkout", root / "run", root / "commands"
            (checkout / ".git").mkdir(parents=True)
            (checkout / ".git/config").touch()
            (run / "artifacts").mkdir(parents=True)
            commands.mkdir()
            # The fake clock advances through the queue without a real wait.
            timeout = commands / "timeout"
            timeout.write_text(
                '#!/bin/sh\nlimit=${1%s}; shift\n'
                'if [ "$FAKE_PREFLIGHT_WAIT_SECONDS" -gt "$limit" ]; then\n'
                '  echo "simulated preflight timeout" >&2; exit 124\n'
                'fi\nexec "$@"\n')
            timeout.chmod(0o755)
            preflight = root / "preflight"
            preflight.write_text(
                '#!/bin/sh\nset -eu\n'
                'printf "%s\\n" "$FAKE_PREFLIGHT_WAIT_SECONDS" > "$MEDULLA_RUN_DIR/completed"\n')
            preflight.chmod(0o755)
            result = subprocess.run(["bash", "-euc", 'source "$1"', "setup", str(SETUP)],
                cwd=checkout, env={**os.environ, "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                    "project_dir": str(checkout), "LANE_WORKTREE": str(checkout),
                    "MEDULLA_RUN_DIR": str(run), "REPOSITORY_PREFLIGHT": str(preflight),
                    "FAKE_PREFLIGHT_WAIT_SECONDS": "601"},
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((run / "completed").read_text(), "601\n")


if __name__ == "__main__":
    unittest.main()
