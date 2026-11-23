"""Fence configured native operations with the existing planner claim and receipt."""
from copy import deepcopy
from pathlib import Path

from common import digest, read, require, write
from context_reads import object_read
import planning_claims as claims
import publication
from flow_context import verify
from flow_batch import members


def failure_scope(config):
    return digest([config["url"], config["workspace"], config.get("workflow"), config["selection"]["kind"]])


def failure_counts(config, target, addresses):
    counts = {address: 1 for address in addresses}
    pending = set(addresses)
    scope = failure_scope(config)
    paths = []
    for path in Path(config["runs_folder"]).glob("*/artifacts/result.json"):
        try:
            paths.append((path.stat().st_mtime_ns, str(path), path))
        except OSError:
            continue
    for _, _, path in sorted(paths, reverse=True):
        if path.parent.resolve() == target.resolve():
            continue
        try:
            result = read(path)
        except (OSError, ValueError):
            continue
        if not isinstance(result, dict):
            continue
        if result.get("failure_scope") != scope or result.get("reason_code") in ("DRY_RUN", "ACTIVE_TASK"):
            continue
        if result.get("claim_released") is not True or result.get("needs_recovery"):
            continue
        revisions = result.get("item_revisions")
        if not isinstance(revisions, dict):
            continue
        previous = result.get("retry_failures") or {}
        for address in pending.intersection(revisions):
            count = previous.get(address, 0) if isinstance(previous, dict) else 0
            if type(count) is int and count > 0 and result.get("reason_code") in ("FLOW_FAILED", "FAILURE_LIMIT") and \
                    address not in result.get("failure_escalated", []):
                counts[address] += count
            pending.remove(address)
        if not pending:
            break
    return counts


def operations(config, assignment, claim, value):
    policy = config["publication"]
    require(isinstance(value, dict) and set(value) <= {"operations", "outcome"}, "invalid flow publication envelope")
    rows = value["operations"]
    require(isinstance(rows, list) and len(rows) <= 100, "flow output exceeds the native operation limit")
    selected = assignment["selected"]
    items = {item["address"]: item for item in members(assignment)}
    editable = {item["address"]: item for item in [*items.values(), *assignment["children"]]}
    context = assignment.get("context", {})
    parent = context.get("parent", {}).get("address")
    related = {item["address"]: item for item in [*([context["parent"]] if parent else []), *context.get("incoming", [])]}
    require(not any(item["document"]["data"].get("assignee") for item in related.values()), "related node is held")
    editable.update(related)
    revisions = {key: item["current_revision"] for key, item in editable.items()}
    owned = claims.claimed_revisions(claim)
    require(set(owned) == set(items), "claim does not match the configured batch")
    revisions.update(owned)
    result, parent_updates, refs, modified, updates, archived = [], [], set(), set(), {}, set()
    release_refs = {address: "flow_release" + ("_" + str(index) if index else "")
                    for index, address in enumerate(items)}
    for row in deepcopy(rows):
        require(isinstance(row, dict) and set(row) <= {"ref", "command"}, "invalid native operation envelope")
        cmd = row.get("command")
        require(isinstance(cmd, dict) and cmd.get("op") in policy.get("allowed_operations", []),
                "operation is outside config.publication.allowed_operations")
        ref = row.get("ref")
        require(ref is None or isinstance(ref, str) and ref and ref not in refs and not ref.startswith("flow_release"),
                "duplicate or reserved publication ref")
        if ref:
            refs.add(ref)
        op = cmd["op"]
        if op == "save_object" and cmd.get("revision") == 0:
            require(cmd.get("kind") in policy.get("create_kinds", []) and "id" not in cmd,
                    "creation kind or explicit id is outside the publication policy")
            require(cmd.get("parent") in items, "new objects must belong to a claimed object")
        else:
            address = cmd.get("target") if op == "note" else cmd.get("ac") or cmd.get("target")
            address = address or str(cmd.get("kind")) + ":" + str(cmd.get("id"))
            if address in related:
                permission = policy.get("related_updates", {})
                require(op == "save_object" and set(cmd) <= {"op", "kind", "id", "revision", "data", "relations", "reason"},
                        "related update must be a scoped save")
                if address == parent:
                    require(permission.get("parent") == ["stage"] and set(cmd.get("data") or {}) == {"stage"} and
                            isinstance(cmd["data"]["stage"], str) and cmd["data"]["stage"] and not cmd.get("relations"), "parent update permits stage only")
                else:
                    require(permission.get("incoming") == "remove_selected_edge" and not cmd.get("data") and any(
                        row["command"].get("op") == "archive_object" and claims.address_of(row["command"]) == selected["address"]
                        for row in rows), "consumer edge removal requires the selected archive")
                    key = config["related"]["incoming"]["relation"]
                    group = deepcopy(related[address]["relations"][key])
                    group["edges"] = [edge for edge in group["edges"] if edge.get("to") != selected["address"]]
                    require(cmd.get("relations") == {key: group}, "consumer update must preserve relation metadata and other edges")
            require(address in editable and editable[address]["kind"] in policy.get("update_kinds", []),
                    "update is outside the configured claimed objects and direct children")
            if op != "note":
                require(address not in modified or op == "archive_object" and address in owned
                        and address in updates and address not in archived,
                        "one guarded save followed by one archive is permitted for a claimed object")
                require(cmd.get("revision") == revisions[address], "operation has a stale revision: " + address)
                modified.add(address)
                if op == "archive_object":
                    archived.add(address)
            else:
                # A note needs a revision-checked save in this same batch.
                require(address in modified or address in owned, "note needs a preceding guarded update")
        require(not any(key in cmd for key in ("workspace", "request_id", "clean")), "flow command overrides a host field")
        require("parent" not in cmd or cmd["parent"] in items and cmd.get("revision") == 0,
                "flow cannot move existing objects")
        require("assignee" not in (cmd.get("data") or {}), "flow cannot change an execution claim")
        if op == "save_object" and cmd.get("revision") != 0 and address == parent:
            parent_updates.append(row)
            continue
        if op != "note" and cmd.get("revision") != 0 and address in owned:
            require(ref is None, "a claimed-object change uses the host release ref")
            if op == "save_object":
                updates[address] = cmd
                continue
            cmd["revision"] = {"$ref": release_refs[address] + "/saved_revision"}
        result.append(row)
    releases = []
    for address, item in items.items():
        cmd = updates.get(address) or claims.save_command({**item, "current_revision": owned[address]}, None,
                                   "Publish the configured workflow result and release its claim.")
        cmd["data"] = {**cmd.get("data", {}), "assignee": None}
        releases.append({"ref": release_refs[address], "command": cmd})
    require(len(parent_updates) + len(releases) + len(result) <= 100, "publication and claim releases exceed one native batch")
    return [*parent_updates, *releases, *result]


def publish(api, config, target):
    assignment, claim = read(target / "input.json"), read(target / "claim.json")
    verify(api, config, assignment, claim)
    output = read(target / config["publication"]["file"])
    outcome = output.get("outcome", {"status": "published"})
    require(isinstance(outcome, dict) and set(outcome) <= {"status", "reason", "reason_code"} and
            outcome.get("status") in ("published", "blocked") and
            all(isinstance(outcome[key], str) for key in outcome), "invalid flow outcome")
    batch = operations(config, assignment, claim, output)
    result = publication.mutate(api, target / "publication.json", "joppa_batch",
                                {"workspace": config["workspace"], "operations": batch})
    require(len(result.get("results", [])) == len(batch), "publication response is incomplete; inspect its receipt")
    indices = [index for index, row in enumerate(batch) if str(row.get("ref", "")).startswith("flow_release")]
    revisions = {item["address"]: saved_revision(result, batch[indices[index]]["command"], indices[index])
                 for index, item in enumerate(members(assignment))}
    value = {**outcome, "selected_revision": revisions[assignment["selected"]["address"]],
             "item_revisions": revisions, "claim_released": True, "acceptance_verified": False}
    if config.get("failure_escalation"):
        value["failure_scope"] = failure_scope(config)
    write(target / "result.json", value)
    if assignment.get("items") or any(row["command"]["op"] == "archive_object" for row in batch):
        # The confirmed transaction is durable before optional reads of final node revisions.
        try:
            revisions = {address: object_read(api, config["workspace"], address, allow_archived=True)["current_revision"]
                         for address in revisions}
            write(target / "result.json", {**value, "item_revisions": revisions,
                  "selected_revision": revisions[assignment["selected"]["address"]]})
        except Exception as error:
            print("flow publication confirmed; final revision read failed: " + str(error))


def saved_revision(result, command, index=0):
    first = result.get("results", [result])[index]
    return (first.get("object") or {}).get("revision", command["revision"] + 1)


def fail(api, config, target, reason):
    for name in ("claim.json", "publication.json", "release.json"):
        receipt = target / name
        if receipt.exists() and read(receipt).get("status") in ("pending", "uncertain"):
            write(target / "result.json", {"status": "blocked", "reason": reason,
                  "claim_released": False, "needs_recovery": True, "acceptance_verified": False})
            return
    claim_path = target / "claim.json"
    released = False
    if claim_path.exists() and read(claim_path).get("status") == "confirmed":
        receipt = target / "publication.json"
        if receipt.exists() and read(receipt).get("status") in ("pending", "uncertain", "confirmed"):
            require(False, "publication needs receipt recovery; claim retained")
        claim = read(claim_path)
        owners = claims.owned(api, config["workspace"], claim)
        owned_revisions = {**claims.claimed_revisions(claim), **claim.get("revisions", {})}
        batch, addresses = [], list(claims.claimed(claim))
        policy = config.get("failure_escalation") if config.get("failure_notes", True) and \
            str(config.get("vars", {}).get("DRY_RUN", "false")).lower() != "true" else None
        counts = failure_counts(config, target, addresses) if policy else {}
        escalated = []
        for address in addresses:
            selected = object_read(api, config["workspace"], address)
            require(selected["current_revision"] == owned_revisions[address] and
                    claims.assignee_of(selected) == owners[address], "flow claim changed before failed release: " + address)
            command = claims.save_command(selected, None, "Release the failed configured workflow claim.")
            if policy and counts[address] >= policy["after"]:
                require(selected["kind"] in config["publication"]["update_kinds"], "failure escalation kind is outside the publication policy")
                command["data"].update(policy["data"])
                command["reason"] = reason[:1000]
                escalated.append(address)
            batch.append({"command": command})
            if config.get("failure_notes", True):
                batch.append({"command": claims.note(address, {"id": "flow-" + claims.run_id(target)[:40], "text": reason[:1000]})})
        result = publication.mutate(api, target / "release.json", "joppa_batch",
                                     {"workspace": config["workspace"], "operations": batch})
        released = True
        step = 2 if config.get("failure_notes", True) else 1
        revisions = {address: saved_revision(result, batch[index * step]["command"], index * step)
                     for index, address in enumerate(addresses)}
        revision = revisions[addresses[0]]
    else:
        revision, revisions = None, {}
    value = {"status": "blocked", "reason": reason, "claim_released": released,
             "selected_revision": revision, "item_revisions": revisions, "acceptance_verified": False}
    if released and policy:
        value.update(failure_scope=failure_scope(config), retry_failures=counts, failure_escalated=escalated,
                     reason_code="FAILURE_LIMIT" if escalated else "FLOW_FAILED")
    write(target / "result.json", value)
