"""Validate and publish reviewed Task mechanisms in one Joppa transaction."""
from copy import deepcopy
from pathlib import Path
from uuid import uuid4
import json
import re

from common import digest, fingerprint, inside, read, require, run, strings, text, write
from mcp import Rejected
import validation
import context

from task_contracts import (
    MAX_PUBLICATION_OPERATIONS, MAX_DATA_VALUE, title_limit, unclaimed, editable, retirable, ordered_tasks,
    criterion_plan, package_counters, title_budgets, task_title, checked_task_title, check_line,
    contract_fields, contract,
)
from plan_validation import validate, validate_one, binding_checks, verify_bindings, acceptance_rows
from test_nodes import bind_missing
from joppa_reads import blocked, ended
from context_reads import object_read
from planning_claims import address_of, closing_operations, release, owned, require_fenced



def depends_edges(links):
    """The depends_on edges of a link list in the Joppa relations form. A pin stays only when the link has one."""
    return [{"to": link["target"], **({"revision": link["revision"]} if link.get("revision") is not None else {})}
            for link in links if link.get("relation") == "depends_on"]

def ensure_recovered(root, current, server, workspace, ac):
    """Refuse another claim while an earlier run needs receipt recovery."""
    for claim_file in Path(root).glob("*/artifacts/claim.json"):
        target = claim_file.parent
        if target.resolve() == current.resolve():
            continue
        claim = read(claim_file)
        args = claim.get("arguments", {})
        commands = [args["command"]] if "command" in args else [item["command"] for item in args.get("operations", [])]
        if args.get("workspace") != workspace or ac not in {address_of(item) for item in commands}:
            continue
        if claim.get("server") and claim["server"] != server:
            continue
        receipts = [read(target / name) for name in ("claim.json", "publication.json", "release.json")
                    if (target / name).exists()]
        require(not any(item.get("status") in ("pending", "uncertain") for item in receipts),
                f"earlier run needs receipt recovery: {target}")
        if claim.get("status") == "confirmed":
            release = read(target / "release.json") if (target / "release.json").exists() else {}
            released = release.get("status") == "confirmed" and not any(
                item.get("ac") == ac and item.get("unknown") for item in release.get("skipped_claims", []))
            finished = (target / "result.json").exists() and read(target / "result.json").get("status") == "published"
            require(released or finished, f"earlier claim or publication needs recovery: {target}")


COMMIT = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def dependency_targets(plan, types):
    """Explicit local Task targets of plan.depends_on. Skip Tasks saved in this batch.
    An inherited link that the batch keeps exactly needs no read: Joppa accepts it with an absent target."""
    aliases = {task["id"]: task["target"] for task in plan["tasks"] if task.get("target")}
    own = set(aliases) | set(aliases.values()) | {task["id"] for task in plan["tasks"]}
    candidates = set()
    for task in plan["tasks"]:
        if task["action"] == "retire":
            continue
        candidates.update(aliases.get(dependency, dependency) for dependency in task["depends_on"])
    result = []
    for address in sorted(item for item in candidates if isinstance(item, str) and ":" in item and item not in own):
        kind = address.split(":", 1)[0]
        require(kind in types, f"dependency type {kind} is not in the workspace schema")
        if types[kind].get("role") == "task":
            result.append(address)
    return result


def completed_dependencies(api, workspace, plan, types):
    """Read each dependency target once before the batch. Return the done Tasks: archived with a valid data.commit.
    Refuse an unreadable, missing or retired target before any write."""
    completed = set()
    for address in dependency_targets(plan, types):
        try:
            object = object_read(api, workspace, address, allow_archived=True)
        except Exception as error:
            raise ValueError(f"dependency {address} could not be read before publication: {error}") from None
        if not ended(object):
            continue
        commit = object["document"]["data"].get("commit")
        require(isinstance(commit, str) and COMMIT.fullmatch(commit),
                f"dependency {address} is archived without a valid commit; revise the plan")
        completed.add(address)
    return completed


def operations(plan, assignment, completed=frozenset()):
    """Compose the batch. A dependency in completed is satisfied: keep its existing link unchanged or add none."""
    validate(plan, assignment)
    inventory = {item["address"]: item for item in assignment["joppa"]["tasks"]}
    targets = {task.get("target") for task in plan["tasks"] if task["action"] in ("update", "retire")}
    for existing in inventory.values():
        if blocked(existing):
            require(existing["address"] in targets,
                    f"blocked Task {existing['address']} needs a new contract or retirement")
    repositories = {item["id"]: item for item in assignment["repositories"]}
    objects = assignment["joppa"]["objects"]
    grouped = assignment["joppa"].get("scope") == "requirement"
    result, refs = [], {}
    retired = {task["target"] for task in plan["tasks"] if task["action"] == "retire"}
    aliases = {task["id"]: task["target"] for task in plan["tasks"] if task.get("target")}
    changed, counters = set(), package_counters(plan, assignment)
    acceptance, spec = acceptance_rows(plan, assignment), assignment["joppa"].get("covers")
    for number, task in enumerate(ordered_tasks(plan["tasks"]), 1):
        ac = task["ac"]
        scope = context.criterion_assignment(assignment, ac)
        schema = scope["joppa"]["task_schema"]
        owner = objects[ac]["document"]["data"].get("owner")
        require(owner, "criterion owner is required for new Task documents")
        existing = inventory.get(task.get("target"))
        if task["action"] == "retire":
            # Retirement archives the Task without data.commit. Done Tasks carry the commit.
            result.append({"command": {"op": "archive_object", "target": existing["address"],
                "revision": existing["current_revision"], "reason": task["outcome"]}})
            changed.add(ac)
            continue
        data = deepcopy(existing["document"]["data"]) if existing else {"owner": owner}
        # Joppa execution uses implementation Tasks for both code and scoped verification.
        # Verification evidence remains a separate operation.
        title = task["title"]
        if grouped:
            title = checked_task_title(task, assignment, counters)
        data["title"] = title
        fields = contract_fields(task)
        if not existing or context.task_contract(data) != context.task_contract(fields):
            data.update(fields)
        if "contract" in data:
            data.setdefault("body", data["contract"])
            del data["contract"]
        # The lane binds one verified test to each listed criterion check. Task-only checks stay outside.
        # Joppa reserves data.acceptance for process commands. The authored mapping is data.acceptance_checks.
        data.pop("acceptance_checks", None)
        if acceptance.get(task["id"]):
            data["acceptance_checks"] = acceptance[task["id"]]
        if spec:
            # Write full criterion addresses. The parent criterion still owns update and retirement.
            data.pop(spec["field"], None)
            if task.get("covers"):
                data[spec["field"]] = list(task["covers"])
        project = repositories[task["repository"]]["project"]
        project_id = project.split(":", 1)[1]
        projects = list(data.get("projects") or [])
        if project_id not in projects:
            if project not in projects:
                projects.append(project_id)
        data["projects"] = projects
        links = deepcopy(existing["document"].get("links", [])) if existing else []
        links = [link for link in links if not (link.get("blocking") and link.get("relation") == "depends_on"
                                                and link.get("target") in retired)]
        for dependency in task["depends_on"]:
            canonical = aliases.get(dependency, dependency)
            if canonical in completed:
                # Joppa accepts an absent target only in a link that exactly matches an existing link.
                continue
            if dependency in refs:
                target = {"$ref": refs[dependency] + "/address"}
            else:
                require(canonical in objects, f"unknown dependency: {dependency}")
                target = canonical
            # Joppa orders work by the current target state. A new ordering link needs no revision pin.
            candidate = {"target": target, "relation": "depends_on", "blocking": True}
            # An explicit dependency in this plan replaces its earlier revision pin.
            links = [link for link in links if not (link.get("relation") == "depends_on"
                                                   and link.get("target") in (canonical, target))]
            links.append(candidate)
        reopen = bool(existing) and blocked(existing)
        if reopen:
            # The revised contract answers the block. The same save clears the hold.
            data.pop("hold", None)
        # clean replaces the whole data, so a removed field does not survive the merge.
        # Only the depends_on key is sent. Joppa keeps the other relation keys.
        command = {"op": "save_object", "kind": scope["joppa"]["task_type"],
                   "revision": existing["current_revision"] if existing else 0,
                   "parent": ac, "data": data, **({"clean": True} if existing else {}),
                   "reason": "Publish the reviewed mechanism for this criterion."}
        edges = depends_edges(links)
        if edges or existing:
            command["relations"] = {"depends_on": {"edges": edges}}
        if existing:
            command["id"] = existing["address"].split(":", 1)[1]
            document = existing["document"]
            if reopen:
                require(context.task_contract(data) != context.task_contract(document["data"]),
                        f"blocked Task {existing['address']} needs a new contract or retirement")
            if (data == document["data"] and edges == depends_edges(document["links"])
                    and ac == document["parent"]):
                continue
        ref = "task" + str(number)
        result.append({"ref": ref, "command": command})
        changed.add(ac)
        changed.update(task.get("covers", []))
        refs[task["id"]] = ref
        if existing:
            refs[existing["address"]] = ref
    for criterion in context.selected_criteria(assignment):
        ac = criterion["id"]
        scope = context.criterion_assignment(assignment, ac)
        value = criterion_plan(plan, assignment, ac)
        if value["disposition"] != "verify_existing":
            continue
        # Create only the missing (criterion, test) nodes. Existing nodes keep their results.
        bindings = bind_missing(ac, [check["test"] for check in value["acceptance_checks"]],
                                scope["joppa"]["test_nodes"], scope["joppa"],
                                objects[ac]["document"]["data"].get("owner"))
        result.extend(bindings)
        if bindings:
            changed.add(ac)
    for criterion in context.selected_criteria(assignment):
        ac = criterion["id"]
        held = any(task["document"]["parent"] == ac and blocked(task) for task in inventory.values())
        result.extend(closing_operations(objects[ac], not grouped or ac in changed or held,
            "Publish the reviewed Requirement plan." if grouped
            else "Publish reviewed test bindings." if plan["disposition"] == "verify_existing"
            else "Publish reviewed Tasks. The criterion still requires verification."))
    require(len(result) <= MAX_PUBLICATION_OPERATIONS, f"one publication supports at most {MAX_PUBLICATION_OPERATIONS} operations")
    return require_fenced(result)


def mutate(api, target, name, arguments, *, retain_claim=False):
    """Record each request before its only attempt. Retain uncertain results."""
    require(not target.exists(), f"mutation already attempted: inspect {target.name}; no automatic retry")
    args = deepcopy(arguments)
    args["request_id"] = "crew-planning-" + str(uuid4())
    record = {"tool": name, "arguments": args, "status": "pending", "server": getattr(api, "url", None)}
    if retain_claim:
        record["retain_claim"] = True
    write(target, record)
    try:
        result = api.call(name, args)
    except Rejected as error:
        write(target, {**record, "status": "rejected", "error": str(error)})
        raise
    except Exception as error:
        write(target, {**record, "status": "uncertain", "error": str(error)})
        raise
    write(target, {**record, "status": "confirmed", "result": result})
    return result
