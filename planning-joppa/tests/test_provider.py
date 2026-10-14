"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
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
from mcp import MCPError, Rejected
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
            "acceptance_checks": [{"repository": "service", "scenario": "Criterion action", "expected": "Criterion output"}],
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
        objects = {obj["address"]: obj for obj in (ac, req, cap, dom, project, existing)}
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "area": {"role": "group"},
                 "project": {"role": "document"}, "work": {"role": "task", "parents": ["criterion"],
                    "question": "What work?", "references": {"projects": {"multiple": True, "target": "project"}}}}
        tree = {"position": 20, "schema": {"revision": 2, "types": types}}
        detail = {"position": 20, "requirement": {"current_revision": 7,
                   "revisions": [{"number": 7, "body": "Required behavior", "tasks": {"runtime": "summary"},
                                  "runs": {}, "confirmed": True}], "comments": {"decision": "Approved"}}}
        calls = []
        class Reader:
            def call(self, tool, args):
                calls.append(tool)
                if tool == "joppa_tree":
                    return deepcopy(tree)
                if tool == "joppa_read":
                    return deepcopy(detail)
                if tool == "joppa_tests":
                    return deepcopy(assignment()["joppa"]["test_status"])
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                return {"position": 20, "items": [{"address": "work:one"}], "next_cursor": None}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        value, snapshot, criterion = context.load(Reader(), config, "a")
        self.assertEqual(criterion["address"], "criterion:a")
        self.assertEqual(value["joppa"]["task_type"], "work")
        self.assertEqual(value["requirement"]["revision"], 3)
        self.assertEqual(snapshot["requirement"]["number"], 7)
        self.assertEqual(snapshot["requirement"]["comments"], {"decision": "Approved"})
        self.assertNotIn("tasks", snapshot["requirement"])
        self.assertEqual(len(value["joppa"]["tasks"]), 1)
        self.assertTrue(set(calls).issubset({"joppa_tree", "joppa_read", "joppa_objects", "joppa_tests"}))
        detail["requirement"]["current_revision"] = 8
        with self.assertRaisesRegex(ValueError, "another revision"):
            context.load(Reader(), config, "a")

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
        self.assertIn("1. Use the existing mechanism", saved["data"]["contract"])
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
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner"}))
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
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner"}))
            api = Fake(result={"process": {"planning_claim": {"actor": "other", "position": 22}}})
            with self.assertRaisesRegex(ValueError, "does not hold"):
                publication.release(api, target, "example", "criterion:a", "Failure")
            self.assertEqual(len(api.calls), 1)
            api = Fake(result={"process": {"planning_claim": {"actor": "planner", "position": 22}}})
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(api.calls[-1][1]["command"]["op"], "release_planning")
            self.assertEqual(read(target / "release.json")["status"], "confirmed")

    def test_unchanged_blocked_task_keeps_the_planning_claim(self):
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
                for name, body in {"input": data, "plan": value, "joppa-snapshot": {},
                    "claim": {"status": "confirmed", "actor": "planner", "result": {"position": 22}}}.items():
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
                    self.assertEqual(mutations[0][1]["operations"][0]["command"]["op"], "finish_planning")

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
