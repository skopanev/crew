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
import validation
import context
import publication
import planning_claims as claims
import critic_notes
import retry_marks
from mcp import Rejected
from joppa_reads import blocked

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
    require(all(f'"{name}"' in advertised for name in ("save_object", "archive_object", "assess")),
            "Joppa generic node operations are not deployed; no claim was attempted")
    requirement = os.environ.get("PLANNING_JOPPA_REQ")
    assignment, snapshot, ac = (context.load_requirement(api, config, requirement) if requirement
                                else context.load(api, config, os.environ["PLANNING_JOPPA_AC"]))
    criteria = context.selected_criteria(assignment)
    require(not config.get("ac_ids") or {item["id"] for item in criteria}.issubset(config["ac_ids"]),
            "selected criteria are outside config.ac_ids")
    claims.planning_idle(api, config, assignment)
    for criterion in criteria:
        publication.ensure_recovered(config["runs_folder"], target, config["url"], config["workspace"], criterion["id"])
    write(target / "input.json", assignment)
    write(target / "joppa-snapshot.json", snapshot)
    # A due retry of Crew's own failure mark adds a fenced assess ready to the same claim batch.
    retries = assignment["joppa"].get("retry", {})
    operations = claims.claim_operations(assignment, criteria, claims.marker(target), retries)
    try:
        publication.mutate(api, target / "claim.json", "joppa_batch",
                           {"workspace": config["workspace"], "operations": operations},
                           extra={"retry": retries} if retries else None)
    except Rejected as error:
        # A stale revision refuses the whole batch. Read the holders again and stop without a retry.
        holders = claims.current_assignees(api, config["workspace"], [item["id"] for item in criteria])
        raise ValueError(f"planning claim refused: {error}; current assignees: {json.dumps(holders)}") from None
    claim = read(target / "claim.json")
    # Record the revision of each AC that this run wrote. Any later edit or reassignment stops the run.
    claim = {**claim, "revisions": claims.claimed_revisions(claim)}
    write(target / "claim.json", claim)
    # Record the assessment position that each later fenced assess of this run expects.
    claim["positions"] = retry_marks.claimed_positions(api, config["workspace"], claim, assignment["joppa"]["objects"],
                                                       retries)
    write(target / "claim.json", claim)
    holders = claims.owned(api, config["workspace"], claim)
    # Claiming changes only data.assignee. Check that no other writer changed authored context.
    fresh, current, current_ac = (context.load_requirement(api, config, requirement, [item["id"] for item in criteria])
                                  if requirement else context.load(api, config, ac["address"]))
    retry_marks.compare_claimed(snapshot, current, retries, target, context.unchanged)
    claims.planning_idle(api, config, fresh, holders)
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
    claims.planning_idle(api, config, fresh, claims.owned(api, config["workspace"], claim))
    verify_bindings(api, config, plan, fresh, snapshots, None)
    # Read dependency targets last. A target that ends after this read makes Joppa refuse the whole batch.
    completed = publication.completed_dependencies(api, config["workspace"], plan,
                                                   current.get("schema", {}).get("types", {}))
    operations = publication.operations(plan, fresh, completed, claim.get("positions", {}))
    held = any(blocked(task) for task in fresh["joppa"]["tasks"])
    criteria = {item["id"] for item in context.selected_criteria(fresh)}
    if not grouped and all(claims.is_closing(op, criteria) for op in operations) and not held:
        released = publication.release(api, target, config["workspace"], assignment["ac"]["id"],
                                       "Reviewed Task contracts are unchanged.")
        require(released, "unchanged Tasks require confirmed claim release")
        write(target / "result.json", {"status": "unchanged", "ac": assignment["ac"]["id"],
              "acceptance_verified": False, "claim_released": True, "task_count": 0})
        signal("READY", "Existing Task contracts match the reviewed plan. Planning claim released.")
        return
    if held and len(operations) > 1:
        print(run(["node", str(Path(__file__).with_name("cleanup.mjs"))],
            input=json.dumps({"config": config, "tasks": fresh["joppa"]["tasks"], "operations": operations}), timeout=120), end="")
    result = publication.mutate(api, target / "publication.json", "joppa_batch", {
        "workspace": config["workspace"], "operations": operations}, retain_claim=held)
    results = result.get("results")
    require(isinstance(results, list) and len(results) == len(operations),
            "publication response is incomplete; inspect publication.json before another run")
    write(target / "result.json", {"status": "published", "scope": "planned_tasks", "ac": assignment["ac"]["id"],
          **({"requirement": assignment["requirement"]["id"], "criteria": [item["id"] for item in context.selected_criteria(assignment)]}
             if grouped else {}),
          "acceptance_verified": False,
          "task_count": sum(op.get("ref", "").startswith("task") or op["command"]["op"] == "archive_object"
                            for op in operations),
          "plan_digest": digest(plan),
          "snapshots": snapshots, "prepared_snapshots": read(target / "snapshots.json"),
          "contracts": {key: value["bundle_digest"] for key, value in contracts.items()},
          "reviews": reviews, "publication": result})
    signal("READY", "Reviewed plan published. Criterion acceptance remains a separate result.")


def failure_code(reason):
    """A short code for the Joppa assess reason: a leading UPPER_CODE: prefix, or PLANNING_FAILED."""
    match = re.match(r"([A-Z][A-Z0-9_]{2,63}):", reason)
    return match.group(1) if match else "PLANNING_FAILED"


def fail(reason=None, code=None, critic=None):
    target = shared.artifacts()
    target.mkdir(parents=True, exist_ok=True)
    reason = reason or os.environ.get("MEDULLA_LAST_MESSAGE") or "workflow stopped without a valid result"
    errors = [read(path) for path in sorted(target.glob("error-*.json"))]
    if errors:
        reason += "; " + "; ".join(item["reason"] for item in errors)
    code = code or failure_code(reason)
    released, release_error = False, None
    try:
        if (target / "input.json").exists():
            assignment = read(target / "input.json")
            config = settings()
            # Only the explicit final critic rejection gives a note. Old critic files never do.
            notes = critic_notes.build(target, critic, (assignment.get("joppa") or {}).get("scope") == "requirement") \
                if critic else None
            released = publication.release(context.client(config), target, config["workspace"], assignment["ac"]["id"], reason,
                                           code, notes)
    except Exception as error:
        release_error = str(error)
    uncertain = any(path.exists() and read(path)["status"] in ("pending", "uncertain")
                    for path in (target / "claim.json", target / "publication.json", target / "release.json"))
    publication_path = target / "publication.json"
    incomplete = publication_path.exists() and read(publication_path)["status"] == "confirmed"
    claim_path = target / "claim.json"
    retained = claim_path.exists() and read(claim_path)["status"] == "confirmed" and not released
    needs_recovery = uncertain or incomplete or bool(release_error) or retained
    receipt = read(target / "release.json") if (target / "release.json").exists() else {}
    write(target / "result.json", {"status": "blocked", "scope": "planned_tasks", "reason": reason, "failure_code": code,
          "claim_released": released, "release_error": release_error,
          "skipped_claims": receipt.get("skipped_claims", []),
          **({"retry_exhausted": receipt["retry_exhausted"]} if receipt.get("retry_exhausted") else {}),
          "needs_recovery": needs_recovery,
          "acceptance_verified": False})
    signal("BLOCKED", reason + ("; inspect mutation receipts before another run" if needs_recovery else ""))


def needs_human():
    assessment = shared.require_necessity(allow_owner_gaps=True)
    require(assessment["owner_gaps"], "no required owner decision")
    fail("Required owner decision: " + "; ".join(
        f"{item['owner']}: {item['decision']}" for item in assessment["owner_gaps"]), "NEEDS_HUMAN")


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
            fail(str(error), critic=error if isinstance(error, validation.CriticRejection) else None)
        return 1
    return 0


if __name__ == "__main__":
    from stdio import install_sigterm_exit
    # Register before MCP clients so their shutdown output precedes the final error.
    atexit.register(report_failure)
    install_sigterm_exit()
    sys.exit(main())
