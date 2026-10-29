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
from mcp import MCPError, Rejected, Reader
import publication


def item(address, parent=None, data=None, process=None, role=None):
    return {"address": address, "kind": address.split(":")[0], "id": address.split(":")[1],
            "current_revision": 3, "document": {"present": True, "data": data or {"title": address, "owner": "owner"},
             "parent": parent, "links": [], "revision": 3, "actor": "document-owner", "position": 10},
            "process": process or {}, "annotations": {"comments": []}, "files": [], "references": [],
            "position": 20, "historical": False, "review_required": False, "work_ready": True}


def assignment():
    task = context.source(item("work:old", "criterion:a", {"title": "Existing", "owner": "document-owner",
        "purpose": "implementation", "contract": "Existing contract", "projects": ["other"], "custom": "preserve"},
        {"assignee": None, "status": "open", "done": None, "retired": None}))
    task["document"]["links"] = [{"target": "record:note", "relation": "related", "revision": 3, "blocking": False}]
    ac = context.source(item("criterion:a", "rule:r"))
    dependency = context.source(item("work:dependency", "criterion:b"))
    return {"workspace": "example", "ac": {"id": "criterion:a"},
            "repositories": [{"id": "service", "project": "project:p", "path": "/tmp/example-source",
                              "cbm_project": "service", "modules": [{"name": "core", "path": "src"}]}],
            "joppa": {"task_type": "work", "task_schema": {"question": "What work?", "title_preview_length": 64},
                      "tasks": [task], "objects": {"criterion:a": ac, "work:old": task, "work:dependency": dependency},
                      "test_status": {"address": "criterion:a", "tests": [], "tests_draft": False,
                                      "tests_revision": None}}}


def plan():
    task = {"id": "first", "action": "create", "ac": "criterion:a", "title": "Create a mechanism",
            "repository": "service", "module": "core", "outcome": "Observable output",
            "steps": ["Use the existing mechanism and reject invalid input."], "reuse": ["Existing mechanism"],
            "depends_on": [], "checks": [{"scenario": "Reject invalid input", "expected": "No mutation"}]}
    return {"disposition": "implement", "outcome": "Criterion output", "necessity": "Required work",
            "approach": "Use the existing mechanism", "rationale": "Minimum sufficient scope",
            "alternatives": ["Existing behavior does not supply the output"], "blockers": [],
            "acceptance_checks": [{"repository": "service", **deepcopy(task["checks"][0])}],
            "tasks": [task]}


class Fake:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if self.error:
            raise self.error
        return self.result


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
        class Server:
            def call(self, name, args):
                calls.append((name, deepcopy(args)))
                if name == "joppa_tree":
                    return {"position": 20, "schema": {"types": types}}
                if name == "joppa_tests":
                    return {"address": args["ac"], "status": "grey", "tests_draft": False}
                if name != "joppa_objects":
                    raise AssertionError("Unsupported tool: " + name)
                if args.get("address"):
                    result = deepcopy(objects[args["address"]])
                    for key in ("kind", "historical", "item_id"):
                        result.pop(key, None)
                    if not result.get("process"):
                        result.pop("process", None)
                    return result
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

    def test_compact_detail_capture_refuses_a_changed_document_or_position(self):
        for drift in ('document', 'position'):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                compact = item('work:a')
                compact.update(position=3, comments={'items': [], 'total': 0})
                full = deepcopy(compact)
                if drift == 'document':
                    full['document']['data']['title'] = 'Changed'
                else:
                    full['position'] = 4
                class Server(Fake):
                    def raw_call(self, name, args):
                        return deepcopy(compact)
                api = Server(result=full)
                reader = Reader(api, 'example', Path(directory))
                with self.assertRaisesRegex(MCPError, 'changed before its planning snapshot'):
                    reader.call('joppa_objects', {'address': 'work:a'})
                self.assertFalse((Path(directory) / 'joppa-snapshot.json').exists())

    def test_title_limit_uses_the_current_schema_name_and_keeps_the_older_name(self):
        data, value = assignment(), plan()
        value['tasks'][0]['title'] = 'x' * 90
        data['joppa']['task_schema'].update(title_max_length=128, title_preview_length=64)
        publication.operations(value, data)
        data['joppa']['task_schema']['title_max_length'] = 80
        with self.assertRaisesRegex(ValueError, 'configured 80-character limit'):
            publication.operations(value, data)
        del data['joppa']['task_schema']['title_max_length']
        with self.assertRaisesRegex(ValueError, 'configured 64-character limit'):
            publication.operations(value, data)

    def test_new_contract_fields_keep_the_full_mechanism_within_each_value_limit(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task['steps'] = ['Preserve the required behavior. ' + '🙂' * 240] * 5
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertEqual(saved['contract'], 'Goal: ' + task['outcome'])
        self.assertEqual(saved['steps'], task['steps'])
        self.assertGreater(len(context.task_contract(saved)), 1024)
        for key in ('contract', 'repository', 'module', 'steps', 'checks'):
            for entry in saved[key] if isinstance(saved[key], list) else [saved[key]]:
                self.assertLessEqual(len(entry), 1024)

    def test_contract_value_limits_fail_before_publication_without_truncation(self):
        for field, size in (('outcome', 1018), ('step', 1024), ('check', 1024)):
            for extra in (0, 1):
                with self.subTest(field=field, extra=extra):
                    data, value = assignment(), plan()
                    task = value['tasks'][0]
                    if field == 'outcome':
                        task['outcome'] = '🙂' * (size + extra)
                    elif field == 'step':
                        task['steps'] = ['🙂' * (size + extra)]
                    else:
                        task['checks'] = [{'scenario': 'x', 'expected': '🙂' * (size + extra - 5)}]
                        value['acceptance_checks'] = [{'repository': 'service', **task['checks'][0]}]
                    before = deepcopy(value)
                    if extra:
                        with self.assertRaisesRegex(ValueError, 'use at most 1024; no text was truncated'):
                            publication.operations(value, data)
                    else:
                        publication.operations(value, data)
                    self.assertEqual(value, before)

    def test_unchanged_long_inline_contract_is_not_migrated_by_a_link_update(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task.update(action='update', target='work:old', revision=3, steps=['x' * 1024, 'y' * 1024],
                    depends_on=['work:dependency'])
        old = data['joppa']['tasks'][0]['document']['data']
        old.update(title=task['title'], contract=publication.contract(task, value), projects=['other', 'p'])
        before = deepcopy(old)
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertGreater(len(saved['contract']), 1024)
        self.assertEqual(saved, before)
        self.assertNotIn('steps', saved)
        self.assertEqual(old, before)

    def test_changed_structured_steps_update_a_blocked_task_with_the_same_goal(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task.update(action='update', target='work:old', revision=3)
        old = data['joppa']['tasks'][0]
        old['document']['data'].update(publication.contract_fields(task))
        old['process']['blocked'] = {'reason': 'Failed', 'position': 19}
        task['steps'].append('Handle the recorded failure in the same mechanism.')
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertEqual(saved['contract'], old['document']['data']['contract'])
        self.assertNotEqual(saved['steps'], old['document']['data']['steps'])

    def test_structured_recovery_step_zero_keeps_its_scope_and_order(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task.update(action='update', target='work:old', revision=3)
        task['steps'].insert(0, '0. Resume from the confirmed checkpoint without reapplying it.')
        old = data['joppa']['tasks'][0]['document']['data']
        old.update(publication.contract_fields(task))
        task['steps'].append('Handle the remaining failure within this module.')
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertEqual(saved['steps'][0], old['steps'][0])
        self.assertEqual(context.task_contract(saved).count('\n0. Resume'), 1)
        old['module'] = 'other'
        with self.assertRaisesRegex(ValueError, 'recovery step 0 scope mismatch'):
            publication.operations(value, data)

    def test_pending_work_hydrates_structured_queue_rows_without_a_projection_change(self):
        data, value = assignment(), plan()
        fields = publication.contract_fields(value['tasks'][0])
        obj = item('work:outside', 'criterion:outside', fields)
        calls = []
        class Server:
            def call(self, name, args):
                calls.append((name, args))
                if name == 'joppa_tasks':
                    return {'tasks': [{'address': obj['address'], 'revision': 3, 'title': 'Outside',
                        'projects': ['p'], 'status': 'open', 'contract': fields['contract']}], 'next_cursor': None}
                self_address = args['address']
                if self_address != obj['address']:
                    raise AssertionError(self_address)
                return deepcopy(obj)
        result = context.pending_work(Server(), {'workspace': 'example', 'repositories': data['repositories']}, data)
        self.assertEqual(result[0]['repository'], 'service')
        self.assertEqual(result[0]['module'], 'core')
        self.assertIn('Use the existing mechanism', result[0]['how'])
        self.assertEqual([name for name, args in calls], ['joppa_tasks', 'joppa_objects'])

    def test_test_list_revision_keeps_only_current_contract_pins(self):
        value = item("criterion:a")
        value["contract_revision"] = 2
        self.assertEqual(context.source(value)["contract_revision"], 2)
        for pin, current, contract, expected in ((2, 3, 2, True), (1, 3, 2, False),
                (4, 3, 2, False), (2, 3, 0, False), (True, 3, 1, False)):
            self.assertEqual(context.current_pin(pin, current, contract), expected)
            link = {"revision": pin, "status": {"access": True, "present": True,
                "current_revision": current, "contract_revision": contract,
                "review_required": False, "satisfied": True}}
            self.assertEqual(context.remote_satisfied(link), expected)

    def test_snapshots_keep_selected_lists_and_ignore_runtime_task_revisions(self):
        types = {"criterion": {"role": "ac"}, "work": {"role": "task"}}
        ac = item("criterion:a", data={"title": "Criterion", "tests": ["checks.rs > first"]})
        ac["contract_revision"] = 3
        selected = context.snapshot_source(ac, types, [ac["address"]])
        sibling = context.snapshot_source(ac, types, [])
        ac["current_revision"] = ac["document"]["revision"] = 4
        ac["document"]["data"]["tests"] = ["checks.rs > replacement"]
        self.assertNotEqual(selected, context.snapshot_source(ac, types, [ac["address"]]))
        self.assertEqual(sibling, context.snapshot_source(ac, types, []))
        task = item("work:one")
        task["contract_revision"] = 3
        before = context.snapshot_source(task, types)
        task["contract_revision"] = task["current_revision"] = task["document"]["revision"] = 4
        self.assertEqual(before, context.snapshot_source(task, types))

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

    def test_acceptance_checks_cannot_disappear_from_published_tasks(self):
        data, value = assignment(), plan()
        check = {"repository": "service", "scenario": "Exercise the complete criterion", "expected": "Required result"}
        value["acceptance_checks"] = [check]
        with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
            publication.operations(value, data)
        value["tasks"][0]["checks"].append({key: val for key, val in check.items() if key != "repository"})
        saved = publication.operations(value, data)[0]["command"]
        self.assertIn("Exercise the complete criterion => Required result", context.task_contract(saved["data"]))
        value["acceptance_checks"][0]["repository"] = "client"
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "client", "project": "project:q"})
        with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
            publication.operations(value, data)

    def test_unchanged_task_can_retain_its_acceptance_check(self):
        data, value = assignment(), plan()
        old = data["joppa"]["tasks"][0]
        old["document"]["data"]["contract"] = publication.contract(deepcopy(value["tasks"][0]), value)
        value["tasks"][0]["checks"] = [{"scenario": "Another mechanism", "expected": "Another output"}]
        self.assertEqual(publication.operations(value, data)[0]["command"]["revision"], 0)
        for field in ("done", "retired"):
            with self.subTest(field=field):
                old["process"][field] = "Finished"
                with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
                    publication.operations(value, data)
                old["process"][field] = None
        value["tasks"][0].update(action="update", target="work:old", revision=3)
        with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
            publication.operations(value, data)

    def test_published_check_preserves_both_scenario_and_command(self):
        data, value = assignment(), plan()
        for check in (value["acceptance_checks"][0], value["tasks"][0]["checks"][0]):
            check.update(command="bun test checks.test.ts", cwd="src")
        saved = context.task_contract(publication.operations(value, data)[0]["command"]["data"])
        self.assertIn("Reject invalid input [bun test checks.test.ts (cwd: src)] => No mutation", saved)

    def test_direct_ac_filter_refuses_before_claim(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_filter", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        data = assignment()
        api = Fake(result={"commands": ["claim_planning", "finish_planning", "release_planning"]})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PLANNING_JOPPA_AC": "criterion:a"}, clear=False), \
             patch.object(stage, "settings", return_value={"workspace": "example", "ac_ids": ["criterion:b"]}), \
             patch.object(stage, "reader_servers"), patch.object(stage.context, "client", return_value=api), \
             patch.object(stage.context, "load", return_value=(data, {}, data["joppa"]["objects"]["criterion:a"])), \
             patch.object(stage.shared, "artifacts", return_value=Path(directory)):
            with self.assertRaisesRegex(ValueError, "outside config.ac_ids"):
                stage.prepare()
        self.assertEqual([name for name, _ in api.calls], ["joppa_help"])

    def test_requirement_claim_guard_checks_siblings_and_exact_own_receipt(self):
        data = assignment()
        data["decisions"] = [json.dumps({"acs": [{"id": "criterion:a"}, {"id": "criterion:b"}]})]
        own = {"actor": "planner", "position": 22}
        objects = {address: item(address, "rule:r") for address in ("criterion:a", "criterion:b")}
        objects["criterion:a"]["process"]["planning_claim"] = {**own, "future_metadata": "allowed"}
        objects["criterion:b"]["process"]["planning_claim"] = {"actor": "other", "position": 23}
        class Server:
            def call(self, name, args):
                return deepcopy(objects[args["address"]])
        with self.assertRaisesRegex(ValueError, "active planning run"):
            context.planning_idle(Server(), {"workspace": "example"}, data)
        with self.assertRaisesRegex(ValueError, "active planning run on criterion:b"):
            context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": own})
        objects["criterion:b"]["process"].pop("planning_claim")
        context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": own})
        with self.assertRaisesRegex(ValueError, "no longer holds"):
            context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": {**own, "position": 24}})
        objects["criterion:b"]["document"]["present"] = False
        context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": own})
        with self.assertRaisesRegex(ValueError, "another Requirement criterion"):
            context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:b": own})

    def test_retained_sibling_order_and_dependencies_remain_approved(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}],
            criterion_schemas={"criterion:a": {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")}})
        data["decisions"] = [json.dumps({"acs": [{"id": "criterion:a"}, {"id": "criterion:b"}]})]
        retained = context.source(item("work:retained", "criterion:b", {"title": "[07] Approved work", "owner": "owner",
            "purpose": "implementation", "contract": "Repository: service\nModule: core"}, {"status": "open"}))
        data["joppa"]["objects"][retained["address"]] = retained
        value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"}]
        value["acceptance_checks"][0]["ac"] = "criterion:a"
        value["tasks"][0]["depends_on"] = ["work:retained"]
        original = deepcopy(retained)
        command = publication.operations(value, data)[0]["command"]
        self.assertTrue(command["data"]["title"].startswith("[08] "))
        self.assertEqual(command["links"][0]["target"], "work:retained")
        self.assertEqual(retained, original)
        retained["document"]["data"]["title"] = "Legacy approved work"
        self.assertTrue(publication.operations(value, data)[0]["command"]["data"]["title"].startswith("[01] "))
        old = data["joppa"]["objects"]["work:old"]
        old["process"]["blocked"] = {"reason": "Failed"}
        old["document"]["data"].update(title="[03] Existing work", contract="Repository: service\nModule: core")
        retained["document"]["data"]["title"] = "[07] Approved work"
        data["joppa"]["tasks"] = [old]
        value["tasks"][0].update(action="update", target="work:old", revision=3, depends_on=[])
        retained["document"]["links"] = [{"target": "work:old", "revision": 3, "relation": "depends_on", "blocking": True}]
        commands = publication.operations(value, data)
        self.assertTrue(commands[0]["command"]["data"]["title"].startswith("[03] "))
        self.assertEqual(retained["document"]["links"][0]["target"], "work:old")
        new = deepcopy(plan()["tasks"][0])
        new.update(id="new", depends_on=["first"])
        value["tasks"].append(new)
        commands = publication.operations(value, data)
        self.assertTrue(commands[1]["command"]["data"]["title"].startswith("[08] "))

    def test_cross_criterion_retirement_cannot_become_a_dependency(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
            criterion_schemas={address: {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")} for address in ("criterion:a", "criterion:b")})
        data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed"}
        consumer = deepcopy(data["joppa"]["tasks"][0])
        consumer.update(address="work:consumer")
        consumer["document"]["parent"] = "criterion:b"
        data["joppa"]["tasks"].append(consumer)
        data["joppa"]["objects"][consumer["address"]] = consumer
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "client", "project": "project:q"})
        value["criteria"] = [{"ac": address, "disposition": "implement"} for address in ("criterion:a", "criterion:b")]
        value["acceptance_checks"] = [{**deepcopy(value["acceptance_checks"][0]), "ac": address}
                                      for address in ("criterion:a", "criterion:b")]
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        update = deepcopy(value["tasks"][0])
        update.update(id="consumer", action="update", ac="criterion:b", target="work:consumer", repository="client")
        value["tasks"].append(update)
        for dependency in ("first", "work:old"):
            update["depends_on"] = [dependency]
            with self.assertRaisesRegex(ValueError, "retired by this plan"):
                publication.operations(value, data)

    def test_partial_release_recovery_stays_bound_to_the_unreadable_criterion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, current = root / "older/artifacts", root / "current/artifacts"
            old.mkdir(parents=True)
            current.mkdir(parents=True)
            (old / "claim.json").write_text(json.dumps({"status": "confirmed", "server": "https://example.invalid/mcp",
                "arguments": {"workspace": "example", "operations": [
                    {"command": {"op": "claim_planning", "ac": address}} for address in ("criterion:a", "criterion:b")]}}))
            release = {"status": "confirmed", "released": ["criterion:b"],
                       "skipped_claims": [{"ac": "criterion:a", "unknown": True, "reason": "planning claim could not be read"}]}
            (old / "release.json").write_text(json.dumps(release))
            def check(address):
                publication.ensure_recovered(root, current, "https://example.invalid/mcp", "example", address)
            with self.assertRaisesRegex(ValueError, "claim or publication needs recovery"):
                check("criterion:a")
            check("criterion:b")
            release["skipped_claims"][0].pop("unknown")
            release["skipped_claims"][0]["reason"] = "planning claim is missing or replaced"
            (old / "release.json").write_text(json.dumps(release))
            check("criterion:a")

    def test_requirement_tasks_keep_order_and_internal_dependency_links(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", tasks=[], criteria=[], criterion_schemas={})
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "client", "project": "project:q"})
        value["criteria"], value["tasks"], value["acceptance_checks"] = [], [], []
        for index, address in enumerate(("criterion:a", "criterion:b", "criterion:c")):
            data["joppa"]["criteria"].append({"id": address, "revision": 3})
            data["joppa"]["objects"][address] = context.source(item(address, "rule:r"))
            data["joppa"]["criterion_schemas"][address] = {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")}
            task = deepcopy(plan()["tasks"][0])
            task.update(id=f"step{index}", ac=address, repository="client" if index == 2 else "service",
                        depends_on=[f"step{index - 1}"] if index else ["work:dependency"])
            value["tasks"].append(task)
            value["criteria"].append({"ac": address, "disposition": "implement"})
            value["acceptance_checks"].append({**deepcopy(plan()["acceptance_checks"][0]),
                "ac": address, "repository": task["repository"]})
        # Input order must not change the prerequisite order.
        value["tasks"].reverse()
        commands = publication.operations(value, data)
        saves = [operation["command"] for operation in commands if operation["command"]["op"] == "save_object"]
        self.assertEqual([command["parent"] for command in saves], ["criterion:a", "criterion:b", "criterion:c"])
        self.assertEqual([command["data"]["title"][:4] for command in saves], ["[01]", "[02]", "[01]"])
        self.assertEqual(saves[0]["links"][0]["target"], "work:dependency")
        self.assertIn({"target": {"$ref": "task1/address"}, "revision": {"$ref": "task1/saved_revision"},
                       "relation": "depends_on", "blocking": True}, saves[1]["links"])
        self.assertEqual(saves[2]["links"][0]["target"], {"$ref": "task2/address"})
        self.assertEqual([operation["command"]["ac"] for operation in commands[-3:]],
                         ["criterion:a", "criterion:b", "criterion:c"])
        value["tasks"][0]["ac"] = "criterion:outside"
        with self.assertRaisesRegex(ValueError, "selected Requirement criterion"):
            publication.operations(value, data)

    def test_requirement_claim_release_is_atomic_and_checks_every_holder(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            receipt = {"status": "confirmed", "holders": {"criterion:a": "planner", "criterion:b": "planner"},
                "arguments": {"workspace": "example", "operations": [
                    {"command": {"op": "claim_planning", "ac": address, "revision": 3}}
                    for address in ("criterion:a", "criterion:b")]},
                "result": {"results": [{"position": 22}, {"position": 23}]}}
            (target / "claim.json").write_text(json.dumps(receipt))
            class Server(Fake):
                def call(self, name, args):
                    self.calls.append((name, deepcopy(args)))
                    if name == "joppa_objects":
                        return {"process": {"planning_claim": {"actor": "planner", "position":
                            22 if args["address"] == "criterion:a" else 23}}}
                    return {"results": [{"position": 24}, {"position": 25}]}
            api = Server()
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            name, arguments = api.calls[-1]
            self.assertEqual(name, "joppa_batch")
            self.assertEqual([entry["command"]["ac"] for entry in arguments["operations"]],
                             ["criterion:a", "criterion:b"])
            self.assertEqual(read(target / "release.json")["status"], "confirmed")
            (target / "release.json").unlink()
            class Replaced(Server):
                def call(self, name, args):
                    result = super().call(name, args)
                    if name == "joppa_objects" and args["address"] == "criterion:b":
                        result["process"]["planning_claim"] = {"actor": "another-planner", "position": 26}
                    return result
            api = Replaced()
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual([entry["command"]["ac"] for entry in api.calls[-1][1]["operations"]], ["criterion:a"])
            release = read(target / "release.json")
            self.assertEqual(release["released"], ["criterion:a"])
            self.assertEqual(release["skipped_claims"][0]["ac"], "criterion:b")
            with self.assertRaisesRegex(ValueError, "does not hold"):
                publication.held_claims(api, "example", receipt)
            (target / "release.json").unlink()
            class Uncertain(Server):
                def call(self, name, args):
                    if name == "joppa_batch":
                        raise MCPError("release response lost")
                    return super().call(name, args)
            with self.assertRaisesRegex(MCPError, "response lost"):
                publication.release(Uncertain(), target, "example", "criterion:a", "Failure")
            uncertain = read(target / "release.json")
            self.assertEqual(uncertain["status"], "uncertain")
            self.assertEqual(uncertain["released"], [])
            self.assertEqual(uncertain["requested_releases"], ["criterion:a", "criterion:b"])
            (target / "release.json").unlink()
            class Unreadable(Server):
                def call(self, name, args):
                    if name == "joppa_objects" and args["address"] == "criterion:a":
                        raise MCPError("claim read failed")
                    return super().call(name, args)
            api = Unreadable()
            self.assertFalse(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(read(target / "release.json")["released"], ["criterion:b"])
            self.assertTrue(read(target / "release.json")["skipped_claims"][0]["unknown"])
            self.assertEqual([entry["command"]["ac"] for entry in api.calls[-1][1]["operations"]], ["criterion:b"])
            previous_calls = len(api.calls)
            self.assertFalse(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(len(api.calls), previous_calls)

    def test_requirement_prompt_title_budgets_fit_the_publication_bound(self):
        data = assignment()
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "other"})
        schemas = {address: {key: deepcopy(data["joppa"][key])
                    for key in ("task_type", "task_schema", "test_status")}
                   for address in ("criterion:a", "criterion:b")}
        schemas["criterion:b"]["task_schema"]["title_preview_length"] = 43
        data["joppa"].update(scope="requirement", criteria=[{"id": key} for key in schemas], criterion_schemas=schemas)
        data["joppa"]["objects"]["work:old"]["document"]["data"].update(
            title="[999] Existing", contract="Repository: service\nModule: core")
        budgets = publication.title_budgets(data)
        self.assertEqual(budgets, {"service": 36, "other": 37})
        counters = publication.package_counters({}, data)
        for repository, budget in budgets.items():
            for number in range(publication.MAX_PUBLICATION_OPERATIONS):
                task = {"id": str(number), "ac": "criterion:b", "repository": repository, "title": "x" * budget}
                self.assertLessEqual(len(publication.checked_task_title(task, data, counters)), 43)

    @unittest.skipUnless(shutil.which("npx"), "npx is required for the transport lifecycle check")
    def test_cli_failure_remains_after_npx_descendant_shutdown(self):
        for terminate_parent in (False, True):
            with self.subTest(terminate_parent=terminate_parent):
                self.check_npx_shutdown(terminate_parent)

    def check_npx_shutdown(self, terminate_parent):
        with tempfile.TemporaryDirectory() as directory:
            script = ROOT / "planning-joppa/stages.py"
            child = Path(directory) / "mcp-child.mjs"
            child_pid = Path(directory) / "child.pid"
            group_pid = Path(directory) / "group.pid"
            child.write_text('''import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => setTimeout(() => {
  console.error("mcp-remote shutdown stack");
  process.exit(0);
}, 150));
console.log("ready");
setInterval(() => {}, 1000);
''')
            command = [shutil.which("npx"), "--offline", "--call",
                       f"node {shlex.quote(str(child))} {shlex.quote(str(child_pid))} & exit 0"]
            program = f'''import os, runpy, signal, sys
from pathlib import Path
sys.path.insert(0, {str(ROOT / "planning")!r})
import stages
sys.path.insert(0, {str(ROOT / "planning-joppa")!r})
from stdio import StdioRPC
stages.artifacts = lambda: Path({directory!r})
def probe():
    transport = StdioRPC({command!r})
    Path({str(group_pid)!r}).write_text(str(transport.process.pid))
    assert os.getpgid(transport.process.pid) == transport.process.pid
    assert transport.process.stdout.readline() == b"ready\\n"
    assert os.getpgid(int(Path({str(child_pid)!r}).read_text())) == transport.process.pid
    assert transport.process.wait(timeout=5) == 0
    if {terminate_parent!r}:
        print("probe-ready", flush=True)
        signal.pause()
    raise ValueError("Task first: use at most 59 characters")
stages.body_result = probe
sys.argv = [{str(script)!r}, "capture", "plan"]
runpy.run_path({str(script)!r}, run_name="__main__")
'''
            try:
                if terminate_parent:
                    process = subprocess.Popen([sys.executable, "-c", program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        ready, _, _ = select.select([process.stdout], [], [], 10)
                        self.assertTrue(ready, "capture did not reach its MCP command")
                        self.assertEqual(process.stdout.readline().strip(), "probe-ready")
                        process.terminate()
                        stdout, stderr = process.communicate(timeout=20)
                        result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.communicate(timeout=2)
                else:
                    result = subprocess.run([sys.executable, "-c", program], capture_output=True, text=True, timeout=20)
                state = subprocess.run(["ps", "-p", child_pid.read_text(), "-o", "stat="], capture_output=True, text=True).stdout.strip()
            finally:
                if group_pid.exists():
                    try:
                        os.killpg(int(group_pid.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            self.assertEqual(result.returncode, 143 if terminate_parent else 1, result.stderr)
            self.assertIn("mcp-remote shutdown stack", result.stderr)
            if not terminate_parent:
                self.assertEqual(result.stderr.splitlines()[-1],
                                 "planning-joppa/capture: Task first: use at most 59 characters")
            self.assertTrue(not state or state.startswith("Z"), f"MCP descendant remains active: {state}")

    def test_requirement_title_budget_includes_actual_generated_prefix(self):
        for limit, number in ((64, 1), (43, 105)):
            with self.subTest(limit=limit, number=number):
                data, value = assignment(), plan()
                data["joppa"]["task_schema"]["title_preview_length"] = limit
                data["joppa"].update(scope="requirement", criteria=[{"id": "criterion:a"}],
                    criterion_schemas={"criterion:a": {key: deepcopy(data["joppa"][key])
                        for key in ("task_type", "task_schema", "test_status")}})
                old = data["joppa"]["tasks"][0]
                old["document"]["data"].update(title=f"[{number:02d}] Existing",
                    contract="Repository: service\nModule: core")
                prefix = f"[{number:02d}] "
                budget = limit - len(prefix)
                task = value["tasks"][0]
                task.update(action="update", target=old["address"], revision=3, title="x" * budget)
                value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"}]
                value["acceptance_checks"][0]["ac"] = "criterion:a"
                operations = publication.operations(value, data)
                title = operations[0]["command"]["data"]["title"]
                self.assertEqual(title, prefix + task["title"])
                self.assertEqual(len(title), limit)
                task["title"] += "x"
                with self.assertRaisesRegex(ValueError, f"Task first:.*use at most {budget} characters"):
                    publication.operations(value, data)

    def test_requirement_explicitly_orders_every_unfinished_selected_task(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", criteria=[{"id": "criterion:a"}],
            criterion_schemas={"criterion:a": {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")}})
        value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"}]
        value["acceptance_checks"][0]["ac"] = "criterion:a"
        old = data["joppa"]["tasks"][0]
        old["process"]["blocked"] = {"reason": "Failed"}
        with self.assertRaisesRegex(ValueError, "explicitly update or retire unfinished Task work:old"):
            publication.operations(value, data)
        provider = deepcopy(old)
        provider["address"] = "work:provider"
        provider["document"]["data"]["contract"] = "Repository: service\nModule: core"
        data["joppa"]["tasks"].append(provider)
        data["joppa"]["objects"][provider["address"]] = provider
        old["document"]["links"].append({"target": "work:provider", "revision": 3,
                                           "relation": "depends_on", "blocking": True})
        consumer = deepcopy(value["tasks"][0])
        consumer.update(action="update", target="work:old", revision=3, depends_on=["work:provider", "work:dependency"])
        value["tasks"] = [consumer]
        with self.assertRaisesRegex(ValueError, "explicitly update or retire unfinished Task work:provider"):
            publication.operations(value, data)
        prerequisite = deepcopy(consumer)
        prerequisite.update(id="provider", target="work:provider", depends_on=[])
        value["tasks"].append(prerequisite)
        done = deepcopy(old)
        done["address"] = "work:done"
        done["process"]["done"] = {"evidence": "Already landed"}
        data["joppa"]["tasks"].append(done)
        operations = publication.operations(value, data)
        saves = [entry["command"] for entry in operations if entry["command"]["op"] == "save_object"]
        self.assertEqual([entry["id"] for entry in saves], ["provider", "old"])
        self.assertEqual([entry["data"]["title"][:4] for entry in saves], ["[01]", "[02]"])
        self.assertFalse(any(link["relation"] == "depends_on" and link["target"] == "work:provider"
                             for entry in saves for link in entry["links"]))
        self.assertTrue(any(link["target"] == "work:dependency" for link in saves[-1]["links"]))
        provider["process"]["assignee"] = "worker"
        with self.assertRaisesRegex(ValueError, "claimed Tasks"):
            publication.operations(value, data)

    def test_requirement_uses_each_criteria_test_list_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            (Path(directory) / "checks.rs").write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            data["joppa"].update(scope="requirement", tasks=[], criteria=[], criterion_schemas={})
            value.update(disposition="verify_existing", tasks=[], criteria=[], acceptance_checks=[])
            for address, revision in (("criterion:a", 4), ("criterion:b", 9)):
                data["joppa"]["criteria"].append({"id": address})
                data["joppa"]["objects"][address] = context.source(item(address, "rule:r"))
                detail = {key: deepcopy(data["joppa"][key]) for key in ("task_type", "task_schema", "test_status")}
                detail["test_status"].update(address=address, tests_revision=revision)
                data["joppa"]["criterion_schemas"][address] = detail
                value["criteria"].append({"ac": address, "disposition": "verify_existing"})
                value["acceptance_checks"].append({"ac": address, "repository": "service", "scenario": "Existing behavior",
                    "expected": "Required result", "test": "checks.rs > required_behavior",
                    "evidence": "service:checks.rs:1; service:implementation.rs:1"})
            bindings = [operation["command"] for operation in publication.operations(value, data)
                        if operation["command"]["op"] == "set_ac_tests"]
            self.assertEqual([(command["target"], command["revision"]) for command in bindings],
                             [("criterion:a", 4), ("criterion:b", 9)])

    def test_capture_rejects_an_oversized_publication_before_critics(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_size", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
            criterion_schemas={address: {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")} for address in ("criterion:a", "criterion:b")})
        data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
        value["criteria"] = [{"ac": address, "disposition": "implement"} for address in ("criterion:a", "criterion:b")]
        value["acceptance_checks"] = [{**deepcopy(value["acceptance_checks"][0]), "ac": address}
                                      for address in ("criterion:a", "criterion:b")]
        first = value["tasks"][0]
        value["tasks"] = [{**deepcopy(first), "id": f"task{number}", "ac": "criterion:a" if number < 50 else "criterion:b"}
                          for number in range(100)]
        api = Fake()
        with tempfile.TemporaryDirectory() as directory, patch.object(stage, "settings", return_value={"workspace": "example"}), \
             patch.object(stage.context, "client", return_value=api), patch.object(stage.context, "read_assignment", return_value=data), \
             patch.object(stage.shared, "artifacts", return_value=Path(directory)), \
             patch.object(stage.shared, "body_result", return_value=(value, [])), \
             patch.object(stage.shared, "bind_necessity") as necessity:
            with self.assertRaisesRegex(ValueError, "100 operations"):
                stage.capture("plan")
            necessity.assert_not_called()
            self.assertFalse((Path(directory) / "plan.json").exists())
        self.assertEqual(api.calls, [])

    def test_requirement_mixes_implementation_and_existing_test_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            (Path(directory) / "checks.rs").write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
                criterion_schemas={address: {key: deepcopy(data["joppa"][key])
                    for key in ("task_type", "task_schema", "test_status")} for address in ("criterion:a", "criterion:b")})
            data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
            value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"},
                                 {"ac": "criterion:b", "disposition": "verify_existing"}]
            value["acceptance_checks"][0]["ac"] = "criterion:a"
            value["acceptance_checks"].append({"ac": "criterion:b", "repository": "service", "scenario": "Existing behavior",
                "expected": "Required result", "test": "checks.rs > required_behavior",
                "evidence": "service:checks.rs:1; service:implementation.rs:1"})
            ops = publication.operations(value, data)
            self.assertEqual([op["command"]["op"] for op in ops],
                             ["save_object", "set_ac_tests", "finish_planning", "finish_planning"])
            self.assertEqual(ops[1]["command"]["target"], "criterion:b")
            self.assertEqual(ops[0]["command"]["parent"], "criterion:a")

    def test_requirement_selection_excludes_unmet_external_dependencies(self):
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "project": {"role": "document"},
                 "work": {"role": "task", "parents": ["criterion"], "question": "What work?",
                          "references": {"projects": {"multiple": True, "target": "project"}}}}
        objects = {address: item(address, "rule:r") for address in ("criterion:a", "criterion:b", "criterion:c")}
        for object in objects.values():
            object["process"]["assessment"] = {"state": "ready"}
        objects.update({"rule:r": item("rule:r"), "project:p": item("project:p"),
                        "criterion:outside": item("criterion:outside", "rule:outside"),
                        "rule:outside": item("rule:outside")})
        objects["criterion:b"]["document"]["links"] = [
            {"target": "criterion:outside", "revision": 3, "relation": "depends_on", "blocking": True}]
        objects["criterion:c"]["document"]["links"] = [
            {"target": "criterion:a", "revision": 3, "relation": "depends_on", "blocking": True}]
        roster = ["criterion:archived", "criterion:a", "criterion:b", "criterion:c"]
        objects["criterion:archived"] = item("criterion:archived", "rule:r")
        objects["criterion:archived"]["document"]["present"] = False
        class Server:
            def call(self, name, args):
                if name == "joppa_tree":
                    return {"position": 20, "schema": {"types": deepcopy(types)}}
                if name == "joppa_tests":
                    rows = [{"address": address, "status": "grey", "tests_draft": False,
                             "tests_revision": None} for address in args["ac"].split(",")]
                    return rows[0] if len(rows) == 1 else {"items": rows}
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                if args.get("parent") == "rule:r":
                    return {"items": [{"address": address, "kind": "criterion",
                                       "present": objects[address]["document"]["present"]} for address in roster]}
                return {"items": []}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        data, snapshot, requirement = context.load_requirement(Server(), config, "r")
        self.assertEqual(requirement["address"], "rule:r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:a"])
        self.assertEqual(snapshot["criteria"], ["criterion:a"])
        self.assertNotIn("criterion:archived", snapshot["objects"])
        objects["criterion:outside"]["current_revision"] = 4
        objects["criterion:outside"]["contract_revision"] = 3
        original_server_call = Server.call
        def green_outside(self, name, args):
            if name == "joppa_tests" and args.get("ac") == "criterion:outside":
                return {"address": "criterion:outside", "status": "green"}
            return original_server_call(self, name, args)
        with patch.object(Server, "call", green_outside):
            ready, _, _ = context.load_requirement(Server(), config, "r")
            self.assertIn("criterion:b", [entry["id"] for entry in ready["joppa"]["criteria"]])
            objects["criterion:outside"]["contract_revision"] = 4
            stale, _, _ = context.load_requirement(Server(), config, "r")
            self.assertNotIn("criterion:b", [entry["id"] for entry in stale["joppa"]["criteria"]])
        objects["criterion:outside"]["current_revision"] = 3
        del objects["criterion:outside"]["contract_revision"]
        with self.assertRaisesRegex(ValueError, "object is absent"):
            context.load(Server(), config, "criterion:archived")
        config["ac_ids"] = ["criterion:c"]
        with self.assertRaisesRegex(ValueError, "no ready criteria"):
            context.load_requirement(Server(), config, "r")
        original_links = objects["criterion:c"]["document"]["links"]
        objects["criterion:c"]["document"]["links"] = []
        filtered, _, _ = context.load_requirement(Server(), config, "r")
        self.assertEqual([entry["id"] for entry in filtered["joppa"]["criteria"]], ["criterion:c"])
        config.pop("ac_ids")
        objects["criterion:c"]["document"]["links"] = original_links
        objects["criterion:a"]["process"]["planning_claim"] = {"actor": "planner", "position": 21}
        with self.assertRaisesRegex(ValueError, "no ready criteria"):
            context.load_requirement(Server(), config, "r")
        resumed, _, _ = context.load_requirement(Server(), config, "r", ["criterion:a"])
        self.assertEqual([entry["id"] for entry in resumed["joppa"]["criteria"]], ["criterion:a"])
        objects["criterion:a"]["document"]["links"] = [
            {"target": "criterion:archived", "revision": 3, "relation": "depends_on", "blocking": True}]
        with self.assertRaisesRegex(ValueError, "object is absent"):
            context.load_requirement(Server(), config, "r", ["criterion:a"])

    def test_retirement_uses_the_existing_atomic_publication(self):
        data, value = assignment(), plan()
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
        value["tasks"][0].update(action="retire", target="work:old", revision=3,
                                 outcome="The approved outcome needs no further work.")
        original = deepcopy(data)
        commands = publication.operations(value, data)
        self.assertEqual([item["command"]["op"] for item in commands], ["retire_task", "finish_planning"])
        self.assertEqual(commands[0]["command"], {"op": "retire_task", "id": "old", "revision": 3,
                                                  "reason": value["tasks"][0]["outcome"]})
        self.assertEqual(data, original)

    def test_retirement_accepts_a_blocked_verification_task(self):
        data, value = assignment(), plan()
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
        data["joppa"]["tasks"][0]["document"]["data"]["purpose"] = "verification"
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        self.assertEqual(publication.operations(value, data)[0]["command"]["op"], "retire_task")

    def test_retirement_requires_existing_dependents_to_remove_the_link(self):
        data, value = assignment(), plan()
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        consumer = deepcopy(data["joppa"]["tasks"][0])
        consumer["address"] = "work:consumer"
        consumer["document"]["links"].append(
            {"target": "work:old", "relation": "depends_on", "blocking": True, "revision": 3})
        consumer["document"]["links"].append(
            {"target": "work:dependency", "relation": "depends_on", "blocking": True, "revision": 3})
        data["joppa"]["tasks"].append(consumer)
        data["joppa"]["objects"][consumer["address"]] = consumer
        with self.assertRaisesRegex(ValueError, "removes the dependency from work:consumer"):
            publication.operations(value, data)
        changed = deepcopy(plan()["tasks"][0])
        changed.update(id="consumer", action="update", target="work:consumer", revision=3, depends_on=[])
        value["tasks"].append(changed)
        commands = publication.operations(value, data)
        self.assertEqual([item["command"]["op"] for item in commands],
                         ["retire_task", "save_object", "finish_planning"])
        links = commands[1]["command"]["links"]
        self.assertFalse(any(link["target"] == "work:old" for link in links))
        self.assertTrue(any(link["target"] == "work:dependency" for link in links))
        self.assertTrue(any(link["target"] == "record:note" for link in links))

    def test_retirement_preserves_finished_dependents(self):
        for field, setting in (("done", "Evidence"), ("retired", {"reason": "Old"})):
            with self.subTest(field=field):
                data, value = assignment(), plan()
                data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
                value["tasks"][0].update(action="retire", target="work:old", revision=3)
                consumer = deepcopy(data["joppa"]["tasks"][0])
                consumer["address"] = "work:consumer"
                consumer["process"][field] = setting
                consumer["document"]["links"].append(
                    {"target": "work:old", "relation": "depends_on", "blocking": True, "revision": 3})
                data["joppa"]["tasks"].append(consumer)
                original = deepcopy(data)
                commands = publication.operations(value, data)
                self.assertEqual([item["command"]["op"] for item in commands], ["retire_task", "finish_planning"])
                self.assertEqual(data, original)

    def test_retirement_refuses_unsafe_targets_and_dependency_use(self):
        data, value = assignment(), plan()
        task = value["tasks"][0]
        task.update(action="retire", target="work:old", revision=3)
        blocked = data["joppa"]["tasks"][0]
        blocked["process"]["blocked"] = {"reason": "Failed", "position": 19}
        for field, setting in (("blocked", None), ("assignee", "worker"),
                               ("claim", {"actor": "worker"}), ("status", "in_progress"),
                               ("done", "Evidence"), ("retired", {"reason": "Old"})):
            with self.subTest(field=field):
                changed = deepcopy(data)
                changed["joppa"]["tasks"][0]["process"][field] = setting
                with self.assertRaises(ValueError):
                    publication.operations(value, changed)
        stale = deepcopy(value)
        stale["tasks"][0]["revision"] = 2
        with self.assertRaisesRegex(ValueError, "source revision"):
            publication.operations(stale, data)
        for dependency in ("first", "work:old"):
            consumer = deepcopy(plan()["tasks"][0])
            consumer.update(id="consumer", depends_on=[dependency])
            mixed = deepcopy(value)
            mixed["tasks"].append(consumer)
            with self.assertRaisesRegex(ValueError, "retired by this plan"):
                publication.operations(mixed, data)
        task["depends_on"] = ["work:dependency"]
        with self.assertRaisesRegex(ValueError, "retirement cannot add dependencies"):
            publication.operations(value, data)

    def test_context_reads_actual_revision_shape_and_custom_roles(self):
        ac = item("criterion:a", "rule:r")
        req = item("rule:r", "area:capability")
        cap = item("area:capability", "area:domain")
        dom = item("area:domain")
        project = item("project:p")
        existing = item("work:one", "criterion:a", process={"status": "in_progress", "assignee": "worker"})
        for obj, display_id in ((ac, "example-A-CRITERION"), (req, "example-R-REQUIREMENT"),
                                (existing, "example-T-EXISTING")):
            obj["item_id"] = display_id
        objects = {obj["address"]: obj for obj in (ac, req, cap, dom, project, existing)}
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "area": {"role": "group"},
                 "project": {"role": "document"}, "work": {"role": "task", "parents": ["criterion"],
                    "question": "What work?", "references": {"projects": {"multiple": True, "target": "project"}}}}
        tree = {"position": 20, "schema": {"revision": 2, "types": types}}
        req["document"]["data"]["body"] = "Required behavior"
        req.pop("annotations")
        req["comments"] = {"items": [{"id": "decision", "text": "Approved"}]}
        calls = []
        class Reader:
            def call(self, tool, args):
                calls.append(tool)
                if tool == "joppa_tree":
                    return deepcopy(tree)
                if tool == "joppa_tests":
                    return deepcopy(assignment()["joppa"]["test_status"])
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                if args.get("related_to"):
                    return {"items": []}
                if args.get("parent") == "rule:r":
                    return {"items": [{"address": "criterion:a", "kind": "criterion", "present": True}]}
                return {"items": [{"address": "work:one"}]}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        value, snapshot, criterion = context.load(Reader(), config, "a")
        self.assertEqual(criterion["address"], "criterion:a")
        self.assertEqual(value["joppa"]["task_type"], "work")
        self.assertEqual(value["requirement"]["revision"], 3)
        self.assertEqual(snapshot["requirement"]["number"], 3)
        self.assertEqual(snapshot["requirement"]["comments"], {"decision": {"id": "decision", "text": "Approved"}})
        self.assertEqual(snapshot["requirement"]["body"], "Required behavior")
        self.assertNotIn("tasks", snapshot["requirement"])
        self.assertEqual(len(value["joppa"]["tasks"]), 1)
        self.assertEqual(json.loads(value["ac"]["text"])["item_id"], ac["item_id"])
        self.assertEqual(json.loads(value["requirement"]["text"])["item_id"], req["item_id"])
        self.assertEqual(value["joppa"]["tasks"][0]["item_id"], existing["item_id"])
        for obj in (ac, req, existing):
            self.assertEqual(value["joppa"]["objects"][obj["address"]]["item_id"], obj["item_id"])
            legacy = deepcopy(obj)
            legacy.pop("item_id")
            self.assertEqual(context.snapshot_source(obj, types, ac["address"]),
                             context.snapshot_source(legacy, types, ac["address"]))
        spec = importlib.util.spec_from_file_location("joppa_prompt_projection", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        with patch.object(stage.shared, "artifacts", return_value=Path("/unused")):
            prompt = stage.prompt_assignment(value)
            self.assertEqual(prompt["ac"]["item_id"], ac["item_id"])
            self.assertEqual(prompt["requirement"]["item_id"], req["item_id"])
            self.assertEqual(prompt["joppa"]["tasks"][0]["item_id"], existing["item_id"])
            grouped = deepcopy(value)
            grouped["joppa"].update(scope="requirement", criteria=[value["ac"]], criterion_schemas={})
            self.assertEqual(stage.prompt_assignment(grouped)["joppa"]["criteria"][0]["item_id"], ac["item_id"])
        self.assertTrue(set(calls).issubset({"joppa_tree", "joppa_objects", "joppa_tests"}))

    def test_update_dependencies_replace_old_edges_before_reference_resolution(self):
        data = assignment()
        prerequisite = deepcopy(data["joppa"]["tasks"][0])
        prerequisite["address"] = "work:prerequisite"
        data["joppa"]["tasks"].append(prerequisite)
        data["joppa"]["objects"][prerequisite["address"]] = prerequisite
        data["joppa"]["tasks"][0]["document"]["links"].append(
            {"target": "work:prerequisite", "revision": 2, "relation": "depends_on", "blocking": True})
        for reference in ("work:prerequisite", "prerequisite"):
            value = plan()
            consumer = value["tasks"][0]
            consumer.update(action="update", target="work:old", revision=3, depends_on=[reference])
            provider = deepcopy(consumer)
            provider.update(id="prerequisite", target="work:prerequisite", depends_on=[])
            value["tasks"] = [consumer, provider]
            commands = publication.operations(value, data)
            dependencies = [link for link in commands[1]["command"]["links"] if link["relation"] == "depends_on"]
            self.assertEqual(len(dependencies), 1)
            self.assertEqual(dependencies[0]["target"], {"$ref": "task1/address"})

    def test_reversed_dependency_order_and_cycles(self):
        value = plan()
        first = value["tasks"][0]
        consumer = deepcopy(first)
        consumer.update(id="consumer", title="Consume the output", depends_on=["first"])
        value["tasks"] = [consumer, first]
        operations = publication.operations(value, assignment())
        self.assertEqual(operations[0]["command"]["data"]["title"], "Create a mechanism")
        self.assertEqual(operations[1]["command"]["data"]["title"], "Consume the output")
        self.assertEqual(operations[1]["command"]["links"][0]["target"], {"$ref": "task1/address"})
        first["depends_on"] = ["consumer"]
        with self.assertRaisesRegex(ValueError, "contain a cycle"):
            publication.operations(value, assignment())

    def test_atomic_references_and_worker_preservation(self):
        data = assignment()
        original = deepcopy(data)
        value = plan()
        second = deepcopy(value["tasks"][0])
        second.update(id="second", action="update", target="work:old", revision=3,
                      depends_on=["first", "work:dependency"])
        value["tasks"].append(second)
        ops = publication.operations(value, data)
        self.assertEqual([op["command"]["op"] for op in ops], ["save_object", "save_object", "finish_planning"])
        saved = ops[1]["command"]
        self.assertEqual(saved["data"]["owner"], "document-owner")
        self.assertEqual(saved["data"]["custom"], "preserve")
        self.assertEqual(saved["data"]["projects"], ["other", "p"])
        self.assertNotIn("assignee", saved)
        self.assertNotIn("status", saved)
        self.assertEqual(saved["question_checked"], "What work?")
        self.assertIn({"target": {"$ref": "task1/address"}, "revision": {"$ref": "task1/saved_revision"},
                       "relation": "depends_on", "blocking": True}, saved["links"])
        self.assertIn({"target": "work:dependency", "revision": 3, "relation": "depends_on", "blocking": True}, saved["links"])
        self.assertIn("1. Use the existing mechanism", context.task_contract(saved["data"]))
        self.assertEqual(data, original)

    def test_refuses_occupied_and_human_work(self):
        value = plan()
        value["tasks"][0].update(action="update", target="work:old", revision=3)
        for field, setting in (("assignee", "worker"), ("claim", {"actor": "worker"}), ("status", "in_progress")):
            data = assignment()
            data["joppa"]["tasks"][0]["process"][field] = setting
            with self.assertRaisesRegex(ValueError, "claimed Tasks"):
                publication.operations(value, data)
        for purpose in ("decision", "manual", "custom"):
            data = assignment()
            data["joppa"]["tasks"][0]["document"]["data"]["purpose"] = purpose
            with self.assertRaisesRegex(ValueError, "only implementation"):
                publication.operations(value, data)

    def test_noop_prerequisite_keeps_fresh_reference_without_save(self):
        data = assignment()
        value = plan()
        first = value["tasks"][0]
        first.update(action="update", target="work:old", revision=3)
        original = data["joppa"]["tasks"][0]
        original["document"]["data"].update(title=first["title"], contract=publication.contract(first, value),
                                             projects=["other", "p"])
        second = deepcopy(first)
        second.update(id="consumer", action="create", title="Consume existing work", depends_on=["first"])
        del second["target"], second["revision"]
        value["tasks"].append(second)
        commands = publication.operations(value, data)
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0]["command"]["data"]["title"], "Consume existing work")
        self.assertIn({"target": "work:old", "revision": 3, "relation": "depends_on", "blocking": True},
                      commands[0]["command"]["links"])
        value["tasks"] = [first]
        self.assertEqual([x["command"]["op"] for x in publication.operations(value, data)], ["finish_planning"])

    def test_restart_refuses_unresolved_receipts_for_the_same_ac(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "old" / "artifacts"
            old.mkdir(parents=True)
            claim = {"status": "confirmed", "server": "https://one.example/mcp", "arguments": {
                "workspace": "example", "command": {"ac": "criterion:a"}}, "result": {"position": 22}}
            (old / "claim.json").write_text(json.dumps(claim))
            (old / "publication.json").write_text(json.dumps({"status": "uncertain"}))
            current = root / "new" / "artifacts"
            check = lambda url="https://one.example/mcp", ac="criterion:a": publication.ensure_recovered(
                root, current, url, "example", ac)
            with self.assertRaisesRegex(ValueError, "receipt recovery"):
                check()
            check("https://two.example/mcp")
            check(ac="criterion:b")
            (old / "publication.json").write_text(json.dumps({"status": "confirmed"}))
            with self.assertRaisesRegex(ValueError, "publication needs recovery"):
                check()
            (old / "result.json").write_text(json.dumps({"status": "published"}))
            check()
            (old / "publication.json").unlink()
            (old / "result.json").unlink()
            with self.assertRaisesRegex(ValueError, "claim or publication"):
                check()
            (old / "release.json").write_text(json.dumps({"status": "confirmed"}))
            check()

    def test_existing_coverage_does_not_create_verification_work(self):
        value = plan()
        value["disposition"] = "verify_existing"
        with self.assertRaisesRegex(ValueError, "must not create verification work"):
            publication.operations(value, assignment())
        value["tasks"] = []
        with self.assertRaisesRegex(ValueError, "acceptance_check.test"):
            publication.operations(value, assignment())

    def test_binding_preserves_the_list_and_skips_an_unchanged_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            (Path(directory) / "checks").mkdir()
            test = Path(directory) / "checks/checks.rs"
            test.write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            value.update(disposition="verify_existing", tasks=[])
            value["acceptance_checks"][0].update(test="checks/checks.rs > required_behavior",
                evidence="service:checks/checks.rs:1; service:implementation.rs:1")
            status = data["joppa"]["test_status"]
            status.update(tests=[{"address": "checks/checks.rs > other"}], tests_revision=4)
            ops = publication.operations(value, data)
            self.assertEqual([op["command"]["op"] for op in ops], ["set_ac_tests", "finish_planning"])
            self.assertEqual(ops[0]["command"]["tests"], ["checks/checks.rs > other", "checks/checks.rs > required_behavior"])
            self.assertEqual(ops[0]["command"]["revision"], 4)
            status["tests"].append({"address": "checks/checks.rs > required_behavior"})
            self.assertEqual(len(publication.operations(value, data)), 1)
            status["tests_draft"] = True
            self.assertEqual(len(publication.operations(value, data)), 2)
            retire = deepcopy(plan()["tasks"][0])
            retire.update(action="retire", target="work:old", revision=3)
            data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
            value["tasks"] = [retire]
            self.assertEqual([op["command"]["op"] for op in publication.operations(value, data)],
                             ["retire_task", "set_ac_tests", "finish_planning"])

    def test_binding_requires_execution_evidence_and_unchanged_cited_source(self):
        from common import fingerprint
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            git = lambda *args: subprocess.check_output(["git", "-C", directory, *args], text=True).strip()
            git("init", "-q")
            (Path(directory) / "checks").mkdir()
            test = Path(directory) / "checks/checks.rs"
            test.write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            git("add", ".")
            git("-c", "user.name=proof", "-c", "user.email=proof@local", "commit", "-qm", "fixture")
            commit = git("rev-parse", "HEAD")
            value.update(disposition="verify_existing", tasks=[])
            value["acceptance_checks"][0].update(test="checks/checks.rs > required_behavior",
                evidence="service:checks/checks.rs:1; service:implementation.rs:1")
            row = {"address": "checks/checks.rs > required_behavior", "status": "pass", "commit": commit}
            data["joppa"]["test_status"]["tests"] = [row]
            snap = {"service": fingerprint(data["repositories"][0])}
            api = Fake(result=data["joppa"]["test_status"])
            publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            data["joppa"]["test_status"]["tests"].append({"address": "checks/checks.rs > another", "status": "not_run"})
            with self.assertRaisesRegex(ValueError, "existing criterion tests contain a failure or missing result"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            data["joppa"]["test_status"]["tests"].pop()
            with self.assertRaisesRegex(ValueError, "snapshot is missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, {})
            row["status"] = "not_run"
            with self.assertRaisesRegex(ValueError, "passing result missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            row["status"] = "pass"
            (Path(directory) / "unrelated.txt").write_text("unrelated\n")
            git("add", ".")
            git("-c", "user.name=proof", "-c", "user.email=proof@local", "commit", "-qm", "unrelated")
            snap = {"service": fingerprint(data["repositories"][0])}
            publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            test.write_text("assert!(false);\n")
            git("add", ".")
            git("-c", "user.name=proof", "-c", "user.email=proof@local", "commit", "-qm", "changed assertion")
            snap = {"service": fingerprint(data["repositories"][0])}
            with self.assertRaises(ValueError):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)

    def test_rejects_stale_and_completed_updates_and_unknown_dependencies(self):
        value = plan()
        value["tasks"][0].update(action="update", target="work:old", revision=2)
        with self.assertRaisesRegex(ValueError, "source revision"):
            publication.operations(value, assignment())
        value["tasks"][0]["revision"] = 3
        data = assignment()
        data["joppa"]["tasks"][0]["process"]["done"] = {"evidence": "Complete"}
        with self.assertRaisesRegex(ValueError, "completed or retired"):
            publication.operations(value, data)
        value = plan()
        value["tasks"][0]["depends_on"] = ["work:unread"]
        with self.assertRaisesRegex(ValueError, "was not read"):
            publication.operations(value, assignment())

    def test_uncertain_publication_keeps_claim_and_never_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner", "arguments": {"workspace": "example", "command": {"op": "claim_planning", "ac": "criterion:a"}}}))
            api = Fake(error=MCPError("transport failed"))
            with self.assertRaises(MCPError):
                publication.mutate(api, target / "publication.json", "joppa_batch", {"workspace": "example", "operations": []})
            receipt = read(target / "publication.json")
            self.assertEqual(receipt["status"], "uncertain")
            self.assertTrue(receipt["arguments"]["request_id"])
            self.assertFalse(publication.release(api, target, "example", "criterion:a", "Failure"))
            with self.assertRaisesRegex(ValueError, "no automatic retry"):
                publication.mutate(api, target / "publication.json", "joppa_batch", {})
            self.assertEqual(len(api.calls), 1)

    def test_confirmed_failure_releases_only_the_same_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner", "arguments": {"workspace": "example", "command": {"op": "claim_planning", "ac": "criterion:a"}}}))
            api = Fake(result={"process": {"planning_claim": {"actor": "other", "position": 22}}})
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(len(api.calls), 1)
            self.assertEqual(read(target / "release.json")["skipped_claims"][0]["ac"], "criterion:a")
            (target / "release.json").unlink()
            api = Fake(result={"process": {"planning_claim": {"actor": "planner", "position": 22}}})
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(api.calls[-1][1]["command"]["op"], "release_planning")
            self.assertEqual(read(target / "release.json")["status"], "confirmed")

    def test_blocked_noop_or_omitted_task_fails_before_publication(self):
        data, value = assignment(), plan()
        task = value["tasks"][0]
        task.update(action="update", target="work:old", revision=3)
        existing = data["joppa"]["tasks"][0]
        existing["document"]["data"].update(title=task["title"], contract=publication.contract(task, value),
                                             projects=["other", "p"])
        existing["process"]["blocked"] = {"reason": "Failed", "position": 19}
        with self.assertRaisesRegex(ValueError, "blocked Task work:old needs a new contract or retirement"):
            publication.operations(value, data)
        task.update(action="create")
        del task["target"], task["revision"]
        with self.assertRaisesRegex(ValueError, "blocked Task work:old needs a new contract or retirement"):
            publication.operations(value, data)

    def test_rejected_blocked_task_update_keeps_the_planning_claim(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_control", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        blocked_refusal = "blocked Task needs a new contract or retirement"
        for blocked, terminal, refusal in ((False, None, blocked_refusal), (True, None, blocked_refusal),
                (True, None, "planning produced no Task changes"),
                (True, "done", blocked_refusal), (True, "retired", blocked_refusal)):
            with self.subTest(blocked=blocked, terminal=terminal, refusal=refusal), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)
                data, value = assignment(), plan()
                task = value["tasks"][0]
                task.update(action="update", target="work:old", revision=3)
                existing = data["joppa"]["tasks"][0]
                existing["document"]["data"].update(title=task["title"], contract=publication.contract(task, value),
                                                     projects=["other", "p"])
                if blocked:
                    existing["process"]["blocked"] = {"reason": "Failed", "position": 19}
                if terminal:
                    finished = deepcopy(existing)
                    finished["address"] = "work:finished"
                    finished["process"][terminal] = {"reason": "Earlier work"}
                    data["joppa"]["tasks"].append(finished)
                    existing["process"].pop("blocked")
                active_blocked = blocked and terminal is None
                if active_blocked:
                    task["steps"].append("Record the exact remaining failure.")
                for name, body in {"input": data, "plan": value, "joppa-snapshot": {},
                    "claim": {"status": "confirmed", "actor": "planner", "result": {"position": 22}, "arguments": {"workspace": "example", "command": {"op": "claim_planning", "ac": "criterion:a"}}}}.items():
                    (target / f"{name}.json").write_text(json.dumps(body))
                class Server(Fake):
                    def call(self, name, args):
                        self.calls.append((name, deepcopy(args)))
                        if name == "joppa_objects":
                            return {"process": {"planning_claim": {"actor": "planner", "position": 22}}}
                        if name == "joppa_batch":
                            raise Rejected(refusal)
                        return {"position": 23}
                api = Server()
                with patch.object(stage, "settings", return_value={"workspace": "example"}), \
                     patch.object(stage.shared, "artifacts", return_value=target), \
                     patch.object(stage.shared, "verify_context", return_value=({}, {}, {})), \
                     patch.object(stage.context, "client", return_value=api), \
                     patch.object(stage.context, "read_assignment", return_value=data), \
                     patch.object(stage.context, "load", return_value=(data, {}, None)), \
                     patch.object(stage.context, "planning_idle"), \
                     patch.object(stage, "run", return_value=""), \
                     patch.object(stage.context, "refresh_reads"), patch.object(stage, "signal"):
                    if active_blocked:
                        with self.assertRaisesRegex(Rejected, refusal):
                            stage.finish()
                        stage.fail(refusal)
                    else:
                        stage.finish()
                result = read(target / "result.json")
                self.assertEqual(result["claim_released"], not active_blocked)
                self.assertEqual(result["status"], "blocked" if active_blocked else "unchanged")
                self.assertEqual((target / "release.json").exists(), not active_blocked)
                if active_blocked:
                    self.assertTrue(result["needs_recovery"])
                    self.assertTrue(read(target / "publication.json")["retain_claim"])
                    mutations = [(name, args) for name, args in api.calls if name != "joppa_objects"]
                    self.assertEqual([name for name, args in mutations], ["joppa_batch"])
                    self.assertEqual(mutations[0][1]["operations"][0]["command"]["op"], "save_object")

    def test_server_rejection_retains_exact_reason(self):
        transport = object.__new__(__import__("mcp").Joppa)
        transport.token = "test-secret"
        transport.rpc = lambda *args: {"isError": True, "structuredContent": {"error": "stale object revision; read the object again"}}
        with self.assertRaisesRegex(Rejected, "stale object revision; read the object again"):
            transport.call("joppa_command", {})

    def test_source_claim_exclusion_and_authority_changes(self):
        old = item("criterion:a")
        current = deepcopy(old)
        current["position"] = 30
        current["process"]["planning_claim"] = {"actor": "planner", "position": 21}
        context.unchanged(context.source(old), context.source(current))
        current["annotations"]["comments"].append({"kind": "decision", "text": "New constraint"})
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(context.source(old), context.source(current))

    def test_snapshot_ignores_task_runtime_changes_but_preserves_contracts(self):
        old = item("work:one", process={"assignee": "worker", "status": "in_progress"})
        current = deepcopy(old)
        current["process"] = {"assignee": None, "status": "open"}
        current["current_revision"] = 4
        current["document"].update(revision=4, actor="worker", position=25, reason="Release the Task")
        types = {"work": {"role": "task"}}
        context.unchanged(context.snapshot_source(old, types), context.snapshot_source(current, types))
        current["document"]["data"]["title"] = "Changed contract"
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(context.snapshot_source(old, types), context.snapshot_source(current, types))

    def test_dry_run_uses_no_mcp_or_agents(self):
        result = subprocess.run([sys.executable, str(ROOT / "planning-joppa/launch.py"), "--config",
            str(ROOT / "planning-joppa/config.example.json"), "--ac-id", "criterion:a", "--dry-run"],
            env={**os.environ, "MEDULLA_BIN": "/unavailable/medulla"}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no MCP calls, claims, agents, or writes", result.stdout)


if __name__ == "__main__":
    unittest.main()
