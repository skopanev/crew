#!/usr/bin/env python3
"""Check the shared CBM through the same stdio connector used by lane agents."""
import json
import os
import select
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def session(connector, image=None):
    command = [sys.executable, connector]
    if image:
        connector = str(Path(connector).resolve(strict=True))
        directory = str(Path(connector).parent)
        command = ['docker', 'run', '--rm', '-i', '--entrypoint', 'python3',
                   '--add-host=host.docker.internal:host-gateway',
                   '-v', f'{directory}:{directory}:ro', image, connector]
    process = subprocess.Popen(command, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE)
    buffer = b""
    request_id = 0

    def send(message):
        process.stdin.write(json.dumps({"jsonrpc": "2.0", **message}).encode() + b"\n")
        process.stdin.flush()

    def call(method, params, timeout=30):
        nonlocal buffer, request_id
        request_id += 1
        send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            if b"\n" not in buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                    raise RuntimeError(f"shared CBM timed out during {method}")
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError(f"shared CBM disconnected during {method}")
                buffer += chunk
                continue
            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue
            reply = json.loads(line)
            if reply.get("id") != request_id:
                continue
            if reply.get("error") or reply.get("result", {}).get("isError"):
                raise RuntimeError(f"shared CBM refused {method}: {reply.get('error') or reply['result']}")
            return reply["result"]

    try:
        call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                            "clientInfo": {"name": "crew-lane-preflight", "version": "1"}})
        send({"method": "notifications/initialized"})
        yield call
    finally:
        process.stdin.close()
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()


def probe(connector, projects):
    with session(connector) as call:
        available = {tool["name"] for tool in call("tools/list", {}).get("tools", [])}
        missing = {"search_code", "search_graph"} - available
        if missing:
            raise RuntimeError(f"shared CBM lacks tools: {', '.join(sorted(missing))}")
        for project in projects:
            call("tools/call", {"name": "search_code", "arguments": {
                "project": project, "pattern": "import", "mode": "files", "max_results": 1}})
            print(f"shared CBM: {project} responds; search_code and search_graph available")


if __name__ == "__main__":
    try:
        probe(sys.argv[1], sys.argv[2:])
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"CBM preflight: {error}", file=sys.stderr)
        sys.exit(2)
