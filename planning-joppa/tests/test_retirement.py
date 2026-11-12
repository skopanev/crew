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


from provider_fixture import item, assignment, plan, Fake, hold, end, links


class ProviderTests(unittest.TestCase):
    def test_retirement_uses_the_existing_atomic_publication(self):
        data, value = assignment(), plan()
        hold(data["joppa"]["tasks"][0], "Failed")
        value["tasks"][0].update(action="retire", target="work:old", revision=3,
                                 outcome="The approved outcome needs no further work.")
        original = deepcopy(data)
        commands = publication.operations(value, data)
        self.assertEqual([item["command"]["op"] for item in commands], ["archive_object", "save_object"])
        self.assertEqual(commands[0]["command"], {"op": "archive_object", "target": "work:old", "revision": 3,
                                                  "reason": value["tasks"][0]["outcome"]})
        self.assertNotIn("commit", json.dumps(commands[0]))
        self.assertEqual(data, original)

    def test_retirement_accepts_a_blocked_task_without_purpose(self):
        data, value = assignment(), plan()
        hold(data["joppa"]["tasks"][0], "Failed")
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        self.assertEqual(publication.operations(value, data)[0]["command"]["op"], "archive_object")

    def test_retirement_requires_existing_dependents_to_remove_the_link(self):
        data, value = assignment(), plan()
        hold(data["joppa"]["tasks"][0], "Failed")
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
        # The blocked consumer gets a new contract, so the same save clears its hold.
        self.assertEqual([item["command"]["op"] for item in commands],
                         ["archive_object", "save_object", "save_object"])
        self.assertNotIn("hold", commands[1]["command"]["data"])
        self.assertEqual(commands[2]["command"]["kind"] + ":" + commands[2]["command"]["id"], "criterion:a")
        saved = links(commands[1]["command"])
        self.assertFalse(any(link["target"] == "work:old" for link in saved))
        self.assertTrue(any(link["target"] == "work:dependency" for link in saved))
        # Only depends_on is sent. Joppa keeps the related edge to record:note.
        self.assertEqual(set(commands[1]["command"]["relations"]), {"depends_on"})

    def test_retirement_preserves_finished_dependents(self):
        for field, setting in (("done", "a" * 40), ("retired", None)):
            with self.subTest(field=field):
                data, value = assignment(), plan()
                hold(data["joppa"]["tasks"][0], "Failed")
                value["tasks"][0].update(action="retire", target="work:old", revision=3)
                consumer = deepcopy(data["joppa"]["tasks"][0])
                consumer["address"] = "work:consumer"
                end(consumer, setting)
                consumer["document"]["links"].append(
                    {"target": "work:old", "relation": "depends_on", "blocking": True, "revision": 3})
                data["joppa"]["tasks"].append(consumer)
                original = deepcopy(data)
                commands = publication.operations(value, data)
                self.assertEqual([item["command"]["op"] for item in commands], ["archive_object", "save_object"])
                self.assertEqual(data, original)

    def test_retirement_refuses_unsafe_targets_and_dependency_use(self):
        data, value = assignment(), plan()
        task = value["tasks"][0]
        task.update(action="retire", target="work:old", revision=3)
        blocked = data["joppa"]["tasks"][0]
        hold(blocked, "Failed")
        def unblock(task): task["document"]["data"].pop("hold")
        def claim(task): task["document"]["data"]["assignee"] = "worker"
        for field, change in (("blocked", unblock), ("assignee", claim),
                              ("done", lambda task: end(task, "a" * 40)), ("retired", end)):
            with self.subTest(field=field):
                changed = deepcopy(data)
                change(changed["joppa"]["tasks"][0])
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
