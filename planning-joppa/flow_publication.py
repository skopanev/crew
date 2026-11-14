"""Fence configured native operations with the existing planner claim and receipt."""
from copy import deepcopy

from common import read, require, write
from context_reads import object_read
import planning_claims as claims
import publication
from flow_context import verify


def operations(config, assignment, claim, value):
    policy = config["publication"]
    require(isinstance(value, dict) and set(value) == {"operations"}, "flow output must contain only operations")
    rows = value["operations"]
    require(isinstance(rows, list) and 0 < len(rows) <= 98, "flow output needs 1..98 native operations")
    selected = assignment["selected"]
    editable = {item["address"]: item for item in [selected, *assignment["children"]]}
    revisions = {key: item["current_revision"] for key, item in editable.items()}
    revisions.update(claims.claimed_revisions(claim))
    result, refs, modified, selected_update = [], set(), set(), None
    for row in deepcopy(rows):
        require(isinstance(row, dict) and set(row) <= {"ref", "command"}, "invalid native operation envelope")
        cmd = row.get("command")
        require(isinstance(cmd, dict) and cmd.get("op") in policy.get("allowed_operations", []),
                "operation is outside config.publication.allowed_operations")
        ref = row.get("ref")
        require(ref is None or isinstance(ref, str) and ref and ref not in refs and ref != "flow_release",
                "duplicate or reserved publication ref")
        if ref:
            refs.add(ref)
        op = cmd["op"]
        if op == "save_object" and cmd.get("revision") == 0:
            require(cmd.get("kind") in policy.get("create_kinds", []) and "id" not in cmd,
                    "creation kind or explicit id is outside the publication policy")
            require(cmd.get("parent") == selected["address"], "new objects must belong to the selected object")
        else:
            address = cmd.get("target") if op == "note" else cmd.get("ac") or cmd.get("target")
            address = address or str(cmd.get("kind")) + ":" + str(cmd.get("id"))
            require(address in editable and editable[address]["kind"] in policy.get("update_kinds", []),
                    "update is outside the configured selected object and direct children")
            if op != "note":
                require(address not in modified, "one revision-changing operation per object is permitted")
                require(cmd.get("revision") == revisions[address], "operation has a stale revision: " + address)
                modified.add(address)
            else:
                # A note needs a revision-checked save in this same batch.
                require(address in modified or address == selected["address"], "note needs a preceding guarded update")
        require(not any(key in cmd for key in ("workspace", "request_id", "clean")), "flow command overrides a host field")
        require("parent" not in cmd or cmd["parent"] == selected["address"] and cmd.get("revision") == 0,
                "flow cannot move existing objects")
        require("assignee" not in (cmd.get("data") or {}), "flow cannot change an execution claim")
        if op != "note" and cmd.get("revision") != 0 and address == selected["address"]:
            require(op in ("save_object", "archive_object"), "unsupported selected-object operation")
            selected_update = cmd
            require(ref is None, "a selected-object save uses the host flow_release ref")
            continue
        result.append(row)
    release = claims.save_command({**selected, "current_revision": revisions[selected["address"]]}, None,
                                  "Publish the configured workflow result and release its claim.")
    if selected_update:
        release = ({**selected_update, "data": {**selected_update.get("data", {}), "assignee": None}}
                   if selected_update["op"] == "save_object" else selected_update)
    # First save also fences notes on the selected object.
    return [{"ref": "flow_release", "command": release}, *result]


def publish(api, config, target):
    assignment, claim = read(target / "input.json"), read(target / "claim.json")
    verify(api, config, assignment, claim)
    output = read(target / config["publication"]["file"])
    batch = operations(config, assignment, claim, output)
    result = publication.mutate(api, target / "publication.json", "joppa_batch",
                                {"workspace": config["workspace"], "operations": batch})
    revision = saved_revision(result, batch[0]["command"])
    write(target / "result.json", {"status": "published", "selected_revision": revision,
          "acceptance_verified": False})


def saved_revision(result, command):
    first = result.get("results", [result])[0]
    return (first.get("object") or {}).get("revision", command["revision"] + 1)


def fail(api, config, target, reason):
    claim_path = target / "claim.json"
    released = False
    if claim_path.exists() and read(claim_path).get("status") == "confirmed":
        receipt = target / "publication.json"
        if receipt.exists() and read(receipt).get("status") in ("pending", "uncertain", "confirmed"):
            require(False, "publication needs receipt recovery; claim retained")
        claim = read(claim_path)
        claims.owned(api, config["workspace"], claim)
        address = next(iter(claims.claimed(claim)))
        selected = object_read(api, config["workspace"], address)
        batch = [{"command": claims.save_command(selected, None, "Release the failed configured workflow claim.")},
                 {"command": claims.note(address, {"id": "flow-" + claims.run_id(target)[:40], "text": reason[:1000]})}]
        result = publication.mutate(api, target / "release.json", "joppa_batch",
                                     {"workspace": config["workspace"], "operations": batch})
        released = True
        revision = saved_revision(result, batch[0]["command"])
    else:
        revision = None
    write(target / "result.json", {"status": "blocked", "reason": reason, "claim_released": released,
                                   "selected_revision": revision, "acceptance_verified": False})
