"""Run a configured Medulla workflow through the existing planner launcher."""
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

from common import digest, require, text
from flow_batch import settings as batch_settings


def configuration(path, raw=None, input_index=None):
    config = json.loads(raw if raw is not None else Path(path).read_bytes())
    if "inputs" in config:
        profiles = config["inputs"]
        keys = {"selection", "order", "exclude_tags", "exclude_children", "children", "references", "related", "publication"}
        require(isinstance(profiles, list) and profiles and all(isinstance(p, dict) and isinstance(p.get("selection"), dict) and
                set(p) <= keys for p in profiles), "inputs needs ordered native selection profiles")
        base = {key: value for key, value in config.items() if key != "inputs"}
        variants = [configuration(path, json.dumps({**base, **profile, "input": index})) for index, profile in enumerate(profiles)]
        if input_index is None:
            return config
        require(type(input_index) is int and 0 <= input_index < len(variants), "invalid input index")
        return variants[input_index]
    for key in ("workspace", "url", "runs_folder", "workflow"):
        text(config.get(key), "config." + key)
    require(Path(config["workflow"]).is_absolute() and Path(config["workflow"]).is_file(),
            "config.workflow must name an existing absolute workflow path")
    require(Path(config["runs_folder"]).is_absolute(), "config.runs_folder must be absolute")
    require(isinstance(config.get("selection"), dict) and config["selection"].get("kind"),
            "config.selection needs a native kind filter")
    require(config.get("mcp_command") or config.get("token_file"), "configure Joppa authentication")
    require(isinstance(config.get("vars", {}), dict), "config.vars must be an object")
    require(isinstance(config.get("exclude_tags", []), list) and
            all(isinstance(tag, str) and tag.strip() for tag in config.get("exclude_tags", [])),
            "exclude_tags must be a list of nonempty tags")
    for name in config.get("vars", {}):
        require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) and
                name != "AGY_PROFILE_HOME" and not name.startswith(("PLANNING_", "CREW_FLOW_", "MEDULLA_")), "reserved workflow variable: " + name)
    publication = config.get("publication")
    require(isinstance(publication, dict), "config.publication is required")
    filename = text(publication.get("file"), "publication.file")
    require(Path(filename).name == filename and filename.endswith(".json"), "publication.file must be a JSON basename")
    require(filename not in ("claim.json", "input.json", "publication.json", "release.json", "result.json", "joppa-snapshot.json"),
            "publication.file names a reserved run artifact")
    for key in ("allowed_operations", "create_kinds", "update_kinds"):
        value = publication.get(key, [])
        require(isinstance(value, list) and all(isinstance(item, str) and item for item in value),
                "publication." + key + " must be a string list")
    require(set(publication.get("allowed_operations", [])) <= {"save_object", "archive_object", "note"},
            "publication contains an unsupported scoped operation")
    structure = publication.get("structure")
    if structure is not None:
        require(isinstance(structure, dict) and set(structure) <= {"create", "move", "note_created"},
                "publication.structure has unsupported permissions")
        for operation, permitted in (("create", publication.get("create_kinds", [])),
                                     ("move", publication.get("update_kinds", []))):
            kinds = structure.get(operation, {})
            require(isinstance(kinds, dict) and all(kind in permitted and isinstance(scopes, list) and scopes and
                    set(scopes) <= {"context_parent", "fresh_parent", "created"} for kind, scopes in kinds.items()),
                    "structural permissions need permitted kinds and parent scopes")
        require(type(structure.get("note_created", False)) is bool and
                (not structure.get("note_created") or "note" in publication.get("allowed_operations", [])),
                "structural notes need note permission")
    require(isinstance(config.get("references", []), list) and
            all(isinstance(item, str) and item for item in config.get("references", [])), "references must be field names")
    batch_settings(config)
    related = config.get("related")
    if related is not None:
        require(isinstance(related, dict) and set(related) <= {"limit", "parent", "incoming"} and
                type(related.get("limit")) is int and 1 <= related["limit"] < 100 and isinstance(related.get("parent"), dict) and
                related["parent"].get("kind"), "related needs a parent kind and limit 1..99")
        require(not config.get("batch"), "related context does not support batches")
        parent, incoming = related["parent"], related.get("incoming")
        require(set(parent) <= {"kind", "exclude_tags", "children", "references"}, "unsupported related parent query")
        require(incoming is None or isinstance(incoming, dict) and set(incoming) == {"kind", "relation"} and
                incoming["kind"] and isinstance(incoming["relation"], str) and incoming["relation"], "invalid incoming query")
    permission = publication.get("related_updates", {})
    require(isinstance(permission, dict) and set(permission) <= {"parent", "incoming"} and
            ("parent" not in permission or permission["parent"] == ["stage"]) and
            ("incoming" not in permission or permission["incoming"] == "remove_selected_edge") and
            (not permission or related is not None), "invalid related write permissions")
    require(type(config.get("repeat", False)) is bool, "config.repeat must be boolean")
    require(config.get("retry", "on_revision") in ("always", "on_revision", "never"),
            "config.retry must be always, on_revision or never")
    require(type(config.get("failure_notes", True)) is bool, "config.failure_notes must be boolean")
    escalation = config.get("failure_escalation")
    if escalation is not None:
        require(isinstance(escalation, dict) and set(escalation) == {"after", "data"} and
                type(escalation["after"]) is int and escalation["after"] > 0,
                "failure_escalation needs a positive after count and data")
        require(isinstance(escalation["data"], dict) and escalation["data"] and
                "assignee" not in escalation["data"] and all(isinstance(key, str) and key and
                    isinstance(value, str) and value for key, value in escalation["data"].items()),
                "failure_escalation.data needs text fields and cannot change assignee")
        require("save_object" in publication.get("allowed_operations", []) and "note" in publication.get("allowed_operations", []) and
                config["selection"]["kind"] in publication.get("update_kinds", []),
                "failure_escalation needs permission to save and note the selected kind")
    return config


def launch(path, raw, item, dry_run):
    profiled = "inputs" in json.loads(raw)
    config = configuration(path, raw, int(os.environ.get("PLANNING_JOPPA_INPUT", "0")))
    if profiled:
        raw = json.dumps(config)
    require(isinstance(item, str) and ":" in item, "configured workflows need a full object address")
    executable = os.environ.get("MEDULLA_BIN", "medulla")
    variables = {**config.get("vars", {}), "PLANNING_JOPPA_CONFIG": str(path),
        "PLANNING_JOPPA_CONFIG_DIGEST": digest(config), "PLANNING_JOPPA_ITEM": item,
        "PLANNING_PYTHON": sys.executable,
        "CREW_FLOW_STAGES": str(Path(__file__).with_name("flow_stages.py").resolve()),
        "FLOW_PUBLICATION": config["publication"]}
    command = [executable, "-w", config["workflow"], "--runs-folder", config["runs_folder"], "--print-run-dir"]
    if dry_run:
        print("ITEM: " + item)
        print("Workflow: " + config["workflow"])
        print("Publication: " + json.dumps(config["publication"]))
        print("Dry run: no MCP calls, claims, agents, or writes")
        return 0
    require(shutil.which(executable), "required executable missing: " + executable)
    with tempfile.TemporaryDirectory(prefix="crew-planner-memory-") as memory, \
            tempfile.TemporaryDirectory(prefix="crew-planner-agy-") as agy:
        command.extend(["--var", "AGY_PROFILE_HOME=" + agy])
        snapshot = Path(memory) / "config.json"
        snapshot.write_bytes(raw.encode() if isinstance(raw, str) else raw)
        snapshot.chmod(0o600)
        variables["PLANNING_JOPPA_CONFIG_SNAPSHOT"] = str(snapshot)
        if profiled:
            variables["PLANNING_JOPPA_CONFIG"] = str(snapshot)
        for name, value in variables.items():
            command.extend(["--var", name + "=" + (value if isinstance(value, str) else json.dumps(value))])
        working = Path(memory) / "work"
        working.mkdir()
        env = dict(os.environ)
        env["LANE_MEMORY_CONFIG"] = ""
        if config.get("context"):
            target = Path(memory) / "context.json"
            target.write_text(json.dumps(config["context"]))
            target.chmod(0o600)
            env["LANE_MEMORY_CONFIG"] = str(target)
        from flow_runtime import execute
        code = execute(command, env, working, config)
        return 1 if code == 75 else code
