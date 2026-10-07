#!/usr/bin/env python3
"""Landing train: land queued lane candidates in batches with one gate run.

Lanes started with "train" in dolber.json stop after review and checks and
queue their candidate (artifacts/train-request.json). Their worktree is
retained. This lander is the only writer to the target branch:

1. Wait until the queue holds train.size candidates, the oldest one waited
   train.waitSeconds, or no lane is running.
2. Apply each candidate's commits onto a fresh target in one integration
   clone. A conflicting candidate leaves the train and is reopened.
3. Run train.gateCommands once on the combined tree.
4. Pass: push, move every ticket to to_test, remove the lane worktrees.
   Fail: split the train in halves and land each half again; a single failing
   candidate is reopened with the gate log.

Git and the gates run inside one container of the lane image, with the lane's
mounts, so the train checks the same environment as the lanes.

usage: train.py [dolber.json] [--once] [--dry-run]

--dry-run builds the train and runs the gates, then stops: no push, no
ticket change, no worktree removal, no result file.
"""
import datetime as dt
import glob
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


class Box:
    """One lane-image container holding the integration clone."""

    def __init__(self, config, work):
        self.config, self.work = config, work
        source = os.path.realpath(config["sourceRoot"])
        mounts = [(source, f"/workspace/{os.path.basename(source)}", "ro"),
                  (work, "/workspace/train", "rw"),
                  (os.path.realpath(config["sshDir"]), "/workspace/lane-ssh", "ro")]
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


def project_repo(config):
    """The repository the lanes work in: the single repo under sourceRoot."""
    module = config.get("module") or ""
    repos = [d for d in os.listdir(config["sourceRoot"])
             if not d.startswith(".") and os.path.isdir(os.path.join(config["sourceRoot"], d, ".git"))]
    if module and module.split("/")[0] in repos:
        return module.split("/")[0]
    if len(repos) != 1:
        sys.exit(f"train.py: expected one repository under sourceRoot, found {repos}")
    return repos[0]


def prepare(box, config, logfile):
    repo = project_repo(config)
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
if [ -d /workspace/gradle-cache/caches ] && [ ! -d "$HOME/.gradle/caches" ]; then
  mkdir -p "$HOME/.gradle" && cp -a /workspace/gradle-cache/. "$HOME/.gradle/" && rm -rf "$HOME/.gradle/daemon"
fi
echo "$target $(git rev-parse HEAD)"
"""
    proc = box.sh(script, logfile, cwd="/workspace/train")
    if proc.returncode:
        raise RuntimeError(f"integration setup failed; see {logfile}")
    target, base = proc.stdout.split()[-2:]
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


def run_gates(box, config, logfile):
    for i, command in enumerate(config["train"]["gateCommands"], 1):
        log(f"  gate {i}: {command}")
        started = time.time()
        proc = box.sh(command, logfile, timeout=5400)
        log(f"  gate {i}: rc={proc.returncode} in {time.time() - started:.0f}s")
        if proc.returncode:
            return False, command
    return True, ""


def push(box, target, logfile):
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
    else:
        note = (f"Landing train {os.path.basename(train_dir)}: {status}. {detail} "
                f"Candidate {item['sha'][:10]} kept as a bundle in the train directory. Reopened for a new lane.")
        proc = subprocess.run(["ntk", "update", "-W", config["workspace"], item["ticket"], "--force",
                               "-s", "open", "-A", note[:300]], capture_output=True, text=True)
        if proc.returncode:  # A full body has no room for the note; the status matters more.
            proc = subprocess.run(["ntk", "update", "-W", config["workspace"], item["ticket"], "--force",
                                   "-s", "open"], capture_output=True, text=True)
        result["reopened"] = proc.returncode == 0
        if proc.returncode:
            result["reopen_error"] = (proc.stderr or proc.stdout)[-500:]
    # The worktree is not needed after landing; a reopened ticket needs it gone for a new lane.
    wt = item["host_worktree"]
    if os.path.isdir(wt):
        if status != "landed":
            subprocess.run(["git", "-C", wt, "bundle", "create", "-q",
                            os.path.join(train_dir, f"{item['ticket']}.bundle"), "HEAD"], capture_output=True)
        shutil.rmtree(wt, ignore_errors=True)
    tmp = os.path.join(item["artifacts"], "train-result.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(result, fh, indent=2)
    os.replace(tmp, os.path.join(item["artifacts"], "train-result.json"))
    log(f"  {item['ticket']}: {status} {detail}")


def land(config, items, train_dir, depth=0):
    """Land items together; split on a gate failure."""
    logfile = os.path.join(train_dir, f"git-{depth}-{items[0]['ticket']}.log")
    work = os.path.join(train_dir, "work")
    os.makedirs(work, exist_ok=True)
    box = Box(config, work)
    try:
        for attempt in range(3):
            target, base = prepare(box, config, logfile)
            log(f"train of {len(items)} on {target}@{base[:10]}: {' '.join(i['ticket'] for i in items)}")
            applied = []
            for item in items:
                state, detail = apply(box, item, target, logfile)
                if state == "ok":
                    applied.append(item)
                else:
                    finish(config, item, state, f"Files: {detail}" if state == "conflict" else detail, train_dir)
            items = applied
            if not items:
                return
            gate_log = os.path.join(train_dir, f"gates-{depth}-{items[0]['ticket']}.log")
            ok, failed = run_gates(box, config, gate_log)
            if not ok:
                break
            if DRY:
                log(f"DRY: gates passed for {len(items)}; no push")
                return
            state, sha = push(box, target, logfile)
            if state == "ok":
                log(f"landed {len(items)} on {target} at {sha[:10]}")
                for item in items:
                    finish(config, item, "landed", f"{target}@{sha}", train_dir)
                return
            if state != "moved":
                raise RuntimeError(f"push failed: {sha}; see {logfile}")
            log(f"{target} moved during the gates; rebuilding the train")
        else:
            raise RuntimeError(f"{target} kept moving; train stopped")
    finally:
        box.close()
    if len(items) == 1:
        finish(config, items[0], "gate_failed", f"Gate failed: {failed}. Log: {gate_log}", train_dir)
        return
    half = len(items) // 2
    log(f"gate failed on {len(items)}: splitting {half}+{len(items) - half}")
    land(config, items[:half], train_dir, depth + 1)
    land(config, items[half:], train_dir, depth + 1)


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
            rows = queued(config)
            if due(config, rows):
                train_dir = os.path.join(config["trainDir"], dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
                os.makedirs(train_dir)
                with open(os.path.join(train_dir, "manifest.json"), "w") as fh:
                    json.dump(rows, fh, indent=2)
                try:
                    land(config, rows, train_dir)
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
