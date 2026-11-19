"""Runtime context for the Joppa planning stages."""
import json
import os
from pathlib import Path
from common import digest, require, write
import stages as shared
import context
import publication
from joppa_reads import ended, task_state


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
        terminal_task = item.get("kind") == assignment["joppa"]["task_type"] and ended(item)
        return {key: value for key, value in item["document"]["data"].items()
                if key not in ("contract", "steps", "checks") or not terminal_task}
    result["joppa"] = {"task_type": assignment["joppa"]["task_type"], "task_schema": assignment["joppa"]["task_schema"],
        "test_nodes": assignment["joppa"]["test_nodes"],
        "task_title_max_length": publication.title_limit(assignment["joppa"]["task_schema"]),
        "task_value_limits": {"outcome": publication.MAX_DATA_VALUE - len("Goal: "),
                              "step": publication.MAX_DATA_VALUE, "check_line": publication.MAX_DATA_VALUE},
        "unfinished_work": assignment["joppa"].get("unfinished_work", []),
        "siblings": assignment["joppa"].get("siblings", []),
        "tasks": [{"address": task["address"], "item_id": task.get("item_id"), "revision": task["current_revision"],
                   **({"remote_links": task["remote_links"]} if task.get("remote_links") else {}),
                   "data": prompt_data(task), "links": task["document"]["links"],
                   "state": task_state(task, assignment["joppa"].get("failed_task_stage"))}
                  for task in tasks],
        "objects": {address: {"item_id": item.get("item_id"), "revision": item["current_revision"], "data": prompt_data(item),
                              **({"remote_links": item["remote_links"]} if item.get("remote_links") else {}),
                              "parent": item["document"]["parent"], "links": item["document"]["links"], "annotations": item["annotations"],
                              **({"state": task_state(item, assignment["joppa"].get("failed_task_stage"))}
                                 if item.get("kind") == assignment["joppa"]["task_type"] else {})}
                    for address, item in assignment["joppa"]["objects"].items() if address not in visible | task_ids}}
    if assignment["joppa"].get("remote"):
        remote = assignment["joppa"]["remote"]
        result["joppa"]["remote"] = {"objects": {key: {**item,
            "role": remote["schemas"][item["workspace"]]["types"][item["kind"]].get("role")}
            for key, item in remote["objects"].items()}}
    if assignment["joppa"].get("workspace_key"):
        result["joppa"]["workspace_key"] = assignment["joppa"]["workspace_key"]
    if assignment["joppa"].get("covers"):
        result["joppa"]["covers_reference"] = assignment["joppa"]["covers"]["field"]
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
