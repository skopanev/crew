"""Failed planning holds each owned AC with assess ready:false. Success releases only. No network."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read
import publication
from provider_fixture import Fake, MARK, assignment, claim_receipt, item, raw_ac
import context


def load_stages():
    spec = importlib.util.spec_from_file_location("joppa_stage_failed_release", ROOT / "planning-joppa/stages.py")
    stage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage)
    return stage


class Server(Fake):
    """Serve live ACs as {address: (assignee, revision)} and confirm each batch."""
    def __init__(self, holders):
        super().__init__()
        self.holders = holders

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if name == "joppa_objects":
            assignee, revision = self.holders[args["address"]]
            return raw_ac(args["address"], assignee, revision)
        return {"results": [{} for _ in args["operations"]]}

    def batches(self):
        return [[entry["command"] for entry in args["operations"]] for name, args in self.calls if name == "joppa_batch"]


def shape(commands):
    return [(entry["op"], entry.get("target") or entry["kind"] + ":" + entry["id"]) for entry in commands]


class FailedReleaseTests(unittest.TestCase):
    def run_fail(self, target, api, *args):
        stage = load_stages()
        (target / "input.json").write_text(json.dumps({"ac": {"id": "criterion:a"}}))
        with patch.object(stage, "settings", return_value={"workspace": "example"}), \
             patch.object(stage.shared, "artifacts", return_value=target), \
             patch.object(stage.context, "client", return_value=api), patch.object(stage, "signal"):
            stage.fail(*args)
        return read(target / "result.json")

    def test_failure_saves_then_assesses_each_owned_criterion_not_ready_in_one_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            receipt = claim_receipt(["criterion:a", "criterion:b"])
            (target / "claim.json").write_text(json.dumps({**receipt, "revisions": {"criterion:a": 4, "criterion:b": 4}}))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            result = self.run_fail(target, api, "context reader stopped")
            [batch] = api.batches()
            self.assertEqual(shape(batch), [("save_object", "criterion:a"), ("assess", "criterion:a"),
                                            ("save_object", "criterion:b"), ("assess", "criterion:b")])
            for save, assess in (batch[0:2], batch[2:4]):
                self.assertNotIn("assignee", save["data"])
                self.assertEqual((save["revision"], save["question_checked"]), (4, "Which rule?"))
                self.assertIn("context reader stopped", save["reason"])
                self.assertEqual((assess["ready"], assess["reason"]), (False, "PLANNING_FAILED"))
            self.assertEqual((result["failure_code"], result["claim_released"], result["needs_recovery"]),
                             ("PLANNING_FAILED", True, False))
            self.assertIn("context reader stopped", result["reason"])
            self.assertEqual(read(target / "release.json")["unassessed_claims"], [])

    def test_failure_code_uses_a_leading_upper_code_or_the_generic_code(self):
        stage = load_stages()
        self.assertEqual(stage.failure_code("WORKTREE_PREEXISTED: src exists"), "WORKTREE_PREEXISTED")
        self.assertEqual(stage.failure_code("planning claim refused: X"), "PLANNING_FAILED")
        self.assertEqual(stage.failure_code("Required owner decision: o: d"), "PLANNING_FAILED")

    def test_success_release_sends_only_the_save_without_assess(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "claim.json").write_text(json.dumps(claim_receipt(["criterion:a"])))
            api = Server({"criterion:a": (MARK, 4)})
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Reviewed Task contracts are unchanged."))
            self.assertEqual([shape(batch) for batch in api.batches()], [[("save_object", "criterion:a")]])
            self.assertNotIn("unassessed_claims", read(target / "release.json"))

    def test_failure_never_assesses_a_reassigned_or_newer_criterion(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            receipt = claim_receipt(["criterion:a", "criterion:b", "criterion:c"])
            (target / "claim.json").write_text(json.dumps(receipt))
            # a: another run holds it. b: this run holds it, but another writer moved the revision. c: unchanged.
            api = Server({"criterion:a": ("crew-planning:other:run-2", 4), "criterion:b": (MARK, 6),
                          "criterion:c": (MARK, 4)})
            result = self.run_fail(target, api, "WORKTREE_PREEXISTED: src exists")
            [batch] = api.batches()
            self.assertEqual(shape(batch), [("save_object", "criterion:b"), ("save_object", "criterion:c"),
                                            ("assess", "criterion:c")])
            self.assertEqual(batch[2]["reason"], "WORKTREE_PREEXISTED")
            self.assertEqual([item["ac"] for item in result["skipped_claims"]], ["criterion:a"])
            self.assertEqual(result["unassessed_claims"],
                             [{"ac": "criterion:b", "reason": "revision 6 is not the claimed revision 4"}])

    def test_uncertain_claim_or_publication_sends_no_release_and_needs_recovery(self):
        for name, body in (("claim.json", {**claim_receipt(["criterion:a"]), "status": "uncertain"}),
                           ("publication.json", {"status": "uncertain"})):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)
                (target / "claim.json").write_text(json.dumps(claim_receipt(["criterion:a"])))
                (target / name).write_text(json.dumps(body))
                api = Server({"criterion:a": (MARK, 4)})
                result = self.run_fail(target, api, "transport failed")
                self.assertEqual(api.batches(), [])
                self.assertFalse((target / "release.json").exists())
                self.assertEqual((result["claim_released"], result["needs_recovery"]), (False, True))

    def test_claim_admission_refuses_more_criteria_than_one_failed_release_batch_fits(self):
        import planning_claims
        self.assertEqual(planning_claims.MAX_CLAIMED_CRITERIA * planning_claims.RELEASE_OPERATIONS,
                         planning_claims.MAX_BATCH)
        stage = load_stages()
        for count in (planning_claims.MAX_CLAIMED_CRITERIA + 1, planning_claims.MAX_CLAIMED_CRITERIA):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)
                data = assignment()
                criteria = [{"id": f"criterion:c{number}", "revision": 3} for number in range(count)]
                data["joppa"]["objects"].update({entry["id"]: context.source(item(entry["id"], "rule:r"))
                                                 for entry in criteria})
                class Help(Fake):
                    def call(self, name, args):
                        self.calls.append((name, deepcopy(args)))
                        if name == "joppa_help":
                            return {"operations": ["save_object", "archive_object", "assess"]}
                        raise RuntimeError("stop after the claim batch")
                api = Help()
                with patch.dict("os.environ", {"PLANNING_JOPPA_REQ": "rule:r"}), \
                     patch.object(stage, "settings", return_value={"workspace": "example", "runs_folder": directory,
                                                                    "url": "https://example.invalid/mcp"}), \
                     patch.object(stage, "reader_servers"), patch.object(stage.shared, "artifacts", return_value=target), \
                     patch.object(stage.context, "client", return_value=api), \
                     patch.object(stage.context, "load_requirement", return_value=(data, {}, None)), \
                     patch.object(stage.context, "selected_criteria", return_value=criteria), \
                     patch.object(stage.claims, "planning_idle"), patch.object(stage.publication, "ensure_recovered"):
                    error = "claim at most 50; no claim was sent" if count > 50 else "stop after the claim batch"
                    with self.assertRaisesRegex(Exception, error):
                        stage.prepare()
                batches = [args for name, args in api.calls if name == "joppa_batch"]
                if count > 50:
                    self.assertEqual((batches, (target / "claim.json").exists()), ([], False))
                else:
                    self.assertEqual(len(batches[0]["operations"]), 50)

    def test_failure_release_of_fifty_criteria_is_one_batch_of_one_hundred_operations(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            addresses = [f"criterion:c{number}" for number in range(50)]
            (target / "claim.json").write_text(json.dumps(claim_receipt(addresses)))
            api = Server({address: (MARK, 4) for address in addresses})
            result = self.run_fail(target, api, "context reader stopped")
            [batch] = api.batches()
            self.assertEqual(len(batch), 100)
            self.assertEqual(shape(batch), [pair for address in addresses
                                            for pair in (("save_object", address), ("assess", address))])
            self.assertEqual((result["unassessed_claims"], result["claim_released"]), ([], True))


if __name__ == "__main__":
    unittest.main()
