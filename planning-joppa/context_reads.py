"""Planning context helpers."""
import re
import json
import fcntl
import os
from pathlib import Path
from common import strings, read, require, text
from mcp import Rejected, complete_object
from context_snapshot import source, snapshot_source, selected_criteria, unchanged


def object_read(api, workspace, address, allow_archived=False):
    result = api.call("joppa_objects", {"workspace": workspace, "address": address})
    result = complete_object(api.call, {"workspace": workspace, "address": address}, result)
    present = result.get("document", {}).get("present")
    require(present is True or allow_archived and present is False, f"object is absent: {address}")
    require(result.get("historical") is False, f"current object required: {address}")
    return result

def read_remote_links(api, remote, object):
    for link in object.get("remote_links", []):
        if (link.get("status", {}).get("access") is True
                and link.get("status", {}).get("present") is True):
            remote_object(api, remote, link["workspace"], link["target"])

def remote_key(workspace, address):
    return "@" + workspace + "/" + address

def remote_object(api, remote, workspace, address):
    """Keep foreign schemas and addresses outside the execution workspace."""
    schemas = remote.setdefault("schemas", {})
    objects = remote.setdefault("objects", {})
    key = remote_key(workspace, address)
    if workspace not in schemas:
        schemas[workspace] = api.call("joppa_tree", {"workspace": workspace})["schema"]
    if key not in objects:
        value = object_read(api, workspace, address)
        require(value.get("address") == address, "remote read returned a different object")
        require(value.get("workspace_key", workspace) == workspace, "remote read returned a different workspace")
        require(value.get("kind") in schemas[workspace]["types"], "remote object type is absent from its schema")
        objects[key] = {**source(value), "workspace": workspace}
    return objects[key]

def remote_snapshot(remote):
    return {"schemas": remote["schemas"], "objects": {
        key: {**snapshot_source(value, remote["schemas"][value["workspace"]]["types"], []),
              "workspace": value["workspace"]}
        for key, value in remote["objects"].items()}}

def verify_remote(api, remote, expected):
    """Read every captured foreign contract again before publication."""
    current = {}
    for value in expected["objects"].values():
        remote_object(api, current, value["workspace"], value["address"])
    unchanged(expected, remote_snapshot(current))
    remote["schemas"] = {**remote.get("schemas", {}), **current["schemas"]}
    remote["objects"] = {**remote.get("objects", {}), **current["objects"]}

def capture_object(target, workspace, object, api=None):
    """Keep the first full read. Serialize readers on the existing snapshot file."""
    path = Path(target) / "joppa-snapshot.json"
    with path.open("r+") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        snapshot = json.load(file)
        assignment = read(Path(target) / "input.json")
        require(object.get("document", {}).get("present") is True and object.get("historical") is False,
                "reader requires a full current object")
        address = text(object.get("address"), "object.address")
        scope = snapshot
        local_keys = {assignment["workspace"], assignment["joppa"].get("workspace_key")}
        workspace = object.get("workspace_key") or workspace
        if workspace not in local_keys:
            require(api is not None, "remote capture needs the authenticated reader")
            scope = snapshot.setdefault("remote", {"schemas": {}, "objects": {}})
            if workspace not in scope["schemas"]:
                scope["schemas"][workspace] = api.call("joppa_tree", {"workspace": workspace})["schema"]
            types = scope["schemas"][workspace]["types"]
            key = remote_key(workspace, address)
        else:
            types = snapshot["schema"]["types"]
            key = address
        require(object.get("kind") in types, "object schema changed during planning")
        current = snapshot_source(object, types, [] if scope is not snapshot else
                                  [item["id"] for item in selected_criteria(assignment)])
        if scope is not snapshot:
            current["workspace"] = workspace
        if key in scope["objects"]:
            unchanged(scope["objects"][key], current)
            return
        scope["objects"][key] = current
        # Keep the lock inode stable. Every reader uses this same file.
        file.seek(0)
        json.dump(snapshot, file, ensure_ascii=False, indent=2)
        file.write("\n")
        file.truncate()
        file.flush()
        os.fsync(file.fileno())

def refresh_reads(api, config, assignment, snapshot, original):
    """Check every captured contract and hydrate publication dependencies."""
    for address in original["objects"]:
        if address not in snapshot["objects"]:
            object = object_read(api, config["workspace"], address)
            assignment["joppa"]["objects"][address] = source(object)
            snapshot["objects"][address] = snapshot_source(object, snapshot["schema"]["types"],
                                                          [item["id"] for item in selected_criteria(assignment)])
    if original.get("remote"):
        remote = assignment["joppa"].setdefault("remote", {})
        verify_remote(api, remote, original["remote"])
        snapshot["remote"] = remote_snapshot(remote)
    unchanged(original, snapshot)

def read_assignment(api, config, target):
    """Hydrate additional reads without changing the fixed assessment input."""
    assignment = read(Path(target) / "input.json")
    snapshot = read(Path(target) / "joppa-snapshot.json")
    for address, expected in snapshot["objects"].items():
        if address not in assignment["joppa"]["objects"]:
            object = object_read(api, config["workspace"], address)
            unchanged(expected, snapshot_source(object, snapshot["schema"]["types"],
                                                [item["id"] for item in selected_criteria(assignment)]))
            assignment["joppa"]["objects"][address] = source(object)
    if snapshot.get("remote"):
        remote = assignment["joppa"].setdefault("remote", {})
        verify_remote(api, remote, snapshot["remote"])
    return assignment


def task_contract(data):
    """Render either stored format without changing the document or claim digest."""
    contract = data.get("contract", "")
    if "steps" not in data:
        return contract if isinstance(contract, str) else ""
    text(contract, "Structured Task contract")
    for key in ("repository", "module"):
        value = text(data.get(key), "Structured Task " + key)
        require("\n" not in value and "\r" not in value, "Structured Task needs a single-line " + key)
    steps = list(strings(data.get("steps"), "Structured Task steps"))
    checks = strings(data.get("checks"), "Structured Task checks")
    lines = [contract, "", f"Repository: {data['repository']}", f"Module: {data['module']}", "", "How:"]
    if steps[0].startswith("0. "):
        lines.append(steps.pop(0))
    lines.extend(f"{number}. " + re.sub(r"^\s*\d+\.\s+", "", step)
                 for number, step in enumerate(steps, 1))
    return "\n".join([*lines, "", "Checks:", *checks])

def pending_work(api, config, assignment):
    for attempt in range(3):
        try:
            return pending_work_page(api, config, assignment)
        except Rejected as error:
            if "task queue changed; start again without cursor" not in str(error) or attempt == 2:
                raise

def pending_work_page(api, config, assignment):
    """Locate unfinished work across Requirements. Full reads still bind reuse and dependencies."""
    visible = set(assignment["joppa"]["objects"])
    projects = {name for repo in config["repositories"] for name in (repo["project"], repo["project"].split(":", 1)[1])}
    result, cursor = [], None
    while True:
        args = {"workspace": config["workspace"], "view": "all", "limit": 100}
        if cursor:
            args["cursor"] = cursor
        page = api.call("joppa_tasks", args)
        for task in page["tasks"]:
            address = task.get("address") or f"task:{task['req']}/{task['id']}"
            if task["status"] in ("done", "retired") or address in visible:
                continue
            if not projects.intersection(task.get("projects", [])):
                continue
            contract = task.get("contract", "")
            if not re.search(r"^Repository:[ \t]*\S", contract, re.M):
                document = object_read(api, config["workspace"], address)
                contract = task_contract(document["document"]["data"])
            def field(name):
                match = re.search(r"^" + name + r":[ \t]*([^\r\n]+)$", contract, re.M)
                return match[1].strip() if match else None
            how = re.search(r"^How:\s*\n(.*?)(?:\nChecks:|\Z)", contract, re.M | re.S)
            ac = task.get("parent") or task.get("ac")
            req = task.get("req")
            legacy_ac = task.get("ac")
            if not req and isinstance(legacy_ac, str) and "/" in legacy_ac:
                req = legacy_ac.removeprefix("ac:").split("/", 1)[0]
            result.append({"address": address, "revision": task["revision"], "title": task["title"],
                "ac": ac, "requirement": req, "status": task["status"],
                "repository": field("Repository"), "module": field("Module"),
                "how": " ".join(how[1].split()) if how else None})
        cursor = page.get("next_cursor")
        if not cursor:
            return result
