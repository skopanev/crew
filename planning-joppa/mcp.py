"""Authenticated MCP calls for the separate Joppa planner."""
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class MCPError(ValueError):
    pass


class Rejected(MCPError):
    """The server confirmed that the tool operation failed."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        return None


class Joppa:
    def __init__(self, url, token_file):
        parsed = urlsplit(url)
        local = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
        if not (parsed.scheme == "https" or local) or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise MCPError("Joppa needs HTTPS or loopback HTTP, without URL credentials")
        self.url = url
        self.token = Path(token_file).expanduser().read_text().strip()
        if not self.token:
            raise MCPError("Joppa token file is empty")
        self.opener = build_opener(NoRedirect)
        self.sequence = 0
        self.session = None
        result = self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                          "clientInfo": {"name": "crew-planning-joppa", "version": "1"}})
        self.protocol = result.get("protocolVersion", "2025-03-26")
        self.rpc("notifications/initialized", {}, notification=True)

    def rpc(self, method, params, notification=False):
        self.sequence += 1
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            payload["id"] = self.sequence
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        if hasattr(self, "protocol"):
            headers["MCP-Protocol-Version"] = self.protocol
        request = Request(self.url, data=json.dumps(payload).encode(), headers=headers)
        try:
            with self.opener.open(request, timeout=30) as response:
                self.session = response.headers.get("Mcp-Session-Id", self.session)
                raw = response.read(8 * 1024 * 1024 + 1)
                content_type = response.headers.get("Content-Type", "")
            if len(raw) > 8 * 1024 * 1024:
                raise MCPError("Joppa response exceeds 8 MiB")
            if notification:
                return None
            if "text/event-stream" in content_type:
                messages = [json.loads("\n".join(line[5:].lstrip() for line in event.splitlines()
                            if line.startswith("data:"))) for event in raw.decode().replace("\r\n", "\n").split("\n\n")
                            if any(line.startswith("data:") for line in event.splitlines())]
                message = next((item for item in messages if isinstance(item, dict) and item.get("id") == self.sequence), None)
            else:
                message = json.loads(raw)
        except HTTPError as error:
            raise MCPError(f"Joppa MCP HTTP {error.code}") from None
        except (URLError, TimeoutError, OSError, UnicodeError, json.JSONDecodeError):
            raise MCPError("Joppa MCP transport failed") from None
        if not isinstance(message, dict) or message.get("id") != self.sequence:
            raise MCPError("Joppa returned a different MCP response")
        if "error" in message or "result" not in message:
            raise MCPError("Joppa rejected the MCP operation")
        return message["result"]

    def tools(self):
        return self.rpc("tools/list", {}).get("tools", [])

    def call(self, name, arguments):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict):
            raise MCPError("Joppa returned an invalid tool result")
        structured = result.get("structuredContent")
        if not isinstance(structured, dict):
            texts = [item["text"] for item in result.get("content", []) if item.get("type") == "text"]
            try:
                structured = json.loads(texts[0]) if len(texts) == 1 else None
            except json.JSONDecodeError:
                structured = None
        if result.get("isError"):
            detail = structured.get("error") if isinstance(structured, dict) else None
            if isinstance(detail, dict):
                detail = detail.get("message") or detail.get("code")
            if not isinstance(detail, str):
                detail = " ".join(item.get("text", "") for item in result.get("content", [])
                                  if item.get("type") == "text") or "TOOL_ERROR"
            detail = detail.replace(self.token, "[credential]").replace("\n", " ")[:2000]
            raise Rejected(f"Joppa {name}: {detail}")
        if not isinstance(structured, dict):
            raise MCPError(f"Joppa {name} returned no object")
        return structured
