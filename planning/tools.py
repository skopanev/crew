"""Local tool setup for planning: CBM registry reads and isolated OpenCode/AGY profiles."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import validation

from common import fingerprint, read, require, run, write

REFRESH_SECONDS = 240
LOCK_POLL_SECONDS = 0.2


def indexed_projects():
    """Read the shared index registry without starting an indexer."""
    rows, offset = [], 0
    while True:
        projects = json.loads(run([os.environ["CBM_BIN"], "cli", "--json", "list_projects",
                                  "--format", "json", "--offset", str(offset)]))
        if isinstance(projects, dict) and "content" in projects:
            require(not projects.get("isError"), "CBM registry query failed")
            projects = projects.get("structuredContent") or json.loads(next(
                block["text"] for block in projects["content"] if block.get("type") == "text"))
        rows.extend(projects if isinstance(projects, list) else projects.get("projects", []))
        if isinstance(projects, list) or not projects.get("has_more"):
            return rows
        next_offset = projects.get("next_offset")
        require(type(next_offset) is int and next_offset > offset, "CBM pagination did not advance")
        offset = next_offset


def cbm_result(tool, *flags, timeout=45):
    """Run one CBM CLI tool and return its JSON object result. Keep CBM's error text on failure."""
    try:
        reply = json.loads(run([os.environ["CBM_BIN"], "cli", "--json", tool, *flags], timeout=timeout))
    except subprocess.TimeoutExpired:
        raise ValueError(f"CBM {tool} did not finish within {timeout:.0f} s") from None
    require(isinstance(reply, dict), f"CBM {tool} returned no result envelope")
    texts = [block.get("text") for block in reply.get("content") or [] if block.get("type") == "text"]
    require(not reply.get("isError"), f"CBM {tool} failed: {' '.join(map(str, texts)) or 'no error text'}")
    result = reply.get("structuredContent")
    if not isinstance(result, dict):
        require(bool(texts) and isinstance(texts[0], str), f"CBM {tool} returned no text result")
        result = json.loads(texts[0])
    require(isinstance(result, dict), f"CBM {tool} returned {result!r}")
    require("error" not in result, f"CBM {tool} failed: {result.get('error')}")
    return result


@contextmanager
def sync_lock(repo, root, deadline):
    """Hold the canonical clone lock that lane safe-sync takes. Never remove the shared file."""
    with open(os.path.join(root, ".git", "sync.lock"), "a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                require(remaining > 0, f"{repo['id']}: canonical sync lock stayed busy for the "
                        f"whole {REFRESH_SECONDS} s CBM refresh budget")
                time.sleep(min(LOCK_POLL_SECONDS, remaining))
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def refresh_index(repositories, rows):
    """Reindex each bound CBM project without a graph snapshot file. Return the fingerprint it indexed."""
    names = {row.get("name") for row in rows}
    for repo in repositories:
        name, root = repo["cbm_project"], os.path.realpath(repo["path"])
        require(name in names, f"{repo['id']}: CBM project {name} is absent from the index")
        require(any(row.get("name") == name and row.get("root_path") == root for row in rows),
                f"{repo['id']}: CBM project {name} is not bound to {root}")
    # One deadline for all CBM calls keeps prepare inside its 480 s node timeout.
    deadline = time.monotonic() + REFRESH_SECONDS
    def call(tool, repo, *flags):
        remaining = deadline - time.monotonic()
        require(remaining > 0, f"{repo['id']}: CBM refresh used its {REFRESH_SECONDS} s budget before {tool}")
        return cbm_result(tool, *flags, timeout=remaining)
    snapshots = {}
    for repo in repositories:
        name, root = repo["cbm_project"], os.path.realpath(repo["path"])
        # One repository lock at a time. The lock wait counts within the same deadline.
        with sync_lock(repo, root, deadline):
            before = fingerprint(repo)
            result = call("index_repository", repo, "--repo-path", root, "--name", name,
                          "--mode", "moderate", "--persistence", "false")
            require(result.get("project") == name, f"{repo['id']}: CBM did not index {name}: {result!r}")
            status = call("index_status", repo, "--project", name, "--format", "json")
            require(status.get("status") == "ready" and status.get("root_path") == root,
                    f"{repo['id']}: CBM project {name} is not ready at {root}: {status!r}")
            require(fingerprint(repo) == before, f"{repo['id']}: source changed during the CBM refresh")
        snapshots[repo["id"]] = before
    return snapshots


def prepare_opencode(read_paths, mcp_servers=None):
    """Keep provider settings in a private native config. Exclude inherited MCP."""
    source_env = {**os.environ, "OPENCODE_DISABLE_PROJECT_CONFIG": "true"}
    command = [os.environ.get("OPENCODE_BIN", "opencode"), "--pure", "debug", "config"]
    def query(environment, phase):
        result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=120)
        require(result.returncode == 0,
                f"OpenCode {phase} config query failed (exit {result.returncode}):\n"
                + (result.stderr.strip() or "OpenCode returned no error details on stderr"))
        return json.loads(result.stdout)
    source = query(source_env, "source")
    providers = source.get("provider", {})
    require(isinstance(providers, dict), "OpenCode provider configuration is invalid")
    root = Path(os.environ["OPENCODE_CONFIG_HOME"])
    require(root.is_dir(), "OpenCode runtime config directory is unavailable")
    directory = root / "opencode"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    file = directory / "opencode.json"
    external = {"*": "deny"}
    for value in read_paths:
        for candidate in (Path(value).expanduser().absolute(), Path(value).expanduser().resolve()):
            path = str(candidate)
            require(path != "/" and not any(char in path for char in "*?"), "OpenCode read path is too broad")
            external[path] = "allow"
            external[path.rstrip("/") + "/**"] = "allow"
    mcp = {name: {"type": "local", "command": [server["command"], *server["args"]], "enabled": True,
                  **({"environment": server["env"]} if server.get("env") else {})}
           for name, server in (mcp_servers or {}).items()}
    with os.fdopen(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        json.dump({"snapshot": False, "provider": providers, "permission": {"external_directory": external},
                   "mcp": mcp}, stream)
    read_only = {key: "deny" for key in ("edit", "write", "patch", "bash")}
    isolated_env = {**os.environ, "XDG_CONFIG_HOME": str(root),
                    "OPENCODE_CONFIG_DIR": str(directory), "OPENCODE_CONFIG": "",
                    "OPENCODE_CONFIG_CONTENT": json.dumps({"permission": read_only}), "OPENCODE_DISABLE_PROJECT_CONFIG": "true"}
    isolated = query(isolated_env, "isolated")
    require(isolated.get("snapshot") is False, "OpenCode snapshots remain enabled")
    require((isolated.get("mcp") or {}) == mcp, "OpenCode isolation failed: MCP inventory differs")
    require(isolated.get("provider", {}) == providers, "OpenCode isolation changed provider settings")
    permission = isolated.get("permission", {})
    require(permission.get("external_directory") == external and
            all(permission.get(key) == "deny" for key in read_only),
            "OpenCode isolation changed read-only permissions")
    return str(root)


def prepare_critic():
    role = os.environ.get("PLANNING_READER_ROLE")
    if not role:
        if os.environ["MEDULLA_HARNESS"] == "agy":
            prepare_agy()
        return
    require(role in ("research", "necessity", "design", "critic", "drift"), "unknown planning reader role")
    import stages as shared
    target = shared.artifacts()
    assignment = read(target / "assignment.json")
    seat = json.loads(os.environ.get("MEDULLA_INPUT") or "{}") if role in ("research", "critic", "drift") else {}
    require(isinstance(seat, dict), "planning reader seat must be an object")
    slug = seat.get("slug", role)
    require(slug in (*validation.RESEARCH, *validation.DRIFT_CRITICS,
                     "design"), "unknown planning reader seat")
    name = f"planning_{role}_{slug}"
    reference = target / f"{name}-reference.json"
    write(reference, {"role": role, "perspective": slug, "question": seat.get("question", ""),
                      "read_instruction": seat.get("read_instruction", ""),
                      "contract_role": "researcher" if role == "research" else
                                       "designer" if role == "design" else "critic"})
    files = [target / file for file in ("assignment.json", "input.json", "contracts.json", "history.json",
             "knowledge.json", "lessons.json", "snapshots.json", "cbm-projects.json", "output-contracts.json",
             f"{role}-rules.md")]
    files.append(reference)
    if role != "research":
        files.append(target / "research.json")
    if role in ("design", "critic", "drift"):
        files.append(target / "necessity.json")
    if role in ("critic", "drift"):
        files.append(target / "plan.json")
    if role == "design" and (target / "critique.json").is_file():
        files.append(target / "critique.json")
    if role == "drift":
        files.extend([target / "drift.json", target / "drift.diff"])
    roots = [str(Path(repo["path"]).absolute()) for repo in assignment["repositories"]]
    for path in read(target / "planning-read-paths.json"):
        if Path(path).is_dir():
            roots.append(path)
        else:
            files.append(Path(path))
    manifest = target / f"{name}-files.json"
    write(manifest, {"files": list(map(str, files)), "roots": roots})
    helper = os.environ.get("PLANNING_READER_HELPER") or str(
        Path(__file__).resolve().parent.parent / "planning-joppa/agent-reader.mjs")
    result = json.loads(run([os.environ.get("NODE_BIN", "node"), "--input-type=module", "-e", '''
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [manifest, helper, name, base, harness] = process.argv.slice(1);
const {prepare, prepareAgy, agentArgs} = await import(pathToFileURL(helper));
const result = prepare(name, JSON.parse(fs.readFileSync(manifest, 'utf8')), base);
if (harness === 'agy') prepareAgy(result.file, result.home);
console.log(JSON.stringify({...result, toml: agentArgs('codex', result.file).at(-1)}));
''', str(manifest), helper, name, str(target / "planning-base-mcp.json"), os.environ["MEDULLA_HARNESS"]], timeout=120))
    servers = read(result["file"])["mcpServers"]
    if os.environ["MEDULLA_HARNESS"] == "opencode":
        prepare_opencode([*roots, *map(str, files)], mcp_servers=servers)
    codex = os.environ["MEDULLA_HARNESS"] == "codex"
    for key, value in {"PLANNING_MCP_CONFIG": result["file"], "PLANNING_READER_HOME": result["home"],
                       "PLANNING_MCP_OPTION": "-c" if codex else "",
                       "PLANNING_MCP_TOML": result["toml"] if codex else "",
                       "PLANNING_MCP_TOOLS_OPTION": "--allowedTools",
                       "PLANNING_MCP_TOOLS": "mcp__joppa__*"}.items():
        shared.emit_var(key, value)


def prepare_agy(mcp_servers=None):
    """Verify the native MCP inventory in a private broker profile."""
    root = Path(os.environ["AGY_PROFILE_HOME"])
    require(root.is_dir(), "AGY runtime profile directory is unavailable")
    config = root / ".gemini/config/mcp_config.json"
    raw = config.read_text().strip() if config.is_file() else ""
    installed = json.loads(raw).get("mcpServers", {}) if raw else {}
    require(not installed or installed == (mcp_servers or {}),
            "AGY isolation failed: unexpected MCP remains")
    environment = {**os.environ, "BROKER_AGY_HOME": str(root), "BROKER_ISOLATE_MCP": "1"}
    result = subprocess.run([os.environ.get("AGY_BIN", "agy"), "mcp", "list"],
                            env=environment, capture_output=True, text=True, timeout=45)
    require(result.returncode == 0, f"AGY MCP query failed (exit {result.returncode})")
    require((installed and all(name in result.stdout for name in installed))
            or (not installed and result.stdout.strip() == "No MCP servers configured."),
            "AGY isolation failed: inherited MCP remains; update broker")
    require(config.parent.is_dir() and config.resolve().is_relative_to(root.resolve()),
            "AGY isolation failed: MCP configuration points outside the runtime profile; update broker")
    if mcp_servers:
        write(config, {"mcpServers": mcp_servers})
        config.chmod(0o600)
        result = subprocess.run([os.environ.get("AGY_BIN", "agy"), "mcp", "list"],
                                env=environment, capture_output=True, text=True, timeout=45)
        require(result.returncode == 0 and all(name in result.stdout for name in mcp_servers),
                "AGY did not load the configured planning MCP")
        require(read(config).get("mcpServers") == mcp_servers, "AGY changed the configured planning MCP")
