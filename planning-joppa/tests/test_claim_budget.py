"""A new claim fits one failure release with critic notes. An older claim still releases. No network."""
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
from common import read
import context
import planning_claims
from provider_fixture import Fake, MARK, assignment, claim_receipt, item, raw_ac


class ClaimBudgetTests(unittest.TestCase):
    def test_new_claim_over_the_note_budget_is_refused(self):
        data = assignment()
        criteria = [{"id": f"criterion:c{number}", "revision": 3} for number in range(34)]
        data["joppa"]["objects"].update({entry["id"]: context.source(item(entry["id"], "rule:r")) for entry in criteria})
        with self.assertRaisesRegex(ValueError, "Requirement has 34 criteria.*claim at most 33; no claim was sent"):
            planning_claims.claim_operations(data, criteria, MARK)
        self.assertEqual(len(planning_claims.claim_operations(data, criteria[:33], MARK)), 33)

    def test_old_fifty_criterion_claim_releases_without_notes_and_records_the_drop(self):
        addresses = [f"criterion:c{number}" for number in range(50)]
        class Server(Fake):
            def call(self, name, args):
                self.calls.append((name, deepcopy(args)))
                if name == "joppa_objects":
                    return raw_ac(args["address"], MARK, 4)
                return {"results": [{} for _ in args["operations"]]}
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "claim.json").write_text(json.dumps(claim_receipt(addresses)))
            api = Server()
            self.assertTrue(planning_claims.release(api, target, "example", addresses[0], "critic rejected",
                                                    "PLANNING_FAILED", {"id": "crew-critic-run-1-0", "text": "x"}))
            [operations] = [args["operations"] for name, args in api.calls if name == "joppa_batch"]
            self.assertEqual(len(operations), 100)
            self.assertNotIn("note", {entry["command"]["op"] for entry in operations})
            receipt = read(target / "release.json")
            self.assertEqual(receipt["critic_notes_dropped"], "batch")
            self.assertNotIn("critic_notes", receipt)
            self.assertEqual(len(receipt["released"]), 50)


if __name__ == "__main__":
    unittest.main()
