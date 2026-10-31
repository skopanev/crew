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


from provider_fixture import item, assignment, plan, Fake


class ProviderTests(unittest.TestCase):
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
                existing["document"]["data"].update(title=task["title"], body=publication.contract(task, value),
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
