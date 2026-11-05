"""Exact own-mark provenance and the failure allowlist. No network."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from retry_fixture import AC, SERVER, Joppa, at, claim, fail, release_receipt
import context
import planning_retry as retry
import retry_rules


def eligible(api, root, seconds):
    return retry.eligible(root, SERVER, "example", context.object_read(api, "example", AC), at(seconds))


class RetryProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.clock = patch.object(retry, "now", return_value=at(0))
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.directory.cleanup()

    def test_reply_without_position_records_no_mark_and_an_operator_mark_gains_no_provenance(self):
        api = Joppa()
        api.reply_positions = False
        target = claim(api, self.root, 1)
        self.assertTrue(fail(api, target))
        receipt = release_receipt(target)
        self.assertEqual((receipt["marks"], receipt["marks_skipped"]),
                         ({}, {AC: "the confirmed reply has no assessment position"}))
        api.operator(ready=False, reason="PLANNING_FAILED")
        self.assertEqual(eligible(api, self.root, 10000), (None, "no Crew failure mark with exact provenance"))

    def retry_due(self, api):
        fail(api, claim(api, self.root, 1))
        due, reason = eligible(api, self.root, 60)
        self.assertIsNone(reason)
        return due

    def test_post_claim_read_failure_keeps_the_durable_reply_position_for_a_fenced_release(self):
        api = Joppa()
        due = self.retry_due(api)
        original = api.call
        reads = []

        def broken(name, args):
            if name == "joppa_objects" and api.batches()[-1][0]["data"].get("assignee") and not reads:
                reads.append(args)
                raise OSError("reader stopped")
            return original(name, args)
        api.call = broken
        with self.assertRaisesRegex(OSError, "reader stopped"):
            claim(api, self.root, 2, {AC: due})
        target = self.root / "2026-11-05_10-00-02-run2/artifacts"
        position = api.acs[AC]["assessment"]["position"]
        self.assertEqual(json.loads((target / "claim.json").read_text())["positions"], {AC: position})
        api.call = original
        self.assertTrue(fail(api, target))
        self.assertEqual(api.batches()[-1][1]["expected_position"], position)

    def test_retry_claim_without_reply_position_retains_the_claim_and_sends_no_unfenced_assess(self):
        api = Joppa()
        due = self.retry_due(api)
        api.reply_positions = False
        target = claim(api, self.root, 2, {AC: due})
        self.assertEqual(json.loads((target / "claim.json").read_text())["positions"], {})
        batches = len(api.batches())
        self.assertFalse(fail(api, target))
        self.assertEqual(len(api.batches()), batches)
        self.assertTrue(release_receipt(target)["skipped_claims"][0]["unknown"])
        self.assertTrue(api.acs[AC]["data"]["assignee"].startswith("crew-planning:"))

    def test_critic_rejection_and_validation_failure_never_consume_automatic_passes(self):
        cases = (("correctness critic rejected: the plan misses a case", None),
                 ("plan validation failed: Task has six steps", None),
                 ("agent did not complete successfully", object()))
        for number, (reason, critic) in enumerate(cases, 1):
            with self.subTest(reason=reason):
                api = Joppa()
                root = self.root / str(number)
                target = claim(api, root, 1)
                self.assertTrue(fail(api, target, reason=reason, critic=critic))
                mark = release_receipt(target)["marks"][AC]
                self.assertEqual((mark["retry_class"], mark["retry_after"]), (None, None))
                self.assertEqual(retry.eligible(root, SERVER, "example", context.object_read(api, "example", AC),
                                                at(10000)), (None, "failure is not retryable"))

    def test_old_receipts_stay_manual(self):
        api = Joppa()
        target = claim(api, self.root, 1)
        self.assertTrue(fail(api, target))
        receipt = release_receipt(target)
        # A mark written before the allowlist has no retry_class and must not retry.
        receipt["marks"][AC].pop("retry_class")
        (target / "release.json").write_text(json.dumps(receipt))
        self.assertEqual(eligible(api, self.root, 10000), (None, "failure is not retryable"))
        del receipt["marks"]
        (target / "release.json").write_text(json.dumps(receipt))
        self.assertEqual(eligible(api, self.root, 10000), (None, "no Crew failure mark with exact provenance"))

    def test_allowlist_matches_only_known_transient_reasons(self):
        classify = retry_rules.classify
        self.assertEqual(classify("1/2 inputs ok (min_success=2); failures: rc x1; agent did not complete successfully",
                                  "PLANNING_FAILED"), "AGENT_INCOMPLETE")
        self.assertEqual(classify("/bin/codebase-memory-mcp failed: CBM daemon is active", "PLANNING_FAILED"),
                         "CBM_UNAVAILABLE")
        self.assertEqual(classify('post hook vetoed the attempt: rc=1; stderr: "method": "initialize"',
                                  "PLANNING_FAILED"), "MCP_STARTUP")
        for reason, code in (("agent did not complete successfully", "NEEDS_HUMAN"),
                             ("agent did not complete successfully; simplicity critic rejected: scope", "PLANNING_FAILED"),
                             ("code research blocked: source has the guard", "PLANNING_FAILED"),
                             ("Joppa joppa_batch: operation 1: linked object is absent", "PLANNING_FAILED"),
                             ("'address'", "PLANNING_FAILED")):
            self.assertIsNone(classify(reason, code), reason)


if __name__ == "__main__":
    unittest.main()
