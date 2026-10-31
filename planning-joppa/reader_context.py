"""Runtime context for the Joppa planning stages."""
import re
import json
import os
from pathlib import Path
from common import run, signal, digest, require, write
import stages as shared
import context
import publication


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
        "task_title_max_length": publication.title_limit(assignment["joppa"]["task_schema"]),
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
