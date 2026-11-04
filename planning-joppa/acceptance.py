"""Match criterion acceptance checks to the Tasks that carry them, including Tasks that cover a criterion."""
import re

from common import require
import context
import coverage
from joppa_reads import ended
from task_contracts import criterion_plan, check_line


def specification(check):
    return {key: check[key] for key in ("scenario", "command", "cwd", "expected") if key in check}


def covered_work(plan, assignment, order, included):
    """Validate Task covers. Return the planned covering Tasks and the retained check carriers of each criterion.
    A carrier is an unfinished Task under an unselected criterion. This plan never edits it."""
    spec = assignment["joppa"].get("covers")
    selected = set(order)
    dispositions = {item.get("ac"): item.get("disposition") for item in plan.get("criteria") or []
                    if isinstance(item, dict)}
    for task in plan.get("tasks", []):
        if task.get("covers") == [] or "covers" not in task:
            continue
        name = f"Task {task.get('id')}"
        require(spec, f"{name}: covers needs config.covers_reference; plan refused")
        values = task["covers"]
        require(isinstance(values, list) and all(isinstance(value, str) for value in values)
                and len(set(values)) == len(values), f"{name}: covers must list distinct criterion addresses")
        require(task.get("action") != "retire", f"{name}: a retired Task cannot cover criteria")
        for address in values:
            require(address in selected and address != task.get("ac"),
                    f"{name}: covered criterion {address} must be another selected criterion of this Requirement")
            require(address.split(":", 1)[0] == spec["target"],
                    f"{name}: covered criterion {address} is not of type {spec['target']}")
            require(dispositions.get(address) == "implement",
                    f"{name}: covered criterion {address} needs disposition implement")
    covering = {address: [task for task in plan.get("tasks", []) if task.get("action") != "retire"
                          and address in task.get("covers", [])] for address in order}
    carriers = {address: [] for address in order}
    if spec:
        kinds = {detail["task_type"] for detail in assignment["joppa"].get("criterion_schemas", {}).values()}
        kinds.add(assignment["joppa"]["task_type"])
        for existing in assignment["joppa"]["objects"].values():
            if existing.get("kind") not in kinds or ended(existing) or existing["address"] in included:
                continue
            for address in coverage.covered(existing["document"]["data"], spec):
                if address in carriers and address != existing["document"].get("parent"):
                    carriers[address].append(existing)
    return covering, carriers


def acceptance_rows(plan, assignment):
    """Map each planned Task ID to the criterion acceptance checks it carries: [{ac, check}].
    Use the same match as validate_one. Task-only checks, such as lint or build checks, stay outside."""
    if assignment["joppa"].get("scope") == "requirement":
        criteria = list(dict.fromkeys(item["id"] for item in context.selected_criteria(assignment)))
    else:
        criteria = [assignment["ac"]["id"]]
    rows = {}
    for address in criteria:
        value = criterion_plan(plan, assignment, address)
        if value.get("disposition") != "implement":
            continue
        for check in value.get("acceptance_checks", []):
            for task in plan.get("tasks", []):
                if (task.get("action") == "retire" or task.get("repository") != check.get("repository")
                        or (task.get("ac") != address and address not in task.get("covers", []))):
                    continue
                if any(specification(own) == specification(check) for own in task.get("checks", [])):
                    row = {"ac": address, "check": check_line(check)}
                    if row not in rows.setdefault(task["id"], []):
                        rows[task["id"]].append(row)
    return rows


def carries(task, address, check):
    """A retained Task carries a criterion check only when its stored acceptance mapping lists it,
    in the same repository. Otherwise the lane could not bind a test to it."""
    data = task["document"]["data"]
    body = context.task_contract(data)
    if re.findall(r"^Repository:[ \t]*([^\r\n]+)$", body, re.M) != [check["repository"]]:
        return False
    kind = address.split(":", 1)[0]
    rows = data.get("acceptance") if isinstance(data.get("acceptance"), list) else []
    return any(isinstance(row, dict) and row.get("check") == check_line(check)
               and (row.get("ac") if ":" in str(row.get("ac")) else kind + ":" + str(row.get("ac"))) == address
               for row in rows)
