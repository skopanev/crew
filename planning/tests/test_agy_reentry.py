import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tools


class AgyReentryTests(unittest.TestCase):
    def test_two_critic_rounds_accept_an_empty_profile_config(self):
        for content in ("", " \n\t"):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / ".gemini/config/mcp_config.json"

                def inventory(*args, **kwargs):
                    config.parent.mkdir(parents=True, exist_ok=True)
                    config.write_text(content)
                    return subprocess.CompletedProcess(args[0], 0, "No MCP servers configured.\n", "")

                with patch.dict(os.environ, {"AGY_PROFILE_HOME": directory, "MEDULLA_HARNESS": "agy"}), \
                        patch.object(tools.subprocess, "run", side_effect=inventory) as query:
                    tools.prepare_critic()
                    tools.prepare_critic()
                    self.assertEqual(query.call_count, 2)

    def test_nonempty_invalid_json_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / ".gemini/config/mcp_config.json"
            config.parent.mkdir(parents=True)
            config.write_text("invalid")
            with patch.dict(os.environ, {"AGY_PROFILE_HOME": directory}), \
                    patch.object(tools.subprocess, "run") as query:
                with self.assertRaises(json.JSONDecodeError):
                    tools.prepare_agy()
                query.assert_not_called()

    def test_empty_config_does_not_skip_the_live_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / ".gemini/config/mcp_config.json"
            config.parent.mkdir(parents=True)
            config.write_text("")
            reply = subprocess.CompletedProcess(["agy", "mcp", "list"], 0, "unexpected-server", "")
            with patch.dict(os.environ, {"AGY_PROFILE_HOME": directory}), \
                    patch.object(tools.subprocess, "run", return_value=reply):
                with self.assertRaisesRegex(ValueError, "inherited MCP remains"):
                    tools.prepare_agy()


if __name__ == "__main__":
    unittest.main()
