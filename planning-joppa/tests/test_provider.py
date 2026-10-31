"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
from common import read
import context
from mcp import MCPError, Rejected, Reader
import publication


from provider_fixture import item, assignment, plan, Fake


class ProviderTests(unittest.TestCase):
    def test_test_list_revision_keeps_only_current_contract_pins(self):
        value = item("criterion:a")
        value["contract_revision"] = 2
        self.assertEqual(context.source(value)["contract_revision"], 2)
        for pin, current, contract, expected in ((2, 3, 2, True), (1, 3, 2, False),
                (4, 3, 2, False), (2, 3, 0, False), (True, 3, 1, False)):
            self.assertEqual(context.current_pin(pin, current, contract), expected)
            link = {"revision": pin, "status": {"access": True, "present": True,
                "current_revision": current, "contract_revision": contract,
                "review_required": False, "satisfied": True}}
            self.assertEqual(context.remote_satisfied(link), expected)

    def test_snapshots_keep_selected_lists_and_ignore_runtime_task_revisions(self):
        types = {"criterion": {"role": "ac"}, "work": {"role": "task"}}
        ac = item("criterion:a", data={"title": "Criterion", "tests": ["checks.rs > first"]})
        ac["contract_revision"] = 3
        selected = context.snapshot_source(ac, types, [ac["address"]])
        sibling = context.snapshot_source(ac, types, [])
        ac["current_revision"] = ac["document"]["revision"] = 4
        ac["document"]["data"]["tests"] = ["checks.rs > replacement"]
        self.assertNotEqual(selected, context.snapshot_source(ac, types, [ac["address"]]))
        self.assertEqual(sibling, context.snapshot_source(ac, types, []))
        task = item("work:one")
        task["contract_revision"] = 3
        before = context.snapshot_source(task, types)
        task["contract_revision"] = task["current_revision"] = task["document"]["revision"] = 4
        self.assertEqual(before, context.snapshot_source(task, types))

    def test_requirement_prompt_title_budgets_fit_the_publication_bound(self):
        data = assignment()
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "other"})
        schemas = {address: {key: deepcopy(data["joppa"][key])
                    for key in ("task_type", "task_schema", "test_status")}
                   for address in ("criterion:a", "criterion:b")}
        schemas["criterion:b"]["task_schema"]["title_preview_length"] = 43
        data["joppa"].update(scope="requirement", criteria=[{"id": key} for key in schemas], criterion_schemas=schemas)
        data["joppa"]["objects"]["work:old"]["document"]["data"].update(
            title="[999] Existing", contract="Repository: service\nModule: core")
        budgets = publication.title_budgets(data)
        self.assertEqual(budgets, {"service": 36, "other": 37})
        counters = publication.package_counters({}, data)
        for repository, budget in budgets.items():
            for number in range(publication.MAX_PUBLICATION_OPERATIONS):
                task = {"id": str(number), "ac": "criterion:b", "repository": repository, "title": "x" * budget}
                self.assertLessEqual(len(publication.checked_task_title(task, data, counters)), 43)

    def test_cli_failure_remains_after_npx_descendant_shutdown(self):
        for terminate_parent in (False, True):
            with self.subTest(terminate_parent=terminate_parent):
                self.check_npx_shutdown(terminate_parent)

    def check_npx_shutdown(self, terminate_parent):
        with tempfile.TemporaryDirectory() as directory:
            script = ROOT / "planning-joppa/stages.py"
            child = Path(directory) / "mcp-child.mjs"
            child_pid = Path(directory) / "child.pid"
            group_pid = Path(directory) / "group.pid"
            child.write_text('''import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => setTimeout(() => {
  console.error("mcp-remote shutdown stack");
  process.exit(0);
}, 150));
console.log("ready");
setInterval(() => {}, 1000);
''')
            command = [shutil.which("npx"), "--offline", "--call",
                       f"node {shlex.quote(str(child))} {shlex.quote(str(child_pid))} & exit 0"]
            program = f'''import os, runpy, signal, sys
from pathlib import Path
sys.path.insert(0, {str(ROOT / "planning")!r})
import stages
sys.path.insert(0, {str(ROOT / "planning-joppa")!r})
from stdio import StdioRPC
stages.artifacts = lambda: Path({directory!r})
def probe():
    transport = StdioRPC({command!r})
    Path({str(group_pid)!r}).write_text(str(transport.process.pid))
    assert os.getpgid(transport.process.pid) == transport.process.pid
    assert transport.process.stdout.readline() == b"ready\\n"
    assert os.getpgid(int(Path({str(child_pid)!r}).read_text())) == transport.process.pid
    assert transport.process.wait(timeout=5) == 0
    if {terminate_parent!r}:
        print("probe-ready", flush=True)
        signal.pause()
    raise ValueError("Task first: use at most 59 characters")
stages.body_result = probe
sys.argv = [{str(script)!r}, "capture", "plan"]
runpy.run_path({str(script)!r}, run_name="__main__")
'''
            try:
                if terminate_parent:
                    process = subprocess.Popen([sys.executable, "-c", program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        ready, _, _ = select.select([process.stdout], [], [], 10)
                        self.assertTrue(ready, "capture did not reach its MCP command")
                        self.assertEqual(process.stdout.readline().strip(), "probe-ready")
                        process.terminate()
                        stdout, stderr = process.communicate(timeout=20)
                        result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.communicate(timeout=2)
                else:
                    result = subprocess.run([sys.executable, "-c", program], capture_output=True, text=True, timeout=20)
                state = subprocess.run(["ps", "-p", child_pid.read_text(), "-o", "stat="], capture_output=True, text=True).stdout.strip()
            finally:
                if group_pid.exists():
                    try:
                        os.killpg(int(group_pid.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            self.assertEqual(result.returncode, 143 if terminate_parent else 1, result.stderr)
            self.assertIn("mcp-remote shutdown stack", result.stderr)
            if not terminate_parent:
                self.assertEqual(result.stderr.splitlines()[-1],
                                 "planning-joppa/capture: Task first: use at most 59 characters")
            self.assertTrue(not state or state.startswith("Z"), f"MCP descendant remains active: {state}")

    def test_requirement_title_budget_includes_actual_generated_prefix(self):
        for limit, number in ((64, 1), (43, 105)):
            with self.subTest(limit=limit, number=number):
                data, value = assignment(), plan()
                data["joppa"]["task_schema"]["title_preview_length"] = limit
                data["joppa"].update(scope="requirement", criteria=[{"id": "criterion:a"}],
                    criterion_schemas={"criterion:a": {key: deepcopy(data["joppa"][key])
                        for key in ("task_type", "task_schema", "test_status")}})
                old = data["joppa"]["tasks"][0]
                old["document"]["data"].update(title=f"[{number:02d}] Existing",
                    contract="Repository: service\nModule: core")
                prefix = f"[{number:02d}] "
                budget = limit - len(prefix)
                task = value["tasks"][0]
                task.update(action="update", target=old["address"], revision=3, title="x" * budget)
                value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"}]
                value["acceptance_checks"][0]["ac"] = "criterion:a"
                operations = publication.operations(value, data)
                title = operations[0]["command"]["data"]["title"]
                self.assertEqual(title, prefix + task["title"])
                self.assertEqual(len(title), limit)
                task["title"] += "x"
                with self.assertRaisesRegex(ValueError, f"Task first:.*use at most {budget} characters"):
                    publication.operations(value, data)

    def test_capture_rejects_an_oversized_publication_before_critics(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_size", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
            criterion_schemas={address: {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")} for address in ("criterion:a", "criterion:b")})
        data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
        value["criteria"] = [{"ac": address, "disposition": "implement"} for address in ("criterion:a", "criterion:b")]
        value["acceptance_checks"] = [{**deepcopy(value["acceptance_checks"][0]), "ac": address}
                                      for address in ("criterion:a", "criterion:b")]
        first = value["tasks"][0]
        value["tasks"] = [{**deepcopy(first), "id": f"task{number}", "ac": "criterion:a" if number < 50 else "criterion:b"}
                          for number in range(100)]
        api = Fake()
        with tempfile.TemporaryDirectory() as directory, patch.object(stage, "settings", return_value={"workspace": "example"}), \
             patch.object(stage.context, "client", return_value=api), patch.object(stage.context, "read_assignment", return_value=data), \
             patch.object(stage.shared, "artifacts", return_value=Path(directory)), \
             patch.object(stage.shared, "body_result", return_value=(value, [])), \
             patch.object(stage.shared, "bind_necessity") as necessity:
            with self.assertRaisesRegex(ValueError, "100 operations"):
                stage.capture("plan")
            necessity.assert_not_called()
            self.assertFalse((Path(directory) / "plan.json").exists())
        self.assertEqual(api.calls, [])

    def test_server_rejection_retains_exact_reason(self):
        transport = object.__new__(__import__("mcp").Joppa)
        transport.token = "test-secret"
        transport.rpc = lambda *args: {"isError": True, "structuredContent": {"error": "stale object revision; read the object again"}}
        with self.assertRaisesRegex(Rejected, "stale object revision; read the object again"):
            transport.call("joppa_command", {})

    def test_source_claim_exclusion_and_authority_changes(self):
        old = item("criterion:a")
        current = deepcopy(old)
        current["position"] = 30
        current["process"]["planning_claim"] = {"actor": "planner", "position": 21}
        context.unchanged(context.source(old), context.source(current))
        current["annotations"]["comments"].append({"kind": "decision", "text": "New constraint"})
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(context.source(old), context.source(current))

    def test_snapshot_ignores_task_runtime_changes_but_preserves_contracts(self):
        old = item("work:one", process={"assignee": "worker", "status": "in_progress"})
        current = deepcopy(old)
        current["process"] = {"assignee": None, "status": "open"}
        current["current_revision"] = 4
        current["document"].update(revision=4, actor="worker", position=25, reason="Release the Task")
        types = {"work": {"role": "task"}}
        context.unchanged(context.snapshot_source(old, types), context.snapshot_source(current, types))
        current["document"]["data"]["title"] = "Changed contract"
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(context.snapshot_source(old, types), context.snapshot_source(current, types))

    def test_dry_run_uses_no_mcp_or_agents(self):
        result = subprocess.run([sys.executable, str(ROOT / "planning-joppa/launch.py"), "--config",
            str(ROOT / "planning-joppa/config.example.json"), "--ac-id", "criterion:a", "--dry-run"],
            env={**os.environ, "MEDULLA_BIN": "/unavailable/medulla"}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no MCP calls, claims, agents, or writes", result.stdout)
