#!/usr/bin/env python3
"""Prints the UDID of an available iOS simulator the active Xcode can build for: runtimes newer than the selected
Xcode's iphonesimulator SDK are skipped (CoreSimulator lists every installed runtime, including those of other Xcode
versions on the runner). Preference: the named device on the requested runtime ("latest" = newest usable), then the
named device on any usable runtime, then the first iPhone (docs/TESTING_AND_CI.md §2.3). "oldest" picks the oldest
usable runtime at or above the app's iOS 16 deployment target (nightly ios-matrix)."""
import json
import subprocess
import sys

name = sys.argv[1]
runtime = sys.argv[2] if len(sys.argv) > 2 else "latest"


def version(text):
    return tuple(int(x) for x in text.replace("-", ".").split(".") if x.isdigit())


sdk = version(subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], text=True).strip())
data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"]))
rows = []
for rt, devices in data["devices"].items():
    if "iOS" not in rt:
        continue
    ver = version(rt.rsplit("iOS-", 1)[-1])
    if ver[:2] > sdk[:2]:
        continue  # not buildable with this Xcode
    for d in devices:
        rows.append((ver, rt, d["name"], d["udid"]))
oldest = runtime == "oldest"
if oldest:
    rows = [r for r in rows if r[0] >= (16,)]
rows.sort(reverse=not oldest)
want = version(runtime) if runtime not in ("latest", "oldest") else None
for pick in (
    lambda r: r[2] == name and (want is None or r[0][: len(want)] == want),
    lambda r: r[2] == name,
    lambda r: r[2].startswith("iPhone") and (want is None or r[0][: len(want)] == want),
    lambda r: r[2].startswith("iPhone"),
):
    match = [r for r in rows if pick(r)]
    if match:
        print(match[0][3])
        sys.stderr.write(f"simulator: {match[0][2]} on {match[0][1]} (SDK {'.'.join(map(str, sdk))})\n")
        sys.exit(0)
sys.exit(f"no available iOS simulator for SDK {sdk}")
