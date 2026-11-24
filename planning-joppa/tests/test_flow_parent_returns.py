"""Check existing parent return guards through the shared native fixture."""
from copy import deepcopy
import os
from unittest.mock import patch
from test_flow_inputs import InputFixture
from common import read, write
import flow_publication
import flow_stages


class ParentReturnTests(InputFixture):
    def test_parent_returns_requires_explicit_permission_and_one_increment(self):
        output = {"operations": [{"command": {"op": "save_object", "kind": "criterion", "id": "a", "revision": 4,
                                               "data": {"stage": "waiting", "returns": 1}}}]}
        with self.assertRaisesRegex(ValueError, "configured fields"):
            self.publish(output)
        self.config["publication"]["related_updates"]["parent"] = ["stage", "returns"]
        self.assignment["schema"]["types"]["work"]["role"] = "task"
        self.assignment["schema"]["types"]["criterion"].update(role="ac", fields={"returns": {"type": "number", "from": "own"}})
        for count in (0, 2, True, 1.0, -1):
            invalid = deepcopy(output); invalid["operations"][0]["command"]["data"]["returns"] = count
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "one guarded increment"):
                flow_publication.operations(self.config, self.assignment, self.claim, invalid)
        for field, value in (("body", "wrong"), ("tags", ["wrong"]), ("assignee", None)):
            invalid = deepcopy(output); invalid["operations"][0]["command"]["data"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                flow_publication.operations(self.config, self.assignment, self.claim, invalid)
        batch = flow_publication.operations(self.config, self.assignment, self.claim, output)
        self.assertEqual(batch[0]["command"]["data"], {"stage": "waiting", "returns": 1})
        self.assertEqual(batch[1]["ref"], "flow_release")
        for changed in ("type", "from"):
            field = self.assignment["schema"]["types"]["criterion"]["fields"]["returns"]
            original = deepcopy(field); field[changed] = "text" if changed == "type" else "children"
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, "one guarded increment"):
                flow_publication.operations(self.config, self.assignment, self.claim, output)
            field.clear(); field.update(original)
        self.assertEqual(len(self.api.batches), 1)


    def test_parent_increment_publishes_in_the_existing_atomic_receipt(self):
        self.config["publication"]["related_updates"]["parent"] = ["stage", "returns"]
        self.api.schema["types"]["work"]["role"] = "task"
        self.api.schema["types"]["criterion"].update(role="ac", fields={"returns": {"type": "number", "from": "own"}})
        # Capture the new schema through the existing prepare, then publish from that claim.
        fresh = self.folder / "fresh" / "artifacts"
        flow_publication.fail(self.api, self.config, self.target, "Release the setup claim before the new captured schema.")
        with patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(fresh.parent)}):
            flow_stages.prepare()
        assignment = read(fresh / "input.json")
        parent = assignment["context"]["parent"]
        write(fresh / "operations.json", {"operations": [{"command": {"op": "save_object", "kind": "criterion", "id": "a",
            "revision": parent["current_revision"], "data": {"stage": "waiting", "returns": 1}}}]})
        flow_publication.publish(self.api, self.config, fresh)
        self.assertEqual(self.api.nodes["criterion:a"]["document"]["data"]["returns"], 1)
        self.assertIsNone(self.api.nodes["work:t"]["document"]["data"].get("assignee"))
        self.assertEqual(read(fresh / "publication.json")["status"], "confirmed")
        batches = len(self.api.batches)
        with self.assertRaises(ValueError):
            flow_publication.publish(self.api, self.config, fresh)
        self.assertEqual(len(self.api.batches), batches)
        self.assertEqual(self.api.nodes["criterion:a"]["document"]["data"]["returns"], 1)


    def test_parent_stuck_preserves_tags_and_requires_the_configured_limit(self):
        self.config["publication"]["related_updates"]["parent"] = ["stage", "returns", "tags"]
        self.config["vars"] = {"TASKER_RETURN_LIMIT": "3", "STUCK_TAG": "configured-stuck"}
        self.assignment["schema"]["types"]["work"]["role"] = "task"
        self.assignment["schema"]["types"]["criterion"].update(role="ac", fields={
            "returns": {"type": "number", "from": "own"}, "tags": {"type": "list", "from": "own"}})
        parent = self.assignment["context"]["parent"]["document"]["data"]
        parent.update(returns=2, tags=["keep", "existing-question"])
        output = {"operations": [{"command": {"op": "save_object", "kind": "criterion", "id": "a", "revision": 4,
            "data": {"stage": "waiting", "returns": 3, "tags": ["keep", "existing-question", "configured-stuck"]}}}]}
        before = deepcopy(self.assignment)
        batch = flow_publication.operations(self.config, self.assignment, self.claim, output)
        self.assertEqual(batch[0]["command"]["data"], output["operations"][0]["command"]["data"])
        self.assertEqual(self.assignment, before)
        for tags in (["configured-stuck"], ["keep", "existing-question", "owner-question"],
                     ["keep", "existing-question", "configured-stuck", "extra"]):
            invalid = deepcopy(output); invalid["operations"][0]["command"]["data"]["tags"] = tags
            with self.subTest(tags=tags), self.assertRaisesRegex(ValueError, "configured stuck addition"):
                flow_publication.operations(self.config, self.assignment, self.claim, invalid)
        parent["returns"] = 1
        early = deepcopy(output); early["operations"][0]["command"]["data"]["returns"] = 2
        with self.assertRaisesRegex(ValueError, "configured stuck addition"):
            flow_publication.operations(self.config, self.assignment, self.claim, early)
        parent["returns"] = 2
        no_count = deepcopy(output); del no_count["operations"][0]["command"]["data"]["returns"]
        with self.assertRaisesRegex(ValueError, "configured stuck addition"):
            flow_publication.operations(self.config, self.assignment, self.claim, no_count)
        parent["tags"].append("configured-stuck")
        self.assertEqual(flow_publication.operations(self.config, self.assignment, self.claim, output)[0]["command"]["data"]["tags"], parent["tags"])
        self.config["vars"]["STUCK_TAG"] = "another-tag"
        with self.assertRaisesRegex(ValueError, "configured stuck addition"):
            flow_publication.operations(self.config, self.assignment, self.claim, output)

