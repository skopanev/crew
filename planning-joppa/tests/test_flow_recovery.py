"""Recover an ended claim without changing a node that the run no longer owns."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import test_flow_shutdown as shutdown
from common import read, write
from flow_recovery import observe_release
import flow_runtime
import publication


class FlowRecoveryTests(unittest.TestCase):
    setUp = shutdown.FlowShutdownTests.setUp
    def test_external_release_preserves_the_entire_node_and_failure_evidence(self):
        node = self.api.nodes["criterion:a"]
        node["document"]["data"].update(stage="ready", delivery={"state": "pending"})
        node["document"]["data"].pop("assignee")
        node["current_revision"] += 2
        before = deepcopy(node)
        write(self.target / "result.json", {"status": "blocked", "reason": "Original failure", "needs_recovery": True})
        self.assertIsNotNone(observe_release(self.api, self.config, self.target, apply=False))
        self.assertTrue(read(self.target / "result.json")["needs_recovery"])
        flow_runtime.release(self.config, self.folder, "Interrupted", True)
        result = read(self.target / "result.json")
        self.assertEqual((result["claim_released"], result["needs_recovery"], result["reason"]), (True, False, "Original failure"))
        self.assertEqual(node, before)
        self.assertEqual(len(self.api.batches), 1)
        publication.ensure_recovered(self.root, self.root / "next" / "artifacts", self.api.url, "example", "criterion:a")
        result["claim_resolution"]["request_id"] = "another-claim"
        write(self.target / "result.json", result)
        with self.assertRaisesRegex(ValueError, "needs recovery"):
            publication.ensure_recovered(self.root, self.root / "next" / "artifacts", self.api.url, "example", "criterion:a")

    def test_changed_revision_with_the_same_holder_releases_only_the_assignee(self):
        node = self.api.nodes["criterion:a"]
        node["current_revision"] += 1
        node["document"]["data"].update(stage="ready", body="Updated by its owner", delivery={"state": "pending"})
        before = deepcopy(node["document"]["data"])
        before.pop("assignee")
        self.config["failure_escalation"] = {"after": 1, "data": {"stage": "wrong-stage"}}
        flow_runtime.release(self.config, self.folder, "Stage already recorded", True)
        self.assertEqual(self.api.nodes["criterion:a"]["document"]["data"], before)
        self.assertTrue(read(self.target / "result.json")["claim_released"])
        self.assertEqual(len(self.api.batches), 2)

    def test_uncertain_receipts_and_a_live_claim_do_not_resolve(self):
        self.assertIsNone(observe_release(self.api, self.config, self.target))
        self.api.nodes["criterion:a"]["document"]["data"].pop("assignee")
        for name in ["publication.json", "release.json"]:
            write(self.target / name, {"status": "uncertain"})
            self.assertIsNone(observe_release(self.api, self.config, self.target))
            (self.target / name).unlink()
        self.assertFalse((self.target / "result.json").exists())


if __name__ == "__main__":
    unittest.main()
