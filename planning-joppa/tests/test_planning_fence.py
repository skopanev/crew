"""Planning fences: exact ownership revision, saves before assess and exact reason codes. No network."""
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from provider_fixture import assignment
from test_generic_lifecycle import Server, raw


class PlanningFenceTests(unittest.TestCase):
    def test_owned_requires_the_exact_assignee_and_the_revision_this_run_wrote(self):
        import planning_claims
        receipt = {"status": "confirmed", "arguments": {"workspace": "example", "operations": [{"command": {
            "op": "save_object", "kind": "criterion", "id": "a", "revision": 3,
            "data": {"assignee": "crew-planning:h:run-1"}}}]},
            "result": {"results": [{"position": 1, "object": {"address": "criterion:a", "revision": 4}}]}}
        self.assertEqual(planning_claims.claimed_revisions(receipt), {"criterion:a": 4})
        for revision, assignee, error in ((4, "crew-planning:h:run-1", None),
                                          (5, "crew-planning:h:run-1", "changed after this run claimed it"),
                                          (4, "crew-planning:h:run-2", "does not hold")):
            with self.subTest(revision=revision, assignee=assignee):
                server = Server({"criterion:a": raw("criterion:a", {"title": "a", "assignee": assignee}, revision)})
                if error:
                    with self.assertRaisesRegex(ValueError, error):
                        planning_claims.owned(server, "example", receipt)
                else:
                    self.assertEqual(planning_claims.owned(server, "example", receipt),
                                     {"criterion:a": "crew-planning:h:run-1"})
        server = Server({"criterion:a": raw("criterion:a", {"title": "a", "assignee": "crew-planning:h:run-1"}, 4)})
        with self.assertRaisesRegex(ValueError, "changed after"):
            planning_claims.owned(server, "example", {**receipt, "revisions": {"criterion:a": 6}})

    def test_every_assess_is_fenced_by_an_earlier_save_of_the_same_target(self):
        import planning_claims
        save = {"command": {"op": "save_object", "kind": "work", "id": "t", "revision": 2, "data": {}}}
        assess = {"command": planning_claims.assess("work:t", "WORKTREE_PREEXISTED")}
        planning_claims.require_fenced([save, assess])
        for operations in ([assess], [assess, save], [{"command": {**save["command"], "revision": 0}}, assess],
                           [{"command": {**save["command"], "id": "other"}}, assess]):
            with self.assertRaisesRegex(ValueError, "needs an earlier save"):
                planning_claims.require_fenced(operations)

    def test_startup_retry_saves_each_task_before_its_assess_and_matches_the_code_exactly(self):
        import reader_context
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "src").mkdir()
            data = assignment()
            data["repositories"][0]["path"] = directory
            task = data["joppa"]["tasks"][0]
            task["document"]["data"].update(body="Goal\nRepository: service\nModule: core", projects=["p"])
            task["process"]["blocked"] = {"reason": "WORKTREE_PREEXISTED"}
            ac = deepcopy(data["joppa"]["objects"]["criterion:a"])
            ac["document"]["data"]["assignee"] = "crew-planning:h:run-1"
            config = {"workspace": "example", "repositories": data["repositories"]}
            sent = []
            def mutate(api, path, name, arguments, **options):
                sent.append(arguments["operations"])
                return {"results": [{} for _ in arguments["operations"]]}
            (target / "claim.json").write_text("{}")
            with patch.object(reader_context.claims, "owned"), patch.object(reader_context, "run", return_value=""), \
                 patch.object(reader_context.publication, "mutate", side_effect=mutate), \
                 patch.object(reader_context, "signal"):
                task["process"]["blocked"]["reason"] = "WORKTREE_PREEXISTED: detail"
                self.assertFalse(reader_context.retry_startup(None, config, target, data, ac, '"assess"'))
                task["process"]["blocked"]["reason"] = "WORKTREE_PREEXISTED"
                self.assertTrue(reader_context.retry_startup(None, config, target, data, ac, '"assess"'))
            operations = [entry["command"] for entry in sent[0]]
            self.assertEqual([(entry["op"], entry.get("target") or entry["kind"] + ":" + entry["id"]) for entry in operations],
                             [("save_object", "work:old"), ("assess", "work:old"),
                              ("save_object", "criterion:a"), ("assess", "criterion:a")])
            self.assertEqual((operations[0]["revision"], operations[0]["data"]), (3, task["document"]["data"]))
            self.assertNotIn("assignee", operations[2]["data"])


if __name__ == "__main__":
    unittest.main()
