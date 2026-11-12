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


from provider_fixture import item, assignment, plan, Fake, hold, end, ACCEPTANCE, links, merged


class ProviderTests(unittest.TestCase):
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
            dependencies = [link for link in links(commands[1]["command"]) if link["relation"] == "depends_on"]
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
        self.assertEqual(links(operations[1]["command"])[0]["target"], {"$ref": "task1/address"})
        first["depends_on"] = ["consumer"]
        with self.assertRaisesRegex(ValueError, "contain a cycle"):
            publication.operations(value, assignment())

    def test_task_update_sends_authored_changes_and_never_computed_fields(self):
        data, value = assignment(), plan()
        data["joppa"]["task_schema"]["fields"] = {"inherited": {"type": "text", "from": "parent"},
                                                 "custom": {"type": "text", "from": "own"}}
        old = data["joppa"]["tasks"][0]["document"]["data"]
        old["inherited"] = "computed parent value"
        value["tasks"][0].update(action="update", target="work:old", revision=3)
        save = publication.operations(value, data)[0]["command"]
        self.assertEqual((save["id"], save["revision"], save.get("clean")), ("old", 3, None))
        self.assertNotIn("inherited", save["data"])
        # Unchanged authored fields stay out of the patch. Joppa keeps them.
        self.assertNotIn("owner", save["data"])
        self.assertNotIn("custom", save["data"])
        self.assertEqual(merged(old, save)["custom"], "preserve")
        old.pop("custom")
        self.assertNotIn("custom", publication.operations(value, data)[0]["command"]["data"])

    def test_atomic_references_and_worker_preservation(self):
        data = assignment()
        original = deepcopy(data)
        value = plan()
        second = deepcopy(value["tasks"][0])
        second.update(id="second", action="update", target="work:old", revision=3,
                      depends_on=["first", "work:dependency"])
        value["tasks"].append(second)
        ops = publication.operations(value, data)
        self.assertEqual([op["command"]["op"] for op in ops], ["save_object", "save_object", "save_object"])
        saved = ops[1]["command"]
        kept = merged(data["joppa"]["tasks"][0]["document"]["data"], saved)
        self.assertEqual(kept["owner"], "document-owner")
        self.assertEqual(kept["custom"], "preserve")
        self.assertEqual(kept["projects"], ["other", "p"])
        self.assertNotIn("assignee", saved)
        self.assertNotIn("status", saved)
        self.assertNotIn("question_checked", saved)
        # New ordering links carry no revision pin.
        self.assertIn({"target": {"$ref": "task1/address"}, "relation": "depends_on", "blocking": True}, links(saved))
        self.assertIn({"target": "work:dependency", "relation": "depends_on", "blocking": True}, links(saved))
        self.assertIn("1. Use the existing mechanism", context.task_contract(saved["data"]))
        self.assertEqual(data, original)

    def test_refuses_occupied_work(self):
        value = plan()
        value["tasks"][0].update(action="update", target="work:old", revision=3)
        data = assignment()
        data["joppa"]["tasks"][0]["document"]["data"]["assignee"] = "worker"
        with self.assertRaisesRegex(ValueError, "claimed Tasks"):
            publication.operations(value, data)

    def test_noop_prerequisite_keeps_fresh_reference_without_save(self):
        data = assignment()
        value = plan()
        first = value["tasks"][0]
        first.update(action="update", target="work:old", revision=3)
        original = data["joppa"]["tasks"][0]
        original["document"]["data"].update(title=first["title"], body=publication.contract(first, value),
                                             projects=["other", "p"], acceptance_checks=deepcopy(ACCEPTANCE))
        second = deepcopy(first)
        second.update(id="consumer", action="create", title="Consume existing work", depends_on=["first"])
        del second["target"], second["revision"]
        value["tasks"].append(second)
        commands = publication.operations(value, data)
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0]["command"]["data"]["title"], "Consume existing work")
        self.assertIn({"target": "work:old", "relation": "depends_on", "blocking": True},
                      links(commands[0]["command"]))
        value["tasks"] = [first]
        self.assertEqual([x["command"]["op"] for x in publication.operations(value, data)], ["save_object"])

    def test_rejects_stale_and_completed_updates_and_unknown_dependencies(self):
        value = plan()
        value["tasks"][0].update(action="update", target="work:old", revision=2)
        with self.assertRaisesRegex(ValueError, "source revision"):
            publication.operations(value, assignment())
        value["tasks"][0]["revision"] = 3
        data = assignment()
        end(data["joppa"]["tasks"][0], "a" * 40)
        with self.assertRaisesRegex(ValueError, "completed or retired"):
            publication.operations(value, data)
        value = plan()
        value["tasks"][0]["depends_on"] = ["work:unread"]
        with self.assertRaisesRegex(ValueError, "was not read"):
            publication.operations(value, assignment())

    def test_blocked_noop_or_omitted_task_fails_before_publication(self):
        data, value = assignment(), plan()
        task = value["tasks"][0]
        task.update(action="update", target="work:old", revision=3)
        existing = data["joppa"]["tasks"][0]
        existing["document"]["data"].update(title=task["title"], body=publication.contract(task, value),
                                             projects=["other", "p"])
        hold(existing, "Failed")
        with self.assertRaisesRegex(ValueError, "blocked Task work:old needs a new contract or retirement"):
            publication.operations(value, data)
        task.update(action="create")
        del task["target"], task["revision"]
        with self.assertRaisesRegex(ValueError, "blocked Task work:old needs a new contract or retirement"):
            publication.operations(value, data)
