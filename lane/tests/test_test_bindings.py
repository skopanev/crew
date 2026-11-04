"""gates.py bindings: bind the coder's test names to the reviewed receipt without another check run."""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

LANE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LANE / "bin"))
import test_bindings  # noqa: E402

CONFIG = {"path": "junit/report.xml", "format": "junit", "identity": "{file} > {name}"}
ONE, TWO = "tests/a.test.ts > one", "tests/a.test.ts > two"


class BindingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.artifacts = Path(directory.name) / "artifacts"
        self.gates = self.artifacts / "gates"
        (self.gates / "r1").mkdir(parents=True)
        self.ticket({"address": "work:t1", "testAcceptance": [{"ac": "criterion:a", "check": "c"}],
                     "bindingNodeLimit": 98})
        self.receipt({ONE: "pass", TWO: "fail"})
        environment = mock.patch.dict(os.environ, {"test_report": json.dumps(CONFIG), "VERIFY_ONLY": "false"})
        environment.start()
        self.addCleanup(environment.stop)

    def ticket(self, value):
        (self.artifacts / "ticket.json").write_text(json.dumps(value))

    def receipt(self, outcomes, report=True):
        path = self.gates / "r1" / "receipt.json"
        value = {"passed": True, "tree": "b" * 40, "candidate_sha": "c" * 40}
        if report:
            value["test_report"] = {**CONFIG, "results": [{"test": name, "outcome": outcome}
                                                          for name, outcome in outcomes.items()]}
        path.write_text(json.dumps(value))
        (self.gates / "current.json").write_text(json.dumps(
            {"receipt": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}))

    def bindings(self, rows):
        (self.artifacts / "test-bindings.json").write_text(json.dumps(rows))

    def record(self):
        return json.loads((self.artifacts / test_bindings.RECORD).read_text())

    def refused(self, code):
        with self.assertRaises(test_bindings.Refused) as caught:
            test_bindings.bind(self.gates)
        self.assertEqual(caught.exception.code, code)
        self.assertFalse((self.artifacts / test_bindings.RECORD).exists())

    def test_bound_rows_are_deduplicated_and_frozen_to_the_receipt(self):
        row = {"task": "work:t1", "ac": "criterion:a", "check": "c", "test": ONE}
        self.bindings([row, row])
        test_bindings.bind(self.gates)
        record = self.record()
        self.assertEqual(record["status"], "bound")
        self.assertEqual(record["rows"], [row])
        self.assertEqual(record["tree"], "b" * 40)
        self.assertEqual(record["bindings_sha256"],
                         hashlib.sha256((self.artifacts / "test-bindings.json").read_bytes()).hexdigest())
        self.assertEqual(record["receipt_sha256"], json.loads((self.gates / "current.json").read_text())["sha256"])

    def test_each_refusal_is_a_coded_gap(self):
        row = {"task": "work:t1", "ac": "criterion:a", "check": "c", "test": ONE}
        self.refused("BINDING_MISSING")
        self.bindings([{**row, "extra": 1}])
        self.refused("BINDING_INVALID")
        self.bindings([{**row, "check": "other"}])
        self.refused("BINDING_INVALID")
        self.bindings([{**row, "test": "tests/a.test.ts > absent"}])
        self.refused("BINDING_NOT_IN_REPORT")
        self.bindings([row, {**row, "test": TWO}])
        self.refused("BINDING_NOT_PASSED")
        self.receipt({}, report=False)
        self.bindings([row])
        self.refused("BINDING_NO_REPORT")

    def test_distinct_criterion_tests_must_fit_the_completion_batch(self):
        self.ticket({"tasks": [{"address": "work:t1", "testAcceptance": [{"ac": "criterion:a", "check": "c"}]}],
                     "bindingNodeLimit": 1})
        self.receipt({ONE: "pass", TWO: "pass"})
        row = {"task": "work:t1", "ac": "criterion:a", "check": "c", "test": ONE}
        self.bindings([row, {**row, "test": TWO}])
        self.refused("PACKAGE_BUDGET")

    def test_legacy_verification_and_no_report_runs_do_not_block(self):
        self.ticket({"address": "work:t1"})
        test_bindings.bind(self.gates)
        self.assertFalse((self.artifacts / test_bindings.RECORD).exists())
        self.ticket({"address": "work:t1", "testAcceptance": [{"ac": "criterion:a", "check": "c"}]})
        with mock.patch.dict(os.environ, {"VERIFY_ONLY": "true"}):
            test_bindings.bind(self.gates)
        self.assertEqual(self.record()["status"], "verify_only")
        with mock.patch.dict(os.environ, {"test_report": ""}):
            test_bindings.bind(self.gates)
        self.assertEqual(self.record()["status"], "no_report")

    def test_a_new_gate_run_binds_its_own_receipt_and_drops_the_old_record(self):
        row = {"task": "work:t1", "ac": "criterion:a", "check": "c", "test": ONE}
        self.bindings([row])
        test_bindings.bind(self.gates)
        newer = self.gates / "r2" / "receipt.json"
        newer.parent.mkdir()
        newer.write_text(json.dumps({"passed": True, "tree": "d" * 40, "candidate_sha": "e" * 40,
                                     "test_report": {**CONFIG, "results": [{"test": ONE, "outcome": "pass"}]}}))
        test_bindings.bind(self.gates, newer)
        self.assertEqual((self.record()["receipt"], self.record()["tree"]), (str(newer.resolve()), "d" * 40))
        test_bindings.invalidate(self.gates)
        self.assertFalse((self.artifacts / test_bindings.RECORD).exists())

    def test_long_values_and_final_verification_landing(self):
        self.bindings([{"task": "work:t1", "ac": "criterion:a", "check": "c", "test": "x" * 1025}])
        self.refused("BINDING_INVALID")
        with mock.patch.dict(os.environ, {"TEST_BINDINGS_VERIFY_ONLY": "true"}):
            test_bindings.bind(self.gates)
        self.assertEqual(self.record()["status"], "verify_only")


if __name__ == "__main__":
    unittest.main()
