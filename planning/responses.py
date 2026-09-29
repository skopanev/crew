"""Final assistant deliveries from the four structured CLI event formats.

Tool output and incomplete streaming deltas cannot supply a planning result.
"""
import json

from common import require


def final_response(events, harness):
    if harness == "codex":
        messages = [e["item"].get("text", "") for e in events
                    if e.get("type") == "item.completed" and e.get("item", {}).get("type") == "agent_message"]
        require(messages, "no completed Codex response")
        message = messages[-1]
    elif harness == "claude-code":
        results = [e for e in events if e.get("type") == "result"]
        require(results and not results[-1].get("is_error"), "no successful Claude result")
        message = results[-1].get("result", "")
        if isinstance(message, dict):
            message = message.get("output", "")
    elif harness == "agy":
        results = [e.get("result", {}) for e in events if e.get("event") == "result"]
        require(results and results[-1].get("status") == "SUCCESS", "no successful Gemini result")
        message = results[-1].get("response", "")
    elif harness == "opencode":
        require(not any(e.get("type") == "error" for e in events), "OpenCode reported an error")
        parts = [e.get("part", {}) for e in events if e.get("type") == "text"]
        require(parts, "no OpenCode assistant text")
        key = parts[-1].get("messageID")
        # Group final assistant message parts; preceding tool/intermediate turns
        # cannot be mistaken for the final JSON delivery.
        message = "".join(p.get("text", "") for p in parts if p.get("messageID") == key) if key else parts[-1].get("text", "")
    else:
        raise ValueError(f"unsupported planning harness: {harness}")
    require(isinstance(message, str) and message.strip(), "empty assistant delivery")
    message = message.strip()
    if message.startswith("```json\n") and message.endswith("```"):
        message = message[8:-3].strip()
    result = json.loads(message)
    require(isinstance(result, dict), "agent response must be one JSON object")
    return result
