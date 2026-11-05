"""Bounded automatic retry: own mark, delays, count per authored AC context and exhaustion. No network."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from retry_fixture import AC, SERVER, Joppa, at, claim, fail, release_receipt
import context
import planning_retry as retry


def eligible(api, root, seconds):
    return retry.eligible(root, SERVER, "example", context.object_read(api, "example", AC), at(seconds))


class BoundedRetryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "runs"
        self.clock = patch.object(retry, "now", return_value=at(0))
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.directory.cleanup()

    def failed_run(self, api, number, retries=None, seconds=0, code="PLANNING_FAILED"):
        retry.now.return_value = at(seconds)
        target = claim(api, self.root, number, retries)
        self.assertTrue(fail(api, target, code))
        return target

    def test_own_mark_is_retried_after_the_delay_with_its_exact_position(self):
        api = Joppa()
        target = self.failed_run(api, 1)
        [claim_batch, release_batch] = api.batches()
        mark = release_receipt(target)["marks"][AC]
        # The failure assess expected the position recorded at the claim: no assessment before.
        self.assertEqual(release_batch[1]["expected_position"], 0)
        self.assertEqual(mark["position"], api.acs[AC]["assessment"]["position"])
        self.assertEqual((mark["code"], mark["mark_source"], mark["attempts"], mark["retry_exhausted"]),
                         ("PLANNING_FAILED", "reply", 0, False))
        self.assertEqual(eligible(api, self.root, 59), (None, "retry delay"))
        due, reason = eligible(api, self.root, 60)
        self.assertIsNone(reason)
        self.assertEqual((due["position"], due["attempt"], due["from_run"]), (mark["position"], 1, target.parent.name))
        retry_target = claim(api, self.root, 2, {AC: due})
        save, assess = api.batches()[2]
        self.assertEqual((save["op"], assess["op"], assess["ready"], assess["expected_position"]),
                         ("save_object", "assess", True, mark["position"]))
        self.assertEqual(api.acs[AC]["assessment"]["state"], "ready")
        # The retry claim records its new ready position for the later fences of the same run.
        self.assertEqual(json.loads((retry_target / "claim.json").read_text())["positions"],
                         {AC: api.acs[AC]["assessment"]["position"]})

    def test_count_persists_across_restart_and_exhausts_after_two_retries(self):
        api = Joppa()
        self.failed_run(api, 1)
        due, _ = eligible(api, self.root, 60)
        second = self.failed_run(api, 2, {AC: due}, 60)
        self.assertEqual(release_receipt(second)["marks"][AC]["attempts"], 1)
        self.assertEqual(eligible(api, self.root, 359), (None, "retry delay"))
        due, _ = eligible(api, self.root, 360)
        self.assertEqual(due["attempt"], 2)
        third = self.failed_run(api, 3, {AC: due}, 360)
        receipt = release_receipt(third)
        self.assertEqual((receipt["marks"][AC]["retry_exhausted"], receipt["retry_exhausted"]), (True, [AC]))
        self.assertIsNone(receipt["marks"][AC]["retry_after"])
        self.assertEqual(eligible(api, self.root, 10000), (None, "RETRY_EXHAUSTED"))
        # A restart reads the same receipts: a copied runs folder under another config path keeps the count.
        moved = Path(self.directory.name) / "other-config" / "runs"
        shutil.copytree(self.root, moved)
        self.assertEqual(retry.eligible(moved, SERVER, "example", context.object_read(api, "example", AC), at(10000)),
                         (None, "RETRY_EXHAUSTED"))

    def test_changed_authored_context_starts_a_new_count(self):
        api = Joppa()
        self.failed_run(api, 1)
        for number, seconds in ((2, 60), (3, 360)):
            due, _ = eligible(api, self.root, seconds)
            self.failed_run(api, number, {AC: due}, seconds)
        self.assertEqual(eligible(api, self.root, 1000), (None, "RETRY_EXHAUSTED"))
        api.edit(body="Given a new rule, when it runs, then it passes.")
        due, reason = eligible(api, self.root, 1000)
        self.assertIsNone(reason)
        self.assertEqual(due["attempt"], 1)

    def test_lifecycle_save_does_not_change_the_authored_context(self):
        api = Joppa()
        before = retry.context_digest(context.object_read(api, "example", AC))
        api.edit(assignee="crew-planning:host:run-9")
        self.assertEqual(retry.context_digest(context.object_read(api, "example", AC)), before)

    def test_needs_human_mark_is_never_retried(self):
        api = Joppa()
        target = self.failed_run(api, 1, code="NEEDS_HUMAN")
        self.assertIsNone(release_receipt(target)["marks"][AC]["retry_after"])
        self.assertEqual(eligible(api, self.root, 10000), (None, "NEEDS_HUMAN"))

    def test_uncertain_publication_of_the_failed_run_is_ineligible(self):
        api = Joppa()
        target = self.failed_run(api, 1)
        (target / "publication.json").write_text('{"status": "uncertain"}')
        self.assertEqual(eligible(api, self.root, 60), (None, "failed run has an uncertain receipt"))

    def test_old_receipt_without_mark_provenance_is_never_auto_cleared(self):
        api = Joppa()
        retry.now.return_value = at(0)
        target = claim(api, self.root, 1)
        receipt = json.loads((target / "claim.json").read_text())
        del receipt["positions"]
        (target / "claim.json").write_text(json.dumps(receipt))
        self.assertTrue(fail(api, target))
        self.assertNotIn("expected_position", api.batches()[1][1])
        self.assertEqual(release_receipt(target)["marks"], {})
        self.assertEqual(eligible(api, self.root, 10000), (None, "no Crew failure mark with exact provenance"))


if __name__ == "__main__":
    unittest.main()
