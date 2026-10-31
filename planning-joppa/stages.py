"""Joppa process nodes around the shared planning graph."""
import atexit
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "planning"))
from common import digest, fingerprint, read, require, run, signal, write
import stages as shared
import context
import publication

_failure_message = None
from reader_context import retry_startup, settings, reader_servers, prepare_reader, prepare_critic, prompt_assignment


def report_failure():
    if _failure_message:
        print(_failure_message, file=sys.stderr, flush=True)


def prepare():
    target = shared.artifacts()
    target.mkdir(parents=True, exist_ok=True)
    config = settings()
    reader_servers()
    api = context.client(config)
    help = api.call("joppa_help", {"workspace": config["workspace"]})
    advertised = json.dumps(help)
    require(all(name in advertised for name in ("claim_planning", "finish_planning", "release_planning")),
            "Joppa planning commands are not deployed; no claim was attempted")
    requirement = os.environ.get("PLANNING_JOPPA_REQ")
    assignment, snapshot, ac = (context.load_requirement(api, config, requirement) if requirement
                                else context.load(api, config, os.environ["PLANNING_JOPPA_AC"]))
    criteria = context.selected_criteria(assignment)
    require(not config.get("ac_ids") or {item["id"] for item in criteria}.issubset(config["ac_ids"]),
            "selected criteria are outside config.ac_ids")
    context.planning_idle(api, config, assignment)
    for criterion in criteria:
        publication.ensure_recovered(config["runs_folder"], target, config["url"], config["workspace"], criterion["id"])
    write(target / "input.json", assignment)
    write(target / "joppa-snapshot.json", snapshot)
    operations = [{"command": {"op": "claim_planning", "ac": item["id"], "revision": item["revision"]}} for item in criteria]
    require(len(operations) <= 100, "Requirement claims exceed the Joppa batch limit of 100 operations")
    tool = "joppa_batch" if requirement else "joppa_command"
    arguments = {"workspace": config["workspace"], "operations": operations} if requirement else {
        "workspace": config["workspace"], "command": operations[0]["command"]}
    publication.mutate(api, target / "claim.json", tool, arguments)
    claim = read(target / "claim.json")
    holders = publication.held_claims(api, config["workspace"], claim)
    write(target / "claim.json", {**claim, "holders": holders,
          **({"actor": next(iter(holders.values()))} if not requirement else {})})
    # Claiming does not change authored context. Check that no other writer changed it.
    fresh, current, current_ac = (context.load_requirement(api, config, requirement, [item["id"] for item in criteria])
                                  if requirement else context.load(api, config, ac["address"]))
    context.unchanged(snapshot, current)
    context.planning_idle(api, config, fresh, {
        address: {"actor": holders[address], "position": position}
        for address, position, _ in publication.claim_entries(claim)})
    if not requirement and retry_startup(api, config, target, fresh, current_ac, advertised):
        return
    assignment["joppa"]["unfinished_work"] = context.pending_work(api, config, assignment)
    write(target / "input.json", assignment)
    shared.prepare_context(prompt_assignment(assignment), mcp_servers=prepare_reader())


def capture(kind):
    if kind not in ("plan", "necessity"):
        return shared.capture(kind)
    target = shared.artifacts()
    error_path = target / f"error-{kind}-{'design' if kind == 'plan' else 'necessity'}.json"
    error_path.unlink(missing_ok=True)
    result, _ = shared.body_result()
    if kind == "necessity":
        shared.save_necessity(result)
        signal("NEEDS_HUMAN" if result["owner_gaps"] else "ASSESSED", "Necessity assessment validated")
    else:
        config = settings()
        api = context.client(config)
        assignment = context.read_assignment(api, config, target)
        publication.operations(result, assignment)
        verify_bindings(api, config, result, assignment,
            {repo["id"]: fingerprint(repo) for repo in assignment["repositories"]}, read(target / "snapshots.json"))
        shared.bind_necessity(result)
        write(target / "plan.json", result)
        signal("PLANNED", "Task mechanisms validated for the selected criterion")


def verify_bindings(api, config, plan, assignment, snapshots, prepared):
    for criterion in context.selected_criteria(assignment):
        address = criterion["id"]
        value = publication.criterion_plan(plan, assignment, address)
        if value["disposition"] == "verify_existing":
            publication.verify_bindings(api, config, value, context.criterion_assignment(assignment, address), snapshots,
                                        prepared if prepared is not None else read(shared.artifacts() / "snapshots.json"))


def finish():
    target = shared.artifacts()
    config = settings()
    api = context.client(config)
    assignment = context.read_assignment(api, config, target)
    plan = read(target / "plan.json")
    publication.validate(plan, assignment)
    reviews, snapshots, contracts = shared.verify_context(assignment, plan, mechanisms_only=True)
    grouped = assignment["joppa"].get("scope") == "requirement"
    fresh, current, _ = (context.load_requirement(api, config, assignment["requirement"]["id"],
                         [item["id"] for item in context.selected_criteria(assignment)]) if grouped
                         else context.load(api, config, assignment["ac"]["id"]))
    context.refresh_reads(api, config, fresh, current, read(target / "joppa-snapshot.json"))
    publication.validate(plan, fresh)
    # Update only the exact Task document reviewed by this plan.
    current_tasks = {item["address"]: item for item in fresh["joppa"]["tasks"]}
    for task in plan["tasks"]:
        if task["action"] in ("update", "retire"):
            actual = current_tasks.get(task["target"])
            require(actual and actual["current_revision"] == task["revision"], "target Task revision changed during planning")
            (publication.retirable if task["action"] == "retire" else publication.editable)(actual)
    claim = read(target / "claim.json")
    require(claim["status"] == "confirmed", "planning claim was not confirmed")
    publication.held_claims(api, config["workspace"], claim)
    context.planning_idle(api, config, fresh, {
        address: {"actor": actor, "position": position}
        for address, position, actor in publication.claim_entries(claim)})
    verify_bindings(api, config, plan, fresh, snapshots, None)
    operations = publication.operations(plan, fresh)
    blocked = any(isinstance(task["process"].get("blocked"), dict)
                  and not task["process"].get("done") and not task["process"].get("retired")
                  for task in fresh["joppa"]["tasks"])
    if not grouped and len(operations) == 1 and not blocked:
        released = publication.release(api, target, config["workspace"], assignment["ac"]["id"],
                                       "Reviewed Task contracts are unchanged.")
        require(released, "unchanged Tasks require confirmed claim release")
        write(target / "result.json", {"status": "unchanged", "ac": assignment["ac"]["id"],
              "acceptance_verified": False, "claim_released": True, "task_count": 0})
        signal("READY", "Existing Task contracts match the reviewed plan. Planning claim released.")
        return
    if blocked and len(operations) > 1:
        print(run(["node", str(Path(__file__).with_name("cleanup.mjs"))],
            input=json.dumps({"config": config, "tasks": fresh["joppa"]["tasks"], "operations": operations}), timeout=120), end="")
    result = publication.mutate(api, target / "publication.json", "joppa_batch", {
        "workspace": config["workspace"], "operations": operations}, retain_claim=blocked)
    results = result.get("results")
    require(isinstance(results, list) and len(results) == len(operations)
            and results[-1].get("command", {}).get("op") in ("finish_planning", "release_planning"),
            "publication response is incomplete; inspect publication.json before another run")
    write(target / "result.json", {"status": "published", "scope": "planned_tasks", "ac": assignment["ac"]["id"],
          **({"requirement": assignment["requirement"]["id"], "criteria": [item["id"] for item in context.selected_criteria(assignment)]}
             if grouped else {}),
          "acceptance_verified": False,
          "task_count": sum(op["command"]["op"] in ("save_object", "retire_task") for op in operations),
          "plan_digest": digest(plan),
          "snapshots": snapshots, "prepared_snapshots": read(target / "snapshots.json"),
          "contracts": {key: value["bundle_digest"] for key, value in contracts.items()},
          "reviews": reviews, "publication": result})
    signal("READY", "Reviewed plan published. Criterion acceptance remains a separate result.")


def fail(reason=None):
    target = shared.artifacts()
    target.mkdir(parents=True, exist_ok=True)
    reason = reason or os.environ.get("MEDULLA_LAST_MESSAGE") or "workflow stopped without a valid result"
    errors = [read(path) for path in sorted(target.glob("error-*.json"))]
    if errors:
        reason += "; " + "; ".join(item["reason"] for item in errors)
    released, release_error = False, None
    try:
        if (target / "input.json").exists():
            assignment = read(target / "input.json")
            config = settings()
            released = publication.release(context.client(config), target, config["workspace"], assignment["ac"]["id"], reason)
    except Exception as error:
        release_error = str(error)
    uncertain = any(path.exists() and read(path)["status"] in ("pending", "uncertain")
                    for path in (target / "claim.json", target / "publication.json", target / "release.json"))
    publication_path = target / "publication.json"
    incomplete = publication_path.exists() and read(publication_path)["status"] == "confirmed"
    claim_path = target / "claim.json"
    retained = claim_path.exists() and read(claim_path)["status"] == "confirmed" and not released
    needs_recovery = uncertain or incomplete or bool(release_error) or retained
    write(target / "result.json", {"status": "blocked", "scope": "planned_tasks", "reason": reason,
          "claim_released": released, "release_error": release_error,
          "skipped_claims": read(target / "release.json").get("skipped_claims", []) if (target / "release.json").exists() else [],
          "needs_recovery": needs_recovery,
          "acceptance_verified": False})
    signal("BLOCKED", reason + ("; inspect mutation receipts before another run" if needs_recovery else ""))


def needs_human():
    assessment = shared.require_necessity(allow_owner_gaps=True)
    require(assessment["owner_gaps"], "no required owner decision")
    fail("Required owner decision: " + "; ".join(
        f"{item['owner']}: {item['decision']}" for item in assessment["owner_gaps"]))


def main():
    global _failure_message
    command = sys.argv[1]
    try:
        if command == "capture":
            capture(sys.argv[2])
        else:
            own = {"prepare": prepare, "finish": finish, "fail": fail, "needs_human": needs_human,
                   "prepare_critic": prepare_critic}
            (own.get(command) or getattr(shared, command))()
    except shared.DriftReview as review:
        signal("DRIFT", review)
    except Exception as error:
        _failure_message = f"planning-joppa/{command}: {error}"
        print(_failure_message, file=sys.stderr)
        if command in ("capture", "prepare_critic"):
            kind = sys.argv[2] if command == "capture" else "critic"
            branch = "design" if kind == "plan" else "necessity" if kind == "necessity" else json.loads(os.environ["MEDULLA_INPUT"])["slug"]
            write(shared.artifacts() / f"error-{kind}-{branch}.json", {"stage": kind, "branch": branch, "reason": str(error)})
        else:
            fail(str(error))
        return 1
    return 0


if __name__ == "__main__":
    from stdio import install_sigterm_exit
    # Register before MCP clients so their shutdown output precedes the final error.
    atexit.register(report_failure)
    install_sigterm_exit()
    sys.exit(main())
