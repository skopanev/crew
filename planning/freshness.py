"""Deterministic admission: unchanged Joppa meaning and age strictly below 24h."""
from copy import deepcopy
from datetime import datetime, timezone

from common import digest, require
from joppa import Joppa

TTL_SECONDS = 24 * 60 * 60


class StalePlan(ValueError):
    pass


def utc_now():
    return datetime.now(timezone.utc)


def select(value, fields):
    require(isinstance(value, dict), "Joppa chain object missing")
    return {field: value[field] for field in fields}


def snapshot(workspace, req_id, ac_id, client=None):
    client = client or Joppa()
    # Equal journal positions prevent mixing parents and a REQ from different
    # reads. Positions are not part of the digest: unrelated writes do not age it.
    for _ in range(3):
        index = client.read(workspace=workspace)
        detail = client.read(workspace=workspace, req=req_id)
        require(index.get("workspace") == detail.get("workspace"), "Joppa workspace mismatch")
        require(type(index.get("position")) is int and type(detail.get("position")) is int,
                "Joppa read has no journal position")
        if index["position"] == detail["position"]:
            break
    else:
        raise ValueError("Joppa changed during read; retry admission")
    req = detail["requirement"]
    require(req["id"] == req_id, "Joppa returned a different Requirement")
    revisions = req["revisions"]
    require(len(revisions) == 1, "expected one current Joppa revision")
    revision = revisions[0]
    require(revision["number"] == req["current_revision"], "Joppa did not return the current revision")
    capability_id = revision["capability"]
    tree = index["index"]
    capability = tree["capabilities"][capability_id]
    domain_id = capability["domain"]
    domain = tree["domains"][domain_id]
    if domain.get("archived") is True:
        raise StalePlan("Joppa Domain is archived; repeat planning")
    require(domain.get("archived") is False, "Joppa Domain archive state missing")
    acs = [a for a in revision["acs"] if a["id"] == ac_id]
    if not acs:
        raise StalePlan("selected AC is absent from the current Requirement; repeat planning")
    require(len(acs) == 1, "selected AC is ambiguous")
    # Only authored meaning, authority and relationships. Task/run activity,
    # read counters, note counts and verification results are not formulation.
    ac_fields = ("id", "text", "description", "owner", "depends_on", "before_launch")
    ac = select(acs[0], ac_fields)
    req_context = select(revision, ("number", "title", "body", "capability", "consumers", "owner", "confirmed"))
    req_context["id"] = req_id
    req_context["acs"] = sorted((select(a, ac_fields) for a in revision["acs"]), key=lambda a: a["id"])
    req_context["description"] = detail.get("notes", {}).get("requirement:" + req_id, {}).get("description", "")
    return {"workspace": detail["workspace"],
            "domain": {"id": domain_id, **select(domain, ("title", "description", "owner", "confirmed", "archived"))},
            "capability": {"id": capability_id, **select(capability, ("title", "description", "owner", "confirmed", "domain"))},
            "requirement": req_context, "ac": ac}


def hydrate(assignment, current):
    """Only Joppa wording enters prompts; handwritten JSON supplies selectors."""
    result = deepcopy(assignment)
    for level in ("domain", "capability"):
        require(assignment[level]["id"] == current[level]["id"], f"input {level} does not match live Joppa chain")
        result[level] = {"id": current[level]["id"], "text": current[level]["title"] + "\n" + current[level]["description"]}
    req = current["requirement"]
    result["workspace"] = current["workspace"]
    result["requirement"] = {"id": req["id"], "revision": req["number"],
                             "text": req["title"] + "\n" + req["body"] + "\n" + req["description"]}
    result["ac"] = {"id": current["ac"]["id"], "text": current["ac"]["text"]}
    result["joppa_context"] = current
    return result


def check_age(completed_at, now):
    try:
        completed = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        raise StalePlan("plan has no valid completion time; repeat planning") from None
    require(completed.tzinfo is not None, "plan completion time must include timezone")
    age = (now - completed).total_seconds()
    require(age >= 0, "plan completion time is in the future; clock or receipt is invalid")
    if age >= TTL_SECONDS:
        raise StalePlan("plan is at least 24 hours old; repeat planning")


def admit(result, client=None, clock=utc_now):
    require(result.get("status") == "ready", "only a ready implementation plan can launch a lane")
    require(result.get("plan_digest") == digest(result.get("plan")), "plan content does not match its digest")
    previous = result.get("joppa_snapshot")
    if not previous or not result.get("joppa_currentness_verified"):
        raise StalePlan("plan has no verified Joppa snapshot; repeat planning")
    check_age(result.get("completed_at"), clock())
    current = snapshot(previous["workspace"], previous["requirement"]["id"], previous["ac"]["id"], client)
    if current != previous:
        raise StalePlan("Domain/Capability/Requirement/AC changed; repeat planning")
    # A slow read can cross the expiry boundary; never approve using start time.
    now = clock()
    check_age(result.get("completed_at"), now)
    return {"status": "allowed", "checked_at": now.isoformat(), "ttl_seconds": TTL_SECONDS,
            "plan_digest": result["plan_digest"], "joppa_digest": digest(current)}
