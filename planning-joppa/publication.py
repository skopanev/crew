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
from plan_validation import validate, validate_one, binding_checks, verify_bindings
from test_nodes import bind_missing
from planning_claims import address_of, closing_operations, release, owned


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


def operations(plan, assignment):
    validate(plan, assignment)
    inventory = {item["address"]: item for item in assignment["joppa"]["tasks"]}
    targets = {task.get("target") for task in plan["tasks"] if task["action"] in ("update", "retire")}
    for existing in inventory.values():
        if (isinstance(existing["process"].get("blocked"), dict)
                and not existing["process"].get("done") and not existing["process"].get("retired")):
            require(existing["address"] in targets,
                    f"blocked Task {existing['address']} needs a new contract or retirement")
    repositories = {item["id"]: item for item in assignment["repositories"]}
    objects = assignment["joppa"]["objects"]
    grouped = assignment["joppa"].get("scope") == "requirement"
    result, refs = [], {}
    retired = {task["target"] for task in plan["tasks"] if task["action"] == "retire"}
    aliases = {task["id"]: task["target"] for task in plan["tasks"] if task.get("target")}
    changed, counters = set(), package_counters(plan, assignment)
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
            if dependency in refs:
                target, revision = {"$ref": refs[dependency] + "/address"}, {"$ref": refs[dependency] + "/saved_revision"}
            else:
                require(canonical in objects, f"unknown dependency: {dependency}")
                target, revision = canonical, objects[canonical]["current_revision"]
            candidate = {"target": target, "revision": revision, "relation": "depends_on", "blocking": True}
            # An explicit dependency in this plan replaces its earlier revision pin.
            links = [link for link in links if not (link.get("relation") == "depends_on"
                                                   and link.get("target") in (canonical, target))]
            links.append(candidate)
        command = {"op": "save_object", "kind": scope["joppa"]["task_type"],
                   "revision": existing["current_revision"] if existing else 0,
                   "parent": ac, "data": data, "links": links,
                   "reason": "Publish the reviewed mechanism for this criterion.", "question_checked": schema["question"]}
        reopen = False
        if existing:
            command["id"] = existing["address"].split(":", 1)[1]
            document = existing["document"]
            reopen = (isinstance(existing["process"].get("blocked"), dict)
                      and not existing["process"].get("done") and not existing["process"].get("retired"))
            if reopen:
                require(context.task_contract(data) != context.task_contract(document["data"]),
                        f"blocked Task {existing['address']} needs a new contract or retirement")
            if data == document["data"] and links == document["links"] and ac == document["parent"]:
                continue
        ref = "task" + str(number)
        result.append({"ref": ref, "command": command})
        if reopen:
            # The revised contract answers the block. Mark the same Task ready in this transaction.
            result.append({"command": {"op": "assess", "target": existing["address"], "ready": True,
                                       "reason": "The reviewed plan replaces the blocked contract."}})
        changed.add(ac)
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
        blocked = any(task["document"]["parent"] == ac and isinstance(task["process"].get("blocked"), dict)
                      and not task["process"].get("done") and not task["process"].get("retired") for task in inventory.values())
        result.extend(closing_operations(objects[ac], not grouped or ac in changed or blocked,
            "Publish the reviewed Requirement plan." if grouped
            else "Publish reviewed test bindings." if plan["disposition"] == "verify_existing"
            else "Publish reviewed Tasks. The criterion still requires verification.",
            assignment["joppa"].get("questions", {}).get(objects[ac]["kind"])))
    require(len(result) <= MAX_PUBLICATION_OPERATIONS, f"one publication supports at most {MAX_PUBLICATION_OPERATIONS} operations")
    return result


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
