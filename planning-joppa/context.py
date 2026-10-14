"""Read one criterion and its current Joppa context."""
import json
import fcntl
import os
import re
from pathlib import Path

from common import digest, read, require, text, validate_input
from mcp import Joppa, Rejected


def configuration(path):
    config = read(path)
    for key in ("workspace", "url", "token_file", "runs_folder", "cbm_store", "cbm_root", "equill_store"):
        text(config.get(key), "config." + key)
    require(isinstance(config.get("repositories"), list) and config["repositories"], "config.repositories required")
    root = Path(path).resolve().parent
    for key in ("token_file", "reader_token_file", "runs_folder", "cbm_store", "cbm_root", "equill_store"):
        if key == "reader_token_file" and key not in config:
            continue
        value = Path(config[key]).expanduser()
        config[key] = str((root / value).resolve() if not value.is_absolute() else value.resolve())
    require(bool(config.get("worktree_root")) == bool(config.get("lane_runs_folder")),
            "worktree_root and lane_runs_folder must be configured together")
    for key in ("worktree_root", "lane_runs_folder"):
        if key not in config:
            continue
        value = Path(text(config[key], "config." + key)).expanduser()
        require(".." not in value.parts, "cleanup path cannot contain parent traversal")
        config[key] = str(value if value.is_absolute() else root / value)
    for repo in config["repositories"]:
        text(repo.get("project"), "repository.project address")
        require(":" in repo["project"], "repository.project must be a full object address")
        value = Path(text(repo.get("path"), "repository.path")).expanduser()
        repo["path"] = str((root / value).resolve() if not value.is_absolute() else value.resolve())
    require(len({r["id"] for r in config["repositories"]}) == len(config["repositories"]), "duplicate repository ID")
    require(len({r["project"] for r in config["repositories"]}) == len(config["repositories"]), "duplicate project mapping")
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
    return Joppa(config["url"], config["token_file"])


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


def object_read(api, workspace, address):
    result = api.call("joppa_objects", {"workspace": workspace, "address": address})
    require(result.get("document", {}).get("present") is True, f"object is absent: {address}")
    require(result.get("historical") is False, f"current object required: {address}")
    return result


def source(object):
    """Ignore journal position and our own planning claim. Keep meaningful state."""
    process = {key: value for key, value in object.get("process", {}).items() if key != "planning_claim"}
    return {key: object.get(key) for key in ("address", "kind", "current_revision", "document", "annotations",
                                           "files", "references", "review_required", "work_ready")} | {"process": process}


def snapshot_source(object, types, selected_ac=None):
    current = source(object)
    for key in ("verification", "pending_run", "summary", "status"):
        current["process"].pop(key, None)
    role = types[object["kind"]].get("role")
    if role == "task" or (role == "ac" and selected_ac and object["address"] != selected_ac):
        # Sibling execution state does not change the authored planning context.
        current.pop("current_revision")
        current.pop("process")
        current.pop("work_ready")
        current.pop("review_required")
        current["document"] = {key: value for key, value in current["document"].items()
                               if key in ("data", "parent", "links", "present", "schema_revision")}
    if role == "task":
        annotations = dict(current.get("annotations") or {})
        comments = annotations.get("comments")
        if isinstance(comments, dict):
            annotations["comments"] = {key: comment for key, comment in comments.items()
                                       if comment.get("actor_type") != "agent"}
        for key in ("comments", "description", "attachments"):
            if not annotations.get(key):
                annotations.pop(key, None)
        current["annotations"] = annotations
    return current


def load(api, config, ac_id):
    for attempt in range(3):
        try:
            return load_once(api, config, ac_id)
        except ValueError as error:
            if not str(error).startswith("workspace changed during ") or attempt == 2:
                raise


def load_once(api, config, ac_id):
    workspace = config["workspace"]
    tree = api.call("joppa_tree", {"workspace": workspace})
    types = tree["schema"]["types"]
    ac_types = [kind for kind, value in types.items() if value.get("role") == "ac"]
    if ":" not in ac_id:
        require(len(ac_types) == 1, "use a full criterion address when the schema has multiple criterion types")
        ac_id = ac_types[0] + ":" + ac_id
    objects = {}
    def get(address):
        if address not in objects:
            objects[address] = object_read(api, workspace, address)
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
    tasks, cursor = [], None
    while True:
        args = {"workspace": workspace, "parent": ac_id, "kind": task_kind, "limit": 100}
        if cursor:
            args["cursor"] = cursor
        page = api.call("joppa_objects", args)
        require(page["position"] == tree["position"], "workspace changed during context read")
        tasks.extend(get(item["address"]) for item in page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            break
    # Read explicit references. Do not traverse unrelated tickets or infer ownership.
    for item in [ac, *parents, *tasks]:
        for link in item["document"].get("links", []):
            get(link["target"])
        for reference in item.get("references", []):
            if isinstance(reference, dict) and reference.get("target"):
                get(reference["target"])
    for repo in config["repositories"]:
        project = get(repo["project"])
        require(project["kind"] == project_ref["target"], "repository project type differs from Task schema")
    requirement = api.call("joppa_read", {"workspace": workspace, "req": req["address"]})
    require(requirement["position"] == tree["position"], "workspace changed during requirement read")
    req_detail = requirement["requirement"]
    revisions = req_detail.get("revisions")
    require(isinstance(revisions, list) and len(revisions) == 1, "current Requirement read must return exactly one revision")
    revision = revisions[0]
    require(revision.get("number") == req_detail["current_revision"], "Requirement read returned another revision")
    # Current verification decisions belong to the Requirement, not the AC document revision.
    meaning = {key: value for key, value in revision.items() if key not in ("tasks", "runs")}
    meaning["comments"] = req_detail.get("comments")
    siblings = []
    for criterion in revision.get("acs", []):
        address = criterion["id"]
        if address == ac_id:
            continue
        sibling = get(address)
        require(types[sibling["kind"]].get("role") == "ac", "Requirement contains a non-criterion child")
        siblings.append(sibling)
        for kind, definition in types.items():
            if definition.get("role") != "task" or sibling["kind"] not in definition.get("parents", []):
                continue
            cursor = None
            while True:
                args = {"workspace": workspace, "parent": address, "kind": kind, "limit": 100}
                if cursor:
                    args["cursor"] = cursor
                page = api.call("joppa_objects", args)
                require(page["position"] == tree["position"], "workspace changed during sibling context read")
                siblings.extend(get(item["address"]) for item in page["items"])
                cursor = page.get("next_cursor")
                if not cursor:
                    break
    for item in siblings:
        for link in item["document"].get("links", []):
            get(link["target"])
        for reference in item.get("references", []):
            if isinstance(reference, dict) and reference.get("target"):
                get(reference["target"])
    require(all(item["position"] == tree["position"] for item in objects.values()), "workspace changed during object read")
    require(api.call("joppa_tree", {"workspace": workspace})["position"] == tree["position"],
            "workspace changed during context read")
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
                            "siblings": [item["address"] for item in siblings],
                            "objects": {key: source(item) for key, item in objects.items()}, "task_type": task_kind,
                            "task_schema": types[task_kind]},
                  "knowledge_query": ac["document"]["data"].get("description") or ac["document"]["data"]["title"]}
    snapshot = {"schema": tree["schema"], "objects": {key: snapshot_source(item, types, ac_id) for key, item in objects.items()},
                "requirement": meaning}
    validate_input(assignment)
    return assignment, snapshot, ac


def unchanged(old, new):
    require(digest(old) == digest(new), "Joppa context changed during planning; read the criterion again")


def capture_object(target, workspace, object):
    """Keep the first full read. Serialize readers on the existing snapshot file."""
    path = Path(target) / "joppa-snapshot.json"
    with path.open("r+") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        snapshot = json.load(file)
        assignment = read(Path(target) / "input.json")
        require(assignment["workspace"] == workspace, "reader workspace differs from the run")
        require(object.get("document", {}).get("present") is True and object.get("historical") is False,
                "reader requires a full current object")
        address = text(object.get("address"), "object.address")
        types = snapshot["schema"]["types"]
        require(object.get("kind") in types, "object schema changed during planning")
        current = snapshot_source(object, types, assignment["ac"]["id"])
        if address in snapshot["objects"]:
            unchanged(snapshot["objects"][address], current)
            return
        snapshot["objects"][address] = current
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
            snapshot["objects"][address] = snapshot_source(object, snapshot["schema"]["types"], assignment["ac"]["id"])
    unchanged(original, snapshot)


def read_assignment(api, config, target):
    """Hydrate additional reads without changing the fixed assessment input."""
    assignment = read(Path(target) / "input.json")
    snapshot = read(Path(target) / "joppa-snapshot.json")
    for address, expected in snapshot["objects"].items():
        if address not in assignment["joppa"]["objects"]:
            object = object_read(api, config["workspace"], address)
            unchanged(expected, snapshot_source(object, snapshot["schema"]["types"], assignment["ac"]["id"]))
            assignment["joppa"]["objects"][address] = source(object)
    return assignment
