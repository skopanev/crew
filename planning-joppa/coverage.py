"""Read and validate the Task reference that lists the other criteria a Task covers.

config.covers_reference names one Task schema reference field. Without it the feature is off.
Crew writes full criterion addresses. A bare ID that Joppa stored as sent reads as the target type address.
"""
from common import require


def reference(config, types, task_kind):
    """Return {field, target} for the configured covers reference of task_kind, or None when it is off."""
    field = config.get("covers_reference")
    if field is None:
        return None
    require(isinstance(field, str) and field.strip() and field not in ("projects", "assignee", "commit",
                                                                       "acceptance", "test_bindings"),
            "config.covers_reference must name one Task reference field")
    definition = (types[task_kind].get("references") or {}).get(field)
    require(isinstance(definition, dict),
            f"config.covers_reference {field} is not a reference of Task type {task_kind}")
    require(definition.get("multiple") is True,
            f"Task reference {field} must allow several criteria")
    target = definition.get("target")
    require(isinstance(target, str) and (types.get(target) or {}).get("role") == "ac",
            f"Task reference {field} must target the criterion type")
    return {"field": field, "target": target}


def covered(data, spec):
    """Full criterion addresses in the covers field of one Task document. Normalize bare IDs."""
    if not spec:
        return []
    values = (data or {}).get(spec["field"])
    if values is None:
        return []
    require(isinstance(values, list) and all(isinstance(value, str) and value.strip() for value in values),
            f"Task reference {spec['field']} must be a list of criterion addresses")
    return list(dict.fromkeys(value if ":" in value else spec["target"] + ":" + value for value in values))
