"""Check configured retry limits with confirmed claims and the existing native batch."""
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_configured_flow as fixtures

flow = fixtures.flow_publication
read, write = fixtures.read, fixtures.write


class FailureEscalationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ConfiguredFlowTests("runTest")
        self.addCleanup(self.fixture.doCleanups)
        with redirect_stdout(io.StringIO()):
            self.fixture.setUp()
        self.api, self.config = self.fixture.api, self.fixture.config
        self.target = self.fixture.target
        self.config["publication"]["update_kinds"].append("criterion")
        self.config["failure_escalation"] = {"after": 3, "data": {"phase": "owner_decision"}}

    def fail(self):
        flow.fail(self.api, self.config, self.target, "The tool stopped. Fix: restore the tool.")
        return read(self.target / "result.json")

    def next_run(self, name):
        self.target = self.fixture.folder / name / "artifacts"
        with patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.target.parent)}), redirect_stdout(io.StringIO()):
            fixtures.flow_stages.prepare()

    def history(self, name, **change):
        value = {"failure_scope": flow.failure_scope(self.config), "reason_code": "FLOW_FAILED",
                 "claim_released": True, "item_revisions": {"criterion:a": 5},
                 "retry_failures": {"criterion:a": 2}, **change}
        write(self.fixture.folder / name / "artifacts/result.json", value)

    def prepare_result(self, name):
        self.target = self.fixture.folder / name / "artifacts"
        with patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.target.parent)}), \
                patch.object(sys, "argv", ["flow_stages.py", "prepare"]), redirect_stdout(io.StringIO()), \
                patch.object(fixtures.flow_stages, "emit") as emit, patch.object(fixtures.flow_stages, "signal") as signal:
            code = fixtures.flow_stages.main()
        return code, emit, signal

    def test_three_refusals_preserve_the_foreign_holder_and_escalate_only_after_an_owned_claim(self):
        (self.target / "claim.json").unlink()
        selected = self.api.nodes["criterion:a"]
        selected["document"]["data"]["assignee"] = "crew-planning:another-run"
        selected["current_revision"] += 1
        selected["document"]["revision"] = selected["current_revision"]
        before, batches = deepcopy(self.api.nodes), len(self.api.batches)
        for index in range(1, 4):
            code, emit, signal = self.prepare_result("refused-" + str(index))
            self.assertEqual(code, 1)
            emit.assert_not_called()
            self.assertTrue(all(call.args[0] != "PREPARED" for call in signal.call_args_list))
            result = read(self.target / "result.json")
            self.assertEqual(result["claim_refused"], "criterion:a")
            self.assertFalse(result["claim_released"])
            self.assertEqual(result["retry_failures"], {"criterion:a": index})
            self.assertEqual(result["failure_escalated"], [])
            self.assertEqual(result["reason_code"], "FAILURE_LIMIT" if index == 3 else "CLAIM_REFUSED")
            self.assertIn("active planning run", result["reason"])
            self.assertEqual(self.api.nodes, before)
            self.assertEqual(len(self.api.batches), batches)
        selected["document"]["data"].pop("assignee")
        selected["current_revision"] += 1
        selected["document"]["revision"] = selected["current_revision"]
        code, emit, signal = self.prepare_result("free-after-limit")
        self.assertEqual(code, 1)
        emit.assert_not_called()
        self.assertTrue(all(call.args[0] != "PREPARED" for call in signal.call_args_list))
        result = read(self.target / "result.json")
        self.assertEqual(result["reason_code"], "FAILURE_LIMIT")
        self.assertTrue(result["claim_released"])
        self.assertEqual(result["failure_escalated"], ["criterion:a"])
        self.assertEqual(len(self.api.batches), batches + 2, "One own claim precedes the guarded escalation batch")
        commands = [row["command"] for row in self.api.batches[-1]["operations"]]
        self.assertEqual(commands[0]["data"], {"assignee": None, "phase": "owner_decision"})
        self.assertEqual(commands[1]["op"], "note")
        self.assertIn("refused claims", commands[1]["text"])

    def test_an_untyped_refusal_message_without_a_claim_cannot_count_or_escalate(self):
        (self.target / "claim.json").unlink()
        self.history("old-failure")
        before, batches = deepcopy(self.api.nodes), len(self.api.batches)
        flow.fail(self.api, self.config, self.target, "Requirement already has an active planning run on criterion:a")
        result = read(self.target / "result.json")
        self.assertNotIn("retry_failures", result)
        self.assertNotIn("claim_refused", result)
        self.assertEqual(self.api.nodes, before)
        self.assertEqual(len(self.api.batches), batches)

    def test_third_confirmed_failure_changes_only_configured_fields_in_the_release_batch(self):
        for index in range(1, 4):
            if index > 1:
                self.next_run("run-" + str(index))
            before = deepcopy(self.api.nodes["criterion:a"])
            result = self.fail()
            self.assertEqual(result["retry_failures"], {"criterion:a": index})
            commands = [row["command"] for row in self.api.batches[-1]["operations"]]
            self.assertEqual([command["op"] for command in commands], ["save_object", "note"])
            self.assertEqual(commands[0]["revision"], before["current_revision"])
            self.assertEqual(commands[1]["target"], "criterion:a")
            self.assertIn("restore the tool", commands[1]["text"])
            self.assertEqual(commands[0]["data"], {"assignee": None, **({"phase": "owner_decision"} if index == 3 else {})})
            self.assertEqual(result["reason_code"], "FAILURE_LIMIT" if index == 3 else "FLOW_FAILED")
        self.assertEqual(self.api.nodes["criterion:a"]["document"]["data"]["title"], before["document"]["data"]["title"])

    def test_failure_file_preserves_every_critic_finding_in_the_release_note(self):
        self.history("two-earlier-failures")
        diagnosis = ("Critic A: quote and reason. " * 70) + "\nCritic B: final quote and required correction."
        (self.target / "failure.txt").write_text(diagnosis)
        with redirect_stdout(io.StringIO()):
            fixtures.flow_stages.failure()
        commands = [row["command"] for row in self.api.batches[-1]["operations"]]
        self.assertEqual(commands[0]["reason"], diagnosis[:1000])
        self.assertEqual(commands[1]["text"], diagnosis)
        self.assertEqual(commands[0]["data"], {"assignee": None, "phase": "owner_decision"})
        self.assertEqual(read(self.target / "result.json")["reason"], diagnosis)
        self.assertIn("Critic B: final quote and required correction.", commands[1]["text"])

    def test_successful_publication_resets_the_same_item_streak(self):
        self.history("old-failure")
        write(self.target / "operations.json", {"operations": [], "outcome": {"status": "published"}})
        flow.publish(self.api, self.config, self.target)
        self.next_run("after-progress")
        self.assertEqual(self.fail()["retry_failures"], {"criterion:a": 1})

    def test_mixed_batch_keeps_each_item_streak_and_resets_only_escalated_items(self):
        self.history("mixed", reason_code="FAILURE_LIMIT", item_revisions={"criterion:a": 5, "criterion:b": 8},
                     retry_failures={"criterion:a": 3, "criterion:b": 1}, failure_escalated=["criterion:a"])
        self.assertEqual(flow.failure_counts(self.config, self.target, ["criterion:a", "criterion:b"]),
                         {"criterion:a": 1, "criterion:b": 2})

    def test_owner_change_between_reads_refuses_every_release_and_business_save(self):
        self.history("old-failure")
        def stolen_read(*args):
            node = self.api.nodes["criterion:a"]
            node["current_revision"] += 1
            node["document"]["data"]["assignee"] = "crew-planning:another-run"
            return deepcopy(node)
        with patch.object(flow, "object_read", side_effect=stolen_read), \
                self.assertRaisesRegex(ValueError, "claim changed before failed release"):
            self.fail()
        self.assertEqual(len(self.api.batches), 1)
        self.assertEqual(self.api.nodes["criterion:a"]["document"]["data"]["assignee"], "crew-planning:another-run")
        self.assertNotIn("phase", self.api.nodes["criterion:a"]["document"]["data"])

    def test_active_dry_unconfirmed_and_other_flow_results_do_not_count(self):
        changes = [{"reason_code": "ACTIVE_TASK"}, {"reason_code": "DRY_RUN"}, {"claim_released": False},
                   {"needs_recovery": True}, {"failure_scope": "another-flow"}, {"item_revisions": {"criterion:b": 5}}]
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                self.history("ignore-" + str(index), **change)
                self.assertEqual(flow.failure_counts(self.config, self.target, ["criterion:a"]), {"criterion:a": 1})

    def test_uncertain_receipt_keeps_the_claim_and_sends_no_batch(self):
        self.history("old-failure")
        receipt = read(self.target / "claim.json")
        write(self.target / "claim.json", {**receipt, "status": "uncertain"})
        result = self.fail()
        self.assertTrue(result["needs_recovery"])
        self.assertNotIn("retry_failures", result)
        self.assertEqual(len(self.api.batches), 1)

    def test_dry_run_and_no_notes_keep_release_only_behavior(self):
        for dry, notes in [(True, False), (True, True), (False, False)]:
            with self.subTest(dry=dry, notes=notes):
                config = {**self.config, "failure_notes": notes, "vars": {"DRY_RUN": str(dry).lower()}}
                self.history("old-failure")
                flow.fail(self.api, config, self.target, "Tool unavailable")
                commands = [row["command"] for row in self.api.batches[-1]["operations"]]
                self.assertEqual(commands[0]["data"], {"assignee": None})
                self.assertNotIn("retry_failures", read(self.target / "result.json"))
                self.next_run("dry-" + str(dry) + "-" + str(notes))

    def test_missing_claim_does_not_escalate_or_change_an_item(self):
        (self.target / "claim.json").unlink()
        result = self.fail()
        self.assertFalse(result["claim_released"])
        self.assertEqual(len(self.api.batches), 1)

    def test_history_reader_ignores_malformed_results_and_current_run(self):
        self.history("invalid", item_revisions=None)
        write(self.fixture.folder / "array/artifacts/result.json", [])
        write(self.target / "result.json", {"failure_scope": flow.failure_scope(self.config), "retry_failures": {"criterion:a": 100}})
        self.assertEqual(flow.failure_counts(self.config, self.target, ["criterion:a"]), {"criterion:a": 1})

    def test_escalation_configuration_requires_guarded_save_and_note_permissions(self):
        base = {**self.config, "workflow": str(fixtures.ROOT / "writer/workflow.yaml"), "mcp_command": ["connector"]}
        self.assertEqual(fixtures.flow_launch.configuration("unused", json.dumps(base)), base)
        for policy in [None, {}, {"after": True, "data": {"phase": "owner_decision"}},
                       {"after": 0, "data": {"phase": "owner_decision"}}, {"after": 3, "data": {}},
                       {"after": 3, "data": {"assignee": "someone"}}, {"after": 3, "data": {"phase": 2}}]:
            if policy is None:
                continue
            with self.subTest(policy=policy), self.assertRaisesRegex(ValueError, "failure_escalation"):
                fixtures.flow_launch.configuration("unused", json.dumps({**base, "failure_escalation": policy}))
        for key, value in [("allowed_operations", ["save_object"]), ("update_kinds", ["work"])]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "failure_escalation"):
                fixtures.flow_launch.configuration("unused", json.dumps({**base, "publication": {**base["publication"], key: value}}))


if __name__ == "__main__":
    unittest.main()
