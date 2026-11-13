"""Mandatory live role contracts from Joppa, read through the lane memory adapter."""
import hashlib
import json
import os
from pathlib import Path

from common import require, run, text

ROLES = ("researcher", "designer", "critic")
# One HTTP client for lanes, planning and audit: the lane hook's adapter.
DATA = Path(__file__).resolve().parents[1] / "lane" / "hooks" / "joppa-data.sh"


def memory(mode, role, project, query=None):
    """The validated reply of one read, with the role, process and project filters of this caller."""
    env = {k: v for k, v in os.environ.items() if k not in ("LANE_MEMORY_ROLE", "LANE_MEMORY_PROCESS")}
    env.update({"LANE_MEMORY_PROJECT": project}, **({"LANE_MEMORY_ROLE": role, "LANE_MEMORY_PROCESS": role} if role else {}))
    reply = json.loads(run(["bash", str(DATA), mode] + ([query] if query is not None else []), timeout=120, env=env))
    require(isinstance(reply.get("items"), list), f"Joppa {mode} reply has no items")
    return reply


def config():
    return json.loads(Path(os.environ["LANE_MEMORY_CONFIG"]).read_text())


def fields(mode):
    return config()[mode].get("fields", [])


def render(reply, mode):
    return run(["bash", str(DATA), "render", json.dumps(fields(mode))], input=json.dumps(reply))


def load_contract(role, project):
    # The process name is configuration; this code names only the workflow role.
    name = (config().get("roles") or {}).get(role)
    require(isinstance(name, str) and name, f"config.context.roles.{role} is missing")
    reply = memory("session", name, project)
    require(reply["items"], f"Joppa contract empty: {name}")
    content = text(render(reply, "session"), f"Joppa {name} content")
    ids = []
    shown = ["body"] + [f for f in fields("session") if f not in ("title", "address", "kind", "revision")]
    for item in reply["items"]:
        require(isinstance(item.get("address"), str) and isinstance(item.get("revision"), int),
                f"Joppa contract item without address or revision: {name}")
        # A heading is not a contract, as in the lane hook.
        require(any(item.get(f) not in (None, "", [], {}) for f in shown),
                f"Joppa contract item without text: {item['address']}")
        ids.append(f"{item['address']}@{item['revision']}")
    # The digest covers the text the agents read; the reply position is global and ignored.
    return {"role": name, "content": content, "record_ids": ids,
            "bundle_digest": hashlib.sha256(content.encode()).hexdigest()}


def load_knowledge(project, query):
    """Lessons for the assignment. No match is a valid answer. No role filter: the query block names its own."""
    reply = memory("query", None, project, query)
    return reply, render(reply, "query") if reply["items"] else ""
