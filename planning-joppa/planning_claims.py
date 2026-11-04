"""Hold criteria for planning with the generic data.assignee field of each AC."""
from copy import deepcopy
from pathlib import Path
import socket

from common import read, require, write
import context_reads

PREFIX = "crew-planning:"
MAX_BATCH = 100
# A failed release needs one save and one assess per criterion in a single batch.
RELEASE_OPERATIONS = 2
MAX_CLAIMED_CRITERIA = MAX_BATCH // RELEASE_OPERATIONS
KEEP = object()


def marker(target):
    """One value per host and run: crew-planning:<host>:<run_id>."""
    return f"{PREFIX}{socket.gethostname()}:{Path(target).resolve().parent.name}"


def address_of(command):
    return command.get("ac") or command.get("target") or command["kind"] + ":" + command["id"]


def assignee_of(object):
    return ((object.get("document") or object).get("data") or {}).get("assignee")


def save_command(object, assignee, reason, question=None):
    """Save the full current document at its read revision. Change only data.assignee, or nothing with KEEP."""
    document = object["document"]
    data = deepcopy(document["data"])
    if assignee is not KEEP:
        data.pop("assignee", None)
        if assignee:
            data["assignee"] = assignee
    command = {"op": "save_object", "kind": object["kind"], "id": object["address"].split(":", 1)[1],
               "revision": object["current_revision"], "parent": document.get("parent"), "data": data,
               "links": deepcopy(document.get("links", [])), "reason": reason}
    if question:
        command["question_checked"] = question
    return command


def assess(target, reason):
    return {"op": "assess", "target": target, "ready": True, "reason": reason}


def not_ready(target, code):
    """Hold a criterion after failed planning. The code is short. The detail stays in the save reason."""
    return {"op": "assess", "target": target, "ready": False, "reason": code}


def claim_operations(assignment, criteria, assignee):
    """One save per AC at the revision read for this plan. A stale write refuses the batch."""
    objects, questions = assignment["joppa"]["objects"], assignment["joppa"].get("questions", {})
    require(len(criteria) <= MAX_CLAIMED_CRITERIA,
            f"Requirement has {len(criteria)} criteria; a failed release needs {RELEASE_OPERATIONS} operations per "
            f"criterion in one batch of at most {MAX_BATCH}, so claim at most {MAX_CLAIMED_CRITERIA}; no claim was sent")
    operations = []
    for item in criteria:
        object = objects[item["id"]]
        require(object["current_revision"] == item["revision"], f"criterion changed before its claim: {item['id']}")
        require(not assignee_of(object), f"Requirement already has an active planning run on {item['id']}")
        operations.append({"command": save_command(object, assignee, "Take this criterion for Crew planning.",
                                                   questions.get(object["kind"]))})
    return operations


def require_fenced(operations):
    """Each assess needs an earlier revision-checked save of the same target in the same batch."""
    saved = set()
    for operation in operations:
        command = operation["command"]
        if command["op"] == "save_object" and command.get("revision") and command.get("id"):
            saved.add(command["kind"] + ":" + command["id"])
        elif command["op"] == "assess":
            require(command["target"] in saved, f"assess {command['target']} needs an earlier save in its batch")
    return operations


def claimed_revisions(receipt):
    """The revision this run wrote: the saved object revision, or the read revision plus one."""
    results = receipt["result"].get("results", [receipt["result"]])
    revisions = {}
    for (address, (_, command)), result in zip(claimed(receipt).items(), results):
        saved = (result.get("object") or {}).get("revision") if isinstance(result, dict) else None
        revisions[address] = saved if type(saved) is int else command["revision"] + 1
    return revisions


def claimed(receipt):
    """Return {address: (assignee, claim command)} for a confirmed claim receipt."""
    require(receipt["status"] == "confirmed", "planning claim was not confirmed")
    args = receipt["arguments"]
    commands = [args["command"]] if "command" in args else [item["command"] for item in args["operations"]]
    results = receipt["result"].get("results", [receipt["result"]])
    require(len(results) == len(commands), "planning claim response is incomplete; inspect claim.json")
    result = {}
    for command in commands:
        assignee = (command.get("data") or {}).get("assignee")
        require(command.get("op") == "save_object" and isinstance(assignee, str) and assignee.startswith(PREFIX),
                "planning claim receipt has no Crew planning assignee; inspect claim.json")
        result[address_of(command)] = (assignee, command)
    return result


def owned(api, workspace, receipt):
    """Read each AC again. Require this run's exact assignee and the exact revision it wrote last."""
    revisions = {**claimed_revisions(receipt), **receipt.get("revisions", {})}
    result = {}
    for address, (assignee, _) in claimed(receipt).items():
        value = api.call("joppa_objects", {"workspace": workspace, "address": address})
        require(assignee_of(value) == assignee, f"this run does not hold the planning claim {address}")
        revision = value.get("current_revision", value.get("revision"))
        require(revision == revisions[address],
                f"criterion {address} changed after this run claimed it: revision {revision}, "
                f"expected {revisions[address]}")
        result[address] = assignee
    return result


def current_assignees(api, workspace, addresses):
    """Report the holders after a refused claim. Do not retry."""
    result = {}
    for address in addresses:
        try:
            result[address] = assignee_of(api.call("joppa_objects", {"workspace": workspace, "address": address}))
        except Exception as error:
            result[address] = f"unreadable: {error}"
    return result


def planning_idle(api, config, assignment, expected=None):
    """Do not split one Requirement between concurrent planning runs."""
    import json
    from context import current_criteria
    expected = expected or {}
    revision = json.loads(assignment["decisions"][0])
    addresses = ({item["address"] for item in current_criteria(api, config["workspace"], revision)}
                 | {assignment["ac"]["id"]})
    require(set(expected).issubset(addresses), "planning receipt contains another Requirement criterion")
    for address in addresses:
        assignee = assignee_of(context_reads.object_read(api, config["workspace"], address))
        if address in expected:
            require(assignee == expected[address], f"this run no longer holds planning claim {address}")
        else:
            require(not assignee, f"Requirement already has an active planning run on {address}")


def release(api, target, workspace, ac, reason, code=None):
    """Save each AC that this run still holds without data.assignee. Keep every other field.
    With a failure code, also assess each AC not ready in the same batch, but only at the revision this run wrote."""
    from publication import mutate
    claim_file = target / "claim.json"
    if not claim_file.exists():
        return False
    receipt = read(claim_file)
    if receipt["status"] != "confirmed":
        return False
    publication = target / "publication.json"
    if publication.exists():
        result = read(publication)
        if (result["status"] != "rejected" or result.get("retain_claim")
                or result.get("error") == "blocked Task needs a new contract or retirement"):
            return False
    prior = target / "release.json"
    if prior.exists():
        release = read(prior)
        return release["status"] == "confirmed" and not any(item.get("unknown") for item in release.get("skipped_claims", []))
    expected = {**claimed_revisions(receipt), **receipt.get("revisions", {})} if code else {}
    operations, released, skipped, unassessed = [], [], [], []
    for address, (assignee, command) in claimed(receipt).items():
        try:
            object = context_reads.object_read(api, workspace, address)
        except Exception:
            skipped.append({"ac": address, "reason": "planning claim could not be read", "unknown": True})
            continue
        if assignee_of(object) != assignee:
            skipped.append({"ac": address, "reason": "planning claim is missing or replaced"})
            continue
        operations.append({"command": save_command(object, None, reason[:1024] or "Release the planning claim.",
                                                   command.get("question_checked"))})
        released.append(address)
        if code and object["current_revision"] == expected.get(address):
            operations.append({"command": not_ready(address, code)})
        elif code:
            unassessed.append({"ac": address, "reason": f"revision {object['current_revision']} is not "
                                                        f"the claimed revision {expected.get(address)}"})
    require_fenced(operations)
    extra = {"failure_code": code, "unassessed_claims": unassessed} if code else {}
    if not operations:
        write(prior, {"status": "confirmed", "released": [], "skipped_claims": skipped, **extra})
        return not any(item.get("unknown") for item in skipped)
    try:
        mutate(api, prior, "joppa_batch", {"workspace": workspace, "operations": operations})
    finally:
        if prior.exists():
            release = read(prior)
            write(prior, {**release, "released": released if release["status"] == "confirmed" else [],
                          "requested_releases": released, "skipped_claims": skipped, **extra})
    return not any(item.get("unknown") for item in skipped)


def closing_operations(object, finished, reason, question=None):
    """Clear this run's assignee. A finished plan also marks the AC ready."""
    operations = [{"command": save_command(object, None, reason, question)}]
    if finished:
        operations.append({"command": assess(object["address"], reason)})
    return require_fenced(operations)


def is_closing(operation, criteria):
    command = operation["command"]
    return command["op"] in ("save_object", "assess") and command.get("revision") != 0 and (
        command.get("target") if command["op"] == "assess" else address_of(command)) in criteria
