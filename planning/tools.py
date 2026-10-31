"""Local tool setup for planning: CBM registry reads and isolated OpenCode/AGY profiles."""
import json
import os
from pathlib import Path
import subprocess

from common import read, require, run, write


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
    mcp = {name: {"type": "local", "command": [server["command"], *server["args"]], "enabled": True}
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
    if os.environ["MEDULLA_HARNESS"] == "agy":
        prepare_agy()


def prepare_agy(mcp_servers=None):
    """Verify the native MCP inventory in a private broker profile."""
    root = Path(os.environ["AGY_PROFILE_HOME"])
    require(root.is_dir(), "AGY runtime profile directory is unavailable")
    config = root / ".gemini/config/mcp_config.json"
    installed = read(config).get("mcpServers", {}) if config.is_file() else {}
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
