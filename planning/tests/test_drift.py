"""Drift review gating in verify_freshness on a real Git repository. No agents or Equill."""
import json
import re
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

PLANNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLANNING))
from common import digest, fingerprint
import drift
import stages
import validation


def verdict(record, affected=False, evidence=None):
    if evidence is None:
        evidence = [{"source": "docs/notes.md",
                     "reason": "Only changed file; the plan cites src/main.py, which the diff leaves unchanged"}]
    return {"drift_digest": record["digest"], "verdict": "affected" if affected else "clear",
            "summary": "Diff checked", "findings": [], "reviewer": {"harness": "codex", "model": "m"},
            "answers": {key: {"affected": affected and key == "reused_units", "evidence": evidence}
                        for key in validation.DRIFT_QUESTIONS}}


class DriftReviewTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="planning-drift-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        for name, content in (("src/main.py", "value = 1\n"), ("src/old.py", "old = 1\n"), ("docs/notes.md", "notes\n")):
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(content)
        self.git("init", "-q")
        self.commit("base")
        self.target = self.root / "run/artifacts"
        self.target.mkdir(parents=True)
        env = patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.target.parent)})
        env.start()
        self.addCleanup(env.stop)
        contract = patch.object(stages, "load_contract", side_effect=lambda role, project: {"bundle_digest": "c1"})
        contract.start()
        self.addCleanup(contract.stop)
        self.assignment = {"workspace": "w", "repositories": [{"id": "test", "path": str(self.repo), "cbm_project": "p",
                                                                "modules": [{"name": "src", "path": "src"}]}]}
        self.plan = {"tasks": [{"repository": "test", "module": "src", "write_paths": ["src/main.py"],
                                "steps": ["Change the predicate"],
                                "checks": [{"command": "python3 -m unittest", "cwd": ".", "expected": "passes"}]}],
                     "acceptance_checks": []}
        for name, value in (("plan.json", self.plan), ("contracts.json", {r: {"bundle_digest": "c1"} for r in stages.ROLES}),
                            ("snapshots.json", {"test": fingerprint(self.assignment["repositories"][0])}),
                            ("research-code.json", {"inspected_paths": [{"repository": "test", "path": "src/main.py"}]}),
                            ("research-knowledge.json", {}), ("research-external.json", {})):
            (self.target / name).write_text(json.dumps(value))

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True).stdout

    def commit(self, message):
        self.git("add", "-A")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message)

    def land(self, name="docs/notes.md", content="more notes\n"):
        (self.repo / name).write_text(content)
        self.commit("landed elsewhere")

    def request(self):
        with patch.object(stages, "emit_var") as emitted:
            with self.assertRaises(stages.DriftReview):
                stages.verify_freshness(self.assignment)
        record = json.loads((self.target / "drift.json").read_text())
        self.assertEqual(record["outcome"], "review")
        self.assertEqual({call.args[0] for call in emitted.call_args_list}, {"drift", "drift_diff", "drift_digest"})
        return record

    def assert_code_drift(self, reason):
        with patch.object(stages, "emit_var") as emitted, self.assertRaises(ValueError) as caught:
            stages.verify_freshness(self.assignment)
        self.assertEqual(str(caught.exception), stages.CODE_DRIFT)
        self.assertIn(reason, json.loads((self.target / "drift.json").read_text())["outcome"])
        return emitted

    def answer(self, record, blocked=(), evidence=None):
        for key in validation.CRITICS:
            (self.target / f"drift-{key}.json").write_text(json.dumps(verdict(record, key in blocked, evidence)))

    def test_verify_context_passes_review_false_through_to_freshness(self):
        # A critic review dict must not shadow the review flag: NOT_READY/NEEDS_HUMAN
        # publication calls verify_context(review=False) and must stay on strict CODE_DRIFT.
        for key in validation.CRITICS:
            (self.target / f"critic-{key}.json").write_text("{}")
        with patch.object(validation, "critique"), \
             patch.object(stages, "read", side_effect=lambda path: {"verdict": "clear", "summary": "ok"}), \
             patch.object(stages, "verify_freshness", return_value=({}, {})) as fresh:
            stages.verify_context(self.assignment, self.plan, review=False)
        fresh.assert_called_once_with(self.assignment, False)

    def test_unchanged_source_needs_no_review(self):
        old, _ = stages.verify_freshness(self.assignment)
        self.assertEqual(old, json.loads((self.target / "snapshots.json").read_text()))
        self.assertFalse((self.target / "drift.json").exists())

    def test_a_clean_advance_publishes_on_the_new_base_after_every_critic_clears(self):
        before = self.git("rev-parse", "HEAD").strip()
        self.land()
        record = self.request()
        repo = record["repositories"]["test"]
        self.assertEqual((repo["old_head"], repo["new_head"]), (before, self.git("rev-parse", "HEAD").strip()))
        self.assertEqual(repo["changes"], [{"status": "M", "path": "docs/notes.md"}])
        self.assertIn("+more notes", (self.target / "drift.diff").read_text())
        self.answer(record)
        base, _ = stages.verify_freshness(self.assignment)
        self.assertEqual(base, {"test": fingerprint(self.assignment["repositories"][0])})
        cleared = drift.cleared(self.target)
        self.assertEqual(sorted(cleared["verdicts"]), sorted(validation.CRITICS))
        self.assertEqual(cleared["digest"], record["digest"])

    def test_clear_verdicts_without_grounded_evidence_are_code_drift(self):
        self.land()
        record = self.request()
        for evidence, reason in (([], "no evidence for cited_paths"),
                                 ([{"source": "docs/notes.md", "reason": "Unaffected."}], "generic"),
                                 ([{"source": "docs/notes.md", "reason": "not affected"}], "generic"),
                                 ([{"source": "somewhere/else.py", "reason": "The diff does not reach this file at all"}],
                                  "neither a changed path nor a plan citation")):
            with self.subTest(reason=reason):
                (self.target / "drift.json").write_text(json.dumps({**record, "outcome": "review"}))
                self.answer(record, evidence=evidence)
                self.assert_code_drift(reason)
                self.assertIsNone(drift.cleared(self.target))

    def test_evidence_may_cite_the_plan_with_repository_and_line(self):
        self.land()
        record = self.request()
        self.answer(record, evidence=[{"source": "test:src/main.py:1",
                                       "reason": "The plan edits src/main.py; the diff changes only docs/notes.md"}])
        base, _ = stages.verify_freshness(self.assignment)
        self.assertEqual(base, record["new"])

    def test_a_dirty_tree_on_the_reviewed_base_is_code_drift(self):
        self.land()
        self.answer(self.request())
        (self.repo / "docs/notes.md").write_text("uncommitted after the review\n")
        self.assert_code_drift("uncommitted changes on the reviewed base")

    def test_every_change_kind_is_listed(self):
        (self.repo / "docs/new.md").write_text("added\n")
        (self.repo / "docs/old.md").write_text("old text\n")
        self.commit("prepare kinds")
        (self.target / "snapshots.json").write_text(json.dumps({"test": fingerprint(self.assignment["repositories"][0])}))
        (self.repo / "docs/added.md").write_text("a different addition\n")
        (self.repo / "docs/old.md").write_text("new text\n")
        self.git("rm", "-q", "docs/new.md")
        self.git("mv", "docs/notes.md", "docs/renamed.md")
        (self.repo / "docs/link").symlink_to("renamed.md")
        self.commit("kinds")
        (self.repo / "docs/link").unlink()
        (self.repo / "docs/link").write_text("now a file\n")
        self.commit("type change")
        rows = self.request()["repositories"]["test"]["changes"]
        self.assertEqual(sorted((r["status"][0], r["path"]) for r in rows),
                         [("A", "docs/added.md"), ("A", "docs/link"), ("D", "docs/new.md"),
                          ("M", "docs/old.md"), ("R", "docs/renamed.md")])

    def test_any_binary_change_is_code_drift_without_review(self):
        base = self.git("rev-parse", "HEAD").strip()
        for path in ("docs/image.bin", "src/data.bin", "web/package-lock.json"):
            with self.subTest(path=path):
                self.git("reset", "-q", "--hard", base)
                (self.target / "drift.json").unlink(missing_ok=True)
                (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
                (self.repo / path).write_bytes(b"\0binary\0" + path.encode())
                self.commit("binary " + path)
                self.assert_code_drift("binary change " + path).assert_not_called()

    def test_a_return_to_the_old_base_after_a_review_request_is_code_drift(self):
        base = self.git("rev-parse", "HEAD").strip()
        self.land()
        self.answer(self.request())
        self.git("reset", "-q", "--hard", base)
        self.assert_code_drift("moved again")
        self.assertIsNone(drift.cleared(self.target))

    def test_without_review_any_drift_is_code_drift(self):
        self.land()
        with self.assertRaisesRegex(ValueError, "^" + re.escape(stages.CODE_DRIFT) + "$"):
            stages.verify_freshness(self.assignment, review=False)
        self.assertFalse((self.target / "drift.json").exists())

    def test_a_commit_while_contracts_load_is_code_drift(self):
        once = threading.Lock()  # contracts load in parallel threads

        def landing(role, project):
            with once:
                if not (self.repo / "docs/late.md").exists():
                    (self.repo / "docs/late.md").write_text("late\n")
                    self.commit("late")
            return {"bundle_digest": "c1"}
        for reviewed in (False, True):
            with self.subTest(reviewed=reviewed):
                if reviewed:
                    self.git("rm", "-q", "docs/late.md")
                    self.commit("start again")
                    (self.target / "snapshots.json").write_text(
                        json.dumps({"test": fingerprint(self.assignment["repositories"][0])}))
                    (self.target / "drift.json").unlink(missing_ok=True)
                    self.land()
                    self.answer(self.request())
                with patch.object(stages, "load_contract", side_effect=landing), \
                     self.assertRaisesRegex(ValueError, "^" + re.escape(stages.CODE_DRIFT) + "$"):
                    stages.verify_freshness(self.assignment)
                self.assertIsNone(drift.cleared(self.target))

    def test_modules_with_the_same_name_in_two_repositories_do_not_collide(self):
        other = self.root / "other"
        (other / "src").mkdir(parents=True)
        (other / "src/tool.py").write_text("tool = 1\n")
        for args in (["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                                    "commit", "-qm", "base"]):
            subprocess.run(["git", "-C", str(other), *args], check=True, capture_output=True)
        self.assignment["repositories"].append({"id": "other", "path": str(other), "cbm_project": "q",
                                                "modules": [{"name": "src", "path": "src"}]})
        (self.target / "snapshots.json").write_text(json.dumps(
            {r["id"]: fingerprint(r) for r in self.assignment["repositories"]}))
        self.git("rm", "-q", "src/old.py")
        self.commit("remove a file in the planned module")
        self.assert_code_drift("test: D src/old.py is cited").assert_not_called()

    def test_a_type_change_is_listed(self):
        (self.repo / "docs/link").symlink_to("notes.md")
        self.commit("link")
        (self.target / "snapshots.json").write_text(json.dumps({"test": fingerprint(self.assignment["repositories"][0])}))
        (self.repo / "docs/link").unlink()
        (self.repo / "docs/link").write_text("now a file\n")
        self.commit("type change")
        self.assertEqual(self.request()["repositories"]["test"]["changes"], [{"status": "T", "path": "docs/link"}])

    def test_one_blocking_critic_is_code_drift(self):
        self.land()
        self.answer(self.request(), blocked=("simplicity",))
        self.assert_code_drift("simplicity: diff affects the plan")
        self.assertIsNone(drift.cleared(self.target))

    def test_a_missing_verdict_is_code_drift(self):
        record = (self.land(), self.request())[1]
        self.answer(record)
        (self.target / "drift-correctness.json").unlink()
        self.assert_code_drift("correctness: no drift verdict")

    def test_a_verdict_for_another_diff_or_with_extra_fields_is_code_drift(self):
        self.land()
        record = self.request()
        self.answer({"digest": "other"})
        self.assert_code_drift("different drift")
        self.answer(record)
        (self.target / "drift.json").write_text(json.dumps({**record, "outcome": "review"}))
        extra = {**verdict(record), "note": "x"}
        (self.target / "drift-necessity.json").write_text(json.dumps(extra))
        self.assert_code_drift("extra fields")

    def test_a_second_move_during_the_review_is_code_drift(self):
        self.land()
        record = self.request()
        self.answer(record)
        self.land("docs/notes.md", "again\n")
        emitted = self.assert_code_drift("moved again")
        emitted.assert_not_called()

    def test_a_diff_over_the_cap_is_code_drift_without_review(self):
        self.land("docs/large.txt", "x" * (drift.DIFF_LIMIT + 1))
        self.assert_code_drift("diff exceeds").assert_not_called()

    def test_a_cited_path_renamed_or_deleted_is_code_drift_without_review(self):
        for change in (("mv", "src/main.py", "src/entry.py"), ("rm", "-q", "src/main.py"), ("rm", "-q", "src/old.py")):
            with self.subTest(change=change):
                self.git("reset", "-q", "--hard", self.git("rev-list", "--max-parents=0", "HEAD").strip())
                (self.target / "drift.json").unlink(missing_ok=True)
                self.git(*change)
                self.commit("restructure")
                # src/old.py is cited only because the task module is src.
                self.assert_code_drift("is cited by the plan or research").assert_not_called()

    def test_a_path_named_only_in_plan_prose_counts_as_cited(self):
        self.plan["tasks"][0]["steps"] = ["Reuse the parser in docs/notes.md"]
        (self.target / "plan.json").write_text(json.dumps(self.plan))
        self.git("rm", "-q", "docs/notes.md")
        self.commit("remove notes")
        self.assert_code_drift("D docs/notes.md").assert_not_called()

    def test_an_uncited_delete_still_gets_a_review(self):
        self.git("rm", "-q", "docs/notes.md")
        self.commit("remove notes")
        self.assertEqual(self.request()["repositories"]["test"]["changes"], [{"status": "D", "path": "docs/notes.md"}])

    def test_a_dirty_tree_is_code_drift_without_review(self):
        (self.repo / "docs/notes.md").write_text("uncommitted\n")
        self.assert_code_drift("uncommitted changes").assert_not_called()
        (self.target / "drift.json").unlink()
        self.land()
        (self.repo / "untracked.txt").write_text("x\n")
        self.assert_code_drift("uncommitted changes").assert_not_called()

    def test_a_head_that_is_not_a_descendant_is_code_drift_without_review(self):
        self.land()
        self.git("checkout", "-q", "--orphan", "other")
        self.commit("unrelated history")
        self.assert_code_drift("did not advance").assert_not_called()

    def test_a_changed_contract_still_wins_over_a_reviewable_drift(self):
        self.land()
        with patch.object(stages, "load_contract", side_effect=lambda role, project: {"bundle_digest": "c2"}), \
             self.assertRaisesRegex(ValueError, "Equill contract changed"):
            stages.verify_freshness(self.assignment)
        self.assertFalse((self.target / "drift.json").exists(), "no review requested")

    def test_clean_digest_matches_fingerprint_of_a_clean_tree(self):
        self.assertTrue(drift.clean(fingerprint(self.assignment["repositories"][0])))
        (self.repo / "untracked.txt").write_text("x\n")
        self.assertFalse(drift.clean(fingerprint(self.assignment["repositories"][0])))


class DriftVerdictTests(unittest.TestCase):
    def test_strict_verdict_shape(self):
        record = {"digest": "d"}
        validation.drift(verdict(record), "d")
        good = verdict(record)["answers"]["cited_paths"]
        for broken, reason in (({"verdict": "clear", "answers": {**verdict(record)["answers"],
                                                               "cited_paths": {**good, "affected": True}}}, "disagree"),
                               ({"answers": {"cited_paths": good}}, "every question"),
                               ({"answers": {**verdict(record)["answers"], "cited_paths": {"affected": False}}}, "evidence list"),
                               ({"answers": {**verdict(record)["answers"], "cited_paths": {**good, "evidence": ["src"]}}},
                                "source and reason"),
                               ({"findings": [{"blocking": True, "claim": "c", "evidence": "e", "resolution": "r"}]}, "disagree"),
                               ({"verdict": "maybe"}, "invalid drift verdict")):
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(ValueError, reason):
                    validation.drift({**verdict(record), **broken}, "d")


if __name__ == "__main__":
    unittest.main()
