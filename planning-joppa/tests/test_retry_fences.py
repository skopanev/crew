"""expected_position fences: an operator assessment is never overwritten. No network."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from retry_fixture import AC, SERVER, Joppa, at, claim, fail, release_receipt
from mcp import Rejected
import context
import planning_retry as retry
import publication
import retry_marks
from provider_fixture import assignment, plan


class RetryFenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.clock = patch.object(retry, "now", return_value=at(0))
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.directory.cleanup()

    def test_operator_assessment_after_the_failure_stops_the_retry_and_refuses_a_stale_claim(self):
        api = Joppa()
        fail(api, claim(api, self.root, 1))
        due, _ = retry.eligible(self.root, SERVER, "example", context.object_read(api, "example", AC), at(60))
        operator = api.operator(ready=False, reason="PLANNING_FAILED")
        # Same reason, same shared actor: only the exact recorded position is provenance.
        self.assertEqual(retry.eligible(self.root, SERVER, "example", context.object_read(api, "example", AC), at(60)),
                         (None, "no Crew failure mark with exact provenance"))
        revision = api.acs[AC]["revision"]
        with self.assertRaisesRegex(Rejected, "stale assessment position"):
            claim(api, self.root, 2, {AC: due})
        # The earlier save of the same batch is refused too. The operator assessment stays.
        self.assertEqual((api.acs[AC]["revision"], api.acs[AC]["assessment"]["position"]), (revision, operator))
        self.assertNotIn("assignee", api.acs[AC]["data"])
        self.assertEqual(json.loads((self.root / "2026-11-05_10-00-02-run2/artifacts/claim.json").read_text())["status"],
                         "rejected")

    def test_failure_release_is_fenced_and_keeps_a_later_operator_decision(self):
        api = Joppa(assessment={"state": "ready", "reason": "Owner approved", "position": 500, "actor": "operator"})
        target = claim(api, self.root, 1)
        self.assertEqual(json.loads((target / "claim.json").read_text())["positions"], {AC: 500})
        operator = api.operator(ready=False, reason="OWNER_HOLD")
        with self.assertRaisesRegex(Rejected, "stale assessment position"):
            fail(api, target)
        [_, release] = api.batches()
        self.assertEqual(release[1]["expected_position"], 500)
        self.assertEqual(api.acs[AC]["assessment"], {"state": "waiting", "reason": "OWNER_HOLD", "position": operator,
                                                     "actor": "operator"})
        self.assertEqual(release_receipt(target)["status"], "rejected")

    def test_mark_needs_a_read_that_matches_the_release(self):
        api = Joppa()
        target = claim(api, self.root, 1)
        original = api.call

        def intervene(name, args):
            result = original(name, args)
            if name == "joppa_batch" and any(op["command"]["op"] == "assess" for op in args["operations"]):
                api.operator(ready=False, reason="PLANNING_FAILED")
            return result
        api.call = intervene
        self.assertTrue(fail(api, target))
        receipt = release_receipt(target)
        self.assertEqual((receipt["marks"], receipt["marks_skipped"]), ({}, {AC: "reply position differs from the read"}))

    def test_publication_assess_ready_is_fenced_on_the_claimed_position(self):
        operations = publication.operations(plan(), assignment(), positions={AC: 77})
        [assess] = [item["command"] for item in operations if item["command"]["op"] == "assess"]
        self.assertEqual((assess["target"], assess["expected_position"]), (AC, 77))
        [unfenced] = [item["command"] for item in publication.operations(plan(), assignment())
                      if item["command"]["op"] == "assess"]
        self.assertNotIn("expected_position", unfenced)

    def test_reply_position_reads_the_verified_assess_result_shape(self):
        native = {"command": {"op": "assess", "target": AC}, "object": None, "position": 953}
        self.assertEqual(retry_marks.reply_position(native, AC), 953)
        # Only the top-level native position of this assess counts. Contradictions and other results are refused.
        self.assertIsNone(retry_marks.reply_position({**native, "assessment": {"position": 7}}, AC))
        self.assertIsNone(retry_marks.reply_position({**native, "command": {"op": "save_object"}}, AC))
        self.assertIsNone(retry_marks.reply_position({**native, "command": {"op": "assess", "target": "criterion:b"}}, AC))
        self.assertIsNone(retry_marks.reply_position({"assessment": {"position": 7}}, AC))
        self.assertIsNone(retry_marks.reply_position({"command": {"op": "assess"}, "object": None}, AC))

    def test_position_is_zero_without_assessment_and_unknown_without_a_server_position(self):
        self.assertEqual(retry.position({"process": {}}), 0)
        self.assertIsNone(retry.position({"process": {"assessment": {"state": "waiting", "reason": "X"}}}))
        self.assertEqual(retry.position({"process": {"assessment": {"state": "waiting", "position": 4}}}), 4)

    def test_retry_claim_compares_authored_context_without_the_replaced_assessment(self):
        def snapshot(state, data):
            return {"objects": {AC: {"document": {"data": data}, "work_ready": state == "ready",
                                     "process": {"assessment": {"state": state}}}}}
        compared = []
        unchanged = lambda old, new: compared.append(old == new) or None
        retry_marks.compare_claimed(snapshot("waiting", {"a": 1}), snapshot("ready", {"a": 1}), {AC: {}},
                                    self.root, unchanged)
        retry_marks.compare_claimed(snapshot("waiting", {"a": 1}), snapshot("ready", {"a": 2}), {AC: {}},
                                    self.root, unchanged)
        self.assertEqual(compared, [True, False])
        self.assertEqual(json.loads((self.root / "joppa-snapshot.json").read_text())["objects"][AC]["process"],
                         {"assessment": {"state": "ready"}})


if __name__ == "__main__":
    unittest.main()
