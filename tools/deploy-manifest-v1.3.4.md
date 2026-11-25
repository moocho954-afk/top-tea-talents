# TTT v1.3.4 — Deployment manifest (for the parent agent; subagent cannot use the live browser)
Date: 2026-11-25 ~14:50 EST. Owner order 2026-11-25 12:21 EST (follow-up system must cover the older sends too).
Repo: moocho954-afk/top-tea-talents (branch main). Render service: top-tea-talents-api (srv-dc14avff3r2c73bj0oh0, Docker Free, Oregon, Auto-Deploy OFF).
Local package dir: ~/workspace/top-tea-talents-public — NOTE: this dir has NO .git, so push goes through the GitHub web UI (upload/replace files), never `git push` and never re-run a failed Pages job.

## What changed (4 files)
MODIFIED:
- server/src/server.ts — new `sentReceipt()` helper (reads the email_queue SENT row for an application: sent_at + message_id); GET /applications/follow-ups and POST /applications/nudge-stale fall back to it when the snapshot has no sentAt; the nudge handler also hands the resolved date to the nudge email so it prints the true sent date, not "recently". `VERSION` 1.3.3 → 1.3.4.
- server/package.json — version 1.3.3 → 1.3.4.
- server/selftest.sh — version assert 1.3.4; 2 new v1.3.4 checks (fixture: SENT application + email_queue SENT row, snapshot WITHOUT sentAt → follow-ups returns the queue date with daysSinceSent 6 + "nudge due"; nudge-stale dry-run lists it as nudge-due).
- VERSION.json — backend_version 1.3.4, v1.3.4 note prepended.

## Why this fix, not a data backfill
The 6 older SENT applications were sent Nov 23, before v1.3.2 stored sentAt in the snapshot — their snapshot_json has no sentAt, so follow-ups/nudge read "sent date unknown" forever. The email_queue SENT rows are the ground truth (the drain wrote sent_at + message_id at send time; proven from the ledger email.sent events). A data backfill would need a new write endpoint and risks clobbering snapshots; the read fallback fixes both handlers with zero data mutation and protects any future gap. POST /applications/:id/snapshot must NOT be used for this — it rebuilds the snapshot without sentAt and would overwrite the stored email.

## Ground truth for the live 6 (from ledger email.sent events, all Nov 23)
- TTT-59D66A66 (Joseph, Travel App) 2026-11-23T06:23:24.733Z, msg 1a20712d556bf6a2, to moocho954@gmail.com
- TTT-A186BF20 (Mona, Commercial Auditions) 2026-11-23T17:58:57.495Z, msg 1a2098f9f459d9d8, to mlcptalent@gmail.com
- TTT-5211E06C (Mona, Wellness Oasis) 2026-11-23T17:59:34.256Z, msg 1a209902ebe4d038, to Kyndall@kynnectevents.com
- TTT-65319130 (Mona, Female Athlete) 2026-11-23T17:59:59.586Z, msg 1a20990921578ff9, to submit@utalentsmiami.com
- TTT-828C3446 (Joseph, AutoZone) 2026-11-23T18:00:28.767Z, msg 1a209910583ac868, to miamitalentcasting@gmail.com
- TTT-79D23990 (Joseph, Commercial Auditions) 2026-11-23T18:01:55.667Z, msg 1a20992579c0b71f, to mlcptalent@gmail.com
All 6 are 2 days old on Nov 25 — nudge-due Nov 28. The 2 newest (Wellness Oasis TTT-AF21CD4B, Liquor Store TTT-8539BACE, sent Nov 24) already had sentAt and are unaffected.

## Test evidence (all green, local)
- `bun run typecheck` → clean.
- `bash server/selftest.sh` → SELFTEST: 191 passed, 0 failed (189 + 2 new v1.3.4 checks).

## Deploy steps (browser web UI)
1. GitHub web UI → repo moocho954-afk/top-tea-talents → main → upload/replace the 4 files above (modified files via the file's edit/upload-replace). Commit to main.
2. Render dashboard → service top-tea-talents-api → Manual Deploy → Deploy latest commit (autoDeploy is OFF, so the push alone does not deploy). Wait for Live.
3. If the deploy fails, do NOT re-run a failed Pages/deploy job — trigger a fresh manual deploy.

## Verify live (after deploy)
1. `python3 ~/workspace/custom-connectors/custom.top-tea-talents/bin/ttt.py health` → ok:true, version **1.3.4**, live_mode:true, test_mode:false.
2. `ttt.py api GET /api/v1/applications/follow-ups` → 200, all 6 rows now carry sentAt (Nov 23 times above) + daysSinceSent 2 + nextAction "waiting — nudge due in 3 day(s)"; the 2 newest still 1 day. Zero rows "sent date unknown".
3. `ttt.py api POST /api/v1/applications/nudge-stale --body '{"dryRun":true}'` → 200, `nudged: []`, 6 skipped "only 2 day(s) since sent", 2 skipped "only 1 day(s) since sent". Sends nothing.
4. Drift watch next run should go IN_SYNC once GitHub matches disk.

## Guards (unchanged — verify nothing regressed)
Gender hard gate, unpaid/TFP never auto-sent, undisclosed pay needs approval, caps 3/day + 10/week per talent, auto-runner only sends automationEligible. No live backend data was touched by this build — the fix is a read fallback only. No secret/token in any file or report. $0 — no card, no paid tier.

## Rollback
If health is not 1.3.4 or any verify step fails: re-deploy the previous commit on Render (manual deploy → pick the prior commit) and report. The cron bodies tolerate the old server — the 6 rows stay "sent date unknown" and get skipped, nothing mis-sends.
