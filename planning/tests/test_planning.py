import copy
import json
import io
import os
import re
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLANNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLANNING))
from common import validate_input, fingerprint, read, write, digest
import stages
import tools


class FingerprintTests(unittest.TestCase):
    def test_fingerprint_streams_untracked_bytes_and_detects_content_changes(self):
        with tempfile.TemporaryDirectory(prefix="crew-planning-test-") as temp:
            repo = Path(temp) / "repo"
            (repo / "src").mkdir(parents=True)
            (repo / "src/main.py").write_text("value = 1\n")
            for args in (["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]):
                subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
            path = repo / "src/artifact.bin"
            path.write_bytes(b"a" * (3 * 1024 * 1024))
            source = {"id": "test", "path": str(repo), "cbm_project": "test-project",
                      "modules": [{"name": "src", "path": "src"}]}
            with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
                before = fingerprint(source)
                self.assertEqual(before, fingerprint(source))
                with path.open("r+b") as file:
                    file.seek(2 * 1024 * 1024)
                    file.write(b"b")
                self.assertNotEqual(before, fingerprint(source))


class ValidationTests(unittest.TestCase):
    def test_requires_domain_and_capability_meaning(self):
        original = json.loads((PLANNING / "tests/input.example.json").read_text())
        for level in ("domain", "capability"):
            for invalid in (None, {}, {"id": "present", "text": " "}):
                with self.subTest(level=level, invalid=invalid):
                    data = copy.deepcopy(original)
                    data[level] = invalid
                    with self.assertRaisesRegex(ValueError, level):
                        validate_input(data)

    def test_rejects_path_traversal_and_duplicate_repositories(self):
        data = json.loads((PLANNING / "tests/input.example.json").read_text())
        data["repositories"][0]["modules"][0]["path"] = "../outside"
        with self.assertRaisesRegex(ValueError, "relative path"):
            validate_input(data)
        data["repositories"][0]["modules"][0]["path"] = "."
        data["repositories"].append(copy.deepcopy(data["repositories"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate repository"):
            validate_input(data)


class ReferenceContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="planning-context-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "artifacts"
        self.target.mkdir()
        self.large = "Full context Ω </signal:var>\n" * 10000
        self.assignment = json.loads((PLANNING / "tests/input.example.json").read_text())
        self.assignment["repositories"][0]["path"] = str(self.root / "source")
        self.assignment["ac"]["text"] = self.large
        self.env = patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.root), "CBM_BIN": "/cbm",
            "CBM_CACHE_DIR": "/cache", "CBM_ALLOWED_ROOT": str(self.root / "source"),
            "OUTPUT_CONTRACT": self.large, "NECESSITY_OUTPUT_CONTRACT": self.large})
        self.env.start()
        self.addCleanup(self.env.stop)

    def prepare(self):
        with patch.object(stages, "refresh_index", return_value={"snapshot": self.large}), \
             patch.object(stages, "load_contract", return_value={"content": self.large}), \
             patch.object(stages, "load_knowledge", return_value=({"raw": self.large}, self.large)), \
             patch.object(stages, "run", return_value=self.large), patch.object(stages, "prepare_opencode"), \
             redirect_stdout(io.StringIO()) as output:
            stages.prepare_context(self.assignment, projects=[], mcp_servers={"sources": {
                "command": "/reader", "args": ["--read-only"]}})
        return output.getvalue()

    def test_large_frozen_context_is_complete_and_absent_from_signals(self):
        output = self.prepare()
        self.assertNotIn(self.large, output)
        self.assertLess(len(output), 2000)
        self.assertEqual(read(self.target / "assignment.json"), self.assignment)
        self.assertEqual(read(self.target / "lessons.json"), self.large)
        self.assertEqual(read(self.target / "contracts.json")["critic"]["content"], self.large)
        self.assertEqual(read(self.target / "output-contracts.json")["OUTPUT_CONTRACT"], self.large)
        self.assertIn("sources", read(self.target / "planning-base-mcp.json")["mcpServers"])
        for role in ("research", "necessity", "design", "critic", "drift"):
            self.assertEqual((self.target / f"{role}-rules.md").read_text(),
                             (PLANNING / "prompts" / f"{role}.md").read_text())

    def test_role_grants_exclude_peer_reports_and_preserve_the_full_question(self):
        self.prepare()
        write(self.target / "critique.json", {"previous_plan": self.large, "blocking_findings": self.large})
        extra_file = self.root / "reference.txt"
        extra_file.write_text(self.large)
        extra_root = self.root / "documents"
        extra_root.mkdir()
        write(self.target / "planning-read-paths.json", [str(extra_file), str(extra_root)])
        reader_config = self.target / "configured-reader.json"
        write(reader_config, {"mcpServers": {"joppa": {"command": "/reader", "args": [],
              "env": {"CREW_READER_FILES": "[]"}}}})
        def prepared(argv, **kwargs):
            self.assertEqual(argv[1:3], ["--input-type=module", "-e"])
            return json.dumps({"file": str(reader_config), "home": str(self.root / "seat"),
                               "toml": "mcp_servers={joppa={command=\"/reader\",args=[]}}"})
        cases = [("research", "code", "codex"), ("research", "knowledge", "codex"),
                 ("research", "external", "codex"), ("necessity", "necessity", "codex"),
                 ("design", "design", "claude-code"), ("critic", "simplicity", "agy"),
                 ("critic", "correctness", "opencode"), ("drift", "necessity", "codex"),
                 ("drift", "simplicity", "agy"), ("drift", "correctness", "opencode")]
        for role, slug, harness in cases:
            with self.subTest(role=role, slug=slug), patch.dict(os.environ, {
                 "PLANNING_READER_ROLE": role, "MEDULLA_HARNESS": harness,
                 "MEDULLA_INPUT": json.dumps({"slug": slug, "question": self.large})}), \
                 patch.object(tools, "run", side_effect=prepared), \
                 patch.object(tools, "prepare_opencode") as opencode, redirect_stdout(io.StringIO()) as output:
                tools.prepare_critic()
                name = f"planning_{role}_{slug}"
                grant = read(self.target / f"{name}-files.json")
                names = {Path(file).name for file in grant["files"]}
                self.assertEqual(read(self.target / f"{name}-reference.json")["question"],
                                 "" if role in ("design", "necessity") else self.large)
                self.assertEqual(grant["roots"], [self.assignment["repositories"][0]["path"], str(extra_root)])
                self.assertIn(str(extra_file), grant["files"])
                self.assertIn(f"{role}-rules.md", names)
                self.assertFalse(any(file.startswith(("critic-", "drift-", "research-"))
                                     and file.endswith(".json") for file in names))
                self.assertEqual("critique.json" in names, role == "design")
                self.assertEqual("plan.json" in names, role in ("critic", "drift"))
                self.assertEqual("drift.diff" in names, role == "drift")
                self.assertNotIn(self.large, output.getvalue())
                if harness == "opencode":
                    self.assertNotIn(str(self.root), opencode.call_args.args[0])
                    self.assertIn("CREW_READER_FILES", opencode.call_args.kwargs["mcp_servers"]["joppa"]["env"])
                else:
                    opencode.assert_not_called()

    def test_node_import_does_not_run_the_helper_cli(self):
        self.prepare()
        helper = self.root / "reader-helper.mjs"
        helper.write_text(r'''import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function prepare(name, grant, existing) {
  const source = JSON.parse(fs.readFileSync(existing, 'utf8')).mcpServers.sources;
  const file = path.join(process.env.MEDULLA_RUN_DIR, 'artifacts', name + '-reader.json');
  const server = {...source, env: {CREW_READER_FILES: JSON.stringify(grant.files)}};
  fs.writeFileSync(file, JSON.stringify({mcpServers: {joppa: server}}));
  return {file, home: ''};
}
export function prepareAgy() { throw new Error('Do not start AGY in this test'); }
export function agentArgs() { return ['-c', 'mcp_servers={joppa={command="/reader",args=[]}}']; }
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error('The imported helper must not execute its CLI');
}
''')
        with patch.dict(os.environ, {"PLANNING_READER_HELPER": str(helper),
             "PLANNING_READER_ROLE": "necessity", "MEDULLA_HARNESS": "codex",
             "MEDULLA_INPUT": '"inherited outer pool input"',
             "OUTPUT_CONTRACT": "", "NECESSITY_OUTPUT_CONTRACT": ""}), redirect_stdout(io.StringIO()) as output:
            tools.prepare_critic()
        config = read(self.target / "planning_necessity_necessity-reader.json")
        self.assertEqual(config["mcpServers"]["joppa"]["command"], "/reader")
        self.assertIn("PLANNING_MCP_TOML", output.getvalue())
        self.assertEqual(read(self.target / "planning_necessity_necessity-reference.json")["perspective"], "necessity")

    def test_research_and_revision_outputs_remain_complete_without_inline_context(self):
        for branch in stages.validation.RESEARCH:
            write(self.target / f"research-{branch}.json", {"status": "complete", "summary": self.large})
        with patch.object(stages.validation, "research"), \
             patch.object(stages, "assessment_digest", return_value="frozen"), \
             redirect_stdout(io.StringIO()) as output:
            stages.research_join()
        self.assertNotIn(self.large, output.getvalue())
        self.assertEqual(read(self.target / "research.json")["code"]["summary"], self.large)
        plan = {"approach": self.large}
        write(self.target / "plan.json", plan)
        for slug in stages.validation.CRITICS:
            write(self.target / f"critic-{slug}.json", {"verdict": "reject", "findings": [
                {"blocking": True, "claim": self.large}]})
        with patch.object(stages.validation, "critique"), redirect_stdout(io.StringIO()) as output:
            stages.critique_join()
        feedback = read(self.target / "critique.json")
        self.assertEqual(feedback["previous_plan"], plan)
        self.assertEqual(feedback["blocking_findings"]["simplicity"][0]["claim"], self.large)
        self.assertNotIn(self.large, output.getvalue())
        self.assertEqual(read(self.target / "revisions.json")[0]["plan_digest"], digest(plan))

    def test_only_role_address_and_draft_references_enter_agent_prompts(self):
        workflow = (PLANNING / "workflow.yaml").read_text()
        self.assertEqual((PLANNING.parent / "planning-joppa/workflow.yaml").resolve(),
                         (PLANNING / "workflow.yaml").resolve())
        prompts = re.findall(r"    prompt: \|\n(.*?)(?=    post:)", workflow, re.S)
        self.assertEqual(len(prompts), 5)
        for prompt in prompts:
            variables = set(re.findall(r"\{\{var:([^}]+)\}\}", prompt))
            for round_number in (1, 2, 4):
                for seat in ("code", "knowledge", "external", "simplicity", "correctness", "necessity"):
                    assembled = prompt.replace("{{var:planning_item_address}}", "criterion:example").replace(
                        "{{var:planning_plan_path}}", "/workspace/public-project/.medulla/runs/planning-joppa/20261124-long-example/artifacts/plan.json")
                    self.assertLessEqual(len(assembled) + 586, 1024, (round_number, seat))
            self.assertLessEqual(variables, {"planning_item_address", "planning_plan_path"})
            self.assertIn("next_offset is null", prompt)
            self.assertNotIn("{{file:", prompt)
            self.assertNotIn("{{input.", prompt)
        self.assertIn('web_search="live"', workflow)
        self.assertIn("check_index_coverage", workflow)
        self.assertIn("PLANNING_READER_ROLE: design", workflow)
        self.assertNotIn("features.shell_tool=false", workflow)


if __name__ == "__main__":
    unittest.main()
