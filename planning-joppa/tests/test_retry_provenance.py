"""Exact own-mark provenance and the failure allowlist. No network."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from retry_fixture import ROOT, AC, SERVER, Joppa, at, claim, fail, release_receipt, run_folder
import context
import planning_retry as retry
import retry_marks
import retry_rules


def load_stages():
    spec = importlib.util.spec_from_file_location("joppa_stage_provenance", ROOT / "planning-joppa/stages.py")
    stage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage)
    return stage


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

    def test_retry_claim_without_reply_position_stops_prepare_before_agents_and_publication(self):
        api = Joppa()
        due = self.retry_due(api)
        api.reply_positions = False
        stage = load_stages()
        target = run_folder(self.root, 2)
        object = context.source(context.object_read(api, "example", AC))
        data = {"ac": {"id": AC}, "decisions": ["{}"], "joppa": {"objects": {AC: object}, "retry": {AC: due},
                "criteria": [{"id": AC, "revision": object["current_revision"]}]}}
        settings = {"workspace": "example", "runs_folder": str(self.root), "url": api.url}
        with patch.dict("os.environ", {"PLANNING_JOPPA_REQ": "rule:r"}), \
             patch.object(stage, "settings", return_value=settings), patch.object(stage, "reader_servers"), \
             patch.object(stage.shared, "artifacts", return_value=target), \
             patch.object(stage.context, "client", return_value=api), \
             patch.object(stage.context, "load_requirement", return_value=(data, {}, None)) as load, \
             patch.object(stage.claims, "planning_idle"), patch.object(stage.publication, "ensure_recovered"), \
             patch.object(stage, "prepare_reader") as reader, patch.object(stage.shared, "prepare_context") as agents, \
             patch.object(stage.context, "pending_work") as pending, patch.object(stage, "signal"):
            with self.assertRaisesRegex(ValueError, "no recorded assessment position .* no unfenced assess"):
                stage.prepare()
            self.assertEqual((load.call_count, reader.called, agents.called, pending.called), (1, False, False, False))
            batches = len(api.batches())
            stage.fail("prepare stopped")
        self.assertEqual(len(api.batches()), batches)
        self.assertTrue(release_receipt(target)["skipped_claims"][0]["unknown"])
        self.assertTrue(api.acs[AC]["data"]["assignee"].startswith("crew-planning:"))
        result = json.loads((target / "result.json").read_text())
        self.assertEqual((result["status"], result["needs_recovery"]), ("blocked", True))
        # The finish invariant refuses publication of a retry run without a known position.
        with self.assertRaisesRegex(ValueError, "no recorded assessment position"):
            retry_marks.required_positions(json.loads((target / "claim.json").read_text()), [AC])
        self.assertEqual(retry_marks.required_positions({"positions": {}}, [AC]), {})

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
        self.assertEqual(classify("/bin/codebase-memory-mcp failed: stderr: codebase-memory-mcp: CBM daemon is active or "
                                  "starting but could not accept this client within 30000 ms", "PLANNING_FAILED"),
                         "CBM_UNAVAILABLE")
        self.assertEqual(classify("Command '['/bin/codebase-memory-mcp', 'cli', '--json', 'list_projects']' timed out "
                                  "after 45 seconds", "PLANNING_FAILED"), "CBM_UNAVAILABLE")
        for reason in ("required executable missing: codebase-memory-mcp",
                       "/bin/codebase-memory-mcp failed: stderr: unknown project funnel7-index",
                       "/bin/codebase-memory-mcp failed: stderr: invalid arguments: --format",
                       "/bin/codebase-memory-mcp failed: stderr: permission denied: /cbm/config.json"):
            self.assertIsNone(classify(reason, "PLANNING_FAILED"), reason)
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
