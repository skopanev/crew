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


def ensure_recovered(root, current, server, workspace, ac):
    """Refuse another claim while an earlier run needs receipt recovery."""
    for claim_file in Path(root).glob("*/artifacts/claim.json"):
        target = claim_file.parent
        if target.resolve() == current.resolve():
            continue
        claim = read(claim_file)
        args = claim.get("arguments", {})
        commands = [args["command"]] if "command" in args else [item["command"] for item in args.get("operations", [])]
        if args.get("workspace") != workspace or ac not in {item.get("ac") for item in commands}:
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
        repository = re.findall(r"^Repository:[ \t]*([^\r\n]+)$", data.get("contract", ""), re.M)
        if len(repository) != 1:
            continue
        repository = repository[0]
        match = re.match(r"^\[(\d+)\]\s", data.get("title", ""))
        counters[repository] = max(counters.get(repository, 0), int(match[1]) if match else 0)
    return counters


def task_title(task, objects, counters):
    """Preserve update labels. Dependencies determine execution order."""
    existing = objects.get(task.get("target"), {})
    data = existing.get("document", {}).get("data", {})
    prefix = re.match(r"^\[(\d+)\]\s", data.get("title", ""))
    repository = task["repository"]
    same_repository = re.findall(r"^Repository:[ \t]*([^\r\n]+)$", data.get("contract", ""), re.M) == [repository]
    if prefix and same_repository:
        number = int(prefix[1])
    else:
        counters[repository] = counters.get(repository, 0) + 1
        number = counters[repository]
    return f"[{number:02d}] " + re.sub(r"^\[\d+\]\s*", "", text(task.get("title"), "task.title"))


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
        if existing["address"] in retired | updates or existing["process"].get("done") or existing["process"].get("retired"):
            continue
        dependencies = {link["target"] for link in existing["document"].get("links", [])
                        if link.get("relation") == "depends_on" and link.get("blocking") is True}
        require(not dependencies.intersection(retired),
                f"retirement requires an update that removes the dependency from {existing['address']}")
    for existing in assignment["joppa"]["tasks"]:
        if existing["document"].get("parent") not in selected or existing["process"].get("done") or existing["process"].get("retired"):
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
            title = task_title(task, assignment["joppa"]["objects"], counters)
            schema = context.criterion_assignment(assignment, task["ac"])["joppa"]["task_schema"]
            require(len(title) <= schema.get("title_preview_length", 64), "ordered Task title exceeds its schema limit")
        for dependency in task.get("depends_on", []):
            require(dependency in local or dependency in assignment["joppa"]["objects"],
                    f"dependency was not read in the Requirement context: {dependency}")
    for address in selected:
        value = criterion_plan(plan, assignment, address)
        own = {task["id"] for task in value["tasks"]}
        for task in value["tasks"]:
            task["depends_on"] = [dependency for dependency in task.get("depends_on", [])
                                  if aliases.get(dependency, dependency) in own or dependency not in local and dependency not in aliases]
        validate_one(value, context.criterion_assignment(assignment, address))


def validate_one(plan, assignment):
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
            body = existing["document"]["data"].get("contract", "") if existing else ""
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
        if address in retired or existing["process"].get("done") or existing["process"].get("retired"):
            continue
        dependencies = {link["target"] for link in existing["document"].get("links", [])
                        if link.get("blocking") and link.get("relation") == "depends_on"}
        require(not dependencies.intersection(retired) or address in updates,
                f"retirement requires an update that removes the dependency from {address}")
    validation.plan(normalized, assignment)
    if plan.get("disposition") == "implement" and any(task["action"] != "retire" for task in normalized["tasks"]):
        fields = ("scenario", "command", "cwd", "expected")
        for check in plan["acceptance_checks"]:
            specification = {key: check[key] for key in fields if key in check}
            require(any(task["action"] != "retire" and task["repository"] == check["repository"]
                        and any({key: own[key] for key in fields if key in own} == specification
                                for own in task["checks"]) for task in normalized["tasks"]),
                    "every AC acceptance check must be assigned to Task checks in its repository")
    schema = assignment["joppa"]["task_schema"]
    limit = schema.get("title_preview_length", 64)
    for task in plan.get("tasks", []):
        require(len(task["title"]) <= limit, f"Task title exceeds the configured {limit}-character limit")


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
        evidence = text(check.get("evidence"), "acceptance_check.evidence")
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
    statuses = {}
    for repo, address, source, paths in binding_checks(plan, assignment):
        snapshot = snapshots.get(repo["id"], {})
        baseline = (prepared or snapshots).get(repo["id"], {})
        require(snapshot.get("head") and baseline.get("head"), "test evidence repository snapshot is missing")
        if source not in statuses:
            statuses[source] = api.call("joppa_tests", {"workspace": config["workspace"], "ac": source})
        status = statuses[source]
        require(status.get("address") == source, "test evidence belongs to another criterion")
        row = next((item for item in status.get("tests", []) if item["address"] == address), None)
        require(row is not None and row.get("status") == "pass", f"recorded passing result missing for {address}")
        commit = row.get("commit")
        require(isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", commit),
                "test execution evidence needs a commit")
        head = snapshot["head"]
        run(["git", "-C", repo["path"], "merge-base", "--is-ancestor", commit, head])
        run(["git", "-C", repo["path"], "diff", "--quiet", commit, head, "--", *paths])
        if prepared:
            run(["git", "-C", repo["path"], "diff", "--quiet", baseline["head"], head, "--", *paths])
    require(not any(item.get("status") in ("fail", "missing")
                    for item in assignment["joppa"]["test_status"]["tests"]),
            "existing criterion tests contain a failure or missing result")
    require(all(fingerprint(repo) == snapshots.get(repo["id"]) for repo in assignment["repositories"]),
            "source changed while checking existing test evidence")


def contract(task, plan):
    lines = ["Goal: " + task["outcome"], "",
             f"Repository: {task['repository']}", f"Module: {task['module']}", "", "How:"]
    steps = task["steps"]
    if steps[0].startswith("0. "):
        lines.append(steps[0])
        steps = steps[1:]
    lines.extend(f"{number}. " + re.sub(r"^\s*\d+\.\s+", "", step)
                 for number, step in enumerate(steps, 1))
    lines += ["", "Checks:"]
    for check in task["checks"]:
        method = check.get("scenario") or f"{check['command']} (cwd: {check['cwd']})"
        lines.append(method + " => " + check["expected"])
    return "\n".join(lines)


def operations(plan, assignment):
    validate(plan, assignment)
    inventory = {item["address"]: item for item in assignment["joppa"]["tasks"]}
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
            result.append({"command": {"op": "retire_task", "id": existing["address"].split(":", 1)[1],
                "revision": existing["current_revision"], "reason": task["outcome"]}})
            changed.add(ac)
            continue
        data = deepcopy(existing["document"]["data"]) if existing else {"owner": owner, "purpose": "implementation"}
        # Joppa execution uses implementation Tasks for both code and scoped verification.
        # Verification evidence remains a separate operation.
        title = task["title"]
        if grouped:
            title = task_title(task, objects, counters)
            require(len(title) <= schema.get("title_preview_length", 64), "ordered Task title exceeds its schema limit")
        data.update(title=title, contract=contract(task, plan))
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
        if existing:
            command["id"] = existing["address"].split(":", 1)[1]
            document = existing["document"]
            if data == document["data"] and links == document["links"] and ac == document["parent"]:
                continue
        ref = "task" + str(number)
        result.append({"ref": ref, "command": command})
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
        status = scope["joppa"]["test_status"]
        tests = list(dict.fromkeys([*[item["address"] for item in status["tests"]],
                                   *[check["test"] for check in value["acceptance_checks"]]]))
        require(len(tests) <= 200, "criterion supports at most 200 tests")
        if tests != [item["address"] for item in status["tests"]] or status["tests_draft"]:
            result.append({"command": {"op": "set_ac_tests", "target": ac, "tests": tests,
                "revision": status.get("tests_revision") or 0,
                "reason": "Bind existing tests after review of every criterion assertion."}})
            changed.add(ac)
    for criterion in context.selected_criteria(assignment):
        ac = criterion["id"]
        blocked = any(task["document"]["parent"] == ac and isinstance(task["process"].get("blocked"), dict)
                      and not task["process"].get("done") and not task["process"].get("retired") for task in inventory.values())
        result.append({"command": {"op": "finish_planning" if not grouped or ac in changed or blocked else "release_planning", "ac": ac,
            "reason": "Publish the reviewed Requirement plan." if grouped
                      else "Publish reviewed test bindings." if plan["disposition"] == "verify_existing"
                      else "Publish reviewed Tasks. The criterion still requires verification."}})
    require(len(result) <= 100, "one publication supports at most 100 operations")
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


def held(api, workspace, address, position, actor=None):
    obj = api.call("joppa_objects", {"workspace": workspace, "address": address})
    claim = obj.get("process", {}).get("planning_claim")
    require(isinstance(claim, dict) and claim.get("position") == position
            and (actor is None or claim.get("actor") == actor), "this run does not hold the planning claim")
    return claim


def claim_entries(receipt):
    require(receipt["status"] == "confirmed", "planning claim was not confirmed")
    results = receipt["result"].get("results", [receipt["result"]])
    args = receipt["arguments"]
    commands = [args["command"]] if "command" in args else [item["command"] for item in args["operations"]]
    require(len(results) == len(commands), "planning claim response is incomplete; inspect claim.json")
    entries = []
    for command, result in zip(commands, results):
        address = command["ac"]
        require(type(result.get("position")) is int, "planning claim response has no event position; inspect claim.json")
        actor = receipt.get("holders", {}).get(address, receipt.get("actor"))
        entries.append((address, result["position"], actor))
    return entries


def held_claims(api, workspace, receipt):
    return {address: held(api, workspace, address, position, actor)["actor"]
            for address, position, actor in claim_entries(receipt)}


def release(api, target, workspace, ac, reason):
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
    holders, skipped = {}, []
    for address, position, actor in claim_entries(receipt):
        try:
            object = api.call("joppa_objects", {"workspace": workspace, "address": address})
            require(isinstance(object, dict) and isinstance(object.get("process"), dict), "claim read is incomplete")
        except Exception:
            skipped.append({"ac": address, "reason": "planning claim could not be read", "unknown": True})
            continue
        claim = object.get("process", {}).get("planning_claim")
        if not isinstance(claim, dict) or claim.get("position") != position or actor is not None and claim.get("actor") != actor:
            skipped.append({"ac": address, "reason": "planning claim is missing or replaced"})
            continue
        holders[address] = claim["actor"]
    if holders:
        write(claim_file, {**receipt, "holders": {**receipt.get("holders", {}), **holders}})
    operations = [{"command": {"op": "release_planning", "ac": address, "reason": reason[:2000]}}
                  for address in holders]
    if not operations:
        write(prior, {"status": "confirmed", "released": [], "skipped_claims": skipped})
        return not any(item.get("unknown") for item in skipped)
    tool = "joppa_batch" if "operations" in receipt["arguments"] else "joppa_command"
    arguments = {"workspace": workspace, "operations": operations} if tool == "joppa_batch" else {
        "workspace": workspace, "command": operations[0]["command"]}
    try:
        mutate(api, prior, tool, arguments)
    finally:
        if prior.exists():
            release = read(prior)
            write(prior, {**release, "released": list(holders) if release["status"] == "confirmed" else [],
                          "requested_releases": list(holders), "skipped_claims": skipped})
    return not any(item.get("unknown") for item in skipped)
