"""The existing read-only MCP stdio protocol loop."""
import json
import sys
from joppa_reads import MCPError


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
