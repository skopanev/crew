"""Every Claude Code node in the lane runs without native background tasks."""

import re
import unittest
from pathlib import Path


WORKFLOW = Path(__file__).resolve().parents[1] / "workflow.yaml"


def nodes():
    """Each top-level node of the workflow, as its name and its text."""
    text = WORKFLOW.read_text().split("\nnodes:\n", 1)[1]
    parts = re.split(r"^  ([\w-]+):\n", text, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2]))


class CoderBackgroundTasksTests(unittest.TestCase):
    def test_claude_code_nodes_disable_background_tasks(self):
        coders = {name: body for name, body in nodes().items()
                  if re.search(r"^      harness: claude-code$", body, re.M)}
        self.assertIn("implement_code", coders)
        self.assertIn("git_fix", coders)
        for name, body in coders.items():
            with self.subTest(node=name):
                self.assertRegex(body, re.compile(
                    r"^      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'$", re.M))


if __name__ == "__main__":
    unittest.main()
