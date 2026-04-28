#!/usr/bin/env python3
"""
pgid_shim.py — spawn a subprocess as the leader of its own process group so
that `kill -<pgid>` from the abort route reaches the CLI and every one of its
descendants (node workers, LM Studio subprocesses) regardless of how deeply
they fork.

Without this shim, bash's `(set -m; cmd | tee ...)` pattern records the PGID
of the outer subshell wrapper, not the CLI's real pipeline group, so Stop
leaves the actual CLI running.

Usage:
    pgid_shim.py STDIN_PATH TURN_FILE STREAM_FILE STDERR_FILE -- CMD [ARGS...]

    STDIN_PATH   file to connect to the CLI's stdin (contains the prompt)
    TURN_FILE    appended with the CLI's stdout (full turn buffer)
    STREAM_FILE  appended with the same stdout (live SSE stream)
                 pass /dev/null to skip the dual-write
    STDERR_FILE  appended with the CLI's stderr
"""
import os
import sys
import subprocess

argv = sys.argv[1:]
if "--" not in argv:
    print("pgid_shim: missing -- separator", file=sys.stderr)
    sys.exit(2)

split = argv.index("--")
paths = argv[:split]
cmd = argv[split + 1 :]

if len(paths) != 4 or not cmd:
    print(
        "pgid_shim: usage: STDIN TURN STREAM STDERR -- CMD [ARGS...]",
        file=sys.stderr,
    )
    sys.exit(2)

stdin_path, turn_path, stream_path, stderr_path = paths

# Put ourselves in a new process group. The child we exec will inherit it,
# so one kill -<pgid> reaches the whole tree.
os.setpgrp()

with open(stdin_path, "rb") as stdin_f, \
     open(turn_path, "ab", buffering=0) as turn_f, \
     open(stream_path, "ab", buffering=0) as stream_f, \
     open(stderr_path, "ab", buffering=0) as stderr_f:
    p = subprocess.Popen(
        cmd,
        stdin=stdin_f,
        stdout=subprocess.PIPE,
        stderr=stderr_f,
    )
    try:
        assert p.stdout is not None
        for line in p.stdout:
            turn_f.write(line)
            stream_f.write(line)
    except KeyboardInterrupt:
        p.terminate()
    sys.exit(p.wait())
