"""Observe an external claim release without sending a tracker write."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "planning"))
from common import read, require
from mcp import Joppa
import planning_claims as claims


def resolved_release(result, claim, address):
    proof = result.get("claim_resolution") or {}
    if result.get("claim_released") is not True or result.get("needs_recovery") or \
            proof.get("method") != "observed_external_release":
        return False
    owners = claims.claimed(claim)
    rows = proof.get("items") or {}
    revisions = claims.claimed_revisions(claim)
    return proof.get("request_id") == claim["arguments"]["request_id"] and address in owners and \
        set(rows) == set(owners) and all(type(rows[key].get("revision")) is int and
            rows[key]["revision"] >= revisions[key] and rows[key].get("assignee") != owner
            for key, (owner, _) in owners.items())


def observe_release(api, config, target, apply=True):
    claim_file = target / "claim.json"
    if not claim_file.exists():
        return None
    claim = read(claim_file)
    if claim.get("status") != "confirmed":
        return None
    require(claim.get("server") in (None, config["url"]) and
            claim["arguments"]["workspace"] == config["workspace"], "Recovery scope differs from the claim")
    for name in ("publication.json", "release.json"):
        if (target / name).exists() and read(target / name).get("status") in ("pending", "uncertain"):
            return None
    rows, revisions = {}, claims.claimed_revisions(claim)
    for address, (owner, _) in claims.claimed(claim).items():
        node = api.call("joppa_objects", {"workspace": config["workspace"], "address": address})
        revision = node.get("current_revision")
        require(node.get("address") == address and node.get("historical") is False and
                type(revision) is int and revision >= revisions[address], "Recovery needs a current object: " + address)
        assignee = claims.assignee_of(node)
        if assignee == owner:
            return None
        rows[address] = {"revision": revision, "assignee": assignee}
    proof = {"method": "observed_external_release", "request_id": claim["arguments"]["request_id"],
             "observed_at": datetime.now(timezone.utc).isoformat(), "items": rows}
    if apply:
        file = target / "result.json"
        prior = read(file) if file.exists() else {}
        value = {**prior, "status": prior.get("status", "blocked"),
                 "reason": prior.get("reason", "This finished run no longer owns its claim."),
                 "claim_released": True, "needs_recovery": False, "claim_resolution": proof,
                 "acceptance_verified": False}
        temporary = file.with_name(file.name + ".recovery-" + str(os.getpid()))
        try:
            with temporary.open("x") as output:
                os.chmod(temporary, 0o600)
                json.dump(value, output)
                output.write("\n")
            temporary.replace(file)
        finally:
            temporary.unlink(missing_ok=True)
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--run", required=True, help="The finished detached launch folder")
    parser.add_argument("--apply", action="store_true", help="Update local result.json after the read-only check")
    args = parser.parse_args()
    config, folder = read(Path(args.config)), Path(args.run).resolve()
    root = Path(config["runs_folder"]).resolve()
    require(folder.parent == root, "Recovery run is outside runs_folder")
    launch = read(folder / "launch.json")
    require(isinstance(launch.get("result", {}).get("code"), int), "The detached launch has not finished")
    pid = launch.get("worker", {}).get("pid")
    if type(pid) is int and pid > 0:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise ValueError("The detached worker PID is still alive")
    native = Path(launch["medullaRun"]).resolve()
    require(native.parent == root, "Medulla run is outside runs_folder")
    prior = read(native / "artifacts" / "result.json")
    require(isinstance(prior, dict) and prior.get("status") in ("blocked", "failed") and
            isinstance(prior.get("reason"), str) and prior["reason"].strip(),
            "Recovery needs an existing failure result")
    api = Joppa(config["url"], config.get("token_file"), config.get("mcp_command"))
    try:
        proof = observe_release(api, config, native / "artifacts", apply=args.apply)
        require(proof, "Claim is still owned or a receipt needs recovery; no local change")
        print(json.dumps({"resolved": args.apply, "tracker_writes": 0, **proof}))
    finally:
        if api.stdio:
            api.stdio.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("flow recovery: " + str(error), file=sys.stderr)
        sys.exit(2)
