#!/usr/bin/env python3
"""Start the server as the HOME (LAN) instance — read-gating off.

run.py gates /load and /save-names by default (fail-safe: a bare
`python run.py` behaves like the tunnel-facing public instance and
refuses to serve saves, which carry long-term GPS traces). This
wrapper is the explicit opt-in: it marks the process as the home
instance so loading works, and is what the LAN service (and local
dev, when you need Load) should run.

Only run this on a listener that isn't reachable from the internet
(firewalled to the home subnet / not behind the tunnel ingress).
It listens on its own port (4539) so it can never be confused with —
or accidentally swapped for — the gated instance on 8464/8465: the
tunnel ingress keeps pointing at the gated ports, and the "Load
server (home)" field in Settings points at http://<lan-ip>:4539.

CC_LAN must be in the environment BEFORE run.py is imported — the
flag is read at import time — hence a wrapper script rather than a
flag after the fact. The env var also survives Werkzeug's debug
reloader re-exec.
"""
import os

os.environ["CC_LAN"] = "1"

import run  # noqa: E402  (import must come after the env var is set)

if __name__ == "__main__":
    run.app.run(host="0.0.0.0", port=4539, debug=True)
