"""Configured grouping and ordering for one atomic flow claim."""
from functools import cmp_to_key
import re

from common import require


def settings(config):
    batch = config.get("batch")
    if batch is None:
        return None
    require(isinstance(batch, dict) and set(batch) <= {"size", "by"}, "batch needs size and optional by")
    require(type(batch.get("size")) is int and 1 <= batch["size"] <= 50, "batch.size must be 1..50")
    require(batch.get("by") is None or isinstance(batch["by"], str) and
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", batch["by"]), "batch.by must name a field")
    return batch


def field(item, name):
    if name in item:
        return item[name]
    current = item.get("document", item)
    for part in name.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def ordered(rows, config):
    def compare(left, right):
        for order in config.get("order", []):
            a, b = field(left, order["field"]), field(right, order["field"])
            if a == b:
                continue
            if a is None or b is None:
                return 1 if a is None else -1
            if not (type(a) in (int, float) and type(b) in (int, float)):
                a, b = str(a), str(b)
            result = (a > b) - (a < b)
            return -result if order["direction"] == "desc" else result
        return (left["address"] > right["address"]) - (left["address"] < right["address"])
    return sorted(rows, key=cmp_to_key(compare))


def members(assignment):
    return assignment.get("items") or [assignment["selected"]]
