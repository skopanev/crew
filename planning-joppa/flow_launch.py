"""Run a configured Medulla workflow through the existing planner launcher."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from common import digest, require, text


def configuration(path, raw=None):
    config = json.loads(raw if raw is not None else Path(path).read_bytes())
    for key in ("workspace", "url", "runs_folder", "workflow"):
        text(config.get(key), "config." + key)
    require(Path(config["workflow"]).is_absolute() and Path(config["workflow"]).is_file(),
            "config.workflow must name an existing absolute workflow path")
    require(Path(config["runs_folder"]).is_absolute(), "config.runs_folder must be absolute")
    require(isinstance(config.get("selection"), dict) and config["selection"].get("kind"),
            "config.selection needs a native kind filter")
    require(config.get("mcp_command") or config.get("token_file"), "configure Joppa authentication")
    require(isinstance(config.get("vars", {}), dict), "config.vars must be an object")
    for name in config.get("vars", {}):
        require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) and
                not name.startswith(("PLANNING_", "CREW_FLOW_", "MEDULLA_")), "reserved workflow variable: " + name)
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
    require(isinstance(config.get("references", []), list) and
            all(isinstance(item, str) and item for item in config.get("references", [])), "references must be field names")
    return config


def launch(path, raw, item, dry_run):
    config = configuration(path, raw)
    require(isinstance(item, str) and ":" in item, "configured workflows need a full object address")
    executable = os.environ.get("MEDULLA_BIN", "medulla")
    variables = {**config.get("vars", {}), "PLANNING_JOPPA_CONFIG": str(path),
        "PLANNING_JOPPA_CONFIG_DIGEST": digest(config), "PLANNING_JOPPA_ITEM": item,
        "PLANNING_PYTHON": sys.executable,
        "CREW_FLOW_STAGES": str(Path(__file__).with_name("flow_stages.py").resolve()),
        "FLOW_PUBLICATION": config["publication"]}
    command = [executable, "-w", config["workflow"], "--runs-folder", config["runs_folder"], "--print-run-dir"]
    for name, value in variables.items():
        command.extend(["--var", name + "=" + (value if isinstance(value, str) else json.dumps(value))])
    if dry_run:
        print("ITEM: " + item)
        print("Workflow: " + config["workflow"])
        print("Publication: " + json.dumps(config["publication"]))
        print("Dry run: no MCP calls, claims, agents, or writes")
        return 0
    require(shutil.which(executable), "required executable missing: " + executable)
    with tempfile.TemporaryDirectory(prefix="crew-planner-memory-") as memory:
        env = dict(os.environ)
        env["LANE_MEMORY_CONFIG"] = ""
        if config.get("context"):
            target = Path(memory) / "context.json"
            target.write_text(json.dumps(config["context"]))
            target.chmod(0o600)
            env["LANE_MEMORY_CONFIG"] = str(target)
        code = subprocess.run(command, env=env, check=False).returncode
        return 1 if code == 75 else code
