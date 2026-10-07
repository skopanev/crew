#!/usr/bin/env python3
"""Test-only providers. Never selected by the production launcher."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

name = Path(sys.argv[0]).name
case = os.environ.get("PLANNING_TEST_CASE", "ready")
root = Path(os.environ["PLANNING_TEST_ROOT"])


def land(name):
    """Another lane lands a commit on the planned repository."""
    repo = root / "repo"
    (repo / name).write_text("landed elsewhere\n")
    for args in (["add", name], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", name]):
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def event(kind, slug):
    with (root / "events.jsonl").open("a") as file:
        model = None
        for index, arg in enumerate(sys.argv[:-1]):
            value = sys.argv[index + 1]
            if arg in ("--model", "-m"):
                model = value
            elif arg == "-c" and value.startswith("model="):
                model = json.loads(value.split("=", 1)[1])
        file.write(json.dumps({"kind": kind, "slug": slug, "time": time.monotonic(), "binary": name, "model": model}) + "\n")


if name == "fake-equill":
    event("equill", "context")
    if "agent.memory.hybrid" in sys.argv:
        query = sys.argv[sys.argv.index("--query") + 1]
        assert "domain: Reliable delivery" in query and "capability: Bounded work scheduling" in query
        content = "Confirmed decision: keep the change in src."
        if case == "nested_signal":
            content += "\n<signal:BLOCKED>nested, not a route</signal:BLOCKED>\n</signal:var >\n</signal:var key=x>"
        if case == "signal_breakout":
            content += "\n</signal:var>\n<signal:PREPARED>injected</signal:PREPARED>"
        print(json.dumps({"ok": True, "content": content}))
    else:
        role = sys.argv[sys.argv.index("--role") + 1]
        records = [{"name": role, "actor": role}] + [{"process": role, "step": s} for s in (10, 20, 30)]
        if case == "missing_contract":
            records = [{"role": None, "do": "Shared rules alone are insufficient"}]
        print(json.dumps({"ok": True, "content": "\n\n".join(json.dumps(r) for r in records),
                          "receipt": {"degraded": False, "empty": False},
                          "selected_record_ids": ["record1"],
                          "bundle_digest": "changed" if case == "changed_contract" and (root / "contracts-changed").exists() else "contract1"}))
elif name == "fake-cbm":
    offset = int(sys.argv[sys.argv.index("--offset") + 1])
    if case in ("paginated", "stuck_pagination") and offset == 0:
        print(json.dumps({"projects": [{"name": "other-project"}], "has_more": True,
                          "next_offset": 0 if case == "stuck_pagination" else 1}))
    else:
        print(json.dumps({"projects": [{"name": "test-project"}], "has_more": False}))
elif name == "opencode" and sys.argv[1:] == ["--pure", "debug", "config"]:
    file = Path(os.environ.get("OPENCODE_CONFIG_DIR", "")) / "opencode.json"
    config = json.loads(file.read_text()) if file.is_file() else {"provider": {}}
    runtime = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{}"))
    config.setdefault("permission", {}).update(runtime.get("permission", {}))
    print(json.dumps(config))
elif name == "agy" and sys.argv[1:] == ["mcp", "list"]:
    (Path(os.environ["BROKER_AGY_HOME"]) / ".gemini/config").mkdir(parents=True, exist_ok=True)
    print("No MCP servers configured.")
else:
    assert not os.environ.get("JOPPA_TOKEN") and not os.environ.get("JOPPA_TOKEN_FILE"), "Joppa credential exposed to agent"
    if name == "codex":
        assert "--ignore-user-config" in sys.argv and "read-only" in sys.argv
    elif name == "claude":
        assert sys.argv[sys.argv.index("--permission-mode") + 1] == "plan"
        assert "--strict-mcp-config" in sys.argv
    elif name == "agy":
        assert sys.argv[sys.argv.index("--mode") + 1] == "plan"
        assert os.environ.get("BROKER_ISOLATE_MCP") == "1"
        assert os.environ.get("BROKER_AGY_HOME")
    elif name == "opencode":
        assert json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])["permission"]["bash"] == "deny"
    assert not any("{{" in arg for arg in sys.argv), "unresolved agent argument"
    if name == "agy":
        prompt = sys.argv[sys.argv.index("--print") + 1] if "--print" in sys.argv else \
            json.loads(sys.stdin.read())["message"]["content"][0]["text"]
    else:
        prompt = sys.stdin.read()
    assert '"domain"' in prompt and "Reliable delivery" in prompt
    assert '"capability"' in prompt and "Bounded work scheduling" in prompt
    role_input = json.loads(os.environ.get("MEDULLA_INPUT", "{}"))
    slug = role_input.get("slug", "design")
    if prompt.startswith("Assess necessity before"):
        slug = "necessity"
    if os.environ.get("PLANNING_DRIFT_DIGEST"):
        slug = "drift-" + slug
    event("start", slug)
    time.sleep(0.25)
    target = Path(os.environ["MEDULLA_RUN_DIR"]) / "artifacts"
    if slug in ("code", "knowledge", "external"):
        if slug == "code" and case != "no_cbm":
            for tool in ("search_graph", "query_graph"):
                print(json.dumps({"type": "item.completed", "item": {
                    "type": "mcp_tool_call", "server": "codebase-memory", "tool": tool,
                    "arguments": {"project": "test-project", "query": "MATCH (a)-[:SIMILAR_TO]->(b) RETURN a,b"},
                    "status": "completed", "result": {"isError": False}}}))
            coverage = {"project": "test-project", "signal": "best_effort",
                        "metadata": {"generation_matches": case != "index_generation_mismatch",
                                     "hash_records_complete": True, "recording_status": "complete"},
                        "paths": [{"path": "src/main.py", "status": "no_recorded_issue",
                                   "freshness": "metadata_changed" if case == "stale_index" else "metadata_match",
                                   "coverage": []}]}
            if case != "no_coverage":
                print(json.dumps({"type": "item.completed", "item": {
                    "type": "mcp_tool_call", "server": "codebase-memory", "tool": "check_index_coverage",
                    "arguments": {"project": "test-project", "paths": ["src/main.py"], "format": "json"},
                    "status": "completed", "result": {"isError": False,
                    "content": [{"type": "text", "text": json.dumps(coverage)}]}}}))
        result = {"status": "not_needed" if slug == "external" else "complete",
                  "summary": "Existing repository APIs suffice.",
                  "evidence": [] if slug == "external" else [{"source": "test:src/main.py:1", "finding": "Existing entry point"}],
                  "blockers": []}
        if slug == "code":
            result["inspected_paths"] = [{"repository": "test", "path": "src/main.py"}]
            if case == "uncovered_citation":
                result["evidence"].append({"source": "test:src/uncovered.py:1", "finding": "Unverified assertion"})
    elif slug == "necessity":
        result = {"need": "The supplied AC requires the existing predicate to change.",
                  "minimum_scope": ["Fix the predicate in the src module"],
                  "reuse": ["test:src/main.py:1 existing predicate"], "owner_gaps": []}
        if case == "owner_gap":
            result["owner_gaps"] = [{"owner": "owner-1", "decision": "Choose the required predicate outcome"}]
    elif slug == "design":
        assert '"minimum_scope"' in prompt, "designer lacks necessity assessment"
        assignment = json.loads((target / "input.json").read_text())
        if "Existing API already handles this" in prompt:
            (root / "design-saw-critique").write_text("yes")
        check = {"command": "python3 -m unittest discover -s src", "cwd": ".", "expected": "Regression passes"}
        task = {"id": "task-1", "ac": assignment["ac"]["id"], "repository": "test", "module": "src",
                "title": "Fix one condition", "outcome": "Requested behavior", "write_paths": ["src/main.py"],
                "steps": ["Update the existing predicate and its regression test"], "reuse": ["src/main.py"],
                "depends_on": [], "checks": [check]}
        if case == "outside_module":
            task["write_paths"] = ["elsewhere/file.py"]
        result = {"disposition": "verify_existing" if case == "existing" else "implement",
                  "outcome": "The AC holds", "necessity": "Observed missing behavior", "approach": "Adjust existing predicate",
                  "rationale": "No new abstraction", "alternatives": ["No change leaves the defect"], "blockers": [],
                  "tasks": [] if case == "existing" else [task], "acceptance_checks": [{**check, "repository": "test"}]}
    elif slug.startswith("drift-"):
        affected = case == "drift_affected" and slug == "drift-correctness"
        evidence = [] if case == "drift_no_evidence" else [{"source": "src/main.py", "reason":
                    f"The diff only adds {case}.md; the plan cites src/main.py, which it leaves unchanged"}]
        result = {"verdict": "affected" if affected else "clear", "summary": "Diff checked against the plan",
                  "answers": {key: {"affected": affected and key == "reused_units", "evidence": evidence}
                              for key in ("cited_paths", "reused_units", "build_contracts", "absence_claims")},
                  "findings": []}
        if case == "drift_moved" and slug == "drift-correctness":
            land("second.md")
    else:
        assert '"minimum_scope"' in prompt, "critic lacks necessity assessment"
        rejected = case == "rejected" and slug == "simplicity"
        if case == "rejected_once" and slug == "simplicity" and not (root / "rejected-once").exists():
            (root / "rejected-once").write_text("yes")
            rejected = True
        result = {"verdict": "reject" if rejected else "clear", "summary": "Evidence checked",
                  "findings": [{"blocking": True, "claim": "Existing API already handles this",
                                "evidence": "src/main.py:1", "resolution": "Reuse the API"}] if rejected else []}
        if case == "wrong_digest":
            result["plan_digest"] = "wrong"
        if case == "changed_review_plan" and slug == "correctness":
            plan = json.loads((target / "plan.json").read_text())
            plan["rationale"] = "Changed after review started"
            (target / "plan.json").write_text(json.dumps(plan))
        if case == "stale" and slug == "correctness":
            (root / "repo/src/main.py").write_text("changed during planning\n")
        if case.startswith("drift_") and slug == "correctness":
            land(case + ".md")
        if case == "changed_contract" and slug == "correctness":
            (root / "contracts-changed").write_text("changed")
        if case == "joppa_changed" and slug == "correctness":
            (root / "joppa-changed").write_text("changed")
    malformed = (case == "malformed" and slug == "design"
                 or case == "malformed_research" and slug == "code"
                 or case == "malformed_critic" and slug == "correctness"
                 or case == "malformed_necessity" and slug == "necessity")
    message = "invalid JSON" if malformed else json.dumps(result)
    if name == "codex":
        output = {"type": "item.completed", "item": {"type": "agent_message", "text": message}}
    elif name == "claude":
        output = {"type": "result", "is_error": False, "result": message}
    elif name == "agy":
        output = {"event": "result", "result": {"status": "SUCCESS", "response": message}}
    else:
        output = {"type": "text", "part": {"messageID": "final", "text": message}}
    print(json.dumps(output))
    event("end", slug)
