"""Call the configured host MCP command without reading its credentials."""
import atexit
import json
import os
import selectors
import subprocess
import time


def validate_command(command):
    if not isinstance(command, list) or not command or any(
            not isinstance(part, str) or not part.strip() or "\x00" in part for part in command):
        raise ValueError("mcp_command must contain an executable and its arguments")
    return command


class StdioRPC:
    def __init__(self, command):
        self.process = subprocess.Popen(validate_command(command), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.sequence = 0
        atexit.register(self.close)

    def request(self, method, params, notification=False):
        self.sequence += 1
        request = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            request["id"] = self.sequence
        try:
            self.process.stdin.write((json.dumps(request) + "\n").encode())
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            raise ValueError("Joppa MCP command disconnected") from None
        if notification:
            return None
        deadline = time.monotonic() + 120
        while True:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeError):
                    raise ValueError("Joppa MCP command returned invalid JSON") from None
                if not isinstance(message, dict):
                    raise ValueError("Joppa MCP command returned an invalid response")
                if "method" not in message and message.get("id") != self.sequence:
                    raise ValueError("Joppa returned a different MCP response")
                if message.get("id") == self.sequence and "method" not in message:
                    if "error" in message or "result" not in message:
                        raise ValueError("Joppa rejected the MCP operation")
                    return message["result"]
                if "method" in message and "id" in message:
                    reply = {"jsonrpc": "2.0", "id": message["id"]}
                    if message["method"] == "ping":
                        reply["result"] = {}
                    else:
                        reply["error"] = {"code": -32601, "message": "Client method is not supported"}
                    self.process.stdin.write((json.dumps(reply) + "\n").encode())
                    self.process.stdin.flush()
            left = deadline - time.monotonic()
            if left <= 0 or not self.selector.select(left):
                raise ValueError("Joppa MCP command timed out")
            part = os.read(self.process.stdout.fileno(), 65536)
            if not part:
                raise ValueError("Joppa MCP command disconnected")
            self.buffer += part
            if len(self.buffer) > 8 * 1024 * 1024:
                raise ValueError("Joppa response exceeds 8 MiB")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.selector.close()
        try:
            self.process.stdin.close()
        except OSError:
            pass
        self.process.stdout.close()
