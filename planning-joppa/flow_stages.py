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


def prepare():
    target, config = artifacts(), settings()
    api = client(config)
    assignment = flow_context.load(api, config, os.environ["PLANNING_JOPPA_ITEM"])
    selected = assignment["selected"]
    publication.ensure_recovered(config["runs_folder"], target, config["url"], config["workspace"], selected["address"])
    write(target / "input.json", assignment)
    write(target / "joppa-snapshot.json", {"schema": assignment["schema"],
          "objects": flow_context.objects(assignment)})
    operations = claims.claim_operations({"joppa": {"objects": {selected["address"]: selected}}},
        [{"id": selected["address"], "revision": selected["current_revision"]}], claims.marker(target))
    publication.mutate(api, target / "claim.json", "joppa_batch",
                       {"workspace": config["workspace"], "operations": operations})
    claim = read(target / "claim.json")
    flow_context.verify(api, config, assignment, claim)
    assignment["claim_revision"] = claims.claimed_revisions(claim)[selected["address"]]
    write(target / "input.json", assignment)
    contracts = {}
    for role in (config.get("context") or {}).get("roles", {}):
        require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", role), "invalid context role key")
        contracts[role] = load_contract(role, config["workspace"])
        emit(role + "_contract", contracts[role]["content"])
    write(target / "contracts.json", contracts)
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
    target, config = artifacts(), settings()
    reason = reason or os.environ.get("MEDULLA_LAST_MESSAGE") or "Configured workflow stopped before publication"
    # A workflow can leave a short business diagnosis without changing tracker fields.
    detail = target / "failure.txt"
    if detail.is_file() and reason == "Configured workflow stopped before publication":
        reason = detail.read_text()[:1000].strip() or reason
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
            signal("READY", "Configured workflow output published")
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
