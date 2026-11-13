"""Independent acceptance tests for repository scope without projects (black box from the criteria and Sources).

ac:m346wuwt  Planner configuration needs no project mapping: a configuration whose repositories have IDs and no
             project field is accepted.
ac:jlwymt51  Unfinished work lists Tasks of configured repositories: with repository ID service configured, t1
             (service) and t2 (elsewhere and service) are listed; t3 (elsewhere) and t4 (list row service, current
             detail elsewhere) are omitted.
ac:asaiwr0p  Published Tasks get no new project reference: a new Task gets none, and an updated Task keeps its own.

Sources: source:qvg9xxp2 (owner, 2026-11-12) and source:sd0s9yge (declaration = body line `Repository: <id>`).
"""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from provider_fixture import assignment, plan  # noqa: F401  (sets sys.path for planning modules)
import context
import publication
from test_generic_lifecycle import raw


def configuration(repositories):
    """Write a planner configuration with the given repositories and validate it with context.configuration."""
    with tempfile.TemporaryDirectory(prefix="crew-scope-") as folder:
        return validated(Path(folder), repositories)


def validated(root, repositories):
    for repo in repositories:
        (root / repo["path"]).mkdir(parents=True)
    raw_config = {"workspace": "product", "url": "https://joppa.example.invalid/mcp",
                  "mcp_command": ["node", "/opt/broker-joppa-host.cjs"], "runs_folder": str(root / "runs"),
                  "cbm_store": str(root / "cbm"), "cbm_root": str(root), "context": {"token_file": "key", "session": {}, "query": {}},
                  "repositories": repositories}
    path = root / "planner.json"
    path.write_text(json.dumps(raw_config))
    return context.configuration(str(path))


def repository(identifier):
    return {"id": identifier, "path": identifier, "cbm_project": identifier + "-index",
            "modules": [{"name": "feature", "path": "src/feature"}]}


class PlannerConfigurationNeedsNoProjectMapping(unittest.TestCase):
    """ac:m346wuwt"""

    def test_one_repository_service_without_project_is_accepted(self):
        config = configuration([repository("service")])
        self.assertEqual([repo["id"] for repo in config["repositories"]], ["service"])
        self.assertNotIn("project", config["repositories"][0])

    def test_two_repositories_service_and_web_without_project_are_accepted(self):
        config = configuration([repository("service"), repository("web")])
        self.assertEqual([repo["id"] for repo in config["repositories"]], ["service", "web"])
        self.assertTrue(all("project" not in repo for repo in config["repositories"]))


def body(*repositories):
    return "\n".join(["Goal: export 2 rows"] + [f"Repository: {name}" for name in repositories])


def unfinished_work():
    """Configuration: repository ID service only. Four unfinished Tasks t1..t4 as in ac:jlwymt51."""
    rows = {"work:t1": body("service"), "work:t2": body("elsewhere", "service"),
            "work:t3": body("elsewhere"), "work:t4": body("service")}
    details = {"work:t1": raw("work:t1", {"title": "t1", "owner": "owner", "body": body("service")}),
               "work:t2": raw("work:t2", {"title": "t2", "owner": "owner", "body": body("elsewhere", "service")}),
               "work:t3": raw("work:t3", {"title": "t3", "owner": "owner", "body": body("elsewhere")}),
               "work:t4": raw("work:t4", {"title": "t4", "owner": "owner", "body": body("elsewhere")})}

    class Joppa:
        def call(self, name, args):
            assert name == "joppa_objects", name
            if args.get("address"):
                return deepcopy(details[args["address"]])
            return {"items": [{"address": address, "title": address.split(":")[1], "body": text}
                              for address, text in rows.items()], "total": len(rows)}

    data = assignment()
    data["repositories"] = [{"id": "service", "path": "/tmp/example-source", "cbm_project": "service",
                             "modules": [{"name": "core", "path": "src"}]}]
    config = {"workspace": "example", "repositories": data["repositories"]}
    return [entry["address"] for entry in context.pending_work(Joppa(), config, data)]


class UnfinishedWorkListsTasksOfConfiguredRepositories(unittest.TestCase):
    """ac:jlwymt51"""

    def test_lists_t1_and_t2_and_omits_t3_and_t4(self):
        self.assertEqual(sorted(unfinished_work()), ["work:t1", "work:t2"])

    def test_task_that_declares_only_service_is_listed(self):
        self.assertIn("work:t1", unfinished_work())

    def test_task_that_declares_elsewhere_and_service_is_listed(self):
        self.assertIn("work:t2", unfinished_work())

    def test_task_that_declares_only_elsewhere_is_omitted(self):
        self.assertNotIn("work:t3", unfinished_work())

    def test_task_whose_current_detail_moved_to_elsewhere_is_omitted(self):
        self.assertNotIn("work:t4", unfinished_work())


PROJECT_KEYS = ("project", "projects")


def saves(work, value):
    return [entry["command"] for entry in publication.operations(work, value)
            if entry["command"].get("op") == "save_object" and entry["command"].get("kind") == "work"]


def kept(stored, command):
    """The data Joppa keeps after a save: clean replaces data, else data merges and null removes a field."""
    if not command.get("revision") or command.get("clean"):
        return {key: value for key, value in command["data"].items() if value is not None}
    result = deepcopy(stored)
    for key, value in command["data"].items():
        if value is None:
            result.pop(key, None)
        else:
            result[key] = value
    return result


class PublishedTasksGetNoNewProjectReference(unittest.TestCase):
    """ac:asaiwr0p"""

    def assertNoProjectRelation(self, command):
        relations = command.get("relations") or {}
        self.assertFalse([key for key in relations if "project" in key], relations)

    def test_new_task_for_service_without_project_mapping_gets_no_project_reference(self):
        work, value = plan(), assignment()
        value["repositories"][0].pop("project")
        created = [command for command in saves(work, value) if not command.get("revision")]
        self.assertEqual(len(created), 1, created)
        self.assertFalse([key for key in created[0]["data"] if key in PROJECT_KEYS], created[0]["data"])
        self.assertNoProjectRelation(created[0])

    def test_new_task_gets_no_project_reference_from_a_legacy_project_p_field(self):
        work, value = plan(), assignment()
        self.assertEqual(value["repositories"][0]["project"], "project:p")
        created = [command for command in saves(work, value) if not command.get("revision")]
        self.assertEqual(len(created), 1, created)
        self.assertFalse([key for key in created[0]["data"] if key in PROJECT_KEYS], created[0]["data"])
        self.assertNoProjectRelation(created[0])

    def test_updated_task_keeps_its_project_reference_other(self):
        work, value = plan(), assignment()
        value["repositories"][0].pop("project")
        stored = value["joppa"]["objects"]["work:old"]["document"]["data"]
        self.assertEqual(stored["projects"], ["other"])
        work["tasks"][0].update(action="update", target="work:old", revision=3)
        updated = [command for command in saves(work, value) if command.get("id") == "old"]
        self.assertEqual(len(updated), 1, updated)
        self.assertEqual(kept(stored, updated[0])["projects"], ["other"])
        self.assertNoProjectRelation(updated[0])


if __name__ == "__main__":
    unittest.main()
