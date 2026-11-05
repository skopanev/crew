"""Requirement selection admits a waiting AC only for a due retry of Crew's own mark. No network."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from retry_fixture import ROOT, AC, Joppa, at, claim, fail
from provider_fixture import item, assignment, CHECK_TYPE
import context
import planning_claims
import planning_retry as retry

TYPES = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "project": {"role": "document"},
         "work": {"role": "task", "parents": ["criterion"], "question": "What work?",
                  "references": {"projects": {"multiple": True, "target": "project"}}}, "check": CHECK_TYPE}


def server(objects, roster):
    class Server:
        def call(self, name, args):
            if name == "joppa_tree":
                return {"position": 20, "schema": {"types": deepcopy(TYPES)}}
            if args.get("kind") == "check":
                return {"items": []}
            if "address" in args:
                return deepcopy(objects[args["address"]])
            if args.get("parent") == "rule:r":
                return {"items": [{"address": address, "kind": "criterion", "present": True} for address in roster]}
            return {"items": []}
    return Server()


class RetrySelectionTests(unittest.TestCase):
    def test_waiting_criterion_joins_the_requirement_only_with_a_due_retry(self):
        objects = {"rule:r": item("rule:r"), "project:p": item("project:p"),
                   "criterion:a": item("criterion:a", "rule:r"),
                   "criterion:held": item("criterion:held", "rule:r", process={"assessment": {
                       "state": "waiting", "reason": "PLANNING_FAILED", "position": 941}})}
        objects["criterion:held"]["work_ready"] = False
        config = {"workspace": "example", "repositories": assignment()["repositories"], "runs_folder": "/runs",
                  "url": "https://example.invalid/mcp"}
        api = server(objects, ["criterion:a", "criterion:held"])
        with patch.object(retry, "eligible", return_value=(None, "retry delay")):
            data, _, _ = context.load_requirement(api, config, "r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:a"])
        self.assertNotIn("retry", data["joppa"])
        due = {"position": 941, "context": "digest", "attempt": 1, "from_run": "run-1"}
        with patch.object(retry, "eligible", return_value=(due, None)) as check:
            data, _, _ = context.load_requirement(api, config, "r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:a", "criterion:held"])
        self.assertEqual(data["joppa"]["retry"], {"criterion:held": due})
        self.assertEqual(check.call_args.args[:3], ("/runs", "https://example.invalid/mcp", "example"))

    def test_retry_claims_fit_the_batch_within_the_admission_cap(self):
        criteria = [{"id": f"criterion:c{number}", "revision": 3} for number in range(planning_claims.MAX_CLAIMED_CRITERIA)]
        data = {"joppa": {"objects": {entry["id"]: context.source(item(entry["id"], "rule:r")) for entry in criteria}}}
        retries = {entry["id"]: {"position": 10 + number, "attempt": 1} for number, entry in enumerate(criteria)}
        operations = planning_claims.claim_operations(data, criteria, "crew-planning:host:run", retries)
        self.assertEqual(len(operations), 2 * planning_claims.MAX_CLAIMED_CRITERIA)
        self.assertLessEqual(len(operations), planning_claims.MAX_BATCH)
        self.assertEqual(operations[1]["command"]["expected_position"], 10)

    def test_failed_pass_reports_retry_exhaustion_in_its_result(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_retry", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        with tempfile.TemporaryDirectory() as directory, patch.object(retry, "now", return_value=at(0)):
            runs, api = Path(directory), Joppa()
            fail(api, claim(api, runs, 1))
            for number, seconds in ((2, 60), (3, 360)):
                due, _ = retry.eligible(runs, api.url, "example", context.object_read(api, "example", AC), at(seconds))
                target = claim(api, runs, number, {AC: due})
                if number == 2:
                    fail(api, target)
            (target / "input.json").write_text(json.dumps({"ac": {"id": AC}}))
            with patch.object(stage, "settings", return_value={"workspace": "example"}), \
                 patch.object(stage.shared, "artifacts", return_value=target), \
                 patch.object(stage.context, "client", return_value=api), patch.object(stage, "signal"):
                stage.fail("critic stopped")
            result = json.loads((target / "result.json").read_text())
            self.assertEqual((result["retry_exhausted"], result["claim_released"]), ([AC], True))


if __name__ == "__main__":
    unittest.main()
