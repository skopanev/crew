"""Launch the separate Joppa planner for one criterion."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "planning"))
from common import digest, require
import context

OUTPUT_CONTRACT = """This is Joppa planning. Plan exactly the supplied AC.
Use the standard plan shape. Each Task also needs action: create or update.
For update, include target (an existing Task under the supplied AC) and revision (its current document revision).
Preserve its owner, worker assignment, parent and other document fields.
Reuse existing suitable Tasks instead of duplicating their work. Omit unchanged, done and retired Tasks.
An implement plan needs at most five mechanism steps, reuse choices and observable AC and module checks for every Task.
Do not emit shallow implementation Tasks. Lane decides files, functions and test placement.
Use Joppa MCP to inspect relevant Tasks, ACs, Requirements, capabilities and domains in the configured workspace.
Search before creating Tasks. Read the full current object before reuse or a dependency.
The input includes sibling ACs and Tasks under the same Requirement. Reuse their required outputs through dependencies.
Unfinished work lists Tasks across Requirements in the configured repository projects. Check overlapping mechanisms before design.
Read the full current Task before reuse or a dependency. A shared module alone does not require a dependency.
Use earlier local Task IDs or full object addresses read through Joppa MCP for depends_on.
Add dependencies only when one output is required for another Task.
Unlike the default plan shape, verify_existing requires at least one scoped verification Task.
Set purpose: verification on each such Task. Give observable checks. Do not claim that acceptance passed.
The server publishes all Tasks and finishes the planning claim atomically.
Agents do not call Joppa mutations. Do not create a planning placeholder Task.
Title length must obey joppa.task_schema.title_preview_length.
"""


def main():
    parser = argparse.ArgumentParser(description="Plan one Joppa criterion in a separate Medulla workflow.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--ac-id", required=True, help="criterion address or ID when its schema type is unique")
    parser.add_argument("--dry-run", action="store_true", help="validate the config and show the command without MCP, agents or writes")
    args = parser.parse_args()
    path = Path(args.config).expanduser().resolve()
    config = context.configuration(path)
    workflow = Path(__file__).resolve().parent
    variables = {"PLANNING_JOPPA_CONFIG": str(path), "PLANNING_JOPPA_CONFIG_DIGEST": digest(config),
                 "PLANNING_JOPPA_AC": args.ac_id, "PLANNING_PYTHON": sys.executable,
                 "RESEARCH_MODEL": "gpt-6.1-sol", "DESIGN_MODEL": "claude-opus-5-5",
                 "OUTPUT_CONTRACT": OUTPUT_CONTRACT,
                 "NECESSITY_OUTPUT_CONTRACT": "Assess the selected AC. Existing owner decisions remain authoritative. "
                    "Do not produce shallow Tasks or wait for implementation dependencies to land. "
                    "Use Joppa MCP to inspect related work and its context as needed. Describe the minimum mechanism scope. The designer then prepares complete Tasks.",
                 "CBM_CACHE_DIR": config["cbm_store"], "CBM_ALLOWED_ROOT": config["cbm_root"],
                 "CBM_BIN": shutil.which(os.environ.get("CBM_BIN", "codebase-memory-mcp")) or "codebase-memory-mcp",
                 "EQUILL_STORE": config["equill_store"], "EQUILL_BIN": os.environ.get("EQUILL_BIN", "equill"),
                 "EQUILL_ACTOR": "planning", "OPENCODE_BIN": shutil.which("opencode") or "opencode",
                 "AGY_BIN": shutil.which("agy") or "agy"}
    executable = os.environ.get("MEDULLA_BIN", "medulla")
    command = [executable, "-w", str(workflow), "--runs-folder", config["runs_folder"], "--print-run-dir"]
    if args.dry_run:
        print("AC: " + args.ac_id)
        print("Graph: prepare → research → necessity → design → critics → finish")
        print("Publication: Task saves + finish_planning, one transaction")
        print("Command: " + " ".join(command))
        print("Dry run: no MCP calls, claims, agents, or writes")
        return 0
    for binary in (executable, variables["CBM_BIN"], variables["EQUILL_BIN"], "codex", "claude", "opencode", "agy", "git"):
        require(shutil.which(binary), f"required executable missing: {binary}")
    require(Path(config["token_file"]).is_file(), "Joppa token file is unavailable")
    if not os.environ.get("CREW_SKIP_ROLE_CHECK"):
        result = subprocess.run([sys.executable, str(workflow.parent / "roles/export.py"), "--check", "planning", "shared"],
                                env={**os.environ, "EQUILL_STORE": config["equill_store"]}, capture_output=True, text=True)
        require(result.returncode == 0, (result.stderr or result.stdout).strip() or "Crew role check failed")
    with tempfile.TemporaryDirectory(prefix="crew-joppa-opencode-") as opencode, \
            tempfile.TemporaryDirectory(prefix="crew-joppa-agy-") as agy:
        variables.update(OPENCODE_CONFIG_HOME=opencode, AGY_PROFILE_HOME=agy)
        for key, value in variables.items():
            command += ["--var", f"{key}={value}"]
        return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as error:
        print(f"planning-joppa: {error}", file=sys.stderr)
        sys.exit(2)
