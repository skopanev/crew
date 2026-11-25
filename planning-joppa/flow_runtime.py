"""Release a configured flow claim after its Medulla process has stopped."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading

from common import read, write
from stdio import group_alive
from mcp import Joppa
import flow_publication
from flow_recovery import observe_release

STOP_SECONDS = 10
RELEASE_SECONDS = 30


def release(config, folder, reason, stopped):
    target = folder / "artifacts"
    result_file = target / "result.json"
    prior = read(result_file) if result_file.exists() else {}
    if prior.get("claim_released") is True or not (target / "claim.json").exists():
        return
    try:
        if not stopped:
            raise ValueError("Medulla shutdown was not confirmed; claim retained")
        def timeout(number, frame):
            raise TimeoutError("Flow claim release exceeded its 30 s budget")
        previous = signal.signal(signal.SIGALRM, timeout)
        signal.alarm(RELEASE_SECONDS)
        try:
            api = Joppa(config["url"], config.get("token_file"), config.get("mcp_command"))
            try:
                if not observe_release(api, config, target):
                    flow_publication.fail(api, config, target, reason)
            finally:
                if api.stdio:
                    api.stdio.close()
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
    except Exception as error:
        write(result_file, {**prior, "status": "blocked", "reason": reason, "release_error": str(error),
              "claim_released": False, "needs_recovery": True, "acceptance_verified": False})
        print("flow claim needs recovery: " + str(error), file=sys.stderr)


def execute(command, env, cwd, config):
    child, folder, timer = None, None, None
    stopped, forced, finished = 0, False, False
    root = Path(config["runs_folder"]).resolve()

    def send(number):
        if child is not None:
            try:
                os.killpg(child.pid, number)
            except ProcessLookupError:
                pass

    def force():
        nonlocal forced
        forced = True
        send(signal.SIGKILL)

    def stop(number, frame):
        nonlocal stopped, timer
        if stopped:
            return
        stopped = number
        if finished:
            return
        send(signal.SIGTERM)
        timer = threading.Timer(STOP_SECONDS, force)
        timer.daemon = True
        timer.start()

    previous = {number: signal.signal(number, stop) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        child = subprocess.Popen(command, env=env, cwd=cwd, stdout=subprocess.PIPE,
                                 text=True, start_new_session=True)
        if stopped:
            send(signal.SIGTERM)
        with child.stdout:
            for line in child.stdout:
                if folder is None:
                    candidate = Path(line.strip())
                    if candidate.is_absolute() and candidate.is_dir() and candidate.resolve().parent == root:
                        folder = candidate.resolve()
                print(line, end="", flush=True)
        code = child.wait()
        finished = True
        if timer:
            timer.cancel()
            timer.join()
        if folder:
            reason = "Configured workflow interrupted" if stopped or code in (130, 143, -2, -15) else \
                     f"Configured workflow exited {code} before it confirmed claim release"
            release(config, folder, reason, not forced and not group_alive(child.pid))
        return (128 + stopped) if stopped else code
    finally:
        if timer:
            timer.cancel()
        for number, handler in previous.items():
            signal.signal(number, handler)
