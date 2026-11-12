"""Planning on generic Joppa nodes: data.assignee claims, data.hold and archive. No network."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
import context
from joppa_reads import normalize_detail, task_state
from mcp import Rejected
import publication

from provider_fixture import item, assignment, plan, hold, end

REMOVED = ("joppa_tasks", "claim_task", "claim_next_task", "release_task", "block_task", "unblock_task",
           "complete_task", "review_task", "retire_task", "claim_planning", "finish_planning", "release_planning",
           "set_priority", "decide_note")


def stage_module():
    spec = importlib.util.spec_from_file_location("joppa_stage_lifecycle", ROOT / "planning-joppa/stages.py")
    stage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage)
    return stage


def raw(address, data, revision=4, parent="rule:r", links=(), **extra):
    """A live detail read. Local edges arrive in relations, not links."""
    relations = {}
    for link in links:
        edge = {"to": link["target"], **({"revision": link["revision"]} if link.get("revision") is not None else {})}
        relations.setdefault(link.get("relation", "related"), {"edges": []})["edges"].append(edge)
    return {"address": address, "data": data, "revision": revision, "parent": parent,
            **({"relations": relations} if relations else {}), **extra}


class Server:
    """Record every call. Serve raw detail reads and refuse a stale batch on request."""
    def __init__(self, objects, stale=False):
        self.objects, self.stale, self.calls = objects, stale, []

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if name == "joppa_help":
            return {"ops": ["save_object", "archive_object", "note"]}
        if name == "joppa_objects":
            return deepcopy(self.objects[args["address"]])
        if name == "joppa_batch":
            if self.stale:
                raise Rejected("Joppa joppa_batch: stale object revision; read the object again")
            return {"results": [{"position": index} for index, _ in enumerate(args["operations"])]}
        raise AssertionError(name)


class GenericLifecycleTests(unittest.TestCase):
    def claim_input(self):
        data = assignment()
        data["ac"]["revision"] = 3
        data["joppa"]["questions"] = {"criterion": "Which rule?"}
        data["joppa"]["objects"]["criterion:a"]["document"]["data"]["custom"] = {"keep": [1, 2]}
        return data

    def prepare(self, server, data, directory):
        stage = stage_module()
        target = Path(directory) / "run-7" / "artifacts"
        with patch.dict(os.environ, {"PLANNING_JOPPA_AC": "criterion:a"}, clear=False), \
             patch.object(stage, "settings", return_value={"workspace": "example", "runs_folder": directory, "url": "https://example.invalid/mcp"}), \
             patch.object(stage, "reader_servers"), patch.object(stage.context, "client", return_value=server), \
             patch.object(stage.context, "load", return_value=(data, {}, data["joppa"]["objects"]["criterion:a"])), \
             patch.object(stage.claims, "planning_idle"), patch.object(stage.publication, "ensure_recovered"), \
             patch.object(stage, "retry_startup", return_value=True), \
             patch.object(stage.shared, "artifacts", return_value=target):
            stage.prepare()
        return stage, target

    def test_claim_batch_saves_only_the_assignee_at_read_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            data = self.claim_input()
            mark = stage_module().claims.marker(Path(directory) / "run-7" / "artifacts")
            self.assertRegex(mark, r"^crew-planning:[^:]+:run-7$")
            server = Server({"criterion:a": raw("criterion:a", {"title": "criterion:a", "assignee": mark})})
            self.prepare(server, data, directory)
            batches = [args for name, args in server.calls if name == "joppa_batch"]
            self.assertEqual(len(batches), 1)
            self.assertEqual([entry["command"] for entry in batches[0]["operations"]], [{
                "op": "save_object", "kind": "criterion", "id": "a", "revision": 3,
                "data": {"assignee": mark}, "reason": "Take this criterion for Crew planning."}])
            self.assertFalse(any(name in json.dumps(server.calls) for name in REMOVED))

    def test_stale_claim_fails_the_batch_and_stops_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            server = Server({"criterion:a": raw("criterion:a", {"title": "a", "assignee": "crew-planning:x:run-1"})},
                            stale=True)
            with self.assertRaisesRegex(ValueError, r"planning claim refused: .*stale.*crew-planning:x:run-1"):
                self.prepare(server, self.claim_input(), directory)
            self.assertEqual([name for name, _ in server.calls], ["joppa_help", "joppa_batch", "joppa_objects"])
            receipt = json.loads((Path(directory) / "run-7/artifacts/claim.json").read_text())
            self.assertEqual(receipt["status"], "rejected")

    def test_occupied_criterion_is_never_claimed(self):
        data = self.claim_input()
        data["joppa"]["objects"]["criterion:a"]["document"]["data"]["assignee"] = "someone"
        import planning_claims
        with self.assertRaisesRegex(ValueError, "active planning run on criterion:a"):
            planning_claims.claim_operations(data, [data["ac"]], "crew-planning:h:r")

    def test_ownership_mismatch_refuses_publication(self):
        stage = stage_module()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            data, value = assignment(), plan()
            receipt = {"status": "confirmed", "arguments": {"workspace": "example", "operations": [{"command": {
                "op": "save_object", "kind": "criterion", "id": "a", "revision": 3,
                "data": {"assignee": "crew-planning:h:run-1"}}}]},
                "result": {"results": [{"position": 1}]}}
            for name, body in {"input": data, "plan": value, "joppa-snapshot": {}, "claim": receipt}.items():
                (target / f"{name}.json").write_text(json.dumps(body))
            server = Server({"criterion:a": raw("criterion:a", {"title": "a", "assignee": "crew-planning:h:run-2"})})
            with patch.object(stage, "settings", return_value={"workspace": "example"}), \
                 patch.object(stage.shared, "artifacts", return_value=target), \
                 patch.object(stage.shared, "verify_context", return_value=({}, {}, {})), \
                 patch.object(stage.context, "client", return_value=server), \
                 patch.object(stage.context, "read_assignment", return_value=data), \
                 patch.object(stage.context, "load", return_value=(data, {}, None)), \
                 patch.object(stage.context, "refresh_reads"):
                with self.assertRaisesRegex(ValueError, "does not hold the planning claim criterion:a"):
                    stage.finish()
            self.assertNotIn("joppa_batch", [name for name, _ in server.calls])

    def test_finish_batch_clears_assignee_and_hold_and_unblocks_revised_tasks(self):
        data, value = assignment(), plan()
        data["joppa"]["objects"]["criterion:a"]["document"]["data"]["assignee"] = "crew-planning:h:run-1"
        task = value["tasks"][0]
        task.update(action="update", target="work:old", revision=3)
        hold(data["joppa"]["tasks"][0], "Lane failed")
        operations = publication.operations(value, data)
        self.assertEqual([entry["command"]["op"] for entry in operations], ["save_object", "save_object"])
        # The revised contract save clears the Task hold. An update sends only changed fields, null removes one.
        task_save = operations[0]["command"]
        self.assertEqual((task_save["id"], task_save.get("clean")), ("old", None))
        self.assertIsNone(task_save["data"]["hold"])
        release = operations[1]["command"]
        self.assertEqual((release["kind"], release["id"], release["revision"]), ("criterion", "a", 3))
        self.assertEqual(release["data"], {"assignee": None, "hold": None})
        self.assertFalse(any(name in json.dumps(operations) for name in REMOVED))

    def test_retire_archives_without_commit(self):
        data, value = assignment(), plan()
        hold(data["joppa"]["tasks"][0], "Lane failed")
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        command = publication.operations(value, data)[0]["command"]
        self.assertEqual(command, {"op": "archive_object", "target": "work:old", "revision": 3,
                                   "reason": value["tasks"][0]["outcome"]})

    def test_task_detail_classifies_blocked_active_done_and_retired(self):
        def state(**extra):
            data = {"title": "t", **extra.pop("data", {})}
            return task_state(normalize_detail({"address": "work:t"}, raw("work:t", data, **extra)))
        self.assertEqual(state(), "open")
        self.assertEqual(state(data={"assignee": "lane-1"}), "active")
        self.assertEqual(state(data={"hold": "WORKTREE_PREEXISTED"}), "blocked")
        self.assertEqual(state(data={"hold": None}), "open")
        self.assertEqual(state(data={"commit": "a" * 40}, present=False), "done")
        self.assertEqual(state(present=False), "retired")
        self.assertEqual(state(data={"archived": True}), "open")

    def test_task_list_paginates_and_reports_unfinished_states(self):
        data = assignment()
        fields = publication.contract_fields(plan()["tasks"][0])
        rows = [{"address": f"work:t{index}", "data.projects": ["p"] if index != 3 else ["elsewhere"]} for index in range(5)]
        details = {"work:t0": raw("work:t0", {"title": "Open", **fields}),
                   "work:t1": raw("work:t1", {"title": "Mine", "assignee": "lane-1", **fields}),
                   "work:t2": raw("work:t2", {"title": "Held", "hold": "LANE_FAILED", **fields}),
                   "work:t4": raw("work:t4", {"title": "Landed", "commit": "b" * 40, **fields}, present=False)}
        calls = []
        class Lists:
            def call(self, name, args):
                calls.append((name, deepcopy(args)))
                if args.get("address"):
                    return deepcopy(details[args["address"]])
                start = int(args.get("cursor", 0))
                page = {"items": rows[start:start + 2], "total": len(rows)}
                if start + 2 < len(rows):
                    page["next_cursor"] = str(start + 2)
                return page
        config = {"workspace": "example", "repositories": data["repositories"]}
        result = context.pending_work(Lists(), config, data)
        self.assertEqual([(entry["address"], entry["status"]) for entry in result],
                         [("work:t0", "open"), ("work:t1", "active"), ("work:t2", "blocked")])
        self.assertEqual(result[0]["repository"], "service")
        lists = [args for name, args in calls if not args.get("address")]
        self.assertEqual([args.get("cursor") for args in lists], [None, "2", "4"])
        self.assertTrue(all(args["kind"] == "work" and args["parent"] == "*" and args["limit"] == 25
                            and "assignee" not in args and "review_required" not in args["fields"] for args in lists))
        self.assertEqual({name for name, _ in calls}, {"joppa_objects"})

    def test_digest_ignores_assignee_and_commit_but_not_other_fields(self):
        types = {"criterion": {"role": "ac"}, "work": {"role": "task"}}
        for address, selected in (("criterion:a", ["criterion:a"]), ("work:t", None)):
            with self.subTest(address=address):
                old = item(address)
                current = deepcopy(old)
                current["document"]["data"].update(assignee="crew-planning:h:r", commit="c" * 40)
                current["current_revision"] = current["document"]["revision"] = 9
                context.unchanged(context.snapshot_source(old, types, selected),
                                  context.snapshot_source(current, types, selected))
                for key, value in (("title", "Changed"), ("owner", "other"), ("projects", ["x"]), ("module", "m")):
                    changed = deepcopy(current)
                    changed["document"]["data"][key] = value
                    with self.assertRaisesRegex(ValueError, "context changed"):
                        context.unchanged(context.snapshot_source(old, types, selected),
                                          context.snapshot_source(changed, types, selected))

    def test_planner_code_names_no_removed_operation(self):
        for path in sorted((ROOT / "planning-joppa").glob("*.py")):
            text = path.read_text()
            for name in REMOVED:
                self.assertIsNone(re.search(r"\b" + name + r"\b", text), f"{path.name} uses {name}")


if __name__ == "__main__":
    unittest.main()
