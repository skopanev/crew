#!/usr/bin/env python3
"""Test-only providers. Never selected by the production launcher."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

name = Path(sys.argv[0]).name
case = os.environ.get("PLANNING_TEST_CASE", "ready")
root = Path(os.environ["PLANNING_TEST_ROOT"])


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
else:
    assert not os.environ.get("JOPPA_TOKEN") and not os.environ.get("JOPPA_TOKEN_FILE"), "Joppa credential exposed to agent"
    if name == "codex":
        assert "--ignore-user-config" in sys.argv and "read-only" in sys.argv
    elif name == "claude":
        assert sys.argv[sys.argv.index("--permission-mode") + 1] == "plan"
        assert "--strict-mcp-config" in sys.argv
    elif name == "agy":
        assert sys.argv[sys.argv.index("--mode") + 1] == "plan"
    elif name == "opencode":
        assert json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])["permission"]["bash"] == "deny"
    assert not any("{{" in arg for arg in sys.argv), "unresolved agent argument"
    prompt = sys.argv[sys.argv.index("--print") + 1] if name == "agy" else sys.stdin.read()
    assert '"domain"' in prompt and "Reliable delivery" in prompt
    assert '"capability"' in prompt and "Bounded work scheduling" in prompt
    role_input = json.loads(os.environ.get("MEDULLA_INPUT", "{}"))
    slug = role_input.get("slug", "design")
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
    elif slug == "design":
        assignment = json.loads((target / "input.json").read_text())
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
    else:
        plan = json.loads((target / "plan.json").read_text())
        plan_digest = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
        rejected = case == "rejected" and slug == "simplicity"
        result = {"plan_digest": "wrong" if case == "wrong_digest" else plan_digest,
                  "verdict": "reject" if rejected else "clear", "summary": "Evidence checked",
                  "findings": [{"blocking": True, "claim": "Existing API already handles this",
                                "evidence": "src/main.py:1", "resolution": "Reuse the API"}] if rejected else []}
        if case == "stale" and slug == "correctness":
            (root / "repo/src/main.py").write_text("changed during planning\n")
        if case == "changed_contract" and slug == "correctness":
            (root / "contracts-changed").write_text("changed")
        if case == "joppa_changed" and slug == "correctness":
            (root / "joppa-changed").write_text("changed")
    malformed = (case == "malformed" and slug == "design"
                 or case == "malformed_research" and slug == "code"
                 or case == "malformed_critic" and slug == "correctness")
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
