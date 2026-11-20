"""Translate supported Joppa reads for native contract checks."""

class MCPError(ValueError):
    pass


class Rejected(MCPError):
    """The server confirmed that the tool operation failed."""


SYSTEM_RELATIONS = ("depends_on", "related")


def relation_links(relations):
    """Local edges arrive as relations {key: {edges: [{to, revision?}]}}. Only depends_on blocks.
    Only the system keys depends_on and related carry meaning. Flow keys are display only and stay in relations.
    Remote links of set_remote_links keep their own payload and are not read here."""
    return [{"blocking": relation == "depends_on", "relation": relation,
             "revision": edge.get("revision"), "target": edge["to"]}
            for relation, group in (relations or {}).items() if relation in SYSTEM_RELATIONS
            for edge in (group or {}).get("edges", [])]


# With fields, status is a tone string, status.label is separate and an absent optional key is null.
# current_revision is not a detail key. present keeps an archived node archived.
DETAIL_FIELDS = ("revision", "parent", "data", "computed", "present", "status", "status.label", "process",
                 "relations", "references", "comments", "files", "remote_links", "remote_review_required",
                 "remote_links_revision", "result")
OPTIONAL_KEYS = ("computed", "process", "result", "remote_links", "remote_review_required", "current_revision",
                 "present", "files", "references", "remote_links_revision")


def detail_read(args):
    """A current single detail. A revision read keeps the native historical detail with its current_revision."""
    address = args.get("address")
    return (isinstance(address, str) and "," not in address and not args.get("history") and not args.get("relations_of")
            and not args.get("in_relation") and not args.get("fields") and not args.get("revision"))


def normalize_detail(args, value):
    result = dict(value)
    if isinstance(result.get("status"), str):
        result["status"] = {"tone": result["status"], "label": result.get("status.label")}
    result.pop("status.label", None)
    for key in OPTIONAL_KEYS:
        if key in result and result[key] is None:
            del result[key]
    if "document" not in result:
        if not isinstance(result.get("data"), dict) or type(result.get("revision")) is not int or result["revision"] < 1:
            raise MCPError("Joppa object detail is incomplete")
        present = result.get("present", True) is not False
        result["document"] = {"revision": result["revision"], "parent": result.get("parent"),
                              "present": present, "data": result["data"],
                              "links": relation_links(result.get("relations"))}
        result.setdefault("current_revision", result["revision"])
    result.setdefault("address", args.get("address"))
    if not isinstance(result["address"], str):
        raise MCPError("Joppa object address is missing")
    result.setdefault("kind", result["address"].split(":", 1)[0])
    result.setdefault("historical", result["document"].get("revision", result["current_revision"]) != result["current_revision"])
    result["process"] = dict(result.get("process") or {})
    result["annotations"] = dict(result.get("annotations") or {})
    result.setdefault("files", [])
    result.setdefault("references", [])
    result.setdefault("remote_links_revision", 0)
    return result


# Task state comes from generic node fields. The native process stays as Joppa returns it.
def assignee(object):
    return object["document"]["data"].get("assignee")


def ended(object):
    return object["document"].get("present") is False


def done(object):
    return ended(object) and bool(object["document"]["data"].get("commit"))


def node_stage(object):
    stage = (object.get("computed") or {}).get("stage")
    return stage if stage is not None else object["document"]["data"].get("stage")


def block_reason(object, failed_stage=None):
    """Return the configured failure stage of a current failed Task."""
    stage = node_stage(object)
    return stage if not ended(object) and failed_stage and stage == failed_stage else None


def blocked(object, failed_stage=None):
    return block_reason(object, failed_stage) is not None


def task_state(object, failed_stage=None):
    """Classify one Task: done, retired, blocked, active or open."""
    if ended(object):
        return "done" if done(object) else "retired"
    return "active" if assignee(object) else "blocked" if blocked(object, failed_stage) else "open"


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
        # A cursor reply can hold only the comment page. Its object fields, when present, must match.
        following = read_page("joppa_objects", {**args, "comments_cursor": cursor})
        page = ({**result, "comments": following["comments"]} if isinstance(following, dict) and set(following) == {"comments"}
                else normalize_detail(args, following))
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


def validate_failed_stage(config, types=None):
    """Legacy Task planning needs the configured native failure stage."""
    stage = config.get("FAILED_TASK_STAGE")
    if not isinstance(stage, str) or not stage or stage.strip() != stage or stage == "done":
        raise ValueError("FAILED_TASK_STAGE must name a nonterminal Task stage")
    if types is not None:
        tasks = [value for value in types.values() if value.get("role") == "task"]
        if not tasks or any((value.get("fields", {}).get("stage", {}).get("from", "own") != "own" or
                             stage not in value.get("fields", {}).get("stage", {}).get("values", [])) for value in tasks):
            raise ValueError("FAILED_TASK_STAGE is absent from the native Task stage values")
