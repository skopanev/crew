"""Launch planning without claiming work, creating lanes, or modifying a queue."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from common import read, require, validate_input


def main():
    parser = argparse.ArgumentParser(description="Prepare one AC in a separate Medulla workflow.")
    parser.add_argument("--input", required=True, help="AC, Requirement and repository scope JSON")
    parser.add_argument("--dry-run", action="store_true", help="validate and print graph; run no tools or agents")
    parser.add_argument("--cbm-store", default=os.environ.get("CBM_CACHE_DIR"))
    parser.add_argument("--cbm-root", default=os.environ.get("CBM_ALLOWED_ROOT"))
    parser.add_argument("--equill-store", default=os.environ.get("EQUILL_STORE"))
    parser.add_argument("--runs-folder", default=str(Path.home() / ".medulla/planning-runs"))
    parser.add_argument("--research-model", default="gpt-6.1-sol", help="Codex model for research")
    parser.add_argument("--design-model", default="claude-opus-5-5", help="Claude model for plan design; critics are configured individually in workflow.yaml")
    args = parser.parse_args()
    source = Path(args.input).expanduser().resolve()
    data = validate_input(read(source))
    workflow = Path(__file__).resolve().parent
    executable = os.environ.get("MEDULLA_BIN", "medulla")
    require(shutil.which(executable), "medulla is unavailable; put it on PATH or set MEDULLA_BIN")
    output = Path(args.runs_folder).expanduser().resolve()
    for repo in data["repositories"]:
        require(not output.is_relative_to(Path(repo["path"]).resolve()), "runs-folder must be outside inspected repositories")
    if not args.dry_run:
        for key in ("cbm_store", "cbm_root", "equill_store"):
            require(getattr(args, key), f"--{key.replace('_', '-')} is required")
        for binary in (os.environ.get("EQUILL_BIN", "equill"), os.environ.get("CBM_BIN", "codebase-memory-mcp"), "codex", "claude", "agy", "opencode", "git"):
            require(shutil.which(binary), f"required executable missing: {binary}")
    # The live store must match the committed planning snapshots (one-way export).
    # Tests with a fake Equill set CREW_SKIP_ROLE_CHECK.
    if not args.dry_run and not os.environ.get("CREW_SKIP_ROLE_CHECK"):
        check = subprocess.run([sys.executable, str(workflow.parent / "roles/export.py"), "--check", "planning", "shared"],
                               env={**os.environ, "EQUILL_STORE": args.equill_store}, capture_output=True, text=True)
        require(check.returncode == 0, (check.stderr or check.stdout).strip() or "Crew role check failed")
    variables = {
        "PLANNING_INPUT": str(source), "RESEARCH_MODEL": args.research_model, "DESIGN_MODEL": args.design_model,
        "CBM_CACHE_DIR": args.cbm_store or "", "CBM_ALLOWED_ROOT": args.cbm_root or "",
        "CBM_BIN": shutil.which(os.environ.get("CBM_BIN", "codebase-memory-mcp")) or "codebase-memory-mcp",
        "EQUILL_STORE": args.equill_store or "", "EQUILL_BIN": os.environ.get("EQUILL_BIN", "equill"),
        "EQUILL_ACTOR": "planning", "PLANNING_PYTHON": sys.executable,
        "OPENCODE_BIN": shutil.which("opencode") or "opencode",
        "AGY_BIN": shutil.which("agy") or "agy",
    }
    command = [executable, "-w", str(workflow), "--runs-folder", str(output)]
    for key, value in variables.items():
        command += ["--var", f"{key}={value}"]
    if args.dry_run:
        command.append("--dry-run")
    # Provider settings can include keys. Remove the private config after the run.
    with tempfile.TemporaryDirectory(prefix="crew-opencode-") as config_home, \
            tempfile.TemporaryDirectory(prefix="crew-agy-") as agy_home:
        command += ["--var", f"OPENCODE_CONFIG_HOME={config_home}",
                    "--var", f"AGY_PROFILE_HOME={agy_home}"]
        return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as exc:
        print(f"planning: {exc}", file=sys.stderr)
        sys.exit(2)
