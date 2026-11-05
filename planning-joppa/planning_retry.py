"""Bounded automatic retry of failed planning. It reads the existing run receipts only.

A retry needs Crew's own confirmed failure mark: the exact assessment position that release.json recorded for the AC.
The count of retries comes from claim.json receipts that carry a retry entry for the same authored AC context."""
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import digest, read
from context_snapshot import authored_document

# Seconds after the failure mark before retry 1 and retry 2. Then the AC context is exhausted.
DELAYS = (60, 300)
MAX_RETRIES = len(DELAYS)
# An owner decision and a lane scope failure never retry automatically.
INELIGIBLE = frozenset({"NEEDS_HUMAN", "OUT_OF_MODULE"})
RECEIPTS = ("claim.json", "publication.json", "release.json")
COUNTED = ("confirmed", "pending", "uncertain")


def now():
    return datetime.now(timezone.utc)


def stamp(moment):
    return moment.astimezone(timezone.utc).isoformat()


def assessment(object):
    value = (object.get("process") or {}).get("assessment")
    return value if isinstance(value, dict) else {}


def position(object):
    """The current assessment mark: its integer position, 0 without an assessment,
    or None when the server reports an assessment without a position."""
    value = assessment(object)
    if not value:
        return 0
    mark = value.get("position")
    return mark if type(mark) is int and mark > 0 else None


def expected(mark):
    """The optional fence fields of one assess command."""
    return {} if mark is None else {"expected_position": mark}


def context_digest(object):
    """The authored AC context: document fields without lifecycle fields, as the planning snapshot compares them."""
    document = authored_document(object["document"])
    return digest({key: value for key, value in document.items()
                   if key in ("data", "parent", "links", "present", "schema_revision")})


def claim_addresses(claim):
    args = claim.get("arguments", {})
    commands = [args["command"]] if "command" in args else [item["command"] for item in args.get("operations", [])]
    return {command.get("target") or command.get("kind", "") + ":" + command.get("id", "") for command in commands}


def history(root, server, workspace, address):
    """[(artifacts folder, claim receipt)] of the runs that claimed this AC, in start order."""
    result = []
    for claim_file in sorted(Path(root).glob("*/artifacts/claim.json")):
        claim = read(claim_file)
        if claim.get("arguments", {}).get("workspace") != workspace:
            continue
        if claim.get("server") and server and claim["server"] != server:
            continue
        if address in claim_addresses(claim):
            result.append((claim_file.parent, claim))
    return result


def attempts(root, server, workspace, address, context):
    """Automatic retries already sent for this AC and this authored context, across restarts."""
    return sum(1 for _, claim in history(root, server, workspace, address)
               if claim.get("status") in COUNTED and ((claim.get("retry") or {}).get(address) or {})
               .get("context") == context)


def budget(root, server, workspace, address, context, code, marked_at):
    """The retry fields of a new failure mark."""
    done = attempts(root, server, workspace, address, context)
    exhausted = done >= MAX_RETRIES
    after = None if exhausted or code in INELIGIBLE else stamp(marked_at + timedelta(seconds=DELAYS[done]))
    return {"attempts": done, "retry_exhausted": exhausted, "retry_after": after}


def uncertain(target, address):
    receipts = [read(target / name) for name in RECEIPTS if (target / name).exists()]
    release = read(target / "release.json") if (target / "release.json").exists() else {}
    return (any(item.get("status") in ("pending", "uncertain") for item in receipts)
            or any(item.get("ac") == address and item.get("unknown") for item in release.get("skipped_claims", [])))


def eligible(root, server, workspace, object, moment=None):
    """Return ({position, context, attempt, from_run}, None) for a due retry, else (None, reason)."""
    address, value = object["address"], assessment(object)
    if (object.get("document") or {}).get("data", {}).get("assignee"):
        return None, "held"
    if value.get("state") != "waiting":
        return None, "not waiting"
    code, mark = value.get("reason"), position(object)
    if code in INELIGIBLE:
        return None, code
    if not mark:
        return None, "assessment has no position"
    runs = history(root, server, workspace, address)
    found = None
    for index, (target, _) in enumerate(runs):
        release = read(target / "release.json") if (target / "release.json").exists() else {}
        entry = (release.get("marks") or {}).get(address) if release.get("status") == "confirmed" else None
        if entry and entry.get("position") == mark and entry.get("code") == code:
            found = index
    if found is None:
        return None, "no Crew failure mark with exact provenance"
    target, _ = runs[found]
    if any(claim.get("status") != "rejected" for _, claim in runs[found + 1:]):
        return None, "a later run claimed the criterion"
    if uncertain(target, address):
        return None, "failed run has an uncertain receipt"
    entry = read(target / "release.json")["marks"][address]
    context = context_digest(object)
    done = attempts(root, server, workspace, address, context)
    if done >= MAX_RETRIES:
        return None, "RETRY_EXHAUSTED"
    try:
        due = datetime.fromisoformat(entry["marked_at"]) + timedelta(seconds=DELAYS[done])
    except (KeyError, TypeError, ValueError):
        return None, "failure mark has no time"
    if (moment or now()) < due:
        return None, "retry delay"
    return {"position": mark, "context": context, "attempt": done + 1, "from_run": target.parent.name}, None
