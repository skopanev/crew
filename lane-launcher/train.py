#!/usr/bin/env python3
"""Landing train: land queued lane candidates in batches with one gate run.

Lanes started with "train" in dolber.json stop after review and checks and
queue their candidate (artifacts/train-request.json). Their worktree is
retained. This lander is the only writer to the target branch:

1. Wait until the queue holds train.size candidates, the oldest one waited
   train.waitSeconds, or no lane is running.
2. Group the queue by repository (train-request.json names it); per
   repository, apply each candidate's commits onto a fresh target in one
   integration clone. A conflicting candidate leaves the train and is reopened.
   Before that, every candidate's gate receipt is verified against its
   request (digest, task, repository, module, run, tree, candidate commit);
   a refused receipt blocks the ticket and keeps its checkout.
3. Run, once on the combined tree, train.gateCommands plus every
   candidate's own required plan (configured gates, ticket acceptance checks,
   coder checks) with gates.py semantics; each result goes into the receipt.
4. Pass: push, move every ticket to to_test, remove the lane worktrees.
   Fail: split the train in halves and land each half again; a single failing
   candidate is reopened with the gate log. Candidates that land from a failed
   train leave their plans as carried obligations for every later subset of
   it, so a later candidate cannot land over a check that held without it.

Git and the gates run inside one container of the lane image, with the lane's
mounts, so the train checks the same environment as the lanes.

usage: train.py [dolber.json] [--once] [--dry-run]

--dry-run builds the train and runs the gates, then stops: no push, no
ticket change, no worktree removal, no result file.
"""
import contextlib
import datetime as dt
import glob
import hashlib
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import sys
import time

DRY = False
HERE = os.path.dirname(os.path.abspath(__file__))
TOOLING = os.path.dirname(HERE)


def load_gates():
    """The lane's gates.py: one definition of plans and acceptance checks for lanes and train."""
    spec = importlib.util.spec_from_file_location("crew_lane_gates", os.path.join(TOOLING, "lane", "bin", "gates.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GATES = load_gates()
REFUSED = ("receipt_refused",)


def log(msg):
    print(f"[train {dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def load_config(path):
    with open(path) as fh:
        config = json.load(fh)
    train = config.get("train")
    if not isinstance(train, dict):
        sys.exit("train.py: dolber.json needs a train object")
    train.setdefault("size", 3)
    train.setdefault("waitSeconds", 900)
    train.setdefault("intervalSeconds", 60)
    gates = train.get("gateCommands") or config.get("gateCommands")
    if not gates:
        sys.exit("train.py: train.gateCommands (or gateCommands) is required")
    train["gateCommands"] = gates
    mounts = train.setdefault("persistentMounts", [])
    if not isinstance(mounts, list):
        sys.exit("train.py: train.persistentMounts must be a list of {host, inside}")
    for mount in mounts:
        if (not isinstance(mount, dict) or set(mount) != {"host", "inside"}
                or not all(isinstance(mount[k], str) and os.path.isabs(mount[k]) and ":" not in mount[k]
                           for k in ("host", "inside"))
                or os.path.normpath(mount["inside"]).startswith("/workspace/train")):
            sys.exit(f"train.py: invalid train.persistentMounts entry {mount!r}: "
                     "need absolute host and inside paths, no ':', not under /workspace/train")
        os.makedirs(mount["host"], exist_ok=True)
        mount["host"] = os.path.realpath(mount["host"])
    setup = train.get("setup")
    if setup is not None and (not isinstance(setup, str) or not setup.strip()):
        sys.exit("train.py: train.setup must be a nonempty shell command string")
    state = os.path.join(config.get("stateDir", os.path.expanduser("~/.medulla/lane-launcher")),
                         "crew-dispatchers", config["id"].lower())
    config["scopeDir"] = state
    config["trainDir"] = os.path.join(state, "train")
    return config


def queued(config):
    """Requests without a result, oldest first."""
    rows = []
    for req in glob.glob(os.path.join(config["scopeDir"], "runs", "*", "lane", "*", "artifacts", "train-request.json")):
        art = os.path.dirname(req)
        if os.path.exists(os.path.join(art, "train-result.json")):
            continue
        with open(req) as fh:
            item = json.load(fh)
        item["artifacts"] = art
        item["run_dir"] = os.path.dirname(art)
        item["host_worktree"] = os.path.join(config["sourceRoot"], ".worktrees", item["ticket"])
        rows.append(item)
    return sorted(rows, key=lambda r: r["queued_at"])


def lanes_running():
    out = subprocess.run(["docker", "ps", "-q", "--filter", "label=medulla.workflow=lane"],
                         capture_output=True, text=True, check=True).stdout
    return bool(out.strip())


def due(config, rows):
    if not rows:
        return False
    if DRY:
        return True
    if len(rows) >= config["train"]["size"]:
        return True
    oldest = dt.datetime.strptime(rows[0]["queued_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    if (dt.datetime.now(dt.timezone.utc) - oldest).total_seconds() >= config["train"]["waitSeconds"]:
        return True
    return not lanes_running()


class TrainDeferred(Exception):
    """A transient failure: retry the same queue on the next tick."""


class Box:
    """One lane-image container holding the integration clone."""

    def __init__(self, config, work):
        self.config, self.work = config, work
        source = os.path.realpath(config["sourceRoot"])
        mounts = [(source, f"/workspace/{os.path.basename(source)}", "ro"),
                  (work, "/workspace/train", "rw"),
                  (os.path.realpath(config["sshDir"]), "/workspace/lane-ssh", "ro")]
        # Project-owned directories the lander alone keeps across trains (train.persistentMounts).
        mounts += [(m["host"], m["inside"], "rw") for m in config["train"]["persistentMounts"]]
        mounts += [(os.path.realpath(d), f"/workspace/{os.path.basename(os.path.realpath(d))}", "ro")
                   for d in config.get("readOnlyRepos", [])]
        mounts += [(os.path.realpath(d), f"/workspace/{os.path.basename(os.path.realpath(d))}", "rw")
                   for d in config.get("readWriteDirs", [])]
        args = ["docker", "run", "-d", "--rm", "--label", "medulla.workflow=train",
                "--entrypoint", "sleep", "-w", "/workspace/train", "-e", "GIT_LFS_SKIP_SMUDGE=1",
                "-e", "GIT_SSH_COMMAND=ssh -F /dev/null -i /workspace/lane-ssh/id_ed25519 -o IdentitiesOnly=yes "
                      "-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/workspace/lane-ssh/known_hosts"]
        for host, inside, mode in mounts:
            args += ["-v", f"{host}:{inside}:{mode}"]
        args += [config["image"], "infinity"]
        self.id = subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()
        self.source = f"/workspace/{os.path.basename(source)}"

    def sh(self, script, logfile=None, timeout=3600, cwd="/workspace/train/repo"):
        proc = subprocess.run(["docker", "exec", "-w", cwd, self.id, "bash", "-c",
                               "set -euo pipefail; " + script],
                              capture_output=True, text=True, timeout=timeout)
        if logfile:
            with open(logfile, "a") as fh:
                fh.write(f"$ {script}\n{proc.stdout}{proc.stderr}\nrc={proc.returncode}\n")
        return proc

    def close(self):
        subprocess.run(["docker", "rm", "-f", self.id], capture_output=True)


def repository_dir(config, item):
    """The candidate's own repository: a Git checkout directly addressed under sourceRoot."""
    repository = item.get("repository")
    root = os.path.realpath(config["sourceRoot"])
    if (not isinstance(repository, str) or not repository or os.path.isabs(repository)
            or ".." in repository.split("/") or repository.startswith(".")):
        raise ValueError("the request lacks a repository relative to sourceRoot")
    path = os.path.realpath(os.path.join(root, repository))
    if not path.startswith(root + os.sep) or not os.path.isdir(os.path.join(path, ".git")):
        raise ValueError(f"the request repository is not a checkout under sourceRoot: {repository}")
    return repository


def prepare(box, config, repo, logfile):
    src = f"{box.source}/{repo}"
    script = f"""
rm -rf /workspace/train/repo; mkdir -p /workspace/train/repo; cd /workspace/train/repo
git clone -q --no-hardlinks --no-checkout {src} .
git config user.name lane; git config user.email lane@local
git remote set-url origin "$(git -C {src} remote get-url origin)"
timeout 120 git fetch -q origin
target="$(jq -er .target_branch {src}/.ntkrc)"
GIT_LFS_SKIP_SMUDGE=1 git checkout -q --detach "origin/$target"
if [ -d {src}/.git/lfs/objects ] && command -v git-lfs >/dev/null; then
  mkdir -p .git/lfs && cp -r {src}/.git/lfs/objects .git/lfs/ && git lfs checkout >/dev/null
fi
if [ -f scripts/install-git-hooks.sh ]; then bash scripts/install-git-hooks.sh >/dev/null; fi
echo "$target $(git rev-parse HEAD)"
"""
    proc = box.sh(script, logfile, cwd="/workspace/train")
    if proc.returncode:
        raise RuntimeError(f"integration setup failed; see {logfile}")
    target, base = proc.stdout.split()[-2:]
    setup = config["train"].get("setup")
    if setup:
        # Project-owned preparation (train.setup), e.g. seeding a private build cache.
        proc = box.sh("export LANDING_TRAIN=true LANE_WORKTREE=/workspace/train/repo; " + setup, logfile)
        if proc.returncode:
            raise RuntimeError(f"train.setup failed (rc={proc.returncode}); see {logfile}")
        dirty = box.sh("git status --porcelain --untracked-files=normal")
        if dirty.returncode or dirty.stdout.strip():
            raise RuntimeError(f"train.setup changed the checkout; it may only touch ignored files. See {logfile}")
    return target, base


def apply(box, item, target, logfile):
    inside = f"{box.source}/.worktrees/{item['ticket']}"
    script = f"""
git fetch -q {inside} {item['sha']}
[ "$(git rev-parse FETCH_HEAD)" = "{item['sha']}" ]
mb="$(git merge-base FETCH_HEAD origin/{target})"
if ! git -c core.hooksPath=/dev/null cherry-pick --allow-empty --keep-redundant-commits "$mb..FETCH_HEAD" >/dev/null 2>&1; then
  git diff --name-only --diff-filter=U
  git cherry-pick --abort
  exit 3
fi
"""
    proc = box.sh(script, logfile)
    if proc.returncode == 3:
        return "conflict", proc.stdout.strip()
    if proc.returncode:
        return "error", (proc.stderr or proc.stdout).strip()[-500:]
    return "ok", ""


def run_check(box, command, logfile):
    """Run one plan entry in the Box with gates.py semantics; return its result row."""
    started = time.time()
    if isinstance(command, dict):
        # Structured acceptance check: argv without a shell, literal pathspecs, exact stdout.
        GATES.acceptance_check(command, root=os.path.join(box.work, "repo"))
        script = "export GIT_LITERAL_PATHSPECS=1; exec " + shlex.join(command["argv"])
    else:
        script = command
    timed_out = False
    try:
        proc = box.sh(script, logfile, timeout=5400)
        rc, stdout = proc.returncode, proc.stdout
    except subprocess.TimeoutExpired:
        timed_out, rc, stdout = True, 124, ""
    stdout_matches = not (isinstance(command, dict) and "stdout" in command) or stdout == command["stdout"]
    return {"command": command, "exit_code": rc, "timed_out": timed_out, "stdout_matches": stdout_matches,
            "started_at": started, "finished_at": time.time()}


def train_plan(config, items, carried=()):
    """train.gateCommands, every candidate's own verified plan and the carried obligations, each once.

    carried holds (command, ticket) pairs of candidates that already landed from a failed
    batch this subset came from; their code is in the target, so their checks still bind.
    """
    plan = []

    def add(command, owner):
        for row in plan:
            if row["command"] == command:
                row["owners"].append(owner)
                return
        plan.append({"command": command, "owners": [owner]})
    for command in config["train"]["gateCommands"]:
        add(command, "train")
    for item in items:
        for command in item["receipt"]["commands"]:
            add(command, item["ticket"])
    for command, ticket in carried:
        add(command, f"{ticket} (carried)")
    return plan


def obligations(items):
    """The checks landed candidates leave behind for later subsets of their failed batch."""
    return [(command, item["ticket"]) for item in items for command in item["receipt"]["commands"]]


def run_plan(box, plan, logfile):
    """Run the whole plan on the integrated tree; stop at the first failure."""
    results = []
    for i, row in enumerate(plan, 1):
        command = row["command"]
        label = command if isinstance(command, str) else shlex.join(command["argv"])
        log(f"  check {i}/{len(plan)} ({', '.join(row['owners'])}): {label}")
        result = {**run_check(box, command, logfile), "owners": row["owners"]}
        results.append(result)
        log(f"  check {i}: rc={result['exit_code']} stdout_matches={result['stdout_matches']} "
            f"in {result['finished_at'] - result['started_at']:.0f}s")
        if result["exit_code"] or not result["stdout_matches"]:
            return False, label, results
    return True, "", results


def push(box, target, logfile):
    """Push the train; retry transport failures (the git host drops ssh from this network)."""
    for attempt in range(3):
        state, detail = push_once(box, target, logfile)
        if state != "error":
            return state, detail
        log(f"push attempt {attempt + 1} failed: {detail.splitlines()[-1] if detail else ''}")
        time.sleep(20)
    return state, detail


def push_once(box, target, logfile):
    script = f"""
before="$(git ls-remote origin refs/heads/{target} | awk '{{print $1}}')"
git merge-base --is-ancestor "$before" HEAD || exit 3
git push -q origin HEAD:refs/heads/{target}
[ "$(git ls-remote origin refs/heads/{target} | awk '{{print $1}}')" = "$(git rev-parse HEAD)" ]
git rev-parse HEAD
"""
    proc = box.sh(script, logfile)
    if proc.returncode == 3:
        return "moved", ""
    if proc.returncode:
        return "error", (proc.stderr or proc.stdout).strip()[-500:]
    return "ok", proc.stdout.strip().splitlines()[-1]


def finish(config, item, status, detail, train_dir):
    if DRY:
        log(f"  DRY {item['ticket']}: would be {status}: {detail}")
        return
    result = {"status": status, "detail": detail, "train": train_dir,
              "finished_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    env = {**os.environ, "ticket_id": item["ticket"], "project_name": config["workspace"],
           "MEDULLA_RUN_DIR": item["run_dir"]}
    if status == "landed":
        proc = subprocess.run(["node", os.path.join(TOOLING, "lane", "bin", "ticket-outcome.mjs"), "to-test"],
                              env=env, capture_output=True, text=True)
        result["to_test"] = proc.returncode == 0
        if proc.returncode:
            result["to_test_error"] = (proc.stderr or proc.stdout)[-500:]
        elif os.path.getsize(followups) if os.path.exists(followups := os.path.join(item["artifacts"], "followups.txt")) else 0:
            # The lane left nonblocking findings; they need the source ticket in to_test.
            proc = subprocess.run(["node", os.path.join(TOOLING, "lane", "bin", "ticket-outcome.mjs"), "findings"],
                                  env=env, capture_output=True, text=True)
            result["findings"] = (proc.stdout or proc.stderr).strip()[-300:]
    else:
        # A refused receipt is an integrity problem: block for a person, never reopen for a new lane.
        refused = status in REFUSED
        new_status = "blocked" if refused else "open"
        note = (f"Landing train {os.path.basename(train_dir)}: {status}. {detail} "
                + (f"Not landed. Checkout {item['sha'][:10]} retained for inspection; blocked."
                   if refused else
                   f"Candidate {item['sha'][:10]} kept as a bundle in the train directory. Reopened for a new lane."))
        proc = subprocess.run(["ntk", "update", "-W", config["workspace"], item["ticket"], "--force",
                               "-s", new_status, "-A", note[:300]], capture_output=True, text=True)
        if proc.returncode:  # A full body has no room for the note; the status matters more.
            proc = subprocess.run(["ntk", "update", "-W", config["workspace"], item["ticket"], "--force",
                                   "-s", new_status], capture_output=True, text=True)
        result["blocked" if refused else "reopened"] = proc.returncode == 0
        if proc.returncode:
            result["blocked_error" if refused else "reopen_error"] = (proc.stderr or proc.stdout)[-500:]
    # The worktree is not needed after landing; a reopened ticket needs it gone for a new lane.
    wt = item["host_worktree"]
    if os.path.isdir(wt):
        keep = status in REFUSED
        if keep:
            result["worktree_kept"] = wt
        if status != "landed":
            bundle = subprocess.run(["git", "-C", wt, "bundle", "create", "-q",
                                     os.path.join(train_dir, f"{item['ticket']}.bundle"), "HEAD"],
                                    capture_output=True, text=True)
            if bundle.returncode:
                # Without a bundle the checkout is the only copy of the candidate: keep it.
                keep = True
                result["bundle_error"] = (bundle.stderr or bundle.stdout)[-300:]
                result["worktree_kept"] = wt
        if not keep:
            shutil.rmtree(wt, ignore_errors=True)
    tmp = os.path.join(item["artifacts"], "train-result.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(result, fh, indent=2)
    os.replace(tmp, os.path.join(item["artifacts"], "train-result.json"))
    log(f"  {item['ticket']}: {status} {detail}")


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


@contextlib.contextmanager
def lane_scope(env, cwd):
    """Evaluate gates.py functions as the lane did: its environment and its checkout."""
    saved, here = dict(os.environ), os.getcwd()
    os.environ.update(env)
    os.chdir(cwd)
    try:
        yield
    finally:
        os.chdir(here)
        os.environ.clear()
        os.environ.update(saved)


def required_plan(config, item):
    """Recompute the plan the lane had to record, from the dispatcher config and the run artifacts."""
    env = {"gate_commands": json.dumps(config.get("gateCommands") or []),
           "ticket_test_command": json.dumps(config.get("testCommand") or []),
           "TRAIN_GATES_ONLY": "true" if item.get("checks_deferred") else "false",
           "VERIFY_ONLY": "false", "MEDULLA_RUN_DIR": item["run_dir"]}
    with lane_scope(env, item["host_worktree"]):
        return GATES.plan()


def check_receipt(config, item):
    """Verify a candidate's gate receipt against its request; return the receipt or raise ValueError."""
    for key in ("ticket", "sha", "tree", "target", "gate_receipt", "gate_receipt_sha256", "project_dir", "module"):
        if not isinstance(item.get(key), str) or not item[key]:
            raise ValueError(f"the request lacks {key}")
    repository = repository_dir(config, item)
    if not item["project_dir"].endswith("/" + repository):
        raise ValueError("the request repository and project_dir disagree")
    gates_dir = os.path.join(os.path.realpath(item["artifacts"]), "gates")
    path = os.path.realpath(item["gate_receipt"])
    if not path.startswith(gates_dir + os.sep):
        raise ValueError("the gate receipt is outside this run's artifacts")
    if sha256(path) != item["gate_receipt_sha256"]:
        raise ValueError("the gate receipt digest differs from the request")
    with open(path) as fh:
        receipt = json.load(fh)
    expected = {"task": item["ticket"], "tree": item["tree"], "repository": item["project_dir"],
                "module": item["module"], "run": os.path.realpath(item["run_dir"])}
    wrong = [key for key, value in expected.items() if receipt.get(key) != value]
    if wrong:
        raise ValueError(f"the gate receipt does not match the request: {', '.join(wrong)}")
    wt = item["host_worktree"]

    def at(*args):
        return subprocess.run(["git", "-C", wt, *args], capture_output=True, text=True, check=True).stdout.strip()
    try:
        if at("rev-parse", "HEAD") != item["sha"] or at("status", "--porcelain", "--untracked-files=normal"):
            raise ValueError("the candidate checkout changed after it was queued")
        if at("rev-parse", item["sha"] + "^{tree}") != receipt["tree"]:
            raise ValueError("the candidate commit tree differs from the receipt tree")
        if at("rev-parse", receipt["candidate_sha"] + "^{tree}") != receipt["tree"]:
            raise ValueError("the receipt candidate SHA does not identify its tree")
    except subprocess.CalledProcessError as error:
        raise ValueError(f"cannot read the candidate checkout: {(error.stderr or '').strip()[-200:]}")
    deferred = receipt.get("deferred") == "train"
    if deferred != bool(item.get("checks_deferred")):
        raise ValueError("the receipt mode (deferred or executed) differs from the request")
    commands = receipt.get("commands")
    if not isinstance(commands, list) or not commands:
        raise ValueError("the gate receipt has no plan")
    if deferred:
        if receipt.get("checks") or receipt.get("passed"):
            raise ValueError("a deferred receipt cannot carry results")
    else:
        checks = receipt.get("checks") or []
        if receipt.get("passed") is not True or len(checks) != len(commands):
            raise ValueError("the gate receipt is not a complete pass")
        folder = os.path.dirname(path)
        for command, check in zip(commands, checks):
            logfile = os.path.realpath(check.get("log") or "")
            if (check.get("command") != command or check.get("exit_code") != 0
                    or (isinstance(command, dict) and check.get("stdout_matches") is not True)
                    or not logfile.startswith(folder + os.sep) or not os.path.isfile(logfile)
                    or sha256(logfile) != check.get("sha256")):
                raise ValueError("a gate result or log does not match the receipt")
    try:
        required = required_plan(config, item)
    except (OSError, ValueError, KeyError) as error:
        raise ValueError(f"cannot rebuild the required plan: {error}")
    if commands != required:
        raise ValueError("the receipt plan differs from the required plan (gates, ticket and coder checks)")
    return receipt


def verified(config, items, train_dir):
    """Keep candidates whose receipt verifies; refuse the rest explicitly."""
    keep = []
    for item in items:
        try:
            item["receipt"] = check_receipt(config, item)
        except (OSError, ValueError, KeyError, TypeError) as error:
            finish(config, item, "receipt_refused", f"Gate receipt refused: {error}.", train_dir)
            continue
        keep.append(item)
    return keep


def snapshot(box):
    """The integrated candidate as it stood before any gate ran."""
    return {"head": box.sh("git rev-parse HEAD").stdout.strip(),
            "tree": box.sh("git rev-parse HEAD^{tree}").stdout.strip()}


def unchanged(box, before):
    status = box.sh("git status --porcelain --untracked-files=normal")
    return (status.returncode == 0 and not status.stdout.strip()
            and box.sh("git rev-parse HEAD").stdout.strip() == before["head"])


def train_receipt(config, train_dir, depth, items, target, base, ok, failed, gate_log, before, plan, results,
                  carried=()):
    """Bind every check result to the integrated candidate captured before the checks ran."""
    receipt = {"schema": 2, "target": target, "base": base, "integrated_head": before["head"],
               "integrated_tree": before["tree"],
               "gate_commands": config["train"]["gateCommands"], "plan": plan, "checks": results,
               "carried": [{"command": command, "owner": ticket, "landed": True} for command, ticket in carried],
               "passed": ok, "failed_command": failed or None, "gate_log": gate_log,
               "candidates": [{**{k: item.get(k) for k in ("ticket", "sha", "tree", "gate_receipt",
                                                           "gate_receipt_sha256", "checks_deferred",
                                                           "repository", "project_dir", "module")},
                               "receipt_verified": True}
                              for item in items]}
    path = os.path.join(train_dir, f"receipt-{depth}-{items[0]['ticket']}.json")
    with open(path, "w") as fh:
        json.dump(receipt, fh, indent=2)
    return path


def retry_to_test(config):
    """A landed candidate whose to_test transition failed is retried, never forgotten."""
    for path in glob.glob(os.path.join(config["scopeDir"], "runs", "*", "lane", "*", "artifacts", "train-result.json")):
        try:
            with open(path) as fh:
                result = json.load(fh)
        except (OSError, ValueError):
            continue
        if result.get("status") != "landed" or result.get("to_test") is not False:
            continue
        art = os.path.dirname(path)
        with open(os.path.join(art, "train-request.json")) as fh:
            ticket = json.load(fh)["ticket"]
        env = {**os.environ, "ticket_id": ticket, "project_name": config["workspace"],
               "MEDULLA_RUN_DIR": os.path.dirname(art)}
        proc = subprocess.run(["node", os.path.join(TOOLING, "lane", "bin", "ticket-outcome.mjs"), "to-test"],
                              env=env, capture_output=True, text=True)
        result["to_test"] = proc.returncode == 0
        result["to_test_retried_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if proc.returncode:
            result["to_test_error"] = (proc.stderr or proc.stdout)[-500:]
        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(result, fh, indent=2)
        os.replace(tmp, path)
        log(f"  {ticket}: to_test retry {'ok' if proc.returncode == 0 else 'failed'}")


def land(config, items, train_dir, depth=0, carried=()):
    """Land items together; split on a gate failure. Return the items that landed.

    When a failed batch is split, every candidate that lands from it leaves its plan as
    an obligation (carried) for each later subset of that batch, so a later candidate
    cannot land over a check an earlier one passed only without it.
    """
    carried = list(carried)
    items = verified(config, items, train_dir)
    if not items:
        return []
    repos = {item["repository"] for item in items}
    if len(repos) != 1:
        raise RuntimeError(f"a train must hold one repository, got {sorted(repos)}")
    repo = repos.pop()
    logfile = os.path.join(train_dir, f"git-{depth}-{items[0]['ticket']}.log")
    work = os.path.join(train_dir, "work")
    os.makedirs(work, exist_ok=True)
    box = Box(config, work)
    try:
        for attempt in range(3):
            target, base = prepare(box, config, repo, logfile)
            log(f"train of {len(items)} in {repo} on {target}@{base[:10]}: {' '.join(i['ticket'] for i in items)}")
            applied = []
            for item in items:
                if item["target"] != target:
                    finish(config, item, "receipt_refused",
                           f"Gate receipt refused: the request targets {item['target']}, the repository {target}.",
                           train_dir)
                    continue
                state, detail = apply(box, item, target, logfile)
                if state == "ok":
                    applied.append(item)
                else:
                    finish(config, item, state, f"Files: {detail}" if state == "conflict" else detail, train_dir)
            items = applied
            if not items:
                return []
            gate_log = os.path.join(train_dir, f"gates-{depth}-{items[0]['ticket']}.log")
            before = snapshot(box)
            plan = train_plan(config, items, carried)
            ok, failed, results = run_plan(box, plan, gate_log)
            if ok and not unchanged(box, before):
                # A gate that edits tracked files or commits must not decide what lands.
                ok, failed = False, "a gate changed the integrated candidate (HEAD, tracked or new files)"
            receipt = train_receipt(config, train_dir, depth, items, target, base, ok, failed, gate_log, before,
                                    plan, results, carried)
            if not ok:
                break
            if DRY:
                log(f"DRY: gates passed for {len(items)}; no push")
                return []
            state, sha = push(box, target, logfile)
            if state == "ok":
                log(f"landed {len(items)} on {target} at {sha[:10]}")
                for item in items:
                    finish(config, item, "landed", f"{target}@{sha}; train receipt {receipt}", train_dir)
                return items
            if state != "moved":
                raise TrainDeferred(f"push failed: {sha.splitlines()[-1] if sha else ''}; see {logfile}")
            log(f"{target} moved during the gates; rebuilding the train")
        else:
            raise RuntimeError(f"{target} kept moving; train stopped")
    finally:
        box.close()
    if len(items) == 1:
        # Alone on the integrated tree, this candidate is the evidence for its own failure.
        finish(config, items[0], "gate_failed",
               f"Gate failed alone on {target}@{base[:10]}: {failed}"
               + (f" (carried from landed {', '.join(sorted({t for _, t in carried}))})" if carried else "")
               + f". Log: {gate_log}. Receipt: {receipt}", train_dir)
        return []
    half = len(items) // 2
    log(f"gate failed on {len(items)}: splitting {half}+{len(items) - half}")
    first = land(config, items[:half], train_dir, depth + 1, carried)
    second = land(config, items[half:], train_dir, depth + 1, carried + obligations(first))
    return first + second


def land_queue(config, rows, train_dir):
    """One train per repository, oldest request first; a batch never mixes repositories."""
    groups = {}
    for row in rows:
        key = row.get("repository") if isinstance(row.get("repository"), str) else ""
        groups.setdefault(key, []).append(row)
    for group in groups.values():
        land(config, group, train_dir)


def main(argv):
    path = os.path.join(HERE, "dolber.json")
    once = False
    for arg in argv:
        if arg == "--once":
            once = True
        elif arg == "--dry-run":
            global DRY
            DRY = once = True
        elif arg in ("-h", "--help"):
            print(__doc__)
            return
        else:
            path = os.path.abspath(arg)
    config = load_config(path)
    os.makedirs(config["trainDir"], exist_ok=True)
    lock = os.path.join(config["trainDir"], "lock")
    try:
        os.mkdir(lock)
    except FileExistsError:
        sys.exit(f"train.py: lock exists: {lock}; remove it only after the old lander stopped")
    with open(os.path.join(lock, "owner.json"), "w") as fh:
        json.dump({"pid": os.getpid(), "started_at": dt.datetime.now().isoformat()}, fh)
    try:
        while True:
            if not DRY:
                retry_to_test(config)
            rows = queued(config)
            if due(config, rows):
                train_dir = os.path.join(config["trainDir"], dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
                os.makedirs(train_dir)
                with open(os.path.join(train_dir, "manifest.json"), "w") as fh:
                    json.dump(rows, fh, indent=2)
                try:
                    land_queue(config, rows, train_dir)
                except TrainDeferred as error:
                    # Nothing landed and no result was written: the queue is intact.
                    log(f"TRAIN DEFERRED: {error}")
                except Exception as error:  # noqa: BLE001 - keep the queue, report, stop
                    log(f"TRAIN STOPPED: {error}")
                    raise
            elif rows:
                log(f"waiting: {len(rows)} queued ({' '.join(r['ticket'] for r in rows)})")
            if once:
                return
            time.sleep(config["train"]["intervalSeconds"])
    finally:
        shutil.rmtree(lock, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv[1:])
