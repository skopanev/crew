# Sourced by lane/run.sh: command-line usage. Uses run.sh variables.
usage() {
  cat >&2 <<'USAGE'
usage: run.sh --ticket-id <id> --project <Joppa workspace> --source-root <workspace>
              --dispatcher-id <dolber id>
              --cbm-mcp-command <file> --cbm-cache-dir <shared-store>
              --gate-command <shell command> [...]
              [--review-command <shell command>]...
              --test-command '["runner", "args"]' [--gate-timeout <seconds>]
              [--coder-timeout <seconds>]
              [--module <module>]
              [--mount-ro <repo>]... [--mount-rw <dir>]... [--ssh-dir <dir>]
              [--image <image>] [--docker-engine]
              [extra medulla args...]

  --source-root  entire source workspace, mounted read-only. It contains the
                 configured repository of the Joppa Task.
  --cbm-mcp-command  native host CBM executable; broker bridges it for this lane.
              The lane uses that service; it never copies or indexes a database.
  --cbm-cache-dir  existing shared CBM store, the same as the active daemon uses.
  --module    Task module; read from the Joppa Task when omitted
  --image     lane runtime image; defaults to medulla-crew:latest
  --docker-engine  enable the broker box's private Docker engine for tests
  --dispatcher-id  stable Dolber ID; manual lanes use the same ID to share its limit.
  --gate-command  required check, run from the candidate repo root. Repeatable.
                  Supplied by the operator; no commands are inferred from code.
  --review-command  optional check before review; defaults to the gate commands.
  --test-command  required runner argument array for existing-code verification.
  --gate-timeout  maximum seconds per check; defaults to 900.
  --coder-timeout  cap each coder attempt; cannot extend the workflow timeout.
  --mount-ro  another repository to mount READ-ONLY, for scope. Repeatable.
  --mount-rw  an existing directory to mount writable at /workspace/<name>. Repeatable.
  --shared-lock-dir  a shared lock directory directly under the source root, mounted writable.
  --ssh-dir  directory holding ONLY the lane's git key, as id_ed25519, plus an
             optional known_hosts. No default: landing needs a key and a
             made-up path that nobody created is worse than none. The whole
             directory is what the agent can read, so nothing else belongs in it.

Anything after the known flags is passed to medulla unchanged, so --validate,
--dry-run, --resume and --node work as usual.
USAGE
  exit 2
}
