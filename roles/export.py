#!/usr/bin/env python3
"""Export live Crew contracts as recovery drafts, without store metadata.

`export.py --check [lane|planning|shared ...]` writes nothing. It exits 1 when
the live store differs from the committed snapshots, so a lane or planning run
on another machine stops instead of using stale roles. Export is one-way
(store -> snapshot): `git pull` alone never updates a machine's store.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


GROUPS = {
    "lane": ("scout", "coder", "qa"),
    "planning": ("researcher", "designer", "critic"),
}
DIRECTORY = Path(__file__).resolve().parent


def store_path():
    return os.environ.get("EQUILL_STORE", str(Path.home() / ".equill/dev"))


def collect():
    """Read every live contract; return {group: snapshot file content}."""
    snapshots = {group: {} for group in (*GROUPS, "shared")}
    for group, roles in GROUPS.items():
        for role in roles:
            name = f"crew-{group}-{role}"
            result = subprocess.run(
                [os.environ.get("EQUILL_BIN", "equill"), "context",
                 "--store", store_path(),
                 "--profile", "agent.context.target", "--role", name,
                 "--process", name, "--coordinate", "rules=none",
                 "--budget-records", "1000", "--json"],
                env={**os.environ, "EQUILL_ACTOR": group},
                capture_output=True, text=True, timeout=120, check=True,
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
                    continue
                owner = payload.get("actor") or payload.get("role") or payload.get("process")
                if owner and owner != name:
                    raise ValueError(f"Unexpected role in {name}: {owner}")
                draft = {"type": kind, "payload": payload}
                line = json.dumps(draft, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                snapshots[group if owner else "shared"][line] = draft
    contents = {}
    for group, drafts in snapshots.items():
        lines = sorted(drafts, key=lambda line: (
            drafts[line]["type"], drafts[line]["payload"].get("actor", ""),
            drafts[line]["payload"].get("step", drafts[line]["payload"].get("order", 0)), line))
        contents[group] = "\n".join(lines) + "\n"
    return contents


def check(groups):
    """Return the snapshot files whose content differs from the live store."""
    contents = collect()
    stale = []
    for group in groups or contents:
        target = DIRECTORY / f"crew-{group}-records.jsonl"
        if not target.exists() or target.read_text() != contents[group]:
            stale.append(target.name)
    return stale


def export():
    # Read every contract successfully before changing any snapshot.
    for group, content in collect().items():
        target = DIRECTORY / f"crew-{group}-records.jsonl"
        lines = content.splitlines()
        if not target.exists() or target.read_text() != content:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                             dir=DIRECTORY, delete=False) as temporary:
                temporary_path = Path(temporary.name)
                try:
                    temporary.write(content)
                    temporary.close()
                    os.replace(temporary_path, target)
                finally:
                    temporary_path.unlink(missing_ok=True)
        print(f"Equill: {target.name} · {len(lines)} records")


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["--check"]:
            groups = sys.argv[2:]
            unknown = [g for g in groups if g not in (*GROUPS, "shared")]
            if unknown:
                sys.exit(f"Crew role check: unknown group {', '.join(unknown)}")
            stale = check(groups)
            if stale:
                sys.exit(f"Crew roles: the Equill store {store_path()} differs from "
                         f"{', '.join(stale)}. If the snapshot is newer (after git pull), "
                         "record its changed entries in the store; if the store is newer, "
                         "run roles/export.py and commit. Then start again.")
            sys.exit(0)
        export()
    except subprocess.TimeoutExpired:
        print("Crew role export timed out after 120 seconds", file=sys.stderr)
        sys.exit(75)
    except subprocess.CalledProcessError as error:
        sys.exit(f"Crew role export failed: {error.stderr.strip()[-300:] or error}")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"Crew role export failed: {error}")
