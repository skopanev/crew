"""Joppa process nodes around the shared planning graph."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "planning"))
from common import digest, read, require, signal, write
import stages as shared
import context
import publication


def settings():
    path = Path(os.environ["PLANNING_JOPPA_CONFIG"])
    config = context.configuration(path)
    expected = os.environ["PLANNING_JOPPA_CONFIG_DIGEST"]
    require(digest(config) == expected, "planner configuration changed during the run")
    return config


def prepare():
    target = shared.artifacts()
    target.mkdir(parents=True, exist_ok=True)
    config = settings()
    api = context.client(config)
    help = api.call("joppa_help", {"workspace": config["workspace"]})
    advertised = json.dumps(help)
    require(all(name in advertised for name in ("claim_planning", "finish_planning", "release_planning")),
            "Joppa planning commands are not deployed; no claim was attempted")
    assignment, snapshot, ac = context.load(api, config, os.environ["PLANNING_JOPPA_AC"])
    publication.ensure_recovered(config["runs_folder"], target, config["url"], config["workspace"], ac["address"])
    write(target / "input.json", assignment)
    write(target / "joppa-snapshot.json", snapshot)
    receipt = publication.mutate(api, target / "claim.json", "joppa_command", {"workspace": config["workspace"],
        "command": {"op": "claim_planning", "ac": ac["address"], "revision": ac["current_revision"]}})
    require(type(receipt.get("position")) is int, "planning claim response has no event position; inspect claim.json")
    claim = publication.held(api, config["workspace"], ac["address"], receipt["position"])
    write(target / "claim.json", {**read(target / "claim.json"), "actor": claim["actor"]})
    # Claiming does not change authored context. Check that no other writer changed it.
    _, current, _ = context.load(api, config, ac["address"])
    context.unchanged(snapshot, current)
    shared.prepare_context(prompt_assignment(assignment))


def prompt_assignment(assignment):
    """Send authored context once. Keep the complete snapshot in run artifacts."""
    result = {key: value for key, value in assignment.items() if key not in ("joppa", "decisions", "knowledge_query")}
    visible = set()
    for level in ("domain", "capability", "requirement", "ac"):
        item = assignment[level]
        if item["id"] in visible:
            result[level] = {"id": item["id"], "revision": item["revision"], "text": "Same context as its ancestor above."}
        else:
            obj = assignment["joppa"]["objects"][item["id"]]
            result[level] = {"id": item["id"], "revision": item["revision"], "text": json.dumps({
                "data": obj["document"]["data"], "links": obj["document"]["links"],
                "annotations": obj["annotations"], "files": obj["files"]}, ensure_ascii=False)}
            visible.add(item["id"])
    tasks = assignment["joppa"]["tasks"]
    task_ids = {task["address"] for task in tasks}
    result["joppa"] = {"task_type": assignment["joppa"]["task_type"], "task_schema": assignment["joppa"]["task_schema"],
        "tasks": [{"address": task["address"], "revision": task["current_revision"],
                   "data": task["document"]["data"], "links": task["document"]["links"],
                   "process": {key: task["process"].get(key) for key in ("status", "assignee", "done", "retired")}}
                  for task in tasks],
        "objects": {address: {"revision": item["current_revision"], "data": item["document"]["data"],
                              "links": item["document"]["links"], "annotations": item["annotations"]}
                    for address, item in assignment["joppa"]["objects"].items() if address not in visible | task_ids}}
    # The Requirement document already supplies its authored body and AC text.
    decisions = json.loads(assignment["decisions"][0])
    result["decisions"] = [json.dumps({key: decisions.get(key) for key in
        ("confirmed", "comments", "sources", "issues", "verification_scope", "acceptance", "coverage_review")}, ensure_ascii=False)]
    result["knowledge_query"] = assignment["knowledge_query"]
    return result


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
        publication.validate(result, read(target / "input.json"))
        shared.bind_necessity(result)
        write(target / "plan.json", result)
        signal("PLANNED", "Task mechanisms validated for the selected criterion")


def finish():
    target = shared.artifacts()
    assignment = read(target / "input.json")
    plan = read(target / "plan.json")
    publication.validate(plan, assignment)
    reviews, snapshots, contracts = shared.verify_context(assignment, plan)
    config = settings()
    api = context.client(config)
    fresh, current, _ = context.load(api, config, assignment["ac"]["id"])
    context.unchanged(read(target / "joppa-snapshot.json"), current)
    # Update only the exact Task document reviewed by this plan.
    current_tasks = {item["address"]: item for item in fresh["joppa"]["tasks"]}
    for task in plan["tasks"]:
        if task["action"] == "update":
            actual = current_tasks.get(task["target"])
            require(actual and actual["current_revision"] == task["revision"], "target Task revision changed during planning")
            publication.editable(actual)
    claim = read(target / "claim.json")
    require(claim["status"] == "confirmed", "planning claim was not confirmed")
    publication.held(api, config["workspace"], assignment["ac"]["id"], claim["result"]["position"], claim["actor"])
    operations = publication.operations(plan, fresh)
    if len(operations) == 1:
        released = publication.release(api, target, config["workspace"], assignment["ac"]["id"],
                                       "Reviewed Task contracts are unchanged.")
        require(released, "unchanged Tasks require confirmed claim release")
        write(target / "result.json", {"status": "unchanged", "ac": assignment["ac"]["id"],
              "acceptance_verified": False, "claim_released": True, "task_count": 0})
        signal("READY", "Existing Task contracts match the reviewed plan. Planning claim released.")
        return
    result = publication.mutate(api, target / "publication.json", "joppa_batch", {
        "workspace": config["workspace"], "operations": operations})
    results = result.get("results")
    require(isinstance(results, list) and len(results) == len(operations)
            and results[-1].get("command", {}).get("op") == "finish_planning",
            "publication response is incomplete; inspect publication.json before another run")
    write(target / "result.json", {"status": "published", "scope": "planned_tasks", "ac": assignment["ac"]["id"],
          "acceptance_verified": False, "task_count": len(operations) - 1, "plan_digest": digest(plan),
          "snapshots": snapshots, "contracts": {key: value["bundle_digest"] for key, value in contracts.items()},
          "reviews": reviews, "publication": result})
    signal("READY", "Reviewed Tasks published. The criterion still requires implementation and verification.")


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
    write(target / "result.json", {"status": "blocked", "scope": "planned_tasks", "reason": reason,
          "claim_released": released, "release_error": release_error,
          "needs_recovery": uncertain or incomplete or bool(release_error),
          "acceptance_verified": False})
    signal("BLOCKED", reason + ("; inspect mutation receipts before another run" if uncertain or incomplete or release_error else ""))


def needs_human():
    assessment = shared.require_necessity(allow_owner_gaps=True)
    require(assessment["owner_gaps"], "no required owner decision")
    fail("Required owner decision: " + "; ".join(
        f"{item['owner']}: {item['decision']}" for item in assessment["owner_gaps"]))


def main():
    command = sys.argv[1]
    try:
        if command == "capture":
            capture(sys.argv[2])
        else:
            own = {"prepare": prepare, "finish": finish, "fail": fail, "needs_human": needs_human}
            (own.get(command) or getattr(shared, command))()
    except shared.DriftReview as review:
        signal("DRIFT", review)
    except Exception as error:
        print(f"planning-joppa/{command}: {error}", file=sys.stderr)
        if command in ("capture", "prepare_critic"):
            kind = sys.argv[2] if command == "capture" else "critic"
            branch = "design" if kind == "plan" else "necessity" if kind == "necessity" else json.loads(os.environ["MEDULLA_INPUT"])["slug"]
            write(shared.artifacts() / f"error-{kind}-{branch}.json", {"stage": kind, "branch": branch, "reason": str(error)})
        else:
            fail(str(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
