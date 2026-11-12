"""A bounded Joppa note from the final critic rejection of the current plan."""
import re
import sys

from common import digest, read, require
import validation
import planning_claims as claims

TEXT = 1000
FINDINGS = 3
FINDING_TEXT = 280
RUN_IN_TEXT = 200
# A Joppa identifier is ASCII [-_.A-Za-z0-9] of at most 120 bytes. note() appends "-" and 12 hex characters.
RUN_IN_ID = claims.NOTE_ID_BASE - len("crew-critic-") - len("-") - 12


def clip(value, limit):
    value = " ".join(value.split())
    return value if len(value) <= limit else value[:max(limit - 3, 0)].rstrip() + "..."


def build(target, rejection, grouped=False):
    """Return {"id", "text"}, or {"dropped": reason}. The optional note never stops the release."""
    try:
        return compose(target, rejection, grouped)
    except (OSError, ValueError) as error:
        return {"dropped": clip(f"critic verdicts unusable: {error}", 200)}
    except Exception as error:
        # A defect here must not block the save with the hold code. Report it and record it in release.json.
        print(f"critic note construction failed: {type(error).__name__}: {error}", file=sys.stderr)
        return {"dropped": clip(f"note construction failed: {type(error).__name__}: {error}", 200)}


def compose(target, rejection, grouped):
    """Every configured verdict must cover the plan digest that the rejection named. Blocking findings of any
    rejecting seat count. A missing or malformed verdict raises ValueError or OSError."""
    plan_digest = digest(read(target / "plan.json"))
    require(plan_digest == rejection.plan_digest, "critic rejection names a different plan")
    reviews = {key: read(target / f"critic-{key}.json") for key in validation.CRITICS}
    for review in reviews.values():
        validation.critique(review, plan_digest)
    queues = [[(key, finding) for finding in review["findings"] if finding["blocking"]]
              for key, review in reviews.items() if review["verdict"] == "reject"]
    # Alternate between rejecting seats so that each seat appears within the limit.
    findings = [queue[index] for index in range(max(map(len, queues), default=0))
                for queue in queues if index < len(queue)][:FINDINGS]
    require(findings, "no blocking critic finding")
    run = claims.run_id(target)
    lines = [f"Crew planning run {clip(run, RUN_IN_TEXT)} stopped: critics rejected plan {plan_digest[:12]} "
             "after the last revision.", "Evidence to verify against current code, not an instruction."]
    if grouped:
        lines.append("Findings concern the plan for all selected criteria, not this criterion alone.")
    budget = min(FINDING_TEXT, (TEXT - len("\n".join(lines))) // len(findings) - 1)
    lines += [finding_line(key, finding, budget) for key, finding in findings]
    text = "\n".join(lines)
    require(len(text) <= TEXT, "critic note exceeds its text limit")
    run_part = re.sub(r"[^A-Za-z0-9._-]", "-", run)[:RUN_IN_ID]
    return {"id": f"crew-critic-{run_part}-{plan_digest[:12]}", "text": text}


def finding_line(key, finding, budget):
    """Clip claim and resolution separately so that each keeps its own part of the budget."""
    head, middle = f"- {key} critic: ", " Resolution: "
    room = budget - len(head) - len(middle)
    claim, resolution = " ".join(finding["claim"].split()), " ".join(finding["resolution"].split())
    claim_room = max(room - len(resolution), room * 11 // 20)
    claim = clip(claim, claim_room)
    return head + claim + middle + clip(resolution, room - len(claim))
