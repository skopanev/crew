"""Check scoped inputs with native relations and sequential parent revisions."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "planning-joppa"), str(ROOT / "planning")]
from common import read, write
from provider_fixture import item, merged
from test_configured_flow import Tracker
from mcp import Rejected
import flow_context
import flow_launch
import flow_publication
import flow_stages


class RelatedTracker(Tracker):
    def __init__(self):
        super().__init__()
        self.nodes.update({"check:c": item("check:c", "criterion:a"),
                           "work:consumer": item("work:consumer", "criterion:a"),
                           "work:archived": item("work:archived", "criterion:a")})
        group = {"title": "Required work", "color": "blue", "facts": {"why": "keep"},
                 "edges": [{"to": "work:t", "revision": 3, "title": "Old contract"}, {"to": "source:s"}]}
        for address in ("work:consumer", "work:archived"):
            self.nodes[address]["relations"] = {"depends_on": deepcopy(group), "custom": {"edges": []}}
        self.nodes["work:archived"]["document"]["present"] = False

    def call(self, tool, args):
        if tool == "joppa_objects" and not args.get("address"):
            nodes = list(self.nodes.values())
            if args.get("relations_of"):
                nodes = [node for node in nodes if any(edge["to"] == args["relations_of"] for edge in
                         node.get("relations", {}).get(args["relation"], {}).get("edges", []))]
            else:
                nodes = [node for node in nodes if node["document"]["present"] and
                         (not args.get("kind") or node["kind"] == args["kind"]) and
                         ("parent" not in args or node["document"]["parent"] == args["parent"]) and
                         all(node["document"]["data"].get(key) == value for key, value in args.get("data", {}).items())]
            start = int(args.get("cursor", "0")); end = start + 1
            return {"items": [{"address": node["address"], "kind": node["kind"], "revision": node["current_revision"],
                              "parent": node["document"]["parent"]} for node in nodes[start:end]],
                    **({"next_cursor": str(end)} if end < len(nodes) else {})}
        if tool != "joppa_batch":
            return super().call(tool, args)
        nodes, refs, results = deepcopy(self.nodes), {}, []
        for row in args["operations"]:
            cmd = row["command"]
            if cmd["op"] == "note":
                results.append({}); continue
            address = cmd.get("target") or cmd["kind"] + ":" + cmd["id"]
            revision = cmd["revision"]
            if isinstance(revision, dict):
                revision = refs[revision["$ref"].split("/")[0]]
            node = nodes[address]
            if not node["document"]["present"] or node["current_revision"] != revision:
                raise Rejected("stale or archived object")
            if cmd["op"] == "archive_object":
                node["document"]["present"] = False
            else:
                node["document"]["data"] = merged(node["document"]["data"], {**cmd, "data": cmd.get("data", {})})
                node.setdefault("relations", {}).update(deepcopy(cmd.get("relations", {})))
            for changed in [node, *([nodes[node["document"]["parent"]]] if node["kind"] == "work" else [])]:
                changed["current_revision"] += 1
                changed["document"]["revision"] = changed["current_revision"]
            refs[row.get("ref")] = node["current_revision"]
            results.append({"object": {"revision": node["current_revision"]}})
        self.nodes = nodes
        self.batches.append(deepcopy(args))
        return {"results": results}


class InputFixture(unittest.TestCase):
    def setUp(self):
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.target = self.folder / "run" / "artifacts"
        self.api = RelatedTracker()
        self.config = {"workspace": "example", "url": self.api.url, "runs_folder": str(self.folder),
            "workflow": str(ROOT / "writer/workflow.yaml"), "mcp_command": ["connector"], "input": 1,
            "selection": {"kind": "work", "data": {"stage": "waiting"}}, "children": {}, "references": [],
            "exclude_children": None, "related": {"limit": 10,
                "parent": {"kind": "criterion", "exclude_tags": ["hold"], "children": {"kind": "check"}, "references": ["sources"]},
                "incoming": {"kind": "work", "relation": "depends_on"}},
            "publication": {"file": "operations.json", "allowed_operations": ["save_object", "archive_object", "note"],
                "create_kinds": [], "update_kinds": ["work", "criterion"],
                "related_updates": {"parent": ["stage"], "incoming": "remove_selected_edge"}}}
        self.enterContext(patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.target.parent), "PLANNING_JOPPA_ITEM": "work:t"}))
        self.enterContext(patch.object(flow_stages, "settings", return_value=self.config))
        self.enterContext(patch.object(flow_stages, "client", return_value=self.api))
        self.enterContext(patch.object(flow_stages, "emit"))
        self.enterContext(patch.object(flow_stages, "signal"))
        flow_stages.prepare()
        self.assignment, self.claim = read(self.target / "input.json"), read(self.target / "claim.json")

    def stale(self):
        group = deepcopy(self.assignment["context"]["incoming"][0]["relations"]["depends_on"])
        group["edges"] = [edge for edge in group["edges"] if edge["to"] != "work:t"]
        return {"operations": [{"command": {"op": "save_object", "kind": "work", "id": "consumer", "revision": 3,
                    "relations": {"depends_on": group}}},
            {"command": {"op": "save_object", "kind": "criterion", "id": "a", "revision": 4, "data": {"stage": "waiting"}}},
            {"command": {"op": "archive_object", "target": "work:t", "revision": 4}}]}

    def publish(self, output):
        write(self.target / "operations.json", output)
        flow_publication.publish(self.api, self.config, self.target)


class InputTests(InputFixture):
    def test_claim_recaptures_parent_and_stale_preserves_native_metadata_atomically(self):
        self.assertEqual(self.assignment["input"], 1)
        self.assertEqual(self.assignment["context"]["parent"]["current_revision"], 4)
        self.assertEqual([node["address"] for node in self.assignment["context"]["children"]], ["check:c"])
        self.assertEqual(self.assignment["context"]["references"]["sources"][0]["address"], "source:s")
        self.assertEqual([node["address"] for node in self.assignment["context"]["incoming"]], ["work:consumer"])
        before = deepcopy(self.api.nodes)
        output = self.stale()
        self.publish(output)
        batch = self.api.batches[-1]["operations"]
        self.assertEqual(batch[0]["command"]["kind"], "criterion")
        self.assertEqual(batch[1]["ref"], "flow_release")
        self.assertEqual(self.api.nodes["work:consumer"]["relations"],
                         {**before["work:consumer"]["relations"], **output["operations"][0]["command"]["relations"]})
        self.assertEqual(self.api.nodes["work:consumer"]["document"]["data"], before["work:consumer"]["document"]["data"])
        self.assertEqual(self.api.nodes["work:archived"], before["work:archived"])
        self.assertFalse(self.api.nodes["work:t"]["document"]["present"])
        self.assertEqual(read(self.target / "result.json")["selected_revision"], 6)
        self.assertEqual(len(self.api.batches), 2)

    def test_ready_keeps_the_selected_id(self):
        self.publish({"operations": [{"command": {"op": "save_object", "kind": "work", "id": "t", "revision": 4,
                                                 "data": {"stage": "ready"}}}]})
        self.assertEqual(self.api.nodes["work:t"]["document"]["data"],
                         {"title": "Implement the rule", "stage": "ready", "custom": 7})
        self.assertEqual(read(self.target / "result.json")["selected_revision"], 5)

    def test_decision_only_adds_a_note_and_releases_the_claim(self):
        saved = deepcopy(self.api.nodes["work:t"]["document"]["data"])
        saved.pop("assignee")
        self.publish({"operations": [{"command": {"op": "note", "target": "work:t", "id": "decision", "text": "Need a decision"}}]})
        self.assertEqual(self.api.nodes["work:t"]["document"]["data"], saved)
        self.assertTrue(self.api.nodes["work:t"]["document"]["present"])
        self.assertEqual(read(self.target / "result.json")["selected_revision"], 5)

    def test_policy_refuses_parent_body_consumer_data_metadata_and_unrelated_writes(self):
        for index, changes in [(1, {"data": {"body": "wrong"}}), (0, {"data": {"stage": "wrong"}}),
                               (0, {"relations": {"depends_on": {"edges": []}}}), (0, {"id": "archived"})]:
            output = self.stale()
            output["operations"][index]["command"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.publish(output)
        output = self.stale(); output["operations"].pop()
        with self.assertRaisesRegex(ValueError, "selected archive"):
            self.publish(output)
        self.assertEqual(len(self.api.batches), 1)




    def test_dependency_replan_archives_only_the_plan_and_preserves_incoming_edges(self):
        before = deepcopy(self.api.nodes)
        reason = "plan obsolete: prerequisite archived without delivery"
        output = {"operations": [
            {"command": {"op": "save_object", "kind": "criterion", "id": "a", "revision": 4,
                         "data": {"stage": "waiting"}, "reason": reason}},
            {"command": {"op": "note", "target": "work:t", "id": "dependency-replan", "text": reason}},
            {"command": {"op": "archive_object", "target": "work:t", "revision": 4, "reason": reason}}]}
        self.publish(output)
        self.assertFalse(self.api.nodes["work:t"]["document"]["present"])
        self.assertIsNone(self.api.nodes["work:t"]["document"]["data"].get("assignee"))
        self.assertEqual(self.api.nodes["criterion:a"]["document"]["data"]["stage"], "waiting")
        for address in ("work:consumer", "work:archived", "check:c", "source:s"):
            self.assertEqual(self.api.nodes[address], before[address])
        self.assertEqual(read(self.target / "publication.json")["status"], "confirmed")
        self.assertEqual(len(self.api.batches), 2)

    def test_dependency_wait_is_an_opt_in_boolean_in_each_profile(self):
        config = {**self.config, "inputs": [{"selection": {"kind": "criterion"}},
                  {"selection": self.config["selection"], "wait_for_dependencies": True}]}
        for index, enabled in ((0, False), (1, True)):
            value = flow_launch.configuration("fixture", json.dumps(config), index)
            self.assertIs(value.get("wait_for_dependencies", False), enabled)
        for invalid in ("true", 1, None, []):
            config["inputs"][1]["wait_for_dependencies"] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "must be boolean"):
                flow_launch.configuration("fixture", json.dumps(config), 1)

    def test_changed_sources_held_nodes_and_new_present_consumers_stop_before_mutation(self):
        before = deepcopy(self.api.nodes)
        for mode in ("source", "held", "new", "archived"):
            self.api.nodes = deepcopy(before)
            if mode == "source": self.api.nodes["source:s"]["current_revision"] += 1
            if mode == "held": self.api.nodes["work:consumer"]["document"]["data"]["assignee"] = "other"
            if mode == "new": self.api.nodes["work:archived"]["document"]["present"] = True
            if mode == "archived": self.api.nodes["work:consumer"]["document"]["present"] = False
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.publish(self.stale())
        self.assertEqual(len(self.api.batches), 1)

    def test_limits_include_the_host_release(self):
        output = {"operations": [{"command": {"op": "note", "target": "work:t", "id": str(index), "text": "Decision"}}
                                 for index in range(100)]}
        with self.assertRaisesRegex(ValueError, "one native batch"):
            self.publish(output)
        self.config["related"]["limit"] = 1
        with self.assertRaisesRegex(ValueError, "context exceeds"):
            flow_context.related_context(self.api, self.config, self.assignment["selected"], self.api.schema)
        self.assertEqual(len(self.api.batches), 1)

    def test_native_revision_conflict_rolls_back_parent_save_and_claim_release(self):
        call = self.api.call
        def race(tool, args):
            if tool == "joppa_batch":
                self.api.nodes["work:consumer"]["current_revision"] += 1
            return call(tool, args)
        with patch.object(self.api, "call", side_effect=race), self.assertRaises(Rejected):
            self.publish(self.stale())
        self.assertNotIn("stage", self.api.nodes["criterion:a"]["document"]["data"])
        self.assertTrue(self.api.nodes["work:t"]["document"]["data"]["assignee"])
        self.assertTrue(self.api.nodes["work:t"]["document"]["present"])
        self.assertEqual(len(self.api.batches), 1)

    def test_profile_is_frozen_and_cannot_override_identity(self):
        config = {**self.config, "inputs": [{"selection": {"kind": "criterion"}},
                  {"selection": self.config["selection"], "references": [], "children": {}, "exclude_children": None}]}
        path = self.folder / "config.json"
        write(path, config)
        def execute(command, env, cwd, effective):
            variables = dict(value.split("=", 1) for index, value in enumerate(command) if command[index - 1] == "--var")
            self.assertEqual(read(variables["PLANNING_JOPPA_CONFIG"]), effective)
            self.assertEqual(effective["input"], 1)
            self.assertNotIn("inputs", effective)
            write(path, {"changed": True})
            self.assertEqual(flow_launch.configuration(variables["PLANNING_JOPPA_CONFIG"]), effective)
            return 0
        import flow_runtime
        with patch.dict(os.environ, {"PLANNING_JOPPA_INPUT": "1"}), patch.object(flow_launch.shutil, "which", return_value="medulla"), \
             patch.object(flow_runtime, "execute", side_effect=execute):
            self.assertEqual(flow_launch.launch(path, json.dumps(config), "work:t", False), 0)
        config["inputs"][1]["workspace"] = "foreign"
        with self.assertRaisesRegex(ValueError, "native selection profiles"):
            flow_launch.configuration(path, json.dumps(config), 1)

    def test_nonprofile_selection_uses_the_frozen_config_after_the_source_changes(self):
        config = {**self.config, 'selection': {'kind': 'work', 'data': {'repository': 'alpha'}}}
        path = self.folder / 'config.json'
        write(path, config)
        def execute(command, env, cwd, effective):
            variables = dict(value.split('=', 1) for index, value in enumerate(command) if command[index - 1] == '--var')
            write(path, {**config, 'selection': {'kind': 'work', 'data': {'repository': 'beta'}}})
            self.assertEqual(variables['PLANNING_JOPPA_CONFIG'], variables['PLANNING_JOPPA_CONFIG_SNAPSHOT'])
            self.assertEqual(flow_launch.configuration(variables['PLANNING_JOPPA_CONFIG']), effective)
            self.assertEqual(effective['selection']['data'], {'repository': 'alpha'})
            return 0
        import flow_runtime
        with patch.object(flow_launch.shutil, 'which', return_value='medulla'), \
                patch.object(flow_runtime, 'execute', side_effect=execute):
            self.assertEqual(flow_launch.launch(path, json.dumps(config), 'work:t', False), 0)
