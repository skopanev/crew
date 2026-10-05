"""Publication guards in planning-ntk finish() and fail(). No NTK, agent or Equill calls."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stages


def reject(claim):
    return {"verdict": "reject", "summary": "Rejected", "findings": [
        {"blocking": True, "claim": claim, "evidence": "src/main.py:1", "resolution": "Fix it"}]}


class PublicationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="planning-ntk-test-")
        self.addCleanup(temp.cleanup)
        self.run_dir = Path(temp.name)
        self.target = self.run_dir / "artifacts"
        self.target.mkdir()
        env = patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.run_dir), "PLANNING_TICKET": "t-1"})
        env.start()
        self.addCleanup(env.stop)
        plan = {"ntk": {"verdict": "READY", "failure_class": "none", "owner": "", "decision": "", "body": ""},
                "disposition": "implement", "tasks": [{"id": "task-1"}], "blockers": []}
        (self.target / "input.json").write_text(json.dumps({"ticket": {"id": "t-1"}}))
        (self.target / "plan.json").write_text(json.dumps(plan))
        for key in stages.validation.CRITICS:
            review = reject("The plan misses a case") if key == "necessity" else {"verdict": "clear", "summary": "Clear", "findings": []}
            (self.target / f"critic-{key}.json").write_text(json.dumps(review))
        for name in ("validate_plan", "retained", "config", "publication_input", "remember"):
            stub = patch.object(stages, name, return_value={})
            stub.start()
            self.addCleanup(stub.stop)
        critique = patch.object(stages.validation, "critique")
        critique.start()
        self.addCleanup(critique.stop)

    def test_a_rejected_plan_checks_freshness_before_it_publishes(self):
        calls = []
        with patch.object(stages.shared, "verify_freshness", side_effect=lambda a: calls.append("fresh")), \
             patch.object(stages, "ntk", side_effect=lambda action, value: calls.append(action) or {"verdict": "NOT_READY"}), \
             patch.object(stages, "signal"):
            stages.finish()
        self.assertEqual(calls, ["fresh", "publish"])

    def test_stale_sources_stop_a_rejected_plan_before_any_write(self):
        with patch.object(stages.shared, "verify_freshness", side_effect=ValueError("source changed")), \
             patch.object(stages, "ntk") as ntk:
            with self.assertRaises(ValueError):
                stages.finish()
        ntk.assert_not_called()
        self.assertFalse((self.target / "publication-started.json").exists())

    def test_a_failed_publication_is_uncertain_not_unchanged(self):
        with patch.object(stages.shared, "verify_freshness"), \
             patch.object(stages, "ntk", side_effect=RuntimeError("NTK timed out")):
            with self.assertRaises(RuntimeError):
                stages.finish()
        with patch.object(stages, "signal"):
            stages.fail("NTK timed out")
        result = json.loads((self.target / "result.json").read_text())
        self.assertFalse(result["ticket_unchanged"])
        self.assertTrue(result["publication_uncertain"])

    def test_a_run_that_never_published_leaves_the_ticket_unchanged(self):
        with patch.object(stages, "signal"):
            stages.fail("agent failed")
        result = json.loads((self.target / "result.json").read_text())
        self.assertTrue(result["ticket_unchanged"])
        self.assertNotIn("publication_uncertain", result)


if __name__ == "__main__":
    unittest.main()
