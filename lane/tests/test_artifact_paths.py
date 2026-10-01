"""Render the real review prompt and write reports without shell expansion."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

from test_failure_outcome import WORKFLOW, shell_body


@unittest.skipUnless(shutil.which('medulla'), 'installed Medulla required')
class ArtifactPathTests(unittest.TestCase):
    def test_review_reports_are_written_outside_the_checkout(self):
        lines = WORKFLOW.read_text().splitlines()
        start = lines.index('  expert_review:')
        start = lines.index('    prompt: |', start) + 1
        end = start
        while end < len(lines) and (not lines[end] or lines[end].startswith('      ')):
            end += 1
        prompt = textwrap.dedent('\n'.join(lines[start:end]))
        publish = '\n'.join(line for line in shell_body('ntk_claim').splitlines()
                            if 'signal:var key=RUN_ARTIFACTS' in line or '<signal:CLAIMED>' in line)
        with tempfile.TemporaryDirectory(prefix='crew-artifact-path-') as directory:
            root = Path(directory).resolve()
            checkout = root / 'checkout'
            checkout.mkdir()
            writer = root / 'writer.sh'
            writer.write_text("""python3 - "$1" <<'WRITE'
from pathlib import Path
import re, sys
prompt = Path(sys.argv[1]).read_text()
target = Path(re.search(r'^Write (.+):$', prompt, re.M).group(1))
assert target.is_absolute() and '$' not in str(target), target
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text('NONE\\n')
WRITE
""")
            flow = root / 'workflow.yaml'
            flow.write_text(
                "version: '2'\nstart: publish\nvars:\n"
                "  ticket_id: fixture-ticket\n"
                f"  LANE_WORKTREE: {json.dumps(str(checkout))}\n"
                "nodes:\n  publish:\n    on_signal:\n"
                "      CLAIMED: review\n      __default__: __exit_fail__\n"
                "    shell: |\n" + textwrap.indent(publish, '      ') + '\n'
                "  review:\n    inputs:\n"
                "      - slug: architecture\n      - slug: codereview\n      - slug: security\n"
                "    max_parallel: 3\n    on_signal:\n"
                "      __done__: __exit_ok__\n      __failed__: __exit_fail__\n"
                f"    agent:\n      harness: fake\n      model: {json.dumps(str(writer))}\n"
                "    prompt: |\n" + textwrap.indent(prompt, '      ') + '\n')
            result = subprocess.run(
                ['medulla', '-w', str(flow), '--runs-folder', str(root / 'runs')],
                cwd=checkout, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            run = next((root / 'runs').iterdir())
            self.assertEqual(sorted(p.name for p in (run / 'artifacts').iterdir()),
                             ['architecture.md', 'codereview.md', 'security.md'])
            self.assertEqual(list(checkout.iterdir()), [])
            self.assertIn(str(run / 'artifacts'), (run / 'vars.yaml').read_text())


if __name__ == '__main__':
    unittest.main()
