"""Planning context helpers."""
from common import digest, require


def source(object):
    """Ignore journal position and our own planning claim. Keep meaningful state."""
    process = {key: value for key, value in object.get("process", {}).items() if key != "planning_claim"}
    value = {key: object.get(key) for key in ("address", "item_id", "kind", "current_revision", "document", "annotations",
                                            "files", "references", "review_required", "work_ready")} | {"process": process}
    if "contract_revision" in object:
        value["contract_revision"] = object["contract_revision"]
    if object.get("remote_links") or object.get("remote_links_revision", 0) > 0:
        value["remote_links"] = object.get("remote_links", [])
        value["remote_links_revision"] = object.get("remote_links_revision", 0)
        value["remote_review_required"] = object.get("remote_review_required", False)
    return value

def current_pin(pin, current, contract):
    return (type(pin) is int and type(current) is int and type(contract) is int
            and 1 <= contract <= pin <= current)

def remote_satisfied(link):
    status = link.get("status", {})
    revision = link.get("revision")
    return (current_pin(revision, status.get("current_revision"),
                        status.get("contract_revision", status.get("current_revision")))
            and status.get("access") is True
            and status.get("present") is True and status.get("review_required") is False
            and status.get("satisfied") is True)

def test_list(status):
    return {"tests": [item["address"] for item in status["tests"]],
            "tests_revision": status.get("tests_revision"), "tests_draft": status["tests_draft"]}

def snapshot_source(object, types, selected_ac=None):
    current = source(object)
    current.pop("item_id", None)
    current.pop("remote_review_required", None)
    if current.get("remote_links"):
        current["remote_links"] = [{key: value for key, value in link.items() if key != "status"}
                                   for link in current["remote_links"]]
    for key in ("verification", "pending_run", "summary", "status"):
        current["process"].pop(key, None)
    role = types[object["kind"]].get("role")
    selected = {selected_ac} if isinstance(selected_ac, str) else set(selected_ac or [])
    if role == "task" or (role == "ac" and selected_ac is not None and object["address"] not in selected):
        # Sibling execution state does not change the authored planning context.
        current.pop("current_revision")
        current.pop("process")
        current.pop("work_ready")
        current.pop("review_required")
        current["document"] = {key: value for key, value in current["document"].items()
                               if key in ("data", "parent", "links", "present", "schema_revision")}
        if role == "task":
            current.pop("contract_revision", None)
        elif "contract_revision" in current:
            current["document"]["data"] = {key: value for key, value in current["document"]["data"].items()
                                           if key != "tests"}
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

def selected_criteria(assignment):
    return assignment["joppa"].get("criteria", [assignment["ac"]])

def unchanged(old, new):
    require(digest(old) == digest(new), "Joppa context changed during planning; read the criterion again")
