"""Reviewed Task publication helpers."""
from copy import deepcopy
from pathlib import Path
import re
from common import fingerprint, inside, require, run, strings, text
import validation
import context
from test_nodes import node_results, read_nodes
from joppa_reads import ended
from task_contracts import MAX_DATA_VALUE, title_limit, unclaimed, editable, retirable, ordered_tasks, criterion_plan, package_counters, checked_task_title, check_line, contract_fields


def validate(plan, assignment):
    if assignment["joppa"].get("scope") != "requirement":
        return validate_one(plan, assignment)
    selected = {item["id"] for item in context.selected_criteria(assignment)}
    require(all(task.get("ac") in selected for task in plan.get("tasks", [])),
            "Task must belong to a selected Requirement criterion")
    require(all(check.get("ac") in selected for check in plan.get("acceptance_checks", [])),
            "every acceptance check needs its selected criterion address")
    included = {task.get("target") for task in plan.get("tasks", []) if task.get("action") in ("update", "retire")}
    retired = {value for task in plan.get("tasks", []) if task.get("action") == "retire"
               for value in (task["id"], task.get("target"))}
    updates = {task.get("target") for task in plan.get("tasks", []) if task.get("action") == "update"}
    for task in plan.get("tasks", []):
        require(not set(task.get("depends_on", [])).intersection(retired), "Task cannot depend on a Task retired by this plan")
    for existing in assignment["joppa"]["objects"].values():
        if existing["address"] in retired | updates or ended(existing):
            continue
        dependencies = {link["target"] for link in existing["document"].get("links", [])
                        if link.get("relation") == "depends_on" and link.get("blocking") is True}
        require(not dependencies.intersection(retired),
                f"retirement requires an update that removes the dependency from {existing['address']}")
    for existing in assignment["joppa"]["tasks"]:
        if existing["document"].get("parent") not in selected or ended(existing):
            continue
        unclaimed(existing)
        require(existing["address"] in included,
                f"Requirement plan must explicitly update or retire unfinished Task {existing['address']}")
    ordered = ordered_tasks(plan.get("tasks", []))
    local = {task["id"]: task for task in ordered}
    aliases = {task["target"]: task["id"] for task in ordered if task.get("target")}
    counters = package_counters(plan, assignment)
    for task in ordered:
        if task.get("action") != "retire":
            checked_task_title(task, assignment, counters)
        for dependency in task.get("depends_on", []):
            require(dependency in local or dependency in assignment["joppa"]["objects"],
                    f"dependency was not read in the Requirement context: {dependency}")
    for address in selected:
        value = criterion_plan(plan, assignment, address)
        own = {task["id"] for task in value["tasks"]}
        for task in value["tasks"]:
            task["depends_on"] = [dependency for dependency in task.get("depends_on", [])
                                  if aliases.get(dependency, dependency) in own or dependency not in local and dependency not in aliases]
        validate_one(value, context.criterion_assignment(assignment, address), plan.get("tasks", []))

def validate_one(plan, assignment, elsewhere=()):
    normalized = deepcopy(plan)
    normalized["tasks"] = ordered_tasks(normalized.get("tasks", []))
    if normalized.get("disposition") == "verify_existing":
        require(all(task.get("action") == "retire" for task in normalized["tasks"]),
                "existing covered behavior must not create verification work")
        normalized["disposition"] = "implement" if normalized["tasks"] else "verify_existing"
        binding_checks(plan, assignment)
    inventory = {item["address"]: item for item in assignment["joppa"]["tasks"]}
    known = assignment["joppa"]["objects"]
    targets = set()
    retired = {value for task in normalized["tasks"] if task.get("action") == "retire"
               for value in (task["id"], task.get("target"))}
    for task in normalized.get("tasks", []):
        require(task.get("action") in ("create", "update", "retire"), "Task action must be create, update or retire")
        existing = None
        if task["action"] in ("update", "retire"):
            address = text(task.get("target"), "Task target")
            require(address in inventory and address not in targets, "update must target one existing Task under this AC")
            existing = inventory[address]
            (retirable if task["action"] == "retire" else editable)(existing)
            require(task.get("revision") == existing["current_revision"], "Task source revision differs from the input")
            targets.add(address)
        else:
            require("target" not in task and "revision" not in task, "new Task cannot replace an existing Task")
        if task["action"] != "retire":
            steps = strings(task.get("steps"), "task.steps")
            body = context.task_contract(existing["document"]["data"]) if existing else ""
            how = re.search(r"(?ms)^How:\s*\n(.*?)(?=^Checks:|\Z)", body)
            recovery = re.findall(r"(?m)^0\. [^\r\n]+$", how[1] if how else "")
            require(len(recovery) <= 1, "Task has multiple recovery steps")
            if recovery:
                for field, key in (("Repository", "repository"), ("Module", "module")):
                    require(re.findall(r"^" + field + r":[ \t]*([^\r\n]+)$", body, re.M) == [task[key]],
                            f"recovery step 0 scope mismatch: {task['target']}")
                require(steps[0] == recovery[0], f"Task must preserve recovery step 0: {task['target']}")
                task["steps"] = steps[1:]
            require(not any(re.match(r"\s*0\.\s", step) for step in task["steps"]),
                    "Task cannot add or duplicate recovery step 0")
        dependencies = strings(task.get("depends_on"), "task.depends_on", empty=True)
        require(not set(dependencies).intersection(retired), "Task cannot depend on a Task retired by this plan")
        require(task["action"] != "retire" or not dependencies, "retirement cannot add dependencies")
        for dep in dependencies:
            if ":" in dep:
                require(dep in known, f"dependency was not read in the criterion context: {dep}")
                require(dep != task.get("target"), "Task cannot depend on itself")
        aliases = {item.get("target"): item["id"] for item in normalized["tasks"] if item.get("target")}
        task["depends_on"] = [aliases.get(dep, dep) for dep in dependencies if ":" not in dep or dep in aliases]
    updates = {task["target"] for task in normalized["tasks"] if task["action"] == "update"}
    for address, existing in inventory.items():
        if address in retired or ended(existing):
            continue
        dependencies = {link["target"] for link in existing["document"].get("links", [])
                        if link.get("blocking") and link.get("relation") == "depends_on"}
        require(not dependencies.intersection(retired) or address in updates,
                f"retirement requires an update that removes the dependency from {address}")
    validation.plan(normalized, assignment)
    if plan.get("disposition") == "implement" and any(task["action"] != "retire" for task in normalized["tasks"]):
        retained = [task for task in inventory.values() if task["address"] not in targets
                    and not ended(task)]
        for check in plan["acceptance_checks"]:
            assigned = any(task["action"] != "retire" and task["repository"] == check["repository"]
                           and any(specification(own) == specification(check) for own in task["checks"])
                           for task in normalized["tasks"])
            for task in retained:
                body = context.task_contract(task["document"]["data"])
                checks = body.partition("\nChecks:\n")[2].splitlines()
                assigned |= (re.findall(r"^Repository:[ \t]*([^\r\n]+)$", body, re.M) == [check["repository"]]
                             and check_line(check) in checks)
            if not assigned:
                raise ValueError(missing_check(check, assignment["ac"]["id"], elsewhere))
    schema = assignment["joppa"]["task_schema"]
    limit = title_limit(schema)
    for task in plan.get("tasks", []):
        require(len(task["title"]) <= limit, f"Task title exceeds the configured {limit}-character limit")
        if task["action"] != "retire":
            existing = inventory.get(task.get("target"))
            fields = contract_fields(task)
            if not existing or context.task_contract(existing["document"]["data"]) != context.task_contract(fields):
                for key, value in fields.items():
                    entries = enumerate(value) if isinstance(value, list) else [(None, value)]
                    for index, entry in entries:
                        path = key if index is None else f"{key}[{index}]"
                        require(len(entry) <= MAX_DATA_VALUE,
                                f"Task {task['id']}: data.{path} has {len(entry)} characters; "
                                f"use at most {MAX_DATA_VALUE}; no text was truncated")

def specification(check):
    return {key: check[key] for key in ("scenario", "command", "cwd", "expected") if key in check}

def bounded(value, limit=160):
    return value if len(value) <= limit else value[:limit - 3] + "..."

def missing_check(check, address, elsewhere):
    """Name the unassigned check and a Task under another AC that carries the same check."""
    message = (f"AC {address}: acceptance check \"{bounded(check_line(check))}\" must be assigned to Task checks "
               f"of a Task under this AC in repository {check['repository']}")
    found = next((task for task in elsewhere if task.get("ac") != address and task.get("action") != "retire"
                  and task.get("repository") == check["repository"]
                  and any(specification(own) == specification(check) for own in task.get("checks", []))), None)
    if found:
        message += (f"; Task {found['id']} \"{bounded(found.get('title', ''))}\" under AC {found['ac']} carries it,"
                    " but a Task under another AC does not satisfy this AC")
    return message

def binding_checks(plan, assignment):
    repositories = {repo["id"]: repo for repo in assignment["repositories"]}
    checks = plan.get("acceptance_checks")
    require(isinstance(checks, list) and checks, "existing coverage requires test assertions")
    result = []
    for check in checks:
        repo = repositories.get(check.get("repository"))
        require(repo is not None, "test repository is not configured")
        address = text(check.get("test"), "acceptance_check.test")
        parts = address.split(" > ")
        require(len(parts) >= 2 and all(part.strip() for part in parts)
                and len(address) <= 400 and not re.search(r"[\x00-\x1f\x7f-\x9f]", address),
                "test address requires file > test name")
        test = inside(repo["path"], parts[0])
        require(test.is_file() and test.suffix, "bound test file does not exist")
        evidence = text(check.get("evidence"), f"acceptance_check.evidence for {check.get('ac', assignment['ac']['id'])}: {address}")
        citations = re.findall(re.escape(repo["id"]) + r":([^\s:;]+):(\d+)\b", evidence)
        require(citations, "assertion evidence requires repository:path:line")
        paths = {parts[0]}
        for relative, line in citations:
            file = inside(repo["path"], relative)
            require(file.is_file() and 0 < int(line) <= len(file.read_text().splitlines()),
                    "assertion evidence file or line is absent")
            paths.add(relative)
        require(parts[0] in {relative for relative, _ in citations}, "cite an assertion in the bound test file")
        require(paths - {parts[0]}, "cite a covered implementation file")
        paths.add(str(Path(parts[0]).parent))
        source = check.get("source_ac", assignment["ac"]["id"])
        require(source in assignment["joppa"]["objects"], "test source AC must be read in the current context")
        result.append((repo, address, source, sorted(paths)))
    return result

def verify_bindings(api, config, plan, assignment, snapshots, prepared=None):
    """Read execution evidence and verify its cited source before a binding write."""
    workspace, kind, checks = config["workspace"], assignment["joppa"]["test_type"], binding_checks(plan, assignment)
    nodes, results = {}, {}
    for source in dict.fromkeys(source for _, _, source, _ in checks):
        names = {address for _, address, own, _ in checks if own == source}
        nodes[source] = {node["title"]: node for node in read_nodes(api, workspace, kind, source, [source])[source]}
        results.update(node_results(api, workspace, [node for title, node in nodes[source].items() if title in names],
                                    source))
    for repo, address, source, paths in checks:
        snapshot = snapshots.get(repo["id"], {})
        baseline = (prepared or snapshots).get(repo["id"], {})
        require(snapshot.get("head") and baseline.get("head"), "test evidence repository snapshot is missing")
        # A pass exists only on a bound node. An absent node never counts as a pass.
        node = nodes[source].get(address)
        row = node and results[node["address"]]
        require(row is not None and row.get("status") == "pass", f"recorded passing result missing for {address}")
        commit = row.get("commit")
        require(isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", commit),
                "test execution evidence needs a commit")
        head = snapshot["head"]
        run(["git", "-C", repo["path"], "merge-base", "--is-ancestor", commit, head])
        run(["git", "-C", repo["path"], "diff", "--quiet", commit, head, "--", *paths])
        if prepared:
            run(["git", "-C", repo["path"], "diff", "--quiet", baseline["head"], head, "--", *paths])
    existing = [node for node in assignment["joppa"]["test_nodes"] if node["status"] != "green"]
    require(all(node["status"] != "red" for node in existing), "existing criterion tests contain a failure or missing result")
    for row in node_results(api, workspace, existing, assignment["ac"]["id"]).values():
        require(row and row["status"] != "fail", "existing criterion tests contain a failure or missing result")
    require(all(fingerprint(repo) == snapshots.get(repo["id"]) for repo in assignment["repositories"]),
            "source changed while checking existing test evidence")
