"""Authenticated MCP calls for the separate Joppa planner."""
import json
import sys
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
    def __init__(self, url, token_file=None, mcp_command=None):
        parsed = urlsplit(url)
        local = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
        if not (parsed.scheme == "https" or local) or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise MCPError("Joppa needs HTTPS or loopback HTTP, without URL credentials")
        self.url = url
        self.stdio = None
        self.token = ""
        if mcp_command is not None:
            from stdio import StdioRPC
            self.stdio = StdioRPC(mcp_command)
        else:
            self.token = Path(token_file).expanduser().read_text().strip()
        if not self.stdio and not self.token:
            raise MCPError("Joppa token file is empty")
        self.opener = build_opener(NoRedirect)
        self.sequence = 0
        self.session = None
        result = self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                          "clientInfo": {"name": "crew-planning-joppa", "version": "1"}})
        self.protocol = result.get("protocolVersion", "2025-03-26")
        self.rpc("notifications/initialized", {}, notification=True)

    def rpc(self, method, params, notification=False):
        if self.stdio:
            return self.stdio.request(method, params, notification)
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
            if self.token:
                detail = detail.replace(self.token, "[credential]")
            detail = detail.replace("\n", " ")[:2000]
            raise Rejected(f"Joppa {name}: {detail}")
        if not isinstance(structured, dict):
            raise MCPError(f"Joppa {name} returned no object")
        # Compact detail reads omit values that repeat the address or the current revision.
        address = arguments.get("address") if name == "joppa_objects" else None
        if (isinstance(address, str) and isinstance(structured.get("document"), dict)
                and not any(arguments.get(key) for key in ("revision", "history", "comments_cursor", "links_cursor"))):
            structured.setdefault("kind", address.split(":")[0])
            structured.setdefault("historical", False)
            if isinstance(structured.get("current_revision"), int):
                structured.setdefault("contract_revision", structured["current_revision"])
        return structured


READ_TOOLS = frozenset(("joppa_search", "joppa_read", "joppa_tests", "joppa_tree",
                        "joppa_objects", "joppa_tasks", "joppa_model_docs", "joppa_help"))


class Reader:
    """Expose workspace reads to agents. Keep publication in the workflow."""
    def __init__(self, api, workspace, target):
        self.api, self.workspace, self.target = api, workspace, target

    def tools(self):
        tools = []
        for tool in self.api.tools():
            if tool["name"] not in READ_TOOLS:
                continue
            tool = dict(tool)
            tool["annotations"] = {**tool.get("annotations", {}), "readOnlyHint": True, "destructiveHint": False}
            schema = tool["inputSchema"]
            if "workspace" in schema.get("properties", {}):
                tool["inputSchema"] = {**schema, "properties": {**schema["properties"],
                    "workspace": {"type": "string", "default": self.workspace}}}
            tools.append(tool)
        return tools

    def call(self, name, arguments):
        if name not in READ_TOOLS:
            raise MCPError("The planning reader does not permit this tool")
        if not isinstance(arguments, dict):
            raise MCPError("Tool arguments must be an object")
        args = dict(arguments)
        if args.get("item_id"):
            raise MCPError("Use workspace and a full object address instead of item_id")
        if name != "joppa_model_docs":
            args.setdefault("workspace", self.workspace)
        address = args.get("address") if name == "joppa_objects" else (
            args.get("target") or args.get("req")) if name == "joppa_read" else None
        if address and ":" not in address:
            raise MCPError("Use a full kind:id object address")
        result = self.api.call(name, args)
        if self.target is not None and address and not args.get("revision") and not args.get("history"):
            import context
            obj = result if name == "joppa_objects" else context.object_read(self.api, args["workspace"], address)
            context.capture_object(self.target, args["workspace"], obj, self.api)
        return result


def serve(reader, input_stream=sys.stdin, output_stream=sys.stdout):
    """Serve the MCP stdio protocol without forwarding mutation methods."""
    for line in input_stream:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            output_stream.write(json.dumps({"jsonrpc": "2.0", "id": None,
                "error": {"code": -32700, "message": "Invalid JSON"}}) + "\n")
            output_stream.flush()
            continue
        if not isinstance(request, dict):
            output_stream.write(json.dumps({"jsonrpc": "2.0", "id": None,
                "error": {"code": -32600, "message": "Request must be an object"}}) + "\n")
            output_stream.flush()
            continue
        if "id" not in request:
            continue
        response = {"jsonrpc": "2.0", "id": request["id"]}
        method, params = request.get("method"), request.get("params", {})
        try:
            if not isinstance(params, dict):
                raise MCPError("Request params must be an object")
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion", "2025-03-26"),
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "crew-joppa-reader", "version": "1"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": reader.tools()}
            elif method == "tools/call":
                value = reader.call(params["name"], params.get("arguments", {}))
                result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                          "structuredContent": value}
            else:
                raise MCPError("The planning reader does not support this method")
            response["result"] = result
        except (MCPError, ValueError, KeyError, OSError) as error:
            if method == "tools/call":
                response["result"] = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
            else:
                response["error"] = {"code": -32601, "message": str(error)}
        output_stream.write(json.dumps(response, ensure_ascii=False) + "\n")
        output_stream.flush()


if __name__ == "__main__":
    import argparse
    from stdio import install_sigterm_exit
    install_sigterm_exit()
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "planning"))
    parser = argparse.ArgumentParser(description="Read the configured Joppa workspace through MCP stdio.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--workspace", required=True)
    credentials = parser.add_mutually_exclusive_group(required=True)
    credentials.add_argument("--token-file")
    credentials.add_argument("--mcp-command", type=json.loads)
    parser.add_argument("--artifacts")
    args = parser.parse_args()
    try:
        serve(Reader(Joppa(args.url, args.token_file, args.mcp_command), args.workspace,
                     Path(args.artifacts) if args.artifacts else None))
    except (MCPError, ValueError, OSError) as error:
        print("Joppa reader: " + str(error), file=sys.stderr)
        sys.exit(1)
