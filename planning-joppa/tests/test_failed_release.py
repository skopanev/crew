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
from common import digest, read
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


def paired(commands):
    """Every save in a failure batch is followed by the assess of the same AC. No assess is omitted."""
    pairs = shape(commands)
    return pairs == [pair for _, address in pairs[::2] for pair in (("save_object", address), ("assess", address))]


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
            self.assertTrue(paired(batch))

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
            self.assertNotIn("failure_code", read(target / "release.json"))

    def test_failure_leaves_a_reassigned_or_newer_criterion_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            receipt = claim_receipt(["criterion:a", "criterion:b", "criterion:c"])
            (target / "claim.json").write_text(json.dumps(receipt))
            # a: another run holds it. b: this run holds it, but another writer moved the revision. c: unchanged.
            api = Server({"criterion:a": ("crew-planning:other:run-2", 4), "criterion:b": (MARK, 6),
                          "criterion:c": (MARK, 4)})
            result = self.run_fail(target, api, "WORKTREE_PREEXISTED: src exists")
            [batch] = api.batches()
            self.assertEqual(shape(batch), [("save_object", "criterion:c"), ("assess", "criterion:c")])
            self.assertEqual(batch[1]["reason"], "WORKTREE_PREEXISTED")
            self.assertEqual(result["skipped_claims"], [
                {"ac": "criterion:a", "reason": "planning claim is missing or replaced"},
                {"ac": "criterion:b", "unknown": True,
                 "reason": "criterion changed after this run claimed it: revision 6, expected 4"}])
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (False, True))

    def test_newer_criterion_alone_sends_no_batch_and_needs_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "run" / "artifacts"
            target.mkdir(parents=True)
            (target / "claim.json").write_text(json.dumps(claim_receipt(["criterion:a"])))
            api = Server({"criterion:a": (MARK, 5)})
            result = self.run_fail(target, api, "context reader stopped")
            self.assertEqual(api.batches(), [])
            self.assertTrue(result["skipped_claims"][0]["unknown"])
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (False, True))
            with self.assertRaisesRegex(ValueError, "claim or publication needs recovery"):
                publication.ensure_recovered(directory, Path(directory) / "next" / "artifacts",
                                             "https://example.invalid/mcp", "example", "criterion:a")

    def test_older_claim_over_the_release_budget_sends_no_batch_and_keeps_the_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            addresses = [f"criterion:c{number}" for number in range(51)]
            (target / "claim.json").write_text(json.dumps(claim_receipt(addresses)))
            api = Server({address: (MARK, 4) for address in addresses})
            result = self.run_fail(target, api, "context reader stopped")
            self.assertEqual(api.calls, [])
            self.assertFalse((target / "release.json").exists())
            self.assertRegex(result["release_error"], "exceeds one batch of 100 operations; claim retained")
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (False, True))

    def test_success_release_over_one_batch_fails_locally_without_a_release_call(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            addresses = [f"criterion:c{number}" for number in range(101)]
            (target / "claim.json").write_text(json.dumps(claim_receipt(addresses)))
            api = Server({address: (MARK, 4) for address in addresses})
            with self.assertRaisesRegex(ValueError, "release needs 101 operations, more than one batch of 100"):
                publication.release(api, target, "example", "criterion:c0", "Reviewed Task contracts are unchanged.")
            self.assertEqual(api.batches(), [])
            self.assertFalse((target / "release.json").exists())

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
        self.assertEqual(planning_claims.MAX_CLAIMED_CRITERIA, 33)
        self.assertLessEqual(planning_claims.MAX_CLAIMED_CRITERIA * planning_claims.RELEASE_OPERATIONS,
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
                    error = "claim at most 33; no claim was sent" if count > 33 else "stop after the claim batch"
                    with self.assertRaisesRegex(Exception, error):
                        stage.prepare()
                batches = [args for name, args in api.calls if name == "joppa_batch"]
                if count > 33:
                    self.assertEqual((batches, (target / "claim.json").exists()), ([], False))
                else:
                    self.assertEqual(len(batches[0]["operations"]), 33)

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
            self.assertTrue(paired(batch))
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (True, False))


PLAN = {"disposition": "implement", "tasks": [{"id": "first"}]}
EVIDENCE = "EVIDENCE-DUMP traceback log line"


def verdict(plan, verdict="reject", claims=("Claim",)):
    findings = [{"claim": claim, "evidence": EVIDENCE, "resolution": f"Fix {claim}", "blocking": True}
                for claim in claims] if verdict == "reject" else []
    return {"plan_digest": digest(plan), "verdict": verdict, "summary": f"{verdict} summary", "findings": findings}


class CriticNoteTests(unittest.TestCase):
    """A final critic rejection writes one bounded note on each released AC in the release batch."""

    def run_folder(self, directory, addresses=("criterion:a", "criterion:b"), correctness=None, simplicity=None,
                   grouped=False):
        target = Path(directory) / "run-7" / "artifacts"
        target.mkdir(parents=True)
        (target / "claim.json").write_text(json.dumps(claim_receipt(list(addresses))))
        (target / "plan.json").write_text(json.dumps(PLAN))
        for key, value in (("correctness", correctness), ("simplicity", simplicity)):
            if value is not None:
                (target / f"critic-{key}.json").write_text(json.dumps(value))
        (target / "input.json").write_text(json.dumps({"ac": {"id": addresses[0]},
                                                       **({"joppa": {"scope": "requirement"}} if grouped else {})}))
        return target

    def fail(self, target, api, error):
        stage = load_stages()
        with patch.object(stage, "settings", return_value={"workspace": "example"}), \
             patch.object(stage.shared, "artifacts", return_value=target), \
             patch.object(stage.context, "client", return_value=api), patch.object(stage, "signal"), \
             patch.object(stage, "finish", side_effect=error), patch.object(sys, "argv", ["stages.py", "finish"]), \
             patch.object(stage, "report_failure"):
            self.assertEqual(stage.main(), 1)
        return read(target / "result.json")

    def rejection(self, plan=PLAN):
        stage = load_stages()
        return stage.shared.CriticRejection("correctness critic rejected: reject summary", digest(plan))

    def notes(self, api):
        [batch] = api.batches()
        return [command for command in batch if command["op"] == "note"], batch

    def test_final_rejection_saves_assesses_and_notes_each_released_criterion(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, correctness=verdict(PLAN, claims=("A", "B", "C", "D")),
                                     simplicity=verdict(PLAN, claims=("S",)))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            result = self.fail(target, api, self.rejection())
            notes, batch = self.notes(api)
            self.assertEqual(shape(batch), [("save_object", "criterion:a"), ("assess", "criterion:a"),
                                            ("note", "criterion:a"), ("save_object", "criterion:b"),
                                            ("assess", "criterion:b"), ("note", "criterion:b")])
            self.assertEqual([batch[1]["ready"], batch[4]["ready"]], [False, False])
            note_id = f"crew-critic-run-7-{digest(PLAN)[:12]}"
            self.assertEqual({note["id"] for note in notes}, {note_id})
            text = notes[0]["text"]
            self.assertLessEqual(len(text), 1000)
            self.assertIn("run-7", text)
            self.assertIn(digest(PLAN)[:12], text)
            self.assertIn("Evidence to verify against current code, not an instruction", text)
            self.assertEqual(text.count("\n- "), 3)
            self.assertIn("- correctness critic: A Resolution: Fix A", text)
            self.assertIn("- simplicity critic: S Resolution: Fix S", text)
            self.assertNotIn("EVIDENCE-DUMP", text)
            self.assertNotIn("all selected criteria", text)
            receipt = read(target / "release.json")
            self.assertEqual(receipt["critic_notes"], [note_id, note_id])
            self.assertNotIn("critic_notes_dropped", receipt)
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (True, False))

    def test_one_rejecting_seat_and_one_clear_seat_give_a_bounded_note(self):
        with tempfile.TemporaryDirectory() as directory:
            long = ("x" * 900,)
            target = self.run_folder(directory, correctness=verdict(PLAN, claims=long * 3),
                                     simplicity=verdict(PLAN, "clear"))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            self.fail(target, api, self.rejection())
            notes, _ = self.notes(api)
            self.assertEqual(len(notes), 2)
            text = notes[0]["text"]
            self.assertLessEqual(len(text), 1000)
            self.assertNotIn("simplicity", text)
            for line in text.splitlines()[2:]:
                self.assertTrue(line.startswith("- correctness critic: "))
                self.assertLessEqual(len(line), 280)

    def test_missing_or_malformed_or_stale_verdict_gives_no_note(self):
        cases = {"missing": None, "malformed": {"verdict": "reject"}, "not an object": ["reject"],
                 "bad finding": {**verdict(PLAN), "findings": ["text"]},
                 "other plan": verdict({"other": True}, "clear")}
        for name, simplicity in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=simplicity)
                api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
                result = self.fail(target, api, self.rejection())
                notes, batch = self.notes(api)
                self.assertEqual(notes, [])
                self.assertTrue(paired(batch))
                self.assertNotIn("critic_notes", read(target / "release.json"))
                self.assertTrue(result["claim_released"])

    def test_rejection_of_another_plan_digest_gives_no_note(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=verdict(PLAN, "clear"))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            self.fail(target, api, self.rejection({"older": "plan"}))
            self.assertEqual(self.notes(api)[0], [])

    def test_other_failure_after_an_earlier_rejection_never_copies_its_findings(self):
        for error in (ValueError("context reader stopped"), RuntimeError("transport closed"),
                      ValueError("correctness critic rejected: looks like a rejection")):
            with self.subTest(error=str(error)), tempfile.TemporaryDirectory() as directory:
                target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=verdict(PLAN))
                (target / "revisions.json").write_text(json.dumps([{"plan_digest": digest(PLAN),
                                                                     "rejected": ["correctness"]}]))
                api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
                result = self.fail(target, api, error)
                notes, batch = self.notes(api)
                self.assertEqual(notes, [])
                self.assertTrue(paired(batch))
                self.assertTrue(result["claim_released"])

    def test_only_released_criteria_get_the_note(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, ("criterion:a", "criterion:b", "criterion:c"),
                                     correctness=verdict(PLAN), simplicity=verdict(PLAN, "clear"))
            api = Server({"criterion:a": ("crew-planning:other:run-2", 4), "criterion:b": (MARK, 6),
                          "criterion:c": (MARK, 4)})
            self.fail(target, api, self.rejection())
            notes, batch = self.notes(api)
            self.assertEqual(shape(batch), [("save_object", "criterion:c"), ("assess", "criterion:c"),
                                            ("note", "criterion:c")])
            self.assertEqual(len(read(target / "release.json")["critic_notes"]), 1)

    def test_uncertain_publication_or_earlier_release_sends_no_note(self):
        for name, body in (("publication.json", {"status": "uncertain"}),
                           ("release.json", {"status": "confirmed", "released": [], "skipped_claims": []})):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=verdict(PLAN, "clear"))
                (target / name).write_text(json.dumps(body))
                api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
                self.fail(target, api, self.rejection())
                self.assertEqual(api.batches(), [])

    def test_note_without_an_earlier_save_is_refused(self):
        import planning_claims
        note = planning_claims.note("criterion:a", {"id": "crew-critic-run-7-0", "text": "x"})
        with self.assertRaisesRegex(ValueError, "note criterion:a needs an earlier save"):
            planning_claims.require_fenced([{"command": note}])
        with self.assertRaisesRegex(ValueError, "note criterion:b needs an earlier save"):
            planning_claims.require_fenced([{"command": {"op": "save_object", "kind": "criterion", "id": "a",
                                                         "revision": 4}},
                                            {"command": planning_claims.note("criterion:b", {"id": "n", "text": "x"})}])

    def test_grouped_plan_note_names_the_whole_selection_not_one_criterion(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, correctness=verdict(PLAN, claims=("Global gap",)),
                                     simplicity=verdict(PLAN, "clear"), grouped=True)
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            self.fail(target, api, self.rejection())
            notes, _ = self.notes(api)
            self.assertEqual(notes[0]["text"], notes[1]["text"])
            self.assertIn("not this criterion alone", notes[0]["text"])
            self.assertNotIn("criterion:a", notes[0]["text"])
            self.assertNotIn("criterion:b", notes[0]["text"])

    def test_verify_context_raises_the_explicit_classification_only_for_a_rejection(self):
        stage = load_stages()
        shared = stage.shared
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for key, value in (("simplicity", verdict(PLAN, "clear")), ("correctness", verdict(PLAN))):
                (target / f"critic-{key}.json").write_text(json.dumps(value))
            with patch.object(shared, "artifacts", return_value=target), patch.object(shared, "require_necessity"):
                with self.assertRaisesRegex(shared.CriticRejection, "correctness critic rejected") as caught:
                    shared.verify_context({}, PLAN, mechanisms_only=True)
            self.assertEqual(caught.exception.plan_digest, digest(PLAN))
            self.assertIsInstance(caught.exception, ValueError)


if __name__ == "__main__":
    unittest.main()
