"""Mandatory live Equill contracts, loaded by deterministic code."""
import json
import os

from common import require, run, text

ROLES = ("researcher", "designer", "critic")


def load_contract(role, project):
    name = "crew-planning-" + role
    args = [os.environ.get("EQUILL_BIN", "equill"), "context", "--store", os.environ["EQUILL_STORE"],
            "--profile", "agent.context.target", "--role", name, "--process", name,
            "--project", project, "--coordinate", "rules=none", "--json"]
    result = json.loads(run(args, env={**os.environ, "EQUILL_ACTOR": "planning"}))
    require(result.get("ok") is True, f"Equill rejected {name}")
    content = text(result.get("content"), f"Equill {name} content")
    receipt = result.get("receipt", {})
    require(not receipt.get("degraded") and not receipt.get("empty"), f"Equill contract incomplete: {name}")
    records = [json.loads(block) for block in content.split("\n\n") if block.strip()]
    require(any(r.get("name") == name and r.get("actor") == name for r in records), f"Equill process missing: {name}")
    steps = {r.get("step") for r in records if r.get("process") == name}
    require({10, 20, 30}.issubset(steps), f"Equill steps incomplete: {name}")
    ids = result.get("selected_record_ids")
    require(isinstance(ids, list) and ids, f"Equill record receipt missing: {name}")
    return {"role": name, "content": content, "record_ids": ids,
            "bundle_digest": text(result.get("bundle_digest"), "Equill bundle_digest")}
