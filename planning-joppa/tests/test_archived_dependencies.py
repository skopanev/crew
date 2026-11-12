"""Dependency links to done Tasks, and the failure release after a certain rejected publication. No network."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read
from mcp import MCPError, Rejected
import publication
from provider_fixture import Fake, MARK, assignment, claim_receipt, hold, plan, raw_ac, links

TYPES = {"work": {"role": "task"}, "criterion": {"role": "ac"}, "record": {"role": "note"}}
COMMIT = "a" * 40
PINNED = {"target": "work:dependency", "relation": "depends_on", "blocking": True, "revision": 2}
REFUSAL = "operation 1: linked object is absent from the current tree"


def dependency(state):
    """A raw detail of work:dependency: live, done (archived with commit), retired (archived) or missing."""
    if state == "missing":
        raise Rejected("object not found: work:dependency")
    data = {"title": "Dependency", "owner": "owner", **({"commit": COMMIT} if state == "done" else {})}
    return {"address": "work:dependency", "data": data, "revision": 5, "parent": "criterion:b", "links": [],
            **({"present": False} if state in ("done", "retired") else {})}


class Server(Fake):
    """Serve the dependency and the AC. Refuse or lose a Task batch on request. Confirm release batches."""
    def __init__(self, state, outcome="confirm"):
        super().__init__()
        self.state, self.outcome, self.ac = state, outcome, (MARK, 4)

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if name == "joppa_objects":
            return dependency(self.state) if args["address"] == "work:dependency" else raw_ac(args["address"], *self.ac)
        tasks = any(entry["command"].get("kind") == "work" for entry in args["operations"])
        if tasks and self.outcome == "reject":
            raise Rejected(REFUSAL)
        if tasks and self.outcome == "lose":
            raise TimeoutError("response lost")
        return {"results": [{} for _ in args["operations"]]}

    def batches(self):
        return [args["operations"] for name, args in self.calls if name == "joppa_batch"]


def scenario(links=()):
    """Update work:old with a plan dependency on work:dependency of another criterion."""
    data, value = assignment(), plan()
    data["joppa"]["tasks"][0]["document"]["links"].extend(deepcopy(list(links)))
    value["tasks"][0].update(action="update", target="work:old", revision=3, depends_on=["work:dependency"])
    return data, value


def saved_links(data, value, server):
    """The depends_on edges the save sends. Joppa keeps the other relation keys."""
    completed = publication.completed_dependencies(server, "example", value, TYPES)
    return links(publication.operations(value, data, completed)[0]["command"])


def depends(values):
    return [value for value in values if value["relation"] == "depends_on"]


class DependencyLinkTests(unittest.TestCase):
    def test_retained_pinned_link_to_done_target_stays_identical(self):
        data, value = scenario([PINNED])
        existing = depends(deepcopy(data["joppa"]["tasks"][0]["document"]["links"]))
        server = Server("done")
        self.assertEqual(saved_links(data, value, server), existing)
        self.assertIn(PINNED, existing)
        self.assertEqual([args["address"] for _, args in server.calls], ["work:dependency"])

    def test_new_link_to_done_target_is_omitted(self):
        data, value = scenario()
        saved = saved_links(data, value, Server("done"))
        self.assertEqual(saved, [])

    def test_live_target_link_is_replaced_as_before(self):
        data, value = scenario([PINNED])
        saved = saved_links(data, value, Server("live"))
        self.assertEqual(saved, [{"target": "work:dependency", "relation": "depends_on", "blocking": True}])
        self.assertEqual(saved, links(publication.operations(value, data)[0]["command"]))

    def test_inherited_links_to_ended_targets_are_kept_without_reads(self):
        inherited = [{"target": "work:done", "relation": "depends_on", "blocking": True, "revision": 2},
                     {"target": "work:retired", "relation": "depends_on", "blocking": True}]
        data, value = scenario(inherited)
        value["tasks"][0]["depends_on"] = []
        existing = depends(deepcopy(data["joppa"]["tasks"][0]["document"]["links"]))
        server = Server("done")
        self.assertEqual(saved_links(data, value, server), existing)
        self.assertEqual(server.calls, [])

    def test_in_batch_and_non_task_targets_are_not_read(self):
        data, value = scenario()
        first = deepcopy(value["tasks"][0])
        first.update(id="first-new", action="create", depends_on=[])
        first.pop("target"), first.pop("revision")
        value["tasks"][0]["depends_on"] = ["first-new", "record:note"]
        value["tasks"].append(first)
        self.assertEqual(publication.dependency_targets(value, TYPES), [])
        with self.assertRaisesRegex(ValueError, "type record is not in the workspace schema"):
            publication.dependency_targets(value, {"work": {"role": "task"}})


def load_stages():
    spec = importlib.util.spec_from_file_location("joppa_stage_archived", ROOT / "planning-joppa/stages.py")
    stage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage)
    return stage


class PublicationFailureTests(unittest.TestCase):
    def run_finish(self, target, server, between=None):
        """Run finish with a held Task, as in the live defect. Run fail after an error, like main()."""
        stage = load_stages()
        data, value = scenario([PINNED])
        hold(data["joppa"]["tasks"][0], "Lane failed")
        for name, body in {"input": data, "plan": value, "joppa-snapshot": {},
                           "claim": claim_receipt(["criterion:a"])}.items():
            (target / f"{name}.json").write_text(json.dumps(body))
        with patch.object(stage, "settings", return_value={"workspace": "example"}), \
             patch.object(stage.shared, "artifacts", return_value=target), \
             patch.object(stage.shared, "verify_context", return_value=({}, {}, {})), \
             patch.object(stage.context, "client", return_value=server), \
             patch.object(stage.context, "read_assignment", return_value=data), \
             patch.object(stage.context, "load", return_value=(data, {"schema": {"types": TYPES}}, None)), \
             patch.object(stage.claims, "planning_idle"), patch.object(stage, "run", return_value=""), \
             patch.object(stage.context, "refresh_reads"), patch.object(stage, "signal"):
            with self.assertRaises(Exception) as caught:
                stage.finish()
            if between:
                between()
            stage.fail(str(caught.exception))
        return str(caught.exception), read(target / "result.json")

    def test_unknown_or_retired_target_is_refused_before_any_write(self):
        for state, message in (("missing", "could not be read"), ("retired", "archived without a valid commit")):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)
                server = Server(state)
                error, result = self.run_finish(target, server)
                self.assertIn(message, error)
                self.assertFalse((target / "publication.json").exists())
                # Only the failure release writes: it holds the AC not ready.
                self.assertEqual([[entry["command"]["op"] for entry in batch] for batch in server.batches()],
                                 [["save_object"]])
                self.assertTrue(result["claim_released"])

    def test_target_done_after_final_read_rejects_once_and_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            server = Server("live", "reject")
            error, result = self.run_finish(target, server)
            self.assertEqual(error, REFUSAL)
            receipt = read(target / "publication.json")
            self.assertEqual((receipt["status"], receipt["error"], receipt["retain_claim"]), ("rejected", REFUSAL, True))
            publication_batch, release_batch = server.batches()
            self.assertIn({"target": "work:dependency", "relation": "depends_on", "blocking": True},
                          links(publication_batch[0]["command"]))
            self.assertEqual([entry["command"]["op"] for entry in release_batch], ["save_object"])
            self.assertEqual(release_batch[0]["command"]["revision"], 4)
            self.assertEqual(release_batch[0]["command"]["data"], {"assignee": None, "hold": "PLANNING_FAILED"})
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (True, False))
            self.assertEqual(read(target / "publication.json"), receipt)

    def test_newer_or_reassigned_criterion_is_untouched_by_the_failure_release(self):
        for holder, unknown in (((MARK, 5), True), (("crew-planning:other:run-2", 5), False)):
            with self.subTest(holder=holder), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)
                server = Server("live", "reject")
                _, result = self.run_finish(target, server, lambda: setattr(server, "ac", holder))
                self.assertEqual(len(server.batches()), 1)
                self.assertEqual(read(target / "release.json")["skipped_claims"][0]["ac"], "criterion:a")
                self.assertEqual(result["needs_recovery"], unknown)

    def test_uncertain_publication_keeps_the_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            server = Server("live", "lose")
            _, result = self.run_finish(target, server)
            self.assertEqual(read(target / "publication.json")["status"], "uncertain")
            self.assertEqual(len(server.batches()), 1)
            self.assertFalse((target / "release.json").exists())
            self.assertEqual((result["claim_released"], result["needs_recovery"]), (False, True))


if __name__ == "__main__":
    unittest.main()
