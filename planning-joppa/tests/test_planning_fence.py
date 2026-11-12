"""Planning fences: exact ownership revision, saves before notes and exact hold codes. No network."""
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
from provider_fixture import assignment, hold, hold, end
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

    def test_every_note_is_fenced_by_an_earlier_save_of_the_same_target(self):
        import planning_claims
        save = {"command": {"op": "save_object", "kind": "work", "id": "t", "revision": 2, "data": {}}}
        note = {"command": {"op": "note", "target": "work:t", "id": "n", "text": "Failed"}}
        planning_claims.require_fenced([save, note])
        for operations in ([note], [note, save], [{"command": {**save["command"], "revision": 0}}, note],
                           [{"command": {**save["command"], "id": "other"}}, note]):
            with self.assertRaisesRegex(ValueError, "needs an earlier save"):
                planning_claims.require_fenced(operations)

    def test_startup_retry_clears_each_task_hold_and_matches_the_code_exactly(self):
        import reader_context
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "src").mkdir()
            data = assignment()
            data["repositories"][0]["path"] = directory
            task = data["joppa"]["tasks"][0]
            task["document"]["data"].update(body="Goal\nRepository: service\nModule: core", projects=["p"])
            hold(task, "WORKTREE_PREEXISTED")
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
                hold(task, "WORKTREE_PREEXISTED: detail")
                self.assertFalse(reader_context.retry_startup(None, config, target, data, ac, '"assess"'))
                hold(task, "WORKTREE_PREEXISTED")
                task["document"]["data"]["assignee"] = "lane-1"
                with self.assertRaisesRegex(ValueError, "claimed Tasks"):
                    reader_context.retry_startup(None, config, target, data, ac, '"assess"')
                self.assertEqual(sent, [])
                del task["document"]["data"]["assignee"]
                self.assertTrue(reader_context.retry_startup(None, config, target, data, ac, '"assess"'))
            operations = [entry["command"] for entry in sent[0]]
            self.assertEqual([(entry["op"], entry.get("target") or entry["kind"] + ":" + entry["id"]) for entry in operations],
                             [("save_object", "work:old"), ("save_object", "criterion:a")])
            # Partial saves: the Task only clears its hold. The AC releases its assignee and clears its hold.
            self.assertEqual((operations[0]["revision"], operations[0]["data"]), (3, {"hold": None}))
            self.assertEqual(operations[1]["data"], {"assignee": None, "hold": None})

    def test_detail_reads_keep_the_native_process_and_read_the_hold_from_data(self):
        from joppa_reads import normalize_detail, task_state
        process = {"annotation_address": "work:t", "verification": {"state": "pass"}, "acceptance": {"by": "owner"}}
        value = normalize_detail({"address": "work:t"}, raw("work:t", {"title": "t", "hold": "WORKTREE_PREEXISTED"},
                                                           process=deepcopy(process)))
        self.assertEqual(value["process"], process)
        self.assertEqual(task_state(value), "blocked")
        value = normalize_detail({"address": "work:t"}, raw("work:t", {"title": "t", "assignee": "lane-1"},
                                                           links=[{"target": "work:u", "relation": "depends_on", "revision": 2}]))
        self.assertEqual(task_state(value), "active")
        self.assertEqual(value["document"]["links"],
                         [{"blocking": True, "relation": "depends_on", "revision": 2, "target": "work:u"}])

    def test_parent_requirement_revision_bump_from_a_claim_keeps_the_snapshot(self):
        import context
        from joppa_reads import normalize_detail
        types = {"requirement": {"role": "requirement"}, "group": {"role": "group"}}
        before = raw("requirement:r", {"title": "R", "body": "Rule", "owner": "o"}, revision=3, parent="group:g",
                     links=[{"target": "note:n", "relation": "related"}], reason="Write the rule")
        def snapshot(value):
            return context.snapshot_source(normalize_detail({"address": "requirement:r"}, value), types, ["criterion:a"])
        # The claim saves data.assignee on a child AC. Joppa then writes the parent with the same authored fields.
        after = {**deepcopy(before), "revision": 4, "reason": "Criterion criterion:a changed: Take this criterion."}
        context.unchanged(snapshot(before), snapshot(after))
        meaning = {"number": 3, "title": "R", "body": "Rule", "reason": "Write the rule", "acs": [{"id": "criterion:a"}]}
        self.assertEqual(context.authored_meaning(meaning),
                         context.authored_meaning({**meaning, "number": 4, "reason": after["reason"]}))
        for change in (lambda value: value["data"].update(body="Changed rule"),
                       lambda value: value["relations"]["related"]["edges"].append({"to": "note:m"}),
                       lambda value: value.update(parent="group:other")):
            changed = deepcopy(after)
            change(changed)
            with self.assertRaisesRegex(ValueError, "context changed"):
                context.unchanged(snapshot(before), snapshot(changed))
        self.assertNotEqual(context.authored_meaning(meaning), context.authored_meaning({**meaning, "body": "Changed"}))

    def test_pins_accept_any_revision_through_current_and_new_links_have_no_pin(self):
        import context
        import publication
        from provider_fixture import plan
        self.assertTrue(context.current_pin(1, 4, 1))
        self.assertTrue(context.current_pin(4, 4, 1))
        self.assertFalse(context.current_pin(5, 4, 1))
        self.assertFalse(context.current_pin(0, 4, 1))
        value = plan()
        value["tasks"][0]["depends_on"] = ["work:dependency"]
        relations = publication.operations(value, assignment())[0]["command"]["relations"]
        self.assertEqual(relations, {"depends_on": {"edges": [{"to": "work:dependency"}]}})


if __name__ == "__main__":
    unittest.main()
