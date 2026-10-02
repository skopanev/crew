#!/usr/bin/env python3
"""Export live Crew contracts as recovery drafts, without store metadata."""

import json
import os
from pathlib import Path
import subprocess
import sys


GROUPS = {
    "lane": ("scout", "coder", "qa"),
    "planning": ("researcher", "designer", "critic"),
}
DIRECTORY = Path(__file__).resolve().parent


def export():
    snapshots = {group: {} for group in (*GROUPS, "shared")}
    for group, roles in GROUPS.items():
        for role in roles:
            name = f"crew-{group}-{role}"
            result = subprocess.run(
                [os.environ.get("EQUILL_BIN", "equill"), "context",
                 "--store", os.environ.get("EQUILL_STORE", str(Path.home() / ".equill/dev")),
                 "--profile", "agent.context.target", "--role", name,
                 "--process", name, "--coordinate", "rules=none",
                 "--budget-records", "1000", "--json"],
                env={**os.environ, "EQUILL_ACTOR": group},
                capture_output=True, text=True, timeout=30, check=True,
            )
            context = json.loads(result.stdout)
            receipt = context.get("receipt", {})
            records = context.get("records", [])
            if (context.get("ok") is not True or receipt.get("degraded")
                    or receipt.get("empty") or receipt.get("projection") != "ready"
                    or not any(r["type"] == "agent.process.v1"
                               and r["payload"].get("name") == name for r in records)):
                raise ValueError(f"Incomplete Equill contract: {name}")
            for record in records:
                kind, payload = record["type"], record["payload"]
                if kind not in {"agent.process.v1", "agent.step.v1", "agent.role.v1", "agent.rule.v1"}:
                    raise ValueError(f"Unexpected contract record: {kind}")
                if payload.get("project") is not None:
                    raise ValueError(f"Project-specific record in {name}")
                owner = payload.get("actor") or payload.get("role") or payload.get("process")
                if owner and owner != name:
                    raise ValueError(f"Unexpected role in {name}: {owner}")
                draft = {"type": kind, "payload": payload}
                line = json.dumps(draft, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                snapshots[group if owner else "shared"][line] = draft
    # Read every contract successfully before changing any snapshot.
    for group, drafts in snapshots.items():
        lines = sorted(drafts, key=lambda line: (
            drafts[line]["type"], drafts[line]["payload"].get("actor", ""),
            drafts[line]["payload"].get("step", drafts[line]["payload"].get("order", 0)), line))
        target = DIRECTORY / f"crew-{group}-records.jsonl"
        content = "\n".join(lines) + "\n"
        if not target.exists() or target.read_text() != content:
            target.write_text(content)
        print(f"Equill: {target.name} · {len(lines)} records")


if __name__ == "__main__":
    try:
        export()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"Crew role export failed: {error}")
