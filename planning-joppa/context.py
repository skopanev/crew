"""Read one criterion and its current Joppa context."""
import json
import fcntl
import os
import re
from pathlib import Path

from common import digest, read, require, strings, text, validate_input
from mcp import Joppa, Rejected, complete_object
from context_snapshot import (
    source, current_pin, remote_satisfied, snapshot_source, selected_criteria, unchanged, authored_meaning,
)
from context_reads import (
    task_contract, pending_work, pending_work_page, object_read, read_remote_links, remote_key,
    remote_object, remote_snapshot, verify_remote, capture_object, refresh_reads, read_assignment,
)
from requirement_context import load_requirement
from test_nodes import identities, read_nodes, test_type


def requirement_meaning(api, workspace, req, types, get=None):
    """Rebuild the current Requirement verification view without joppa_read."""
    get = get or (lambda address: object_read(api, workspace, address))
    data = req["document"]["data"]
    acs, cursor, seen = [], None, set()
    while True:
        page = api.call("joppa_objects", {"workspace": workspace, "parent": req["address"], "limit": 25,
                                          "fields": ["kind", "present"], **({"cursor": cursor} if cursor else {})})
        acs.extend({"id": item["address"]} for item in page["items"]
                   if item.get("present", True) and types[item["kind"]].get("role") == "ac")
        cursor = page.get("next_cursor")
        if not cursor:
            break
        require(cursor not in seen, "Requirement child pagination did not advance")
        seen.add(cursor)
    notes, cursor, seen = [], None, set()
    while True:
        page = api.call("joppa_objects", {"workspace": workspace, "related_to": req["address"],
                                          "limit": 25, "fields": ["kind", "present"], **({"cursor": cursor} if cursor else {})})
        notes.extend(source(get(item["address"])) for item in page["items"]
                     if item.get("present", True) and types[item["kind"]].get("inbox") is True)
        cursor = page.get("next_cursor")
        if not cursor:
            break
        require(cursor not in seen, "Requirement note pagination did not advance")
        seen.add(cursor)
    return {"number": req["current_revision"], "title": data.get("title"), "body": data.get("body"),
            "owner": data.get("owner"), "reason": req["document"].get("reason"), "acs": acs,
            "summary": req.get("process", {}).get("summary"), "sources": {"notes": notes},
            "comments": (req.get("annotations") or {}).get("comments") or {}}


def current_criteria(api, workspace, revision):
    """Exclude archived criteria from the Requirement revision's roster."""
    return [object for item in revision.get("acs", [])
            if (object := object_read(api, workspace, item["id"], allow_archived=True))["document"]["present"]]


def load(api, config, ac_id):
    for attempt in range(3):
        try:
            return load_once(api, config, ac_id)
        except ValueError as error:
            if not str(error).startswith("workspace changed during ") or attempt == 2:
                raise


# All six tones list present and archived objects. A done Task is archived with the purple tone.
TONES = ["red", "yellow", "orange", "grey", "green", "purple"]


def task_addresses(api, workspace, parent, kind):
    """List the current and archived Tasks of one criterion. Done Tasks keep their landed work in context."""
    addresses, cursor, seen = [], None, set()
    while True:
        page = api.call("joppa_objects", {"workspace": workspace, "parent": parent, "kind": kind, "status": TONES,
                                          "limit": 25, "fields": ["address"], **({"cursor": cursor} if cursor else {})})
        addresses.extend(item["address"] for item in page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            return addresses
        require(cursor not in seen, "Task list pagination did not advance")
        seen.add(cursor)


def load_once(api, config, ac_id):
    workspace = config["workspace"]
    tree = api.call("joppa_tree", {"workspace": workspace})
    types = tree["schema"]["types"]
    ac_types = [kind for kind, value in types.items() if value.get("role") == "ac"]
    if ":" not in ac_id:
        require(len(ac_types) == 1, "use a full criterion address when the schema has multiple criterion types")
        ac_id = ac_types[0] + ":" + ac_id
    objects, remote = {}, {}
    def get(address, archived=False):
        # A done or retired Task is archived. Its document still decides readiness.
        if address not in objects:
            object = object_read(api, workspace, address, allow_archived=archived)
            require(object["document"]["present"] or types[object["kind"]].get("role") == "task",
                    f"object is absent: {address}")
            objects[address] = object
        return objects[address]
    ac = get(ac_id)
    require(types[ac["kind"]]["role"] == "ac", "input must be a criterion")
    parents, seen = [], {ac_id}
    parent = ac["document"].get("parent")
    while parent:
        require(parent not in seen, "parent cycle in criterion context")
        seen.add(parent)
        item = get(parent)
        parents.append(item)
        parent = item["document"].get("parent")
    req = next((item for item in parents if types[item["kind"]].get("role") == "requirement"), None)
    require(req is not None, "criterion needs a requirement ancestor")
    task_types = [kind for kind, value in types.items()
                  if value.get("role") == "task" and ac["kind"] in value.get("parents", [])]
    require(len(task_types) == 1, "criterion needs exactly one direct Task type")
    task_kind = task_types[0]
    require(types[task_kind].get("question"), "Task type needs a configured question")
    project_ref = types[task_kind].get("references", {}).get("projects")
    require(project_ref and project_ref.get("multiple") is True, "Task type needs a projects reference list")
    tasks = [get(address, True) for address in task_addresses(api, workspace, ac_id, task_kind)]
    # Read explicit references. Do not traverse unrelated tickets or infer ownership.
    for item in [ac, *parents, *tasks]:
        for link in item["document"].get("links", []):
            get(link["target"], True)
        read_remote_links(api, remote, item)
        for reference in item.get("references", []):
            if isinstance(reference, dict) and reference.get("target"):
                get(reference["target"])
    for repo in config["repositories"]:
        project = get(repo["project"])
        require(project["kind"] == project_ref["target"], "repository project type differs from Task schema")
    # Current verification decisions belong to the Requirement, not the AC document revision.
    meaning = requirement_meaning(api, workspace, req, types, get)
    revision = meaning
    siblings = []
    for sibling in current_criteria(api, workspace, revision):
        address = sibling["address"]
        if address == ac_id:
            continue
        objects[address] = sibling
        require(types[sibling["kind"]].get("role") == "ac", "Requirement contains a non-criterion child")
        siblings.append(sibling)
        for kind, definition in types.items():
            if definition.get("role") != "task" or sibling["kind"] not in definition.get("parents", []):
                continue
            siblings.extend(get(task, True) for task in task_addresses(api, workspace, address, kind))
    for item in siblings:
        for link in item["document"].get("links", []):
            get(link["target"], True)
        read_remote_links(api, remote, item)
        for reference in item.get("references", []):
            if isinstance(reference, dict) and reference.get("target"):
                get(reference["target"])
    test_kind = test_type(types)
    tests = read_nodes(api, workspace, test_kind, ac_id, [ac_id])[ac_id]
    require(api.call("joppa_tree", {"workspace": workspace})["schema"] == tree["schema"],
            "workspace changed during schema read")
    groups = [item for item in parents if types[item["kind"]].get("role") == "group"]
    context = lambda item: {"id": item["address"], "revision": item["current_revision"],
                            "text": json.dumps(source(item), ensure_ascii=False)}
    scope = context(req)
    assignment = {"kind": "joppa", "workspace": workspace, "ac": context(ac), "requirement": scope,
                  "capability": context(groups[0]) if groups else scope,
                  "domain": context(groups[-1]) if groups else scope,
                  "decisions": [json.dumps(meaning, ensure_ascii=False)],
                  "repositories": config["repositories"],
                  "joppa": {"parents": [source(item) for item in parents], "tasks": [source(item) for item in tasks],
                            "test_nodes": tests, "test_type": test_kind, "test_schema": types[test_kind],
                            "test_rules": tree["schema"].get("test_results") or {},
                            "siblings": [item["address"] for item in siblings],
                            "objects": {key: source(item) for key, item in objects.items()}, "task_type": task_kind,
                            "questions": {kind: value["question"] for kind, value in types.items()
                                          if value.get("role") == "ac" and value.get("question")},
                            "task_schema": types[task_kind]},
                  "knowledge_query": ac["document"]["data"].get("body", ac["document"]["data"].get("description")) or ac["document"]["data"]["title"]}
    snapshot = {"schema": tree["schema"], "objects": {key: snapshot_source(item, types, ac_id) for key, item in objects.items()},
                "requirement": authored_meaning(meaning), "tests": {ac_id: identities(tests)}}
    if remote:
        assignment["joppa"]["remote"] = remote
        snapshot["remote"] = remote_snapshot(remote)
    if tree.get("workspace_key"):
        assignment["joppa"]["workspace_key"] = tree["workspace_key"]
    validate_input(assignment)
    return assignment, snapshot, ac


def criterion_assignment(assignment, address):
    """Keep the existing one-AC validator without changing the shared planner."""
    from copy import deepcopy
    result = deepcopy(assignment)
    result["ac"] = next(item for item in selected_criteria(assignment) if item["id"] == address)
    result["joppa"]["tasks"] = [item for item in assignment["joppa"]["tasks"]
                                 if item["document"]["parent"] == address]
    detail = assignment["joppa"].get("criterion_schemas", {}).get(address)
    if detail:
        result["joppa"].update(detail)
    return result


def lane_runs_folders(config):
    """Return the lane runs folders from lane_runs_folder or lane_runs_folders. Cleanup uses the same rule."""
    single, many = config.get("lane_runs_folder") is not None, config.get("lane_runs_folders") is not None
    require(not (single and many), "set lane_runs_folder or lane_runs_folders, not both")
    if not many:
        return [config["lane_runs_folder"]] if single else []
    folders = config["lane_runs_folders"]
    require(isinstance(folders, list) and folders and all(isinstance(value, str) and value and
            Path(value).expanduser().is_absolute() for value in folders) and len(set(folders)) == len(folders),
            "lane_runs_folders must be a nonempty list of distinct absolute paths")
    return folders


def configuration(path, raw=None):
    config = json.loads(raw) if raw is not None else read(path)
    for key in ("workspace", "url", "runs_folder", "cbm_store", "cbm_root", "equill_store"):
        text(config.get(key), "config." + key)
    if config.get("covers_reference") is not None:
        from coverage import RESERVED
        require(text(config["covers_reference"], "config.covers_reference") not in RESERVED,
                "config.covers_reference cannot name a reserved data field")
    if config.get("mcp_command") is not None:
        from stdio import validate_command
        validate_command(config["mcp_command"])
    else:
        text(config.get("token_file"), "config.token_file")
    require(isinstance(config.get("repositories"), list) and config["repositories"], "config.repositories required")
    root = Path(path).resolve().parent
    for key in ("token_file", "reader_token_file", "runs_folder", "cbm_store", "cbm_root", "equill_store"):
        if key in ("token_file", "reader_token_file") and key not in config:
            continue
        value = Path(config[key]).expanduser()
        config[key] = str((root / value).resolve() if not value.is_absolute() else value.resolve())
    folders = lane_runs_folders(config)
    require(bool(config.get("worktree_root")) == bool(folders),
            "worktree_root and lane runs folders must be configured together")

    def cleanup_path(value, key):
        value = Path(text(value, "config." + key)).expanduser()
        require(".." not in value.parts, "cleanup path cannot contain parent traversal")
        return str(value if value.is_absolute() else root / value)
    if "worktree_root" in config:
        config["worktree_root"] = cleanup_path(config["worktree_root"], "worktree_root")
    if config.get("lane_runs_folders") is not None:
        config["lane_runs_folders"] = [cleanup_path(value, "lane_runs_folders") for value in folders]
    elif folders:
        config["lane_runs_folder"] = cleanup_path(folders[0], "lane_runs_folder")
    for repo in config["repositories"]:
        text(repo.get("project"), "repository.project address")
        require(":" in repo["project"], "repository.project must be a full object address")
        value = Path(text(repo.get("path"), "repository.path")).expanduser()
        repo["path"] = str((root / value).resolve() if not value.is_absolute() else value.resolve())
    require(len({r["id"] for r in config["repositories"]}) == len(config["repositories"]), "duplicate repository ID")
    require(len({r["project"] for r in config["repositories"]}) == len(config["repositories"]), "duplicate project mapping")
    if "ac_ids" in config:
        require(isinstance(config["ac_ids"], list) and bool(config["ac_ids"])
                and all(isinstance(address, str) and ":" in address for address in config["ac_ids"])
                and len(set(config["ac_ids"])) == len(config["ac_ids"]),
                "ac_ids must contain distinct full criterion addresses")
    if config.get("worktree_root"):
        require(all(not Path(repo["path"]).is_relative_to(Path(config["worktree_root"]))
                    for repo in config["repositories"]), "worktree_root cannot contain a canonical repository")
    require(all(not Path(config["runs_folder"]).is_relative_to(Path(r["path"])) for r in config["repositories"]),
            "runs_folder must be outside inspected repositories")
    placeholder = {"id": "config-check", "text": "Validate configuration.", "revision": 1}
    validate_input({"workspace": config["workspace"], "domain": placeholder, "capability": placeholder,
                    "requirement": placeholder, "ac": placeholder, "decisions": [], "repositories": config["repositories"]})
    return config

def client(config):
    return Joppa(config["url"], config.get("token_file"), config.get("mcp_command"))
