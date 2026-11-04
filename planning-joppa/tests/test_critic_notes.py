"""A final critic rejection writes one bounded note on each released AC in the release batch. No network."""
import hashlib
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
import planning_claims
import validation
from provider_fixture import MARK, claim_receipt
from test_failed_release import Server, load_stages, paired, shape


PLAN = {"disposition": "implement", "tasks": [{"id": "first"}]}
EVIDENCE = "EVIDENCE-DUMP traceback log line"


def suffix(address):
    return hashlib.sha256(address.encode()).hexdigest()[:12]


def verdict(plan, verdict="reject", claims=("Claim",)):
    findings = [{"claim": claim, "evidence": EVIDENCE, "resolution": f"Fix {claim}", "blocking": True}
                for claim in claims] if verdict == "reject" else []
    return {"plan_digest": digest(plan), "verdict": verdict, "summary": f"{verdict} summary", "findings": findings}


class CriticNoteTests(unittest.TestCase):
    """A final critic rejection writes one bounded note on each released AC in the release batch."""

    def run_folder(self, directory, addresses=("criterion:a", "criterion:b"), correctness=None, simplicity=None,
                   grouped=False, run="run-7"):
        target = Path(directory) / run / "artifacts"
        target.mkdir(parents=True)
        (target / "claim.json").write_text(json.dumps(claim_receipt(list(addresses))))
        (target / "plan.json").write_text(json.dumps(PLAN))
        for key, value in (("correctness", correctness), ("simplicity", simplicity)):
            if value is not None:
                (target / f"critic-{key}.json").write_text(json.dumps(value))
        (target / "input.json").write_text(json.dumps({"ac": {"id": addresses[0]},
                                                       **({"joppa": {"scope": "requirement"}} if grouped else {})}))
        return target

    def run_main(self, target, api, error):
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
        return validation.CriticRejection("correctness critic rejected: reject summary", digest(plan))

    def notes(self, api):
        [batch] = api.batches()
        return [command for command in batch if command["op"] == "note"], batch

    def test_final_rejection_saves_assesses_and_notes_each_released_criterion(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, correctness=verdict(PLAN, claims=("A", "B", "C", "D")),
                                     simplicity=verdict(PLAN, claims=("S",)))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            result = self.run_main(target, api, self.rejection())
            notes, batch = self.notes(api)
            self.assertEqual(shape(batch), [("save_object", "criterion:a"), ("assess", "criterion:a"),
                                            ("note", "criterion:a"), ("save_object", "criterion:b"),
                                            ("assess", "criterion:b"), ("note", "criterion:b")])
            self.assertEqual([batch[1]["ready"], batch[4]["ready"]], [False, False])
            note_id = f"crew-critic-run-7-{digest(PLAN)[:12]}"
            ids = [f"{note_id}-{suffix('criterion:a')}", f"{note_id}-{suffix('criterion:b')}"]
            self.assertEqual([note["id"] for note in notes], ids)
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
            self.assertEqual(receipt["critic_notes"], ids)
            self.assertNotIn("critic_notes_dropped", receipt)
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (True, False))

    def test_one_rejecting_seat_and_one_clear_seat_give_a_bounded_note(self):
        with tempfile.TemporaryDirectory() as directory:
            long = ("x" * 900,)
            target = self.run_folder(directory, correctness=verdict(PLAN, claims=long * 3),
                                     simplicity=verdict(PLAN, "clear"))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            self.run_main(target, api, self.rejection())
            notes, _ = self.notes(api)
            self.assertEqual(len(notes), 2)
            text = notes[0]["text"]
            self.assertLessEqual(len(text), 1000)
            self.assertNotIn("simplicity", text)
            for line in text.splitlines()[2:]:
                self.assertTrue(line.startswith("- correctness critic: xxx"))
                self.assertRegex(line, r" Resolution: Fix x{40,}\.\.\.$")
                self.assertLessEqual(len(line), 280)

    def test_missing_or_malformed_or_stale_verdict_gives_no_note(self):
        cases = {"missing": None, "malformed": {"verdict": "reject"}, "not an object": ["reject"],
                 "bad finding": {**verdict(PLAN), "findings": ["text"]},
                 "other plan": verdict({"other": True}, "clear")}
        for name, simplicity in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=simplicity)
                api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
                result = self.run_main(target, api, self.rejection())
                notes, batch = self.notes(api)
                self.assertEqual(notes, [])
                self.assertTrue(paired(batch))
                receipt = read(target / "release.json")
                self.assertNotIn("critic_notes", receipt)
                self.assertRegex(receipt["critic_notes_dropped"], "^critic verdicts unusable: ")
                self.assertEqual((result["claim_released"], result["release_error"]), (True, None))

    def test_rejection_of_another_plan_digest_gives_no_note(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=verdict(PLAN, "clear"))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            self.run_main(target, api, self.rejection({"older": "plan"}))
            self.assertEqual(self.notes(api)[0], [])

    def test_other_failure_after_an_earlier_rejection_never_copies_its_findings(self):
        for error in (ValueError("context reader stopped"), RuntimeError("transport closed"),
                      ValueError("correctness critic rejected: looks like a rejection")):
            with self.subTest(error=str(error)), tempfile.TemporaryDirectory() as directory:
                target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=verdict(PLAN))
                (target / "revisions.json").write_text(json.dumps([{"plan_digest": digest(PLAN),
                                                                     "rejected": ["correctness"]}]))
                api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
                result = self.run_main(target, api, error)
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
            self.run_main(target, api, self.rejection())
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
                self.run_main(target, api, self.rejection())
                self.assertEqual(api.batches(), [])

    def test_note_id_stays_a_joppa_identifier_for_long_and_colliding_names(self):
        run = "run:" + "ab:" * 58
        addresses = ("criterion:a/b" + "z" * 300, "criterion:a-b" + "z" * 300)
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, addresses, correctness=verdict(PLAN),
                                     simplicity=verdict(PLAN, "clear"), run=run)
            api = Server({address: (MARK, 4) for address in addresses})
            self.run_main(target, api, self.rejection())
            notes, _ = self.notes(api)
            ids = [note["id"] for note in notes]
            self.assertEqual(len(set(ids)), 2)
            for note in notes:
                self.assertRegex(note["id"], r"^[-_.A-Za-z0-9]+$")
                self.assertEqual(len(note["id"].encode()), 120)
                self.assertIn(run, note["text"])
                self.assertLessEqual(len(note["text"]), 1000)

    def test_invalid_or_failed_note_releases_without_notes(self):
        for notes, reason in (({"id": "bad id!", "text": "x"}, "invalid note"), ({"id": "a" * 108, "text": "x"},
                              "invalid note"), ({"id": "ok", "text": ""}, "invalid note"),
                              ("text", "invalid note"), ({"dropped": "critic verdicts unusable: x"}, "critic verdicts")):
            with self.subTest(notes=str(notes)[:40]), tempfile.TemporaryDirectory() as directory:
                target = self.run_folder(directory)
                api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
                self.assertTrue(planning_claims.release(api, target, "example", "criterion:a", "r", "FAILED", notes))
                [batch] = api.batches()
                self.assertTrue(paired(batch))
                self.assertRegex(read(target / "release.json")["critic_notes_dropped"], "^" + reason)

    def test_note_builder_defect_still_releases_and_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.run_folder(directory, correctness=verdict(PLAN), simplicity=verdict(PLAN, "clear"))
            api = Server({"criterion:a": (MARK, 4), "criterion:b": (MARK, 4)})
            stage = load_stages()
            with patch.object(stage.critic_notes, "compose", side_effect=TypeError("defect")), \
                 patch.object(stage, "settings", return_value={"workspace": "example"}), \
                 patch.object(stage.shared, "artifacts", return_value=target), \
                 patch.object(stage.context, "client", return_value=api), patch.object(stage, "signal"):
                stage.fail("critic rejected", critic=self.rejection())
            result = read(target / "result.json")
            self.assertEqual((result["claim_released"], result["release_error"]), (True, None))
            self.assertTrue(paired(api.batches()[0]))
            self.assertEqual(read(target / "release.json")["critic_notes_dropped"],
                             "note construction failed: TypeError: defect")

    def test_note_without_an_earlier_save_is_refused(self):
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
            self.run_main(target, api, self.rejection())
            notes, _ = self.notes(api)
            self.assertEqual(notes[0]["text"], notes[1]["text"])
            self.assertIn("not this criterion alone", notes[0]["text"])
            self.assertNotIn("criterion:a", notes[0]["text"])
            self.assertNotIn("criterion:b", notes[0]["text"])

    def verify(self, simplicity, correctness):
        stage = load_stages()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for key, value in (("simplicity", simplicity), ("correctness", correctness)):
                (target / f"critic-{key}.json").write_text(json.dumps(value))
            with patch.object(stage.shared, "artifacts", return_value=target), \
                 patch.object(stage.shared, "require_necessity"):
                stage.shared.verify_context({}, PLAN, mechanisms_only=True)

    def test_verify_context_classifies_the_first_rejecting_seat_after_all_verdicts_are_valid(self):
        with self.assertRaisesRegex(validation.CriticRejection, "^correctness critic rejected") as caught:
            self.verify(verdict(PLAN, "clear"), verdict(PLAN))
        self.assertEqual(caught.exception.plan_digest, digest(PLAN))
        with self.assertRaisesRegex(validation.CriticRejection, "^simplicity critic rejected"):
            self.verify(verdict(PLAN), verdict(PLAN))
        with self.assertRaises(ValueError) as caught:
            self.verify(verdict(PLAN), {"verdict": "reject"})
        self.assertNotIsInstance(caught.exception, validation.CriticRejection)
        self.assertEqual(str(caught.exception), "critic reviewed a different plan")

if __name__ == "__main__":
    unittest.main()
