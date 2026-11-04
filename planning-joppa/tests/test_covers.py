"""Shared Tasks that cover several criteria of one Requirement, and the published acceptance mapping."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
import context
import coverage
import publication

from provider_fixture import item, assignment, plan, CHECK_TYPE, end

SPEC = {"field": "covers", "target": "criterion"}
CHECK_B = {"scenario": "Show the saved value", "expected": "The value is visible"}
LINT = {"command": "npm run lint", "cwd": ".", "expected": "exit 0"}


def requirement(covers=True):
    """Two selected criteria. Task first under criterion:a covers criterion:b and carries both checks."""
    data, value = assignment(), plan()
    data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
        criterion_schemas={address: {key: deepcopy(data["joppa"][key]) for key in ("task_type", "task_schema", "test_nodes")}
                           for address in ("criterion:a", "criterion:b")})
    if covers:
        data["joppa"]["covers"] = dict(SPEC)
    data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
    data["decisions"] = [json.dumps({"acs": [{"id": "criterion:a"}, {"id": "criterion:b"}, {"id": "criterion:c"}]})]
    value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"}, {"ac": "criterion:b", "disposition": "implement"}]
    value["acceptance_checks"] = [{**value["acceptance_checks"][0], "ac": "criterion:a"},
                                  {"repository": "service", "ac": "criterion:b", **CHECK_B}]
    task = value["tasks"][0]
    task.update(covers=["criterion:b"], checks=[*task["checks"], dict(CHECK_B), dict(LINT)])
    return data, value


class CoversTests(unittest.TestCase):
    def test_covering_task_publishes_full_addresses_and_only_acceptance_checks(self):
        data, value = requirement()
        operations = publication.operations(value, data)
        save = operations[0]["command"]
        self.assertEqual(save["parent"], "criterion:a")
        self.assertEqual(save["data"]["covers"], ["criterion:b"])
        # The lint check is a Task-only check. It does not enter data.acceptance.
        self.assertEqual(save["data"]["acceptance"], [
            {"ac": "criterion:a", "check": "Reject invalid input => No mutation"},
            {"ac": "criterion:b", "check": "Show the saved value => The value is visible"}])
        # The covered criterion is released and marked ready in the same batch. It has no Task of its own.
        assessed = [operation["command"]["target"] for operation in operations if operation["command"]["op"] == "assess"]
        self.assertEqual(assessed, ["criterion:a", "criterion:b"])
        self.assertEqual(sum(operation["command"].get("kind") == "work" for operation in operations), 1)

    def test_command_acceptance_check_is_mapped_too(self):
        data, value = requirement()
        value["acceptance_checks"].append({"repository": "service", "ac": "criterion:b", **LINT})
        rows = publication.operations(value, data)[0]["command"]["data"]["acceptance"]
        self.assertIn({"ac": "criterion:b", "check": "npm run lint (cwd: .) => exit 0"}, rows)

    def test_covers_are_refused_without_configuration_or_outside_the_selection(self):
        data, value = requirement(covers=False)
        with self.assertRaisesRegex(ValueError, "covers needs config.covers_reference"):
            publication.operations(value, data)
        data, value = requirement()
        value["tasks"][0]["covers"] = ["criterion:c"]
        with self.assertRaisesRegex(ValueError, "must be another selected criterion"):
            publication.operations(value, data)
        value["tasks"][0]["covers"] = ["criterion:a"]
        with self.assertRaisesRegex(ValueError, "must be another selected criterion"):
            publication.operations(value, data)
        data, value = requirement()
        value["criteria"][1]["disposition"] = "verify_existing"
        with self.assertRaisesRegex(ValueError, "needs disposition implement"):
            publication.operations(value, data)
        single, one = assignment(), plan()
        one["tasks"][0]["covers"] = ["criterion:b"]
        with self.assertRaisesRegex(ValueError, "Requirement scope"):
            publication.operations(one, single)

    def test_covered_check_must_sit_in_the_covering_task(self):
        data, value = requirement()
        value["tasks"][0]["checks"] = value["tasks"][0]["checks"][:1]
        with self.assertRaisesRegex(ValueError, "AC criterion:b: acceptance check"):
            publication.operations(value, data)
        data, value = requirement()
        del value["tasks"][0]["covers"]
        with self.assertRaisesRegex(ValueError, "implementation needs Tasks"):
            publication.operations(value, data)

    def test_retained_covering_task_under_unselected_criterion_is_a_check_carrier_only(self):
        data, value = requirement()
        carrier = context.source(item("work:carrier", "criterion:c", {"title": "[04] Shared work", "owner": "owner",
            "body": "Goal: Shared\n\nRepository: service\nModule: core\n\nHow:\n1. Step\n\nChecks:\n"
                    "Show the saved value => The value is visible", "covers": ["b"]}))
        data["joppa"]["objects"]["work:carrier"] = carrier
        original = deepcopy(carrier)
        value["tasks"][0]["covers"] = []
        value["tasks"][0]["checks"] = value["tasks"][0]["checks"][:1]
        operations = publication.operations(value, data)
        self.assertNotIn("work:carrier", json.dumps(operations))
        self.assertEqual(carrier, original)
        self.assertNotIn("covers", operations[0]["command"]["data"])
        # An ended Task carries no check. The covered criterion then needs its own work.
        end(carrier, "a" * 40)
        with self.assertRaisesRegex(ValueError, "implementation needs Tasks"):
            publication.operations(value, data)

    def test_reference_validation_and_bare_id_normalization(self):
        types = {"criterion": {"role": "ac"}, "project": {"role": "document"},
                 "work": {"role": "task", "references": {"covers": {"multiple": True, "target": "criterion"},
                                                         "one": {"multiple": False, "target": "criterion"},
                                                         "projects": {"multiple": True, "target": "project"}}}}
        self.assertIsNone(coverage.reference({}, types, "work"))
        self.assertEqual(coverage.reference({"covers_reference": "covers"}, types, "work"), SPEC)
        for field, message in (("one", "allow several"), ("missing", "is not a reference"), ("projects", "one Task")):
            with self.assertRaisesRegex(ValueError, message):
                coverage.reference({"covers_reference": field}, types, "work")
        types["work"]["references"]["other"] = {"multiple": True, "target": "project"}
        with self.assertRaisesRegex(ValueError, "target the criterion type"):
            coverage.reference({"covers_reference": "other"}, types, "work")
        self.assertEqual(coverage.covered({"covers": ["b", "criterion:b", "criterion:c"]}, SPEC),
                         ["criterion:b", "criterion:c"])
        with self.assertRaisesRegex(ValueError, "list of criterion addresses"):
            coverage.covered({"covers": "criterion:b"}, SPEC)


class CoveredReadinessTests(unittest.TestCase):
    def server(self, task):
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "project": {"role": "document"},
                 "work": {"role": "task", "parents": ["criterion"], "question": "What work?",
                          "references": {"projects": {"multiple": True, "target": "project"},
                                         "covers": {"multiple": True, "target": "criterion"}}}, "check": CHECK_TYPE}
        objects = {address: item(address, "rule:r") for address in ("criterion:a", "criterion:b")}
        objects.update({"rule:r": item("rule:r"), "project:p": item("project:p"), task["address"]: task})
        class Server:
            def call(self, name, args):
                if name == "joppa_tree":
                    return {"schema": {"types": deepcopy(types)}}
                if args.get("kind") == "check":
                    return {"items": []}
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                if args.get("parent") == "rule:r":
                    return {"items": [{"address": address, "kind": "criterion", "present": True}
                                      for address in ("criterion:a", "criterion:b")]}
                if args.get("kind") == "work":
                    return {"items": [{"address": key} for key, value in objects.items()
                                      if key.startswith("work:") and value["document"]["parent"] == args["parent"]]}
                return {"items": []}
        return Server()

    def test_active_or_done_covering_task_owns_its_covered_criterion(self):
        config = {"workspace": "example", "repositories": assignment()["repositories"], "covers_reference": "covers"}
        task = item("work:shared", "criterion:a", {"title": "[01] Shared", "owner": "owner", "body": "Goal: x",
                                                   "covers": ["b"], "assignee": "crew-lane:host:run"})
        with self.assertRaisesRegex(ValueError, "no ready criteria"):
            context.load_requirement(self.server(task), config, "r")
        end(task, "a" * 40)
        del task["document"]["data"]["assignee"]
        with self.assertRaisesRegex(ValueError, "no ready criteria"):
            context.load_requirement(self.server(task), config, "r")
        # Without the configured reference the covers field has no meaning. Only the parent waits for acceptance.
        config.pop("covers_reference")
        data, _, _ = context.load_requirement(self.server(task), config, "r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:b"])
        self.assertNotIn("covers", data["joppa"])


if __name__ == "__main__":
    unittest.main()
