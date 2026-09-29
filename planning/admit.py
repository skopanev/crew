"""Read-only pre-launch check. Exit 0=allowed, 3=stale, 2=read/validation error."""
import argparse
import json
from pathlib import Path
import sys

from common import digest, read, require
from freshness import StalePlan, admit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", required=True)
    parser.add_argument("--task", help="local planning Task id; required with --repository/--module")
    parser.add_argument("--repository")
    parser.add_argument("--module")
    args = parser.parse_args()
    result = read(args.result)
    if args.task or args.repository or args.module:
        require(args.task and args.repository and args.module, "task, repository and module must be supplied together")
        tasks = [t for t in result["plan"]["tasks"] if t["id"] == args.task]
        require(len(tasks) == 1, "planning Task missing or ambiguous")
        task = tasks[0]
        source = read(Path(args.result).parent / "input.json")
        require(digest(source) == result.get("input_digest"), "planning input artifact does not match the receipt")
        repo = next((r for r in source["repositories"] if r["id"] == task["repository"]), None)
        require(repo and Path(repo["path"]).resolve() == Path(args.repository).resolve(), "lane repository differs from planning Task")
        require(task["module"] == args.module, "lane module differs from planning Task")
    print(json.dumps(admit(result)))


if __name__ == "__main__":
    try:
        main()
    except StalePlan as exc:
        print(json.dumps({"status": "stale", "reason": str(exc)}))
        sys.exit(3)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "error", "reason": str(exc)}))
        sys.exit(2)
