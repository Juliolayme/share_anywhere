# Runbook: 20 GB manual transfer test (Web)

CI covers 2 GB nightly (`.github/workflows/nightly.yml`, `large-file`). A 20 GB file (the session limit) is tested by hand before releases, because it needs real disks, real networks and hours of runtime. Record each run in the phase report or the release checklist.

## Setup

1. Two computers on different networks if possible (for example office Wi-Fi and a phone hotspot), or one computer with two browsers for a LAN baseline.
2. Free space: the receiver needs about 2 × 20 GB with "Save to a folder" (browser storage while receiving, then the copy) or 20 GB plus the download with "Keep in this browser". Check the capability table on the save screen: it shows the browser's free storage. A finished file stays in browser storage for 24 hours, then the app removes it.
3. Create the fixture on the sender:

   ```bash
   scripts/gen-fixture.sh 20G ~/sa-20g.bin
   ```

   Write down the SHA-256 it prints.
4. Use the deployed stack (or `docker compose up` with TURN configured) over HTTPS.

## Run

1. Sender: Send → pick `sa-20g.bin` → Create share session.
2. Receiver: enter the code → Receive → choose a save option → Start receiving.
3. While it runs:
   - note the route chip (Direct or Relay) and the speed;
   - reload the receiver tab once, after about 30 %. It must resume from the saved bitmap, not from 0 (the percentage comes back at or above where it was);
   - pause for a minute, then resume;
   - switch the receiver's network once (for example Wi-Fi off and on). The receiver shows "Reconnecting", then continues.
4. Watch memory in the browser's task manager on both sides: it should stay flat (a few hundred MB), not grow with the file.
5. When the receiver shows "All files received · SHA-256 verified", compute the hash of the saved file:

   ```bash
   sha256sum ~/Downloads/sa-20g.bin
   ```

   It must equal the fixture's hash.

## Record

| Field | Value |
|---|---|
| Date, commit | |
| Sender browser and OS | |
| Receiver browser, OS, save option | |
| Networks and route (Direct / Relay) | |
| Duration, average speed | |
| Reload resumed from (%) | |
| Peak memory sender / receiver | |
| Hash match | yes / no |
| Problems | |

## Known limits

- iPhone and iPad Safari usually cannot store 20 GB and suspend background tabs. The save screen warns about it, and this run is not expected to pass there.
- Firefox private windows have no browser storage, so files over 256 MB cannot be received there.
