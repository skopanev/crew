"""The planner scopes work by configured repository IDs, not by projects. No network, credentials, or live mutations."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import context
import publication
from provider_fixture import item, assignment, plan, CHECK_TYPE
from test_generic_lifecycle import raw


def unscoped(repositories):
    """Repository config without a project mapping."""
    return [{key: value for key, value in repo.items() if key != "project"} for repo in repositories]


class RepositoryScopeTests(unittest.TestCase):
    def test_configuration_accepts_a_repository_without_a_project(self):
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        config = {"workspace": "product", "url": "https://joppa.example/mcp", "token_file": "token",
                  "runs_folder": "runs", "cbm_store": "cbm", "cbm_root": "src", "equill_store": "equill",
                  "repositories": [{"id": "app", "path": str(folder / "src" / "app"), "cbm_project": "app",
                                    "modules": [{"name": "core", "path": "src"}]},
                                   {"id": "web", "path": str(folder / "src" / "web"), "cbm_project": "web",
                                    "modules": [{"name": "ui", "path": "src"}]}]}
        (folder / "config.json").write_text(json.dumps(config))
        loaded = context.configuration(folder / "config.json")
        self.assertEqual([repo["id"] for repo in loaded["repositories"]], ["app", "web"])
        self.assertTrue(all("project" not in repo for repo in loaded["repositories"]))

    def test_context_needs_no_task_projects_reference_and_reads_no_project(self):
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"},
                 "work": {"role": "task", "parents": ["criterion"], "question": "What work?"}, "check": CHECK_TYPE}
        objects = {"criterion:a": item("criterion:a", "rule:r"), "rule:r": item("rule:r")}
        reads = []
        class Server:
            def call(self, name, args):
                if name == "joppa_tree":
                    return {"position": 20, "schema": {"types": deepcopy(types)}}
                if args.get("kind") == "check":
                    return {"items": []}
                if "address" in args:
                    reads.append(args["address"])
                    return deepcopy(objects[args["address"]])
                if args.get("parent") == "rule:r":
                    return {"items": [{"address": "criterion:a", "kind": "criterion", "present": True}]}
                return {"items": []}
        config = {"workspace": "example", "repositories": unscoped(assignment()["repositories"])}
        data, _, requirement = context.load_requirement(Server(), config, "r")
        self.assertEqual(requirement["address"], "rule:r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:a"])
        self.assertFalse([address for address in reads if address.startswith("project:")])

    def test_pending_work_keeps_tasks_of_configured_repositories_only(self):
        data = assignment()
        fields = publication.contract_fields(plan()["tasks"][0])
        free = "Goal: Free text\n\nRepository: service\nModule: core"
        rows = [{"address": "work:structured", **{key: fields[key] for key in ("body", "repository", "steps")}},
                {"address": "work:free", "body": free, "repository": None, "steps": None},
                {"address": "work:other", "body": "Goal: Other\n\nRepository: elsewhere", "repository": None, "steps": None},
                # Invalid steps of another repository are not this planner's work and never throw.
                {"address": "work:broken", "body": "Goal: Broken", "repository": "elsewhere", "steps": "not a list"},
                {"address": "work:none", "body": "Goal: No repository", "repository": None, "steps": None},
                # Steps without a repository declare none, as in the lane.
                {"address": "work:stepsonly", "body": "Goal: Steps only", "repository": None, "steps": ["Step"]}]
        details = {"work:structured": raw("work:structured", {"title": "Structured", **fields}),
                   "work:free": raw("work:free", {"title": "Free", "body": free})}
        calls = []
        class Lists:
            def call(self, name, args):
                calls.append(deepcopy(args))
                if args.get("address"):
                    return deepcopy(details[args["address"]])
                return {"items": deepcopy(rows), "total": len(rows)}
        config = {"workspace": "example", "repositories": unscoped(data["repositories"])}
        result = context.pending_work(Lists(), config, data)
        self.assertEqual([(entry["address"], entry["repository"]) for entry in result],
                         [("work:structured", "service"), ("work:free", "service")])
        self.assertEqual([args["address"] for args in calls if args.get("address")], ["work:structured", "work:free"])
        listed = [args for args in calls if not args.get("address")]
        self.assertTrue(all("data.projects" not in args["fields"] and "contract" not in args["fields"]
                            for args in listed))

    def test_new_task_carries_no_project_reference_and_an_update_keeps_existing_ones(self):
        data = assignment()
        data["repositories"] = unscoped(data["repositories"])
        value = plan()
        update = deepcopy(value["tasks"][0])
        update.update(id="second", action="update", target="work:old", revision=3, title="Changed title")
        value["tasks"].append(update)
        saves = [op["command"] for op in publication.operations(value, data) if op["command"]["op"] == "save_object"]
        created = next(command for command in saves if command["revision"] == 0)
        updated = next(command for command in saves if command.get("id") == "old")
        self.assertNotIn("projects", created["data"])
        # The update patch leaves the stored project references untouched.
        self.assertNotIn("projects", updated["data"])


if __name__ == "__main__":
    unittest.main()
