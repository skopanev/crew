"""Deterministic admission: unchanged Joppa meaning and age strictly below 24h."""
from copy import deepcopy
from datetime import datetime, timezone
import re

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


def matches(selector, obj):
    return selector in (obj["address"], obj.get("id"), obj.get("item_id"))


def formulation(obj):
    document = obj["document"]
    require(document.get("revision") == obj.get("current_revision"), "Joppa returned a historical object")
    if document.get("present") is not True or document.get("data", {}).get("archived") is True:
        raise StalePlan("Joppa context object is removed or archived; repeat planning")
    require(isinstance(document.get("data"), dict), "Joppa authored data missing")
    return {"address": obj["address"], "id": obj["id"], "item_id": obj.get("item_id"),
            "revision": document["revision"], "parent": document.get("parent"),
            "data": document["data"], "links": document.get("links", []),
            "references": obj.get("references", []),
            "description": obj.get("annotations", {}).get("description", "")}


def snapshot(workspace, req_id, ac_id, client=None):
    client = client or Joppa()
    # Equal positions prevent mixed reads. Unrelated writes do not enter the digest.
    for _ in range(3):
        selector = {"item_id": req_id} if re.fullmatch(r".+-[A-Z]+-[A-Z0-9]{10}", req_id) else {"workspace": workspace, "req": req_id}
        detail = client.read(**selector)
        if "object" not in detail:
            returned_id = detail["requirement"]["id"]
            ids = detail.get("system_ids", {}).get("requirement", {})
            public_id = ids.get(returned_id, ids.get(returned_id.split(":", 1)[-1]))
            require(public_id, "Joppa read has no object address or public ID")
            detail = client.read(item_id=public_id)
        require(detail.get("workspace") == workspace, "Joppa workspace mismatch")
        obj = detail["object"]
        require(matches(req_id, obj), "Joppa returned a different Requirement")
        position = detail.get("position")
        require(type(position) is int, "Joppa read has no journal position")
        context = formulation(obj)
        ancestors, seen = [], {obj["address"]}
        parent = context["parent"]
        while parent is not None:
            require(isinstance(parent, str) and parent and parent not in seen,
                    "Joppa parent chain is invalid or cyclic")
            require(len(ancestors) < 32, "Joppa parent chain exceeds 32 objects")
            ancestor = client.objects(workspace=workspace, address=parent)
            require(ancestor.get("workspace") == detail.get("workspace"), "Joppa workspace mismatch")
            require(type(ancestor.get("position")) is int, "Joppa object has no journal position")
            if ancestor["position"] != position:
                break
            require(ancestor["address"] not in seen, "Joppa parent chain is cyclic")
            seen.add(parent)
            seen.add(ancestor["address"])
            current = formulation(ancestor)
            ancestors.append(current)
            parent = current["parent"]
        else:
            break
    else:
        raise ValueError("Joppa changed during read; retry admission")
    req = detail["requirement"]
    revisions = req["revisions"]
    require(len(revisions) == 1, "expected one current Joppa revision")
    revision = revisions[0]
    require(revision["number"] == req["current_revision"] == context["revision"],
            "Joppa did not return the current revision")
    public_ids = detail.get("system_ids", {}).get("ac", {})
    acs = [a for a in revision["acs"] if ac_id in
           (a["id"], a["id"].split(":", 1)[-1],
            public_ids.get(a["id"], public_ids.get(a["id"].split(":", 1)[-1])))]
    if not acs:
        raise StalePlan("selected AC is absent from the current Requirement; repeat planning")
    require(len(acs) == 1, "selected AC is ambiguous")
    ac_fields = ("id", "text", "description", "owner", "depends_on", "before_launch")
    ac = select(acs[0], ac_fields)
    req_context = {"id": context["item_id"] or req["id"], "number": context["revision"],
                   **select(context["data"], ("title", "body", "owner")),
                   "consumers": context["data"].get("consumers", []),
                   "confirmed": detail["process"]["confirmed"],
                   "description": context["description"], "formulation": context,
                   "acs": sorted((select(a, ac_fields) for a in revision["acs"]), key=lambda a: a["id"])}
    return {"workspace": detail["workspace"], "ancestors": ancestors,
            "requirement": req_context, "ac": ac}


def hydrate(assignment, current):
    """Only Joppa wording enters prompts; handwritten JSON supplies selectors."""
    result = deepcopy(assignment)
    for level in ("domain", "capability"):
        found = [obj for obj in current["ancestors"] if matches(assignment[level]["id"], obj)]
        require(len(found) == 1, f"input {level} does not match live Joppa chain")
        obj = found[0]
        data = obj["data"]
        result[level] = {"id": obj["address"],
                         "text": data.get("title", "") + "\n" +
                         data.get("description", "") + "\n" + obj["description"]}
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
    if not previous or "ancestors" not in previous or not result.get("joppa_currentness_verified"):
        raise StalePlan("plan has no verified Joppa snapshot; repeat planning")
    check_age(result.get("completed_at"), clock())
    current = snapshot(previous["workspace"], previous["requirement"]["id"], previous["ac"]["id"], client)
    if current != previous:
        raise StalePlan("Joppa formulation or parent context changed; repeat planning")
    # A slow read can cross the expiry boundary; never approve using start time.
    now = clock()
    check_age(result.get("completed_at"), now)
    return {"status": "allowed", "checked_at": now.isoformat(), "ttl_seconds": TTL_SECONDS,
            "plan_digest": result["plan_digest"], "joppa_digest": digest(current)}
