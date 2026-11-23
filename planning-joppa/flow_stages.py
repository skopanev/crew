"""Shared stages for configured tracker flows. The workflow owns its business rules."""
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "planning"))
from common import digest, read, require, signal, write
from contracts import load_contract
from responses import body_result
from mcp import Joppa
from flow_launch import configuration
import flow_context
from flow_batch import members
import flow_publication
import planning_claims as claims
import publication


def artifacts():
    target = Path(os.environ["MEDULLA_RUN_DIR"]) / "artifacts"
    target.mkdir(parents=True, exist_ok=True)
    return target


def emit(name, value):
    from stages import emit_var
    require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name), "invalid workflow variable")
    emit_var(name, value)


def settings():
    config = configuration(Path(os.environ["PLANNING_JOPPA_CONFIG"]))
    require(digest(config) == os.environ["PLANNING_JOPPA_CONFIG_DIGEST"], "flow config changed during the run")
    return config


def client(config):
    return Joppa(config["url"], config.get("token_file"), config.get("mcp_command"))


def release_settings():
    snapshot = os.environ.get("PLANNING_JOPPA_CONFIG_SNAPSHOT")
    if not snapshot:
        return settings()
    config = read(snapshot)
    require(digest(config) == os.environ["PLANNING_JOPPA_CONFIG_DIGEST"], "flow release config digest differs")
    return config


def prepare():
    inline = os.environ.get("FLOW_ASSIGNMENT_INLINE", "true")
    require(inline in ("true", "false"), "FLOW_ASSIGNMENT_INLINE must be true or false")
    target, config = artifacts(), settings()
    api = client(config)
    assignment = flow_context.load(api, config, os.environ["PLANNING_JOPPA_ITEM"])
    selected = assignment["selected"]
    contracts = {}
    for role in (config.get("context") or {}).get("roles", {}):
        require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", role), "invalid context role key")
        contracts[role] = load_contract(role, config["workspace"])
    for item in members(assignment):
        publication.ensure_recovered(config["runs_folder"], target, config["url"], config["workspace"], item["address"])
    write(target / "input.json", assignment)
    write(target / "joppa-snapshot.json", {"schema": assignment["schema"],
          "objects": flow_context.objects(assignment)})
    items = members(assignment)
    operations = claims.claim_operations({"joppa": {"objects": {item["address"]: item for item in items}}},
        [{"id": item["address"], "revision": item["current_revision"]} for item in items], claims.marker(target))
    publication.mutate(api, target / "claim.json", "joppa_batch",
                       {"workspace": config["workspace"], "operations": operations})
    claim = read(target / "claim.json")
    if config.get("related"):
        assignment["context"] = flow_context.related_context(api, config, selected, assignment["schema"])
        write(target / "joppa-snapshot.json", {"schema": assignment["schema"], "objects": flow_context.objects(assignment)})
    flow_context.verify(api, config, assignment, claim)
    assignment["claim_revision"] = claims.claimed_revisions(claim)[selected["address"]]
    assignment["claim_revisions"] = claims.claimed_revisions(claim)
    write(target / "input.json", assignment)
    for role, contract in contracts.items():
        emit(role + "_contract", contract["content"])
    write(target / "contracts.json", contracts)
    # File-based flows read input.json and do not need an assignment in the environment.
    if inline == "true":
        emit("assignment", assignment)
    signal("PREPARED", "Selected object, configured context and execution claim are ready")


def capture(name):
    require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", name), "invalid capture name")
    reserved = {"input", "claim", "publication", "release", "result", "contracts", "joppa-snapshot"}
    require(name not in reserved and name + ".json" != settings()["publication"]["file"], "reserved capture name")
    result, _ = body_result()
    require(isinstance(result, dict), "agent response must be a JSON object")
    write(artifacts() / (name + ".json"), result)
    emit(name.replace("-", "_"), result)
    signal("CAPTURED", "Agent response captured: " + name)


def failure(reason=None):
    target, config = artifacts(), release_settings()
    detail = target / "failure.txt"
    # An explicit exception takes priority. Otherwise use the workflow's business diagnosis.
    reason = reason or (detail.read_text()[:1000].strip() if detail.is_file() else "") or \
             os.environ.get("MEDULLA_LAST_MESSAGE") or "Configured workflow stopped before publication"
    flow_publication.fail(client(config), config, target, reason)
    signal("BLOCKED", reason)


def main():
    command = sys.argv[1]
    try:
        if command == "prepare":
            prepare()
        elif command == "capture":
            capture(sys.argv[2])
        elif command == "publish":
            config = settings()
            flow_publication.publish(client(config), config, artifacts())
            result = read(artifacts() / "result.json")
            signal("READY" if result["status"] == "published" else "BLOCKED",
                   result.get("reason") or "Configured workflow output published")
        elif command == "prepare_critic":
            from tools import prepare_critic
            prepare_critic()
        elif command == "verify":
            config = settings()
            flow_context.verify(client(config), config, read(artifacts() / "input.json"), read(artifacts() / "claim.json"))
            signal("VERIFIED", "Claimed inputs remain current")
        elif command == "fail":
            failure()
        else:
            raise ValueError("unknown configured flow stage: " + command)
        return 0
    except Exception as error:
        print("planning-joppa/flow/" + command + ": " + str(error), file=sys.stderr)
        if command != "fail" and command != "capture":
            try:
                failure(str(error))
            except Exception as release:
                write(artifacts() / "result.json", {"status": "blocked", "reason": str(error),
                      "release_error": str(release), "needs_recovery": True, "acceptance_verified": False})
                print("flow claim needs recovery: " + str(release), file=sys.stderr)
        return 1


if __name__ == "__main__":
    from stdio import install_sigterm_exit
    install_sigterm_exit()
    sys.exit(main())
