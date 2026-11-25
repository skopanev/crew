"""Configured grouping and ordering for one atomic flow claim."""
from functools import cmp_to_key
from datetime import datetime, timezone
import re
import os
from pathlib import Path
import subprocess

from common import require


def settings(config):
    batch = config.get("batch")
    if batch is None:
        return None
    require(isinstance(batch, dict) and set(batch) <= {"size", "by", "unit_field", "min_size", "max_wait_seconds", "age_field", "flush_when_idle"},
            "batch has unsupported fields")
    require(type(batch.get("size")) is int and 1 <= batch["size"] <= 50, "batch.size must be 1..50")
    require(batch.get("by") is None or isinstance(batch["by"], str) and
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", batch["by"]), "batch.by must name a field")
    require("unit_field" not in batch or isinstance(batch["unit_field"], str) and
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", batch["unit_field"]), "batch.unit_field must name a field")
    require(type(batch.get("min_size", 1)) is int and 1 <= batch.get("min_size", 1) <= batch["size"],
            "batch.min_size must be 1..size")
    require(("max_wait_seconds" in batch) == ("age_field" in batch), "batch wait needs age_field")
    if "max_wait_seconds" in batch:
        require(type(batch["max_wait_seconds"]) is int and batch["max_wait_seconds"] > 0 and
                isinstance(batch["age_field"], str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", batch["age_field"]),
                "batch wait needs positive seconds and a timestamp field")
    if "flush_when_idle" in batch:
        pattern = batch["flush_when_idle"]
        require(isinstance(pattern, str) and os.path.isabs(pattern) and not pattern.endswith(os.sep) and
                all(part not in (".", "..") and (part == "*" or not re.search(r"[*?\[\]{}\x00]", part))
                    for part in pattern.split(os.sep)), "batch.flush_when_idle needs an absolute glob with whole * segments")
    return batch


def field(item, name):
    if name in item:
        return item[name]
    parts = name.split(".")
    prefix = ".".join(parts[:2])
    if prefix in item:
        current = item[prefix]
        for part in parts[2:]:
            current = current.get(part) if isinstance(current, dict) else None
        return current
    current = item.get("document", item)
    for part in name.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def projection(name):
    return ".".join(name.split(".")[:2]) if name.startswith("data.") else name


def ordered(rows, config):
    def compare(left, right):
        for order in config.get("order", []):
            a, b = field(left, order["field"]), field(right, order["field"])
            if a == b:
                continue
            if a is None or b is None:
                return 1 if a is None else -1
            if "values" in order:
                values = order["values"]
                a, b = (values.index(value) if value in values else len(values) for value in (a, b))
            if not (type(a) in (int, float) and type(b) in (int, float)):
                a, b = str(a), str(b)
            result = (a > b) - (a < b)
            if result:
                return -result if order["direction"] == "desc" else result
        return (left["address"] > right["address"]) - (left["address"] < right["address"])
    return sorted(rows, key=cmp_to_key(compare))


def members(assignment):
    return assignment.get("items") or [assignment["selected"]]


def select(batch, rows):
    if not batch.get("unit_field"):
        return rows[:batch["size"]]
    units = {}
    for row in rows:
        unit = field(row, batch["unit_field"])
        require(isinstance(unit, str) and unit, "batch item lacks its unit field")
        units.setdefault(unit, []).append(row)
    selected, count = [], 0
    for items in units.values():
        require(count or len(items) <= 50, "batch anchor unit exceeds the native 50-item claim limit")
        if count == batch["size"]:
            break
        if len(selected) + len(items) > 50:
            continue
        selected.extend(items)
        count += 1
    return selected


def ready(batch, rows):
    size = len({field(row, batch["unit_field"]) for row in rows}) if batch.get("unit_field") else len(rows)
    if size >= batch.get("min_size", 1):
        return True
    if not rows:
        return False
    if "flush_when_idle" in batch:
        try:
            return subprocess.run([os.environ.get("NODE_BIN", "node"), str(Path(__file__).with_name("flow-batch.mjs")),
                                   batch["flush_when_idle"]], timeout=5, check=False).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False
    if "max_wait_seconds" not in batch:
        return False
    for row in rows:
        try:
            value = field(row, batch["age_field"])
            at = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else None
            if at and at.tzinfo and (datetime.now(timezone.utc) - at).total_seconds() >= batch["max_wait_seconds"]:
                return True
        except ValueError:
            pass
    return False
