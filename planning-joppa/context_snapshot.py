"""Planning context helpers."""
from common import digest, require


def source(object):
    """Ignore journal position. Keep meaningful state."""
    process = dict(object.get("process", {}))
    value = {key: object.get(key) for key in ("address", "item_id", "kind", "current_revision", "document", "annotations",
                                            "files", "references", "work_ready")} | {"process": process}
    if object.get("remote_links") or object.get("remote_links_revision", 0) > 0:
        value["remote_links"] = object.get("remote_links", [])
        value["remote_links_revision"] = object.get("remote_links_revision", 0)
        value["remote_review_required"] = object.get("remote_review_required", False)
    return value

def current_pin(pin, current, contract):
    return (type(pin) is int and type(current) is int and type(contract) is int
            and 1 <= contract <= pin <= current)

# Lifecycle metadata is not authored contract text. Claims and completion change only these fields.
# Completion also writes the bound test names of the lane.
LIFECYCLE_FIELDS = ("assignee", "commit", "test_bindings")

def authored_document(document):
    result = dict(document)
    if isinstance(result.get("data"), dict):
        result["data"] = {key: value for key, value in result["data"].items() if key not in LIFECYCLE_FIELDS}
    return result

def remote_satisfied(link):
    status = link.get("status", {})
    revision = link.get("revision")
    # Joppa exposes its contract check as review_required, not contract_revision.
    return (current_pin(revision, status.get("current_revision"), 1)
            and status.get("access") is True
            and status.get("present") is True and status.get("review_required") is False
            and status.get("satisfied") is True)

def snapshot_source(object, types, selected_ac=None):
    current = source(object)
    current.pop("item_id", None)
    current.pop("remote_review_required", None)
    if current.get("remote_links"):
        current["remote_links"] = [{key: value for key, value in link.items() if key != "status"}
                                   for link in current["remote_links"]]
    for key in ("verification", "pending_run", "summary", "status"):
        current["process"].pop(key, None)
    current["document"] = authored_document(current["document"])
    role = types[object["kind"]].get("role")
    selected = {selected_ac} if isinstance(selected_ac, str) else set(selected_ac or [])
    if role in ("task", "ac", "requirement", "group"):
        # A planning claim or a lane completion saves lifecycle fields and a new revision. Compare authored fields.
        current.pop("current_revision")
        current.pop("contract_revision", None)
        current["document"] = {key: value for key, value in current["document"].items()
                               if key in ("data", "parent", "links", "present", "schema_revision")}
    if role == "task" or (role == "ac" and selected_ac is not None and object["address"] not in selected):
        # Sibling execution state does not change the authored planning context.
        current.pop("process")
        current.pop("work_ready")
    if role == "task":
        annotations = dict(current.get("annotations") or {})
        comments = annotations.get("comments")
        if isinstance(comments, dict):
            annotations["comments"] = {key: comment for key, comment in comments.items()
                                       if comment.get("actor_type") != "agent"}
        for key in ("comments", "description", "attachments"):
            if not annotations.get(key):
                annotations.pop(key, None)
        current["annotations"] = annotations
    return current

def authored_meaning(meaning):
    """A child AC save gives its Requirement a new revision and reason with the same authored fields."""
    return {key: value for key, value in meaning.items() if key not in ("number", "reason")}

def selected_criteria(assignment):
    return assignment["joppa"].get("criteria", [assignment["ac"]])

def unchanged(old, new):
    require(digest(old) == digest(new), "Joppa context changed during planning; read the criterion again")
