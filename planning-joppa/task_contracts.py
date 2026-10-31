"""Reviewed Task publication helpers."""
from copy import deepcopy
import json
import re
from common import require, text
import context
MAX_PUBLICATION_OPERATIONS = 100
MAX_DATA_VALUE = 1024


def title_limit(schema):
    return schema.get("title_max_length") or schema.get("title_preview_length") or 64

def unclaimed(task):
    process = task["process"]
    require(not process.get("done") and not process.get("retired"),
            "completed or retired Tasks cannot be rewritten")
    require(not process.get("assignee") and not process.get("claim")
            and process.get("status") != "in_progress", "claimed Tasks cannot be rewritten by Crew planning")

def editable(task):
    unclaimed(task)
    require(task["document"]["data"].get("purpose") == "implementation",
            "only implementation Tasks can be rewritten by Crew planning")

def retirable(task):
    unclaimed(task)
    require(isinstance(task["process"].get("blocked"), dict),
            "only blocked Tasks can be retired by Crew planning")

def ordered_tasks(tasks):
    """Order prerequisites before consumers. Reject cycles and duplicate targets."""
    by_id, aliases = {}, {}
    for task in tasks:
        key = text(task.get("id"), "task.id")
        require(key not in by_id and ":" not in key, "local Task IDs must be unique and cannot contain a colon")
        by_id[key] = task
        if task.get("target"):
            require(task["target"] not in aliases, "duplicate Task update target")
            aliases[task["target"]] = key
    result, visiting, done = [], set(), set()
    def visit(key):
        if key in done:
            return
        require(key not in visiting, "planned Task dependencies contain a cycle")
        visiting.add(key)
        for dep in by_id[key].get("depends_on", []):
            local = aliases.get(dep, dep)
            if local in by_id:
                visit(local)
            else:
                require(":" in dep, f"unknown local prerequisite: {dep}")
        visiting.remove(key)
        done.add(key)
        result.append(by_id[key])
    for key in by_id:
        visit(key)
    return result

def criterion_plan(plan, assignment, address):
    if assignment["joppa"].get("scope") != "requirement":
        return deepcopy(plan)
    entries = plan.get("criteria")
    require(isinstance(entries, list), "Requirement plan needs a disposition for every selected AC")
    expected = {item["id"] for item in context.selected_criteria(assignment)}
    require(len(entries) == len(expected) and {item.get("ac") for item in entries} == expected,
            "Requirement plan dispositions must match all selected criteria")
    result = deepcopy(plan)
    result["disposition"] = next(item["disposition"] for item in entries if item["ac"] == address)
    result["tasks"] = [item for item in result["tasks"] if item.get("ac") == address]
    result["acceptance_checks"] = [item for item in result["acceptance_checks"] if item.get("ac") == address]
    return result

def package_counters(plan, assignment):
    """Reserve existing Task indices before numbering new work."""
    if assignment["joppa"].get("scope") != "requirement":
        return {}
    criteria = {item["id"] for item in context.selected_criteria(assignment)}
    for value in assignment.get("decisions", []):
        criteria.update(item["id"] for item in json.loads(value).get("acs", []))
    counters = {}
    for existing in assignment["joppa"]["objects"].values():
        if (existing["document"].get("parent") not in criteria
                or existing["process"].get("done") or existing["process"].get("retired")):
            continue
        data = existing["document"]["data"]
        if data.get("purpose") != "implementation":
            continue
        repository = re.findall(r"^Repository:[ \t]*([^\r\n]+)$", context.task_contract(data), re.M)
        if len(repository) != 1:
            continue
        repository = repository[0]
        match = re.match(r"^\[(\d+)\]\s", data.get("title", ""))
        counters[repository] = max(counters.get(repository, 0), int(match[1]) if match else 0)
    return counters

def title_budgets(assignment):
    """Reserve labels for every Task that can fit in one publication."""
    schemas = assignment["joppa"].get("criterion_schemas", {})
    limit = min(title_limit(schemas.get(item["id"], assignment["joppa"])["task_schema"])
                for item in context.selected_criteria(assignment))
    counters = package_counters({}, assignment)
    budgets = {repo["id"]: limit - len(f"[{counters.get(repo['id'], 0) + MAX_PUBLICATION_OPERATIONS:02d}] ")
               for repo in assignment["repositories"]}
    require(all(value > 0 for value in budgets.values()), "Task schema title limit cannot fit a generated label and title")
    return budgets

def task_title(task, objects, counters):
    """Preserve update labels. Dependencies determine execution order."""
    existing = objects.get(task.get("target"), {})
    data = existing.get("document", {}).get("data", {})
    prefix = re.match(r"^\[(\d+)\]\s", data.get("title", ""))
    repository = task["repository"]
    same_repository = (bool(data.get("body", data.get("contract"))) and
        re.findall(r"^Repository:[ \t]*([^\r\n]+)$", context.task_contract(data), re.M) == [repository])
    if prefix and same_repository:
        number = int(prefix[1])
    else:
        counters[repository] = counters.get(repository, 0) + 1
        number = counters[repository]
    return f"[{number:02d}] " + re.sub(r"^\[\d+\]\s*", "", text(task.get("title"), "task.title"))

def checked_task_title(task, assignment, counters):
    title = task_title(task, assignment["joppa"]["objects"], counters)
    schema = context.criterion_assignment(assignment, task["ac"])["joppa"]["task_schema"]
    limit = title_limit(schema)
    prefix = re.match(r"^\[\d+\] ", title)[0]
    require(len(title) <= limit,
            f"Task {task['id']}: ordered Task title exceeds its schema limit of {limit}; "
            f"use at most {max(0, limit - len(prefix))} characters before generated prefix {prefix!r}")
    return title

def check_line(check):
    method = check.get("scenario", "")
    if "command" in check:
        command = f"{check['command']} (cwd: {check['cwd']})"
        method = f"{method} [{command}]" if method else command
    return method + " => " + check["expected"]

def contract_fields(task):
    return {"body": "Goal: " + task["outcome"], "repository": task["repository"], "module": task["module"],
            "steps": [step if step.startswith("0. ") else re.sub(r"^\s*\d+\.\s+", "", step)
                      for step in task["steps"]], "checks": [check_line(check) for check in task["checks"]]}

def contract(task, plan):
    return context.task_contract(contract_fields(task))
