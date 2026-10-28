"""Joppa process nodes around the shared planning graph."""
import atexit
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "planning"))
from common import digest, fingerprint, read, require, run, signal, write
import stages as shared
import context
import publication

_failure_message = None


def report_failure():
    if _failure_message:
        print(_failure_message, file=sys.stderr, flush=True)


def settings():
    path = Path(os.environ["PLANNING_JOPPA_CONFIG"])
    config = context.configuration(path)
    expected = os.environ["PLANNING_JOPPA_CONFIG_DIGEST"]
    require(digest(config) == expected, "planner configuration changed during the run")
    return config


def reader_servers():
    config = settings()
    if config.get("mcp_command"):
        authentication = ["--mcp-command", json.dumps(config["mcp_command"])]
    else:
        token_file = config.get("reader_token_file")
        require(token_file and Path(token_file).is_file(), "config.reader_token_file must name a read-only Joppa token")
        authentication = ["--token-file", token_file]
    return {"joppa": {"command": os.environ["PLANNING_PYTHON"], "args": [
        str(Path(__file__).resolve().with_name("mcp.py")), "--url", config["url"],
        "--workspace", config["workspace"], *authentication,
        "--artifacts", str(shared.artifacts())]}}


def prepare_reader():
    servers = reader_servers()
    config = Path(os.environ["AGY_PROFILE_HOME"]) / "joppa-reader.json"
    write(config, {"mcpServers": servers})
    config.chmod(0o600)
    shared.emit_var("PLANNING_MCP_CONFIG", str(config))
    shared.emit_var("PLANNING_MCP_TOOLS_OPTION", "--allowedTools")
    shared.emit_var("PLANNING_MCP_TOOLS", "mcp__joppa__*")
    server = servers["joppa"]
    shared.emit_var("PLANNING_MCP_OPTION", "-c")
    shared.emit_var("PLANNING_MCP_TOML", "mcp_servers.joppa={command=" + json.dumps(server["command"])
                    + ",args=" + json.dumps(server["args"]) + ",required=true}")
    return servers


def prepare_critic():
    codex = os.environ["MEDULLA_HARNESS"] == "codex"
    shared.emit_var("PLANNING_CRITIC_MCP_OPTION", "-c" if codex else "")
    shared.emit_var("PLANNING_CRITIC_MCP_TOML", os.environ["PLANNING_MCP_TOML"] if codex else "")
    if os.environ["MEDULLA_HARNESS"] == "agy":
        shared.prepare_agy(mcp_servers=reader_servers())


def prepare():
    target = shared.artifacts()
    target.mkdir(parents=True, exist_ok=True)
    config = settings()
    reader_servers()
    api = context.client(config)
    help = api.call("joppa_help", {"workspace": config["workspace"]})
    advertised = json.dumps(help)
    require(all(name in advertised for name in ("claim_planning", "finish_planning", "release_planning")),
            "Joppa planning commands are not deployed; no claim was attempted")
    requirement = os.environ.get("PLANNING_JOPPA_REQ")
    assignment, snapshot, ac = (context.load_requirement(api, config, requirement) if requirement
                                else context.load(api, config, os.environ["PLANNING_JOPPA_AC"]))
    criteria = context.selected_criteria(assignment)
    require(not config.get("ac_ids") or {item["id"] for item in criteria}.issubset(config["ac_ids"]),
            "selected criteria are outside config.ac_ids")
    context.planning_idle(api, config, assignment)
    for criterion in criteria:
        publication.ensure_recovered(config["runs_folder"], target, config["url"], config["workspace"], criterion["id"])
    write(target / "input.json", assignment)
    write(target / "joppa-snapshot.json", snapshot)
    operations = [{"command": {"op": "claim_planning", "ac": item["id"], "revision": item["revision"]}} for item in criteria]
    require(len(operations) <= 100, "Requirement claims exceed the Joppa batch limit of 100 operations")
    tool = "joppa_batch" if requirement else "joppa_command"
    arguments = {"workspace": config["workspace"], "operations": operations} if requirement else {
        "workspace": config["workspace"], "command": operations[0]["command"]}
    publication.mutate(api, target / "claim.json", tool, arguments)
    claim = read(target / "claim.json")
    holders = publication.held_claims(api, config["workspace"], claim)
    write(target / "claim.json", {**claim, "holders": holders,
          **({"actor": next(iter(holders.values()))} if not requirement else {})})
    # Claiming does not change authored context. Check that no other writer changed it.
    fresh, current, current_ac = (context.load_requirement(api, config, requirement, [item["id"] for item in criteria])
                                  if requirement else context.load(api, config, ac["address"]))
    context.unchanged(snapshot, current)
    context.planning_idle(api, config, fresh, {
        address: {"actor": holders[address], "position": position}
        for address, position, _ in publication.claim_entries(claim)})
    if not requirement and retry_startup(api, config, target, fresh, current_ac, advertised):
        return
    assignment["joppa"]["unfinished_work"] = context.pending_work(api, config, assignment)
    write(target / "input.json", assignment)
    shared.prepare_context(prompt_assignment(assignment), mcp_servers=prepare_reader())


def retry_startup(api, config, target, assignment, ac, advertised):
    tasks = [task for task in assignment["joppa"]["tasks"]
             if not task["document"]["data"].get("archived")
             and not task["process"].get("done") and not task["process"].get("retired")]
    if not tasks or not all(isinstance(task["process"].get("blocked"), dict)
                           and task["process"]["blocked"].get("reason") == "WORKTREE_PREEXISTED" for task in tasks):
        return False
    require("unblock_task" in advertised, "Startup retry requires deployed unblock_task; no research was started")
    require(len(tasks) <= 99, "Startup retry supports at most 99 Tasks in one atomic batch")
    for item in [ac, *tasks]:
        require(item.get("work_ready") is True and item.get("review_required") is False
                and item["process"].get("review_required") is not True,
                "Startup retry requires current owner-reviewed AC and Task contracts")
        require(item["document"].get("present") is True and not item["document"]["data"].get("archived"),
                "Startup retry requires live objects")
    operations = []
    for task in tasks:
        publication.editable(task)
        data = task["document"]["data"]
        contract = context.task_contract(data)
        require(isinstance(contract, str) and contract.strip(), "Startup retry requires an implementation contract")
        def field(name):
            values = re.findall(r"^" + name + r":[ \t]*(\S[^\r\n]*)$", contract, re.M)
            require(len(values) == 1, f"Task contract needs exactly one {name}: line")
            return values[0].strip()
        repo = next((repo for repo in config["repositories"] if repo["id"] == field("Repository")), None)
        require(repo is not None, "Task repository is not configured")
        module = next((module for module in repo["modules"] if module["name"] == field("Module")), None)
        require(module is not None, "Task module is not configured")
        require(any(project in data.get("projects", [])
                    for project in (repo["project"], repo["project"].split(":", 1)[1])),
                "Task projects do not include its configured repository")
        require((Path(repo["path"]) / module["path"]).is_dir(), "Task module directory is absent")
        operations.append({"command": {"op": "unblock_task", "id": task["address"].split(":", 1)[1],
            "revision": task["current_revision"], "reason": "Retry startup after removing the retained worktree.",
            "evidence": task["process"]["blocked"].get("evidence", "")}})
    operations.append({"command": {"op": "finish_planning", "ac": ac["address"],
        "reason": "Retry startup with the same owner-reviewed Task contracts."}})
    claim = read(target / "claim.json")
    publication.held(api, config["workspace"], ac["address"], claim["result"]["position"], claim["actor"])
    print(run(["node", str(Path(__file__).with_name("cleanup.mjs"))], input=json.dumps({
        "config": config, "tasks": tasks, "operations": operations}), timeout=120), end="")
    result = publication.mutate(api, target / "publication.json", "joppa_batch", {
        "workspace": config["workspace"], "operations": operations}, retain_claim=True)
    results = result.get("results")
    require(isinstance(results, list) and len(results) == len(operations)
            and results[-1].get("command", {}).get("op") == "finish_planning",
            "startup publication response is incomplete; inspect publication.json")
    write(target / "result.json", {"status": "published", "scope": "startup_retry", "ac": ac["address"],
        "acceptance_verified": False, "task_count": len(tasks), "publication": result})
    signal("READY", "Retained worktrees removed. Existing Task contracts reopened without research.")
    return True


def prompt_assignment(assignment):
    """Send authored context once. Keep the complete snapshot in run artifacts."""
    result = {key: value for key, value in assignment.items() if key not in ("joppa", "decisions", "knowledge_query")}
    visible = set()
    for level in ("domain", "capability", "requirement", "ac"):
        item = assignment[level]
        if item["id"] in visible:
            result[level] = {"id": item["id"], "revision": item["revision"], "text": "Same context as its ancestor above."}
        else:
            obj = assignment["joppa"]["objects"][item["id"]]
            result[level] = {"id": item["id"], "revision": item["revision"], "text": json.dumps({
                "data": obj["document"]["data"], "links": obj["document"]["links"],
                "annotations": obj["annotations"], "files": obj["files"]}, ensure_ascii=False)}
            visible.add(item["id"])
        if level == "ac":
            result[level]["verification"] = assignment["joppa"]["objects"][item["id"]]["process"].get("verification")
        result[level]["item_id"] = assignment["joppa"]["objects"][item["id"]].get("item_id")
        if assignment["joppa"]["objects"][item["id"]].get("remote_links"):
            result[level]["remote_links"] = assignment["joppa"]["objects"][item["id"]]["remote_links"]
    tasks = assignment["joppa"]["tasks"]
    task_ids = {task["address"] for task in tasks}
    def prompt_data(item):
        terminal_task = item.get("kind") == assignment["joppa"]["task_type"] and (
            item["process"].get("done") or item["process"].get("retired"))
        return {key: value for key, value in item["document"]["data"].items()
                if key not in ("contract", "steps", "checks") or not terminal_task}
    result["joppa"] = {"task_type": assignment["joppa"]["task_type"], "task_schema": assignment["joppa"]["task_schema"],
        "test_status": assignment["joppa"]["test_status"],
        "task_value_limits": {"outcome": publication.MAX_DATA_VALUE - len("Goal: "),
                              "step": publication.MAX_DATA_VALUE, "check_line": publication.MAX_DATA_VALUE},
        "unfinished_work": assignment["joppa"].get("unfinished_work", []),
        "siblings": assignment["joppa"].get("siblings", []),
        "tasks": [{"address": task["address"], "item_id": task.get("item_id"), "revision": task["current_revision"],
                   **({"remote_links": task["remote_links"]} if task.get("remote_links") else {}),
                   "data": prompt_data(task), "links": task["document"]["links"],
                   "process": {key: task["process"].get(key) for key in ("status", "assignee", "done", "retired", "blocked")}}
                  for task in tasks],
        "objects": {address: {"item_id": item.get("item_id"), "revision": item["current_revision"], "data": prompt_data(item),
                              **({"remote_links": item["remote_links"]} if item.get("remote_links") else {}),
                              "parent": item["document"]["parent"], "links": item["document"]["links"], "annotations": item["annotations"],
                              "process": {key: item["process"].get(key) for key in ("status", "assignee", "done", "retired", "blocked")}}
                    for address, item in assignment["joppa"]["objects"].items() if address not in visible | task_ids}}
    if assignment["joppa"].get("remote"):
        remote = assignment["joppa"]["remote"]
        result["joppa"]["remote"] = {"objects": {key: {**item,
            "role": remote["schemas"][item["workspace"]]["types"][item["kind"]].get("role")}
            for key, item in remote["objects"].items()}}
    if assignment["joppa"].get("workspace_key"):
        result["joppa"]["workspace_key"] = assignment["joppa"]["workspace_key"]
    if assignment["joppa"].get("scope") == "requirement":
        criteria = context.selected_criteria(assignment)
        ids = {item["id"] for item in criteria}
        result["ac"] = {**result["ac"], "text": "Selected Requirement criteria appear below."}
        result["joppa"]["objects"] = {key: item for key, item in result["joppa"]["objects"].items() if key not in ids}
        result["joppa"].update(scope="requirement", criteria=[{
            "id": item["id"], "item_id": assignment["joppa"]["objects"][item["id"]].get("item_id"), "revision": item["revision"],
            **({"remote_links": assignment["joppa"]["objects"][item["id"]]["remote_links"]}
               if assignment["joppa"]["objects"][item["id"]].get("remote_links") else {}),
            "annotations": assignment["joppa"]["objects"][item["id"]]["annotations"],
            "files": assignment["joppa"]["objects"][item["id"]]["files"],
            **{key: assignment["joppa"]["objects"][item["id"]]["document"].get(key) for key in ("data", "links")}}
            for item in criteria],
                              criterion_schemas=assignment["joppa"]["criterion_schemas"])
        result["joppa"]["task_title_max_by_repository"] = publication.title_budgets(assignment)
    # The Requirement document already supplies its authored body and AC text.
    decisions = json.loads(assignment["decisions"][0])
    result["decisions"] = [json.dumps({key: decisions.get(key) for key in
        ("confirmed", "comments", "sources", "issues")}, ensure_ascii=False)]
    result["knowledge_query"] = assignment["knowledge_query"]
    result["details_file"] = str(shared.artifacts() / "input.json")
    result["details_note"] = "Read relevant omitted Task contracts in details_file before proposing new work or declaring reuse or duplication."
    return result


def capture(kind):
    if kind not in ("plan", "necessity"):
        return shared.capture(kind)
    target = shared.artifacts()
    error_path = target / f"error-{kind}-{'design' if kind == 'plan' else 'necessity'}.json"
    error_path.unlink(missing_ok=True)
    result, _ = shared.body_result()
    if kind == "necessity":
        shared.save_necessity(result)
        signal("NEEDS_HUMAN" if result["owner_gaps"] else "ASSESSED", "Necessity assessment validated")
    else:
        config = settings()
        api = context.client(config)
        assignment = context.read_assignment(api, config, target)
        publication.operations(result, assignment)
        verify_bindings(api, config, result, assignment,
            {repo["id"]: fingerprint(repo) for repo in assignment["repositories"]}, read(target / "snapshots.json"))
        shared.bind_necessity(result)
        write(target / "plan.json", result)
        signal("PLANNED", "Task mechanisms validated for the selected criterion")


def verify_bindings(api, config, plan, assignment, snapshots, prepared):
    for criterion in context.selected_criteria(assignment):
        address = criterion["id"]
        value = publication.criterion_plan(plan, assignment, address)
        if value["disposition"] == "verify_existing":
            publication.verify_bindings(api, config, value, context.criterion_assignment(assignment, address), snapshots,
                                        prepared if prepared is not None else read(shared.artifacts() / "snapshots.json"))


def finish():
    target = shared.artifacts()
    config = settings()
    api = context.client(config)
    assignment = context.read_assignment(api, config, target)
    plan = read(target / "plan.json")
    publication.validate(plan, assignment)
    reviews, snapshots, contracts = shared.verify_context(assignment, plan, mechanisms_only=True)
    grouped = assignment["joppa"].get("scope") == "requirement"
    fresh, current, _ = (context.load_requirement(api, config, assignment["requirement"]["id"],
                         [item["id"] for item in context.selected_criteria(assignment)]) if grouped
                         else context.load(api, config, assignment["ac"]["id"]))
    context.refresh_reads(api, config, fresh, current, read(target / "joppa-snapshot.json"))
    publication.validate(plan, fresh)
    # Update only the exact Task document reviewed by this plan.
    current_tasks = {item["address"]: item for item in fresh["joppa"]["tasks"]}
    for task in plan["tasks"]:
        if task["action"] in ("update", "retire"):
            actual = current_tasks.get(task["target"])
            require(actual and actual["current_revision"] == task["revision"], "target Task revision changed during planning")
            (publication.retirable if task["action"] == "retire" else publication.editable)(actual)
    claim = read(target / "claim.json")
    require(claim["status"] == "confirmed", "planning claim was not confirmed")
    publication.held_claims(api, config["workspace"], claim)
    context.planning_idle(api, config, fresh, {
        address: {"actor": actor, "position": position}
        for address, position, actor in publication.claim_entries(claim)})
    verify_bindings(api, config, plan, fresh, snapshots, None)
    operations = publication.operations(plan, fresh)
    blocked = any(isinstance(task["process"].get("blocked"), dict)
                  and not task["process"].get("done") and not task["process"].get("retired")
                  for task in fresh["joppa"]["tasks"])
    if not grouped and len(operations) == 1 and not blocked:
        released = publication.release(api, target, config["workspace"], assignment["ac"]["id"],
                                       "Reviewed Task contracts are unchanged.")
        require(released, "unchanged Tasks require confirmed claim release")
        write(target / "result.json", {"status": "unchanged", "ac": assignment["ac"]["id"],
              "acceptance_verified": False, "claim_released": True, "task_count": 0})
        signal("READY", "Existing Task contracts match the reviewed plan. Planning claim released.")
        return
    if blocked and len(operations) > 1:
        print(run(["node", str(Path(__file__).with_name("cleanup.mjs"))],
            input=json.dumps({"config": config, "tasks": fresh["joppa"]["tasks"], "operations": operations}), timeout=120), end="")
    result = publication.mutate(api, target / "publication.json", "joppa_batch", {
        "workspace": config["workspace"], "operations": operations}, retain_claim=blocked)
    results = result.get("results")
    require(isinstance(results, list) and len(results) == len(operations)
            and results[-1].get("command", {}).get("op") in ("finish_planning", "release_planning"),
            "publication response is incomplete; inspect publication.json before another run")
    write(target / "result.json", {"status": "published", "scope": "planned_tasks", "ac": assignment["ac"]["id"],
          **({"requirement": assignment["requirement"]["id"], "criteria": [item["id"] for item in context.selected_criteria(assignment)]}
             if grouped else {}),
          "acceptance_verified": False,
          "task_count": sum(op["command"]["op"] in ("save_object", "retire_task") for op in operations),
          "plan_digest": digest(plan),
          "snapshots": snapshots, "prepared_snapshots": read(target / "snapshots.json"),
          "contracts": {key: value["bundle_digest"] for key, value in contracts.items()},
          "reviews": reviews, "publication": result})
    signal("READY", "Reviewed plan published. Criterion acceptance remains a separate result.")


def fail(reason=None):
    target = shared.artifacts()
    target.mkdir(parents=True, exist_ok=True)
    reason = reason or os.environ.get("MEDULLA_LAST_MESSAGE") or "workflow stopped without a valid result"
    errors = [read(path) for path in sorted(target.glob("error-*.json"))]
    if errors:
        reason += "; " + "; ".join(item["reason"] for item in errors)
    released, release_error = False, None
    try:
        if (target / "input.json").exists():
            assignment = read(target / "input.json")
            config = settings()
            released = publication.release(context.client(config), target, config["workspace"], assignment["ac"]["id"], reason)
    except Exception as error:
        release_error = str(error)
    uncertain = any(path.exists() and read(path)["status"] in ("pending", "uncertain")
                    for path in (target / "claim.json", target / "publication.json", target / "release.json"))
    publication_path = target / "publication.json"
    incomplete = publication_path.exists() and read(publication_path)["status"] == "confirmed"
    claim_path = target / "claim.json"
    retained = claim_path.exists() and read(claim_path)["status"] == "confirmed" and not released
    needs_recovery = uncertain or incomplete or bool(release_error) or retained
    write(target / "result.json", {"status": "blocked", "scope": "planned_tasks", "reason": reason,
          "claim_released": released, "release_error": release_error,
          "skipped_claims": read(target / "release.json").get("skipped_claims", []) if (target / "release.json").exists() else [],
          "needs_recovery": needs_recovery,
          "acceptance_verified": False})
    signal("BLOCKED", reason + ("; inspect mutation receipts before another run" if needs_recovery else ""))


def needs_human():
    assessment = shared.require_necessity(allow_owner_gaps=True)
    require(assessment["owner_gaps"], "no required owner decision")
    fail("Required owner decision: " + "; ".join(
        f"{item['owner']}: {item['decision']}" for item in assessment["owner_gaps"]))


def main():
    global _failure_message
    command = sys.argv[1]
    try:
        if command == "capture":
            capture(sys.argv[2])
        else:
            own = {"prepare": prepare, "finish": finish, "fail": fail, "needs_human": needs_human,
                   "prepare_critic": prepare_critic}
            (own.get(command) or getattr(shared, command))()
    except shared.DriftReview as review:
        signal("DRIFT", review)
    except Exception as error:
        _failure_message = f"planning-joppa/{command}: {error}"
        print(_failure_message, file=sys.stderr)
        if command in ("capture", "prepare_critic"):
            kind = sys.argv[2] if command == "capture" else "critic"
            branch = "design" if kind == "plan" else "necessity" if kind == "necessity" else json.loads(os.environ["MEDULLA_INPUT"])["slug"]
            write(shared.artifacts() / f"error-{kind}-{branch}.json", {"stage": kind, "branch": branch, "reason": str(error)})
        else:
            fail(str(error))
        return 1
    return 0


if __name__ == "__main__":
    from stdio import install_sigterm_exit
    # Register before MCP clients so their shutdown output precedes the final error.
    atexit.register(report_failure)
    install_sigterm_exit()
    sys.exit(main())
