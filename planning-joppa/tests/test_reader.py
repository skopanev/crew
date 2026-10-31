"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
from common import read
import context
from mcp import MCPError, Rejected, Reader, Joppa
import publication


from provider_fixture import item, assignment, plan, Fake


class ProviderTests(unittest.TestCase):
    def test_current_api_keeps_all_requirement_children_decisions_and_tasks(self):
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"},
                 "decision": {"role": "document", "inbox": True}, "project": {"role": "document"},
                 "work": {"role": "task", "parents": ["criterion"], "question": "What work?",
                          "references": {"projects": {"multiple": True, "target": "project"}}}}
        objects = {"rule:r": item("rule:r"), "project:p": item("project:p")}
        for number in range(27):
            for kind, parent in (("criterion", "rule:r"), ("work", "criterion:c00"), ("decision", None)):
                address = f"{kind}:c{number:02}"
                objects[address] = item(address, parent)
                if kind == "decision":
                    objects[address]["document"]["data"]["body"] = "Approved decision. " * 40
        calls = []
        class Server(Joppa):
            def __init__(self):
                pass

            def raw_call(self, name, args):
                calls.append((name, deepcopy(args)))
                if name == "joppa_tree":
                    return {"schema": {"types": types}}
                if name == "joppa_tests":
                    return {"status": "grey", "values": {"asset": {"server": {"status": "grey"}}}}
                if name != "joppa_objects":
                    raise AssertionError("Unsupported tool: " + name)
                if args.get("address"):
                    obj = deepcopy(objects[args["address"]])
                    doc = obj["document"]
                    return {"revision": doc["revision"], "data": doc["data"], "parent": doc["parent"],
                            "links": doc["links"], **({"process": obj["process"]} if obj["process"] else {})}
                rows = [obj for obj in objects.values() if
                        (obj["kind"] == "decision" if args.get("related_to") else obj["document"]["parent"] == args["parent"])
                        and (not args.get("kind") or obj["kind"] == args["kind"])]
                rows.sort(key=lambda obj: obj["address"])
                if args.get("cursor"):
                    rows = [obj for obj in rows if obj["address"] > args["cursor"]]
                page = rows[:25]
                return {"items": [{"address": obj["address"], **{key: obj.get(key, True if key == "present" else None)
                         for key in args["fields"]}} for obj in page],
                        **({"next_cursor": page[-1]["address"]} if len(rows) > 25 else {})}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        value, snapshot, _ = context.load(Server(), config, "criterion:c00")
        self.assertEqual(len(value["joppa"]["tasks"]), 27)
        self.assertEqual(len(snapshot["requirement"]["acs"]), 27)
        self.assertEqual(len(snapshot["requirement"]["sources"]["notes"]), 27)
        decision = snapshot["objects"]["decision:c26"]
        self.assertEqual(decision["document"]["data"]["body"], objects["decision:c26"]["document"]["data"]["body"])
        self.assertTrue(any(args.get("cursor") for name, args in calls))
        objects["decision:c26"]["document"]["data"]["body"] = "Changed approval"
        _, changed, _ = context.load(Server(), config, "criterion:c00")
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(snapshot, changed)

    def test_agent_lists_are_bounded_and_do_not_enable_verbose_reads(self):
        api = Fake(result={'items': []})
        reader = Reader(api, 'example', None)
        reader.call('joppa_objects', {'parent': '*', 'limit': 100, 'verbose': True})
        args = api.calls[-1][1]
        self.assertEqual(args['limit'], 25)
        self.assertEqual(args['fields'], ['title', 'status'])
        self.assertNotIn('verbose', args)
        for limit in (0, -1, '25', True):
            with self.assertRaisesRegex(MCPError, 'positive integer'):
                reader.call('joppa_tasks', {'limit': limit})

    def test_compact_detail_capture_refuses_a_changed_document_or_revision(self):
        for drift in ('document', 'current_revision'):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                compact = item('work:a')
                compact.update(position=3, comments={'items': [], 'total': 0})
                full = deepcopy(compact)
                if drift == 'document':
                    full['document']['data']['title'] = 'Changed'
                else:
                    full['current_revision'] = 4
                class Server(Fake):
                    def raw_call(self, name, args):
                        return deepcopy(compact)
                api = Server(result=full)
                reader = Reader(api, 'example', Path(directory))
                with self.assertRaisesRegex(MCPError, 'changed before its planning snapshot'):
                    reader.call('joppa_objects', {'address': 'work:a'})
                self.assertFalse((Path(directory) / 'joppa-snapshot.json').exists())

    def test_unrelated_workspace_write_does_not_invalidate_an_agent_read(self):
        compact = item('work:a')
        compact.update(position=3, comments={'items': [], 'total': 0})
        full = deepcopy(compact)
        full['position'] = 4
        class Server(Fake):
            def raw_call(self, name, args):
                return deepcopy(compact)
        reader = Reader(Server(result=full), 'example', Path('/unused'))
        with patch.object(context, 'capture_object') as capture:
            self.assertEqual(reader.call('joppa_objects', {'address': 'work:a'}), compact)
            capture.assert_called_once()
        historical = context.complete_object(lambda *args: None, {'revision': 2}, item('work:a'))
        self.assertNotIn('contract_revision', historical)

    def test_remote_reader_keeps_namespace_schema_and_freshness(self):
        local = item("criterion:a")
        local["workspace_key"] = "ws-local"
        local["remote_links"] = [{"workspace": "ws-other", "target": "criterion:a", "relation": "depends_on",
                                  "revision": 3, "blocking": True,
                                  "status": {"access": True, "present": True, "current_revision": 3,
                                             "review_required": False, "satisfied": True}}]
        foreign = item("criterion:a", data={"title": "Remote API", "owner": "owner"})
        foreign["workspace_key"] = "ws-other"
        foreign["item_id"] = "other-R-CONTRACT"
        foreign_schema = {"revision": 1, "types": {"criterion": {"role": "requirement"}}}
        calls, denied = [], False
        class Server:
            def call(self, name, args):
                calls.append((name, deepcopy(args)))
                self_workspace = args["workspace"]
                if self_workspace in ("other", "ws-other"):
                    if denied:
                        raise Rejected("read access denied")
                    if name == "joppa_tree":
                        return {"schema": deepcopy(foreign_schema)}
                    return deepcopy(foreign)
                return deepcopy(local)
        api = Server()
        local = context.object_read(api, "ws-local", local["address"])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            data = assignment()
            data["joppa"]["workspace_key"] = "ws-local"
            data["joppa"]["objects"][local["address"]] = context.source(local)
            schema = {"types": {"criterion": {"role": "ac"}}}
            snapshot = {"schema": schema, "objects": {local["address"]: context.snapshot_source(local, schema["types"])}}
            for name, value in (("input", data), ("joppa-snapshot", snapshot)):
                (target / (name + ".json")).write_text(json.dumps(value))
            reader = Reader(api, "example", target)
            reader.call("joppa_objects", {"workspace": "other", "address": foreign["address"]})
            reader.call("joppa_objects", {"workspace": "ws-local", "address": local["address"]})
            captured = read(target / "joppa-snapshot.json")
            key = context.remote_key("ws-other", foreign["address"])
            self.assertEqual(captured["objects"], snapshot["objects"])
            self.assertEqual(captured["remote"]["schemas"]["ws-other"], foreign_schema)
            self.assertEqual(captured["remote"]["objects"][key]["workspace"], "ws-other")
            changed = deepcopy(local)
            changed["remote_links"][0]["status"]["satisfied"] = False
            self.assertEqual(context.snapshot_source(local, schema["types"]), context.snapshot_source(changed, schema["types"]))
            changed["remote_links"][0]["revision"] += 1
            self.assertNotEqual(context.snapshot_source(local, schema["types"]), context.snapshot_source(changed, schema["types"]))
            changed["remote_links"] = []
            changed["remote_links_revision"] = 2
            cleared = context.snapshot_source(changed, schema["types"])
            self.assertEqual(cleared["remote_links"], [])
            self.assertEqual(cleared["remote_links_revision"], 2)
            changed["remote_links_revision"] = 3
            self.assertNotEqual(cleared, context.snapshot_source(changed, schema["types"]))
            hydrated = context.read_assignment(api, {"workspace": "example"}, target)
            self.assertEqual(hydrated["joppa"]["remote"]["objects"][key]["item_id"], foreign["item_id"])
            self.assertEqual(hydrated["joppa"]["objects"][local["address"]]["document"]["data"]["title"], local["document"]["data"]["title"])
            foreign["current_revision"] += 1
            with self.assertRaisesRegex(ValueError, "context changed"):
                context.read_assignment(api, {"workspace": "example"}, target)
            foreign["current_revision"] -= 1
            foreign_schema["revision"] += 1
            with self.assertRaisesRegex(ValueError, "context changed"):
                context.read_assignment(api, {"workspace": "example"}, target)
            foreign_schema["revision"] -= 1
            denied = True
            with self.assertRaisesRegex(Rejected, "access denied"):
                context.read_assignment(api, {"workspace": "example"}, target)
            self.assertEqual({args["workspace"] for _, args in calls}, {"other", "ws-other", "ws-local"})

    def test_read_only_reader_can_omit_planning_capture(self):
        obj = item("criterion:a")
        api = Fake(result=obj)
        reader = Reader(api, "example", None)
        self.assertEqual(reader.call("joppa_objects", {"address": "criterion:a"}), obj)
        self.assertEqual(api.calls[0][1]["workspace"], "example")
        with self.assertRaises(MCPError):
            reader.call("joppa_batch", {"operations": []})
