"""Record exact assessment positions in the existing claim.json and release.json receipts."""
from copy import deepcopy
import sys

from common import require, write
from context_reads import object_read
import planning_retry as retry

LOG = "planning-joppa"


def reply_position(result):
    """The assessment position that one batch result reports, or None.
    UNVERIFIED shape: assessment.position, object.process.assessment.position, or a top-level position."""
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


def claimed_positions(api, workspace, claim, objects, retries):
    """The assessment position of each claimed AC that a later fenced assess expects.
    A plain claim keeps the position read before the claim. A retry claim wrote a new ready assessment:
    read it again and require the same position that the batch reply reports, when the reply has one."""
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
        elif command["op"] == "assess" and target in retries:
            current = object_read(api, workspace, target)
            mark, reported = retry.position(current), reply_position(result)
            if (mark and mark != retries[target]["position"] and retry.assessment(current).get("state") != "waiting"
                    and reported in (None, mark)):
                positions[target] = mark
    return positions


def record(api, workspace, target, receipt, operations, reply):
    """Fields for release.json after a confirmed failure release. Each mark needs a fenced assess, the confirmed
    reply and a read again that shows this exact assess. Any doubt records no mark, so no automatic retry."""
    try:
        return marks(api, workspace, target, receipt, operations, reply)
    except Exception as error:
        print(f"{LOG}: failure marks not recorded: {error}", file=sys.stderr)
        return {"marks": {}, "marks_error": str(error)[:200]}


def marks(api, workspace, target, receipt, operations, reply):
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
        ac, code = command["target"], command["reason"]
        current = object_read(api, workspace, ac)
        value, mark, replied = retry.assessment(current), retry.position(current), reply_position(reported)
        problem = ("criterion changed after the release" if current["current_revision"] != saves.get(ac)
                   else "criterion is held again" if current["document"]["data"].get("assignee")
                   else "assessment differs from this release" if value.get("state") != "waiting"
                   or value.get("reason") != code or not mark or mark == command["expected_position"]
                   else "reply position differs from the read" if replied not in (None, mark) else None)
        if problem:
            skipped[ac] = problem
            continue
        context = retry.context_digest(current)
        entry = {"position": mark, "code": code, "context": context, "revision": current["current_revision"],
                 "marked_at": retry.stamp(moment), "mark_source": "reply" if replied else "reread",
                 **retry.budget(root, server, workspace, ac, context, code, moment)}
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
