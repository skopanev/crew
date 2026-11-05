"""Record exact assessment positions in the existing claim.json and release.json receipts."""
from copy import deepcopy
import sys

from common import require, write
from context_reads import object_read
import planning_retry as retry

LOG = "planning-joppa"


def reply_position(result):
    """The assessment position that one batch result reports, or None.
    A live assess result is {"command", "object": null, "position"}: position equals process.assessment.position."""
    if not isinstance(result, dict):
        return None
    for value in ((result.get("assessment") or {}).get("position"),
                  (((result.get("object") or {}).get("process") or {}).get("assessment") or {}).get("position"),
                  result.get("position")):
        if type(value) is int and value > 0:
            return value
    return None


def results_of(reply, operations):
    results = reply.get("results") if isinstance(reply, dict) else None
    return results if isinstance(results, list) and len(results) == len(operations) else None


def address(command):
    return command.get("target") or command["kind"] + ":" + command["id"]


def reply_positions(claim, objects, retries):
    """Positions known without a read: the pre-claim position of a plain AC and the reply position of a retry
    assess. A retry AC without a positive reply position gets none, so its release keeps the claim for recovery."""
    operations = claim["arguments"].get("operations", [])
    results = results_of(claim.get("result"), operations) or [None] * len(operations)
    positions = {}
    for operation, result in zip(operations, results):
        command = operation["command"]
        target = address(command)
        if command["op"] == "save_object" and target not in retries:
            mark = retry.position(objects[target])
            if mark is not None:
                positions[target] = mark
        elif command["op"] == "assess" and target in retries and reply_position(result):
            positions[target] = reply_position(result)
    return positions


def verify_positions(api, workspace, target, claim, retries):
    """Read each retry AC again. A different position drops it from claim.json and stops the run.
    The positions are already in claim.json, so a failed read never leads to an unfenced release."""
    for ac in retries:
        if ac not in claim["positions"]:
            continue
        current = object_read(api, workspace, ac)
        if retry.position(current) != claim["positions"][ac] or retry.assessment(current).get("state") == "waiting":
            del claim["positions"][ac]
            write(target, claim)
            require(False, f"retry claim of {ac} does not show its own assessment position; claim retained")


def record(api, workspace, target, receipt, operations, reply, retry_class=None):
    """Fields for release.json after a confirmed failure release. Each mark needs a fenced assess, a positive
    position in the confirmed reply and a read again that shows this exact assess. Any doubt records no mark."""
    try:
        return marks(api, workspace, target, receipt, operations, reply, retry_class)
    except Exception as error:
        print(f"{LOG}: failure marks not recorded: {error}", file=sys.stderr)
        return {"marks": {}, "marks_error": str(error)[:200]}


def marks(api, workspace, target, receipt, operations, reply, retry_class):
    results = results_of(reply, operations)
    require(results is not None, "release reply is incomplete")
    moment, saves, result, skipped, exhausted = retry.now(), {}, {}, {}, []
    root, server = target.parent.parent, receipt.get("server")
    for operation, reported in zip(operations, results):
        command = operation["command"]
        if command["op"] == "save_object":
            saved = (reported.get("object") or {}).get("revision") if isinstance(reported, dict) else None
            saves[address(command)] = saved if type(saved) is int else command["revision"] + 1
            continue
        if command["op"] != "assess" or "expected_position" not in command:
            continue
        ac, code, replied = command["target"], command["reason"], reply_position(reported)
        if not replied:
            skipped[ac] = "the confirmed reply has no assessment position"
            continue
        current = object_read(api, workspace, ac)
        value, mark = retry.assessment(current), retry.position(current)
        problem = ("criterion changed after the release" if current["current_revision"] != saves.get(ac)
                   else "criterion is held again" if current["document"]["data"].get("assignee")
                   else "assessment differs from this release" if value.get("state") != "waiting"
                   or value.get("reason") != code else "reply position differs from the read" if mark != replied
                   else None)
        if problem:
            skipped[ac] = problem
            continue
        context = retry.context_digest(current)
        entry = {"position": replied, "code": code, "context": context, "revision": current["current_revision"],
                 "marked_at": retry.stamp(moment), "mark_source": "reply", "retry_class": retry_class,
                 **retry.budget(root, server, workspace, ac, context, retry_class, moment)}
        result[ac] = entry
        if entry["retry_exhausted"]:
            exhausted.append(ac)
            print(f"{LOG}: RETRY_EXHAUSTED {ac}: {entry['attempts']} automatic retries failed for this AC context",
                  file=sys.stderr)
    return {"marks": result, **({"marks_skipped": skipped} if skipped else {}),
            **({"retry_exhausted": exhausted} if exhausted else {})}


def without_assessment(snapshot, retries):
    """A retry claim replaces the waiting assessment of its ACs. Compare everything else."""
    value = deepcopy(snapshot)
    for ac in retries:
        process = (value.get("objects", {}).get(ac) or {}).get("process")
        if isinstance(process, dict):
            process.pop("assessment", None)
            value["objects"][ac].pop("work_ready", None)
    return value


def compare_claimed(snapshot, current, retries, target, unchanged):
    """After a retry claim, require the same authored context and keep the claimed state as the plan snapshot."""
    if not retries:
        unchanged(snapshot, current)
        return
    unchanged(without_assessment(snapshot, retries), without_assessment(current, retries))
    write(target / "joppa-snapshot.json", current)
