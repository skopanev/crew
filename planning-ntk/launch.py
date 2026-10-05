"""Run NTK planning with a dispatcher configuration."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def configuration(file):
    data = json.loads(Path(file).read_text())
    for name in ("id", "workspace", "sourceRoot", "stateDir", "cbmMcpCommand", "cbmCacheDir"):
        if not isinstance(data.get(name), str) or not data[name].strip():
            raise ValueError(f"Config needs {name}")
    for name in ("sourceRoot", "stateDir", "cbmMcpCommand", "cbmCacheDir"):
        if not Path(data[name]).is_absolute():
            raise ValueError(f"{name} must be absolute")
    for name in ("sourceRoot", "cbmCacheDir"):
        if not Path(data[name]).is_dir():
            raise ValueError(f"Directory does not exist: {name}")
    if not Path(data["cbmMcpCommand"]).is_file():
        raise ValueError("cbmMcpCommand does not exist")
    options = data.get("planning", {})
    if not isinstance(options, dict):
        raise ValueError("planning must be an object")
    tag = options.get("dispatchTag", "crew")
    tags = data.get("tags", [])
    if not isinstance(tag, str) or not tag or not isinstance(tags, list) or tag not in tags or not all(isinstance(t, str) and t.strip() for t in tags):
        raise ValueError("planning.dispatchTag must be one of the dispatcher tags")
    return data


def main():
    parser = argparse.ArgumentParser(description="Prepare one NTK ticket or re-plan one lane failure.")
    parser.add_argument("--config", required=True, help="dispatcher JSON configuration")
    parser.add_argument("--ticket-id", required=True)
    parser.add_argument("--dry-run", action="store_true", help="validate the graph without NTK, Equill or agent calls")
    parser.add_argument("--resume", help="resume publication from this Medulla run directory")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", args.ticket_id):
        raise ValueError("Invalid ticket ID")
    file = Path(args.config).expanduser().resolve(strict=True)
    config = configuration(file)
    here = Path(__file__).resolve().parent
    options = config.get("planning", {})
    workspace = hashlib.sha256(config["workspace"].encode()).hexdigest()[:24]
    state = Path(config["stateDir"]) / "planning-ntk" / workspace
    variables = {
        "PLANNING_CONFIG": str(file), "PLANNING_TICKET": args.ticket_id.lower(),
        "PLANNING_STATE": str(state / args.ticket_id.lower()), "PLANNING_PYTHON": sys.executable,
        "CBM_BIN": config["cbmMcpCommand"], "CBM_CACHE_DIR": config["cbmCacheDir"],
        "CBM_ALLOWED_ROOT": config["sourceRoot"], "EQUILL_BIN": os.environ.get("EQUILL_BIN", "equill"),
        "EQUILL_STORE": options.get("equillStore", os.environ.get("EQUILL_STORE", str(Path.home() / ".equill/dev"))),
        "EQUILL_ACTOR": "planning",
        "OPENCODE_BIN": shutil.which("opencode") or "opencode",
        "RESEARCH_MODEL": options.get("researchModel", "gpt-6-astra"),
        "DESIGN_MODEL": options.get("designModel", "claude-opus-5"),
    }
    medulla = os.environ.get("MEDULLA_BIN", "medulla")
    binaries = [medulla] if args.dry_run else [medulla, "node", "git", "codex", "claude", "agy", "opencode", variables["EQUILL_BIN"]]
    for binary in binaries:
        if not shutil.which(binary):
            raise ValueError(f"Required executable is unavailable: {binary}")
    command = [medulla, "-w", str(here), "--runs-folder", str(state / "runs")]
    for key, value in variables.items():
        command += ["--var", f"{key}={value}"]
    if args.dry_run:
        return subprocess.run(command + ["--dry-run"], check=False).returncode
    # The live store must match the committed planning snapshots (one-way export).
    # Tests with a fake Equill set CREW_SKIP_ROLE_CHECK.
    check = None if os.environ.get("CREW_SKIP_ROLE_CHECK") else subprocess.run([sys.executable, str(here.parent / "roles/export.py"), "--check", "planning", "shared"],
                           env={**os.environ, "EQUILL_STORE": variables["EQUILL_STORE"]}, capture_output=True, text=True)
    if check is not None and check.returncode != 0:
        raise ValueError((check.stderr or check.stdout).strip() or "Crew role check failed")
    if args.resume:
        run_dir = Path(args.resume).resolve(strict=True)
        if not run_dir.is_relative_to((state / "runs").resolve()):
            raise ValueError("Resume directory belongs to another workspace")
        saved = json.loads((run_dir / "artifacts/ntk-input.json").read_text())
        if saved["source"]["ticket"]["id"] != args.ticket_id.lower():
            raise ValueError("Resume directory belongs to another ticket")
        command += ["--run", str(run_dir), "--node", "finish"]
    state.mkdir(parents=True, exist_ok=True)
    with (state / "planner.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another planner runs in this workspace")
        with tempfile.TemporaryDirectory(prefix="crew-opencode-") as config_home:
            command += ["--var", f"OPENCODE_CONFIG_HOME={config_home}"]
            return subprocess.run(command, cwd=config["sourceRoot"], pass_fds=(lock.fileno(),), check=False).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as error:
        sys.exit(f"planning-ntk: {error}")
