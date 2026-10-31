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
        result["document"] = {"revision": result["revision"], "parent": result.get("parent"),
                              "present": result.get("present", True), "data": result["data"],
                              "links": [authored_link(link) for link in result.get("links", [])]}
        result.setdefault("current_revision", result["revision"])
        if not args.get("revision"):
            result.setdefault("review_required", False)
            result.setdefault("work_ready", True)
    result.setdefault("address", args.get("address"))
    if not isinstance(result["address"], str):
        raise MCPError("Joppa object address is missing")
    result.setdefault("kind", result["address"].split(":", 1)[0])
    result.setdefault("historical", result["document"].get("revision", result["current_revision"]) != result["current_revision"])
    if not args.get("revision"):
        result.setdefault("contract_revision", result["current_revision"])
    result["process"] = dict(result.get("process") or {})
    result["process"].setdefault("assignee", None)
    result["annotations"] = dict(result.get("annotations") or {})
    result.setdefault("files", [])
    result.setdefault("references", [])
    result.setdefault("remote_links_revision", 0)
    return result


def normalize_tests(args, result):
    targets = [target for target in args.get("ac", "").split(",") if target]
    if len(targets) == 1 and "items" not in result:
        result.setdefault("address", targets[0])
    for row in result.get("items", [result]):
        row.setdefault("tests_draft", False)
        if not args.get("summary"):
            row.setdefault("tests", [])


def normalize_tasks(result):
    lean = "tasks" not in result and "items" in result
    result.setdefault("tasks", result.get("items", []))
    if lean:
        for row in result["tasks"]:
            row.setdefault("ac", row.get("parent"))
            row.setdefault("claimable", False)
            row.setdefault("review_required", False)


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
