"""Translate supported Joppa reads for native contract checks."""

class MCPError(ValueError):
    pass


class Rejected(MCPError):
    """The server confirmed that the tool operation failed."""


def authored_link(link):
    return {"blocking": link.get("blocking", False), "relation": link.get("relation", "related"),
            "revision": link.get("revision"), "target": link["target"]}


def normalize_detail(args, value):
    result = dict(value)
    if "document" not in result:
        if not isinstance(result.get("data"), dict) or type(result.get("revision")) is not int or result["revision"] < 1:
            raise MCPError("Joppa object detail is incomplete")
        present = result.get("present", True) is not False and result.get("archived") is not True
        result["document"] = {"revision": result["revision"], "parent": result.get("parent"),
                              "present": present, "data": result["data"],
                              "links": [authored_link(link) for link in result.get("links", [])]}
        result.setdefault("current_revision", result["revision"])
        result["process"] = lifecycle(result["document"], result.get("process"))
        if not args.get("revision"):
            result.setdefault("work_ready", True)
    result.setdefault("address", args.get("address"))
    if not isinstance(result["address"], str):
        raise MCPError("Joppa object address is missing")
    result.setdefault("kind", result["address"].split(":", 1)[0])
    result.setdefault("historical", result["document"].get("revision", result["current_revision"]) != result["current_revision"])
    result["process"] = dict(result.get("process") or {})
    result["process"].setdefault("assignee", None)
    result["annotations"] = dict(result.get("annotations") or {})
    result.setdefault("files", [])
    result.setdefault("references", [])
    result.setdefault("remote_links_revision", 0)
    return result


def blocked(assessment):
    """An assessment with ready false holds the node. No assessment means ready."""
    return isinstance(assessment, dict) and (assessment.get("ready") is False
                                             or assessment.get("state") not in (None, "ready"))


def lifecycle(document, process):
    """Derive the Task state from generic node fields. The server has no Task process."""
    data, result = document["data"], {"assessment": (process or {}).get("assessment")}
    result["assignee"] = data.get("assignee")
    if blocked(result["assessment"]):
        reason = result["assessment"].get("reason") or ""
        # The assess reason is the only block evidence, such as a lane "Run: <id>" line.
        result["blocked"] = {"reason": reason, "evidence": reason, "actor": result["assessment"].get("actor")}
    if document["present"] is False:
        result["done" if data.get("commit") else "retired"] = {"commit": data.get("commit")}
    return {key: value for key, value in result.items() if value is not None}


def task_state(object):
    """Classify one Task: done, retired, blocked, active or open."""
    process = object["process"]
    for state in ("done", "retired", "blocked"):
        if process.get(state):
            return state
    return "active" if process.get("assignee") else "open"


def complete_object(read_page, args, value):
    """Read every comment page. Keep the model's reply separate."""
    result = normalize_detail(args, value)
    if not isinstance(result.get("comments"), dict):
        return result
    comments, seen, total = {}, set(), result["comments"].get("total")
    first_args = {key: value for key, value in args.items() if key != "comments_cursor"}
    first = normalize_detail(first_args, read_page("joppa_objects", first_args)) if args.get("comments_cursor") else result
    page, paged = first, False
    while True:
        if any(page.get(key) != result.get(key) for key in ("address", "current_revision", "document")):
            raise MCPError("Joppa object changed during comment read")
        entries = page.get("comments", {}).get("items")
        if not isinstance(entries, list):
            raise MCPError("Joppa comment page is incomplete")
        for comment in entries:
            key = comment.get("id")
            if not isinstance(key, str) or key in comments:
                raise MCPError("Joppa comment page overlaps")
            comments[key] = comment
        cursor = page["comments"].get("next_cursor")
        if not cursor:
            break
        if cursor in seen:
            raise MCPError("Joppa comment pagination did not advance")
        seen.add(cursor)
        page = normalize_detail(args, read_page("joppa_objects", {**args, "comments_cursor": cursor}))
        paged = True
    if isinstance(total, int) and len(comments) != total:
        raise MCPError("Joppa comment list is incomplete")
    if paged:
        check = normalize_detail(first_args, read_page("joppa_objects", first_args))
        if any(check.get(key) != first.get(key) for key in ("address", "current_revision", "document", "comments")):
            raise MCPError("Joppa comments changed during read")
    result["annotations"]["comments"] = comments
    result.pop("comments")
    return result
