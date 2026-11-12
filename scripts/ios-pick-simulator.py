#!/usr/bin/env python3
"""Prints the UDID of an available iOS simulator: the named device on the requested runtime ("latest" = newest),
else the same name on any runtime, else the first available iPhone (docs/TESTING_AND_CI.md §2.3)."""
import json
import subprocess
import sys

name, runtime = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "latest"
data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"]))
rows = []
for rt, devices in data["devices"].items():
    if "iOS" not in rt:
        continue
    ver = tuple(int(x) for x in rt.rsplit("iOS-", 1)[-1].split("-") if x.isdigit())
    for d in devices:
        rows.append((ver, rt, d["name"], d["udid"]))
rows.sort(reverse=True)
want = tuple(int(x) for x in runtime.split(".")) if runtime != "latest" else None
for pick in (
    lambda r: r[2] == name and (want is None or r[0][: len(want)] == want),
    lambda r: r[2] == name,
    lambda r: r[2].startswith("iPhone"),
):
    match = [r for r in rows if pick(r)]
    if match:
        print(match[0][3])
        sys.stderr.write(f"simulator: {match[0][2]} on {match[0][1]}\n")
        sys.exit(0)
sys.exit("no available iOS simulator")
