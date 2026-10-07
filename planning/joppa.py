"""Read-only client for Joppa's authenticated HTTPS MCP endpoint."""
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from common import require


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Joppa:
    def __init__(self):
        self.url = os.environ.get("JOPPA_MCP_URL", "")
        parsed = urlsplit(self.url)
        require(parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")),
                "JOPPA_MCP_URL must be an HTTPS endpoint (HTTP allowed only on loopback)")
        require(not (parsed.username or parsed.password or parsed.query or parsed.fragment), "invalid JOPPA_MCP_URL")
        self.token = os.environ.get("JOPPA_TOKEN", "")
        token_file = os.environ.get("JOPPA_TOKEN_FILE")
        if not self.token and token_file:
            self.token = Path(token_file).expanduser().read_text().strip()
        require(self.token, "JOPPA_TOKEN_FILE or JOPPA_TOKEN is required for unattended MCP reads")
        self.opener = build_opener(NoRedirect)
        self.sequence = 0
        self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                "clientInfo": {"name": "crew-planning", "version": "1"}})

    def rpc(self, method, params):
        self.sequence += 1
        request = Request(self.url, data=json.dumps({"jsonrpc": "2.0", "id": self.sequence,
                          "method": method, "params": params}).encode(),
                          headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json",
                                   "Accept": "application/json, text/event-stream"})
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
            require(len(raw) <= 8 * 1024 * 1024, "Joppa response exceeds size limit")
            message = json.loads(raw)
        except HTTPError as exc:
            raise ValueError(f"Joppa MCP HTTP {exc.code}; live state could not be read") from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise ValueError("Joppa MCP is unavailable or returned invalid JSON") from None
        require(isinstance(message, dict) and message.get("id") == self.sequence, "invalid Joppa MCP response")
        require("error" not in message and "result" in message, "Joppa MCP request failed")
        return message["result"]

    def read(self, **arguments):
        return self.call("joppa_read", arguments)

    def objects(self, **arguments):
        return self.call("joppa_objects", arguments)

    def call(self, name, arguments):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        require(isinstance(result, dict) and not result.get("isError"), "Joppa read failed")
        if isinstance(result.get("structuredContent"), dict):
            return result["structuredContent"]
        content = [c["text"] for c in result.get("content", []) if c.get("type") == "text"]
        require(len(content) == 1, "invalid Joppa read content")
        data = json.loads(content[0])
        require(isinstance(data, dict), "invalid Joppa read object")
        return data
