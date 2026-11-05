"""The narrow allowlist of planning failures that Crew can retry automatically.

Crew classifies its own failure reason when it releases the claim. An unknown reason stays manual."""
import re

# class: (pattern on Crew's own failure reason, why a retry with the same input can pass)
ALLOWLIST = {
    "AGENT_INCOMPLETE": (re.compile(r"agent did not complete successfully"),
                         "An agent process exited before its report, so a researcher or reviewer gave no report."),
    # Only the verified busy, timeout and source-drift signals. A missing executable or a bad project stays manual.
    "CBM_UNAVAILABLE": (re.compile(r"CBM daemon is active or starting but could not accept this client"
                                   r"|another index operation for this project is active"
                                   r"|codebase-memory-mcp'[^\n]*\]' timed out after \d+ seconds"
                                   r"|source changed during the CBM refresh"),
                        "The shared code index daemon was busy or slow, or the source moved during its refresh."),
    "MCP_STARTUP": (re.compile(r"post hook vetoed the attempt.*(\"initialize\"|protocolVersion|notifications/initialized)",
                               re.S),
                    "The reader MCP connector failed during its startup handshake."),
}
# A reason with one of these parts is a decision about the input. A retry with the same input repeats it.
STRUCTURAL = re.compile(r"critic rejected|research blocked|Required owner decision|validation|joppa_batch|"
                        r"claim refused|needs a new contract", re.I)


def classify(reason, code, critic=None):
    """The allowlisted class of one failure, or None. Only the generic code with a known transient reason qualifies.
    A critic rejection or a structural part anywhere in the reason never qualifies."""
    if critic is not None or code != "PLANNING_FAILED" or not isinstance(reason, str) or STRUCTURAL.search(reason):
        return None
    for name, (pattern, _) in ALLOWLIST.items():
        if pattern.search(reason):
            return name
    return None
