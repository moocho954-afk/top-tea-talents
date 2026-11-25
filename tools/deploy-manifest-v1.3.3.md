# TTT v1.3.3 — Deployment manifest (for the parent agent; subagent cannot use the live browser)
Date: 2026-11-25 ~13:00 EST. Owner order 2026-11-25 12:21 EST.
Repo: moocho954-afk/top-tea-talents (branch main). Render service: top-tea-talents-api (srv-dc14avff3r2c73bj0oh0, Docker Free, Oregon, Auto-Deploy OFF).
Local package dir: ~/workspace/top-tea-talents-public — NOTE: this dir has NO .git, so push goes through the GitHub web UI (upload/replace files), never `git push` and never re-run a failed Pages job.

## What changed (10 files)
NEW:
- server/src/classify.ts (216 lines) — shared classifier: deriveSelectivity, deriveProfileKeywords, scoreKeywords, derivePaidGuaranteed, isPaidCompType, locationInGeography.
- tools/classify-test.ts — unit tests, 29/29 PASS.
- tools/paid-guaranteed-test.py — integration test (temp-DB server), 31/31 PASS.
- tools/backfill-classify.ts — backfill script (same module, single source of truth).

MODIFIED:
- server/src/server.ts (4,179 lines) — imports classify.ts; matchTalent keywords + paidGuaranteed; jobs-for-you PAID GUARANTEED first + refined flag; richer buildApplicationEmail; GET /applications/follow-ups + POST /applications/nudge-stale; migrateFollowUpV133 (follow_up_json column); VERSION 1.3.3.
- server/src/schema.sql — applications.follow_up_json TEXT (line 93).
- server/selftest.sh — 2 new v1.3.3 checks (follow-ups + nudge-stale dry-run); expired v1.3.1 anchors replaced; health version assert 1.3.3.
- server/package.json — version 1.3.2 → 1.3.3.
- VERSION.json — backend_version 1.3.3, v1.3.3 note prepended, counts.opportunities 443, exported 2026-11-25T12:52:06-05:00.
- tools/listings-overhaul-progress.md — build log + selftest-failure diagnosis.

NOT part of this deploy (drift/sweep-owned, change on their own): tools/drift-history.jsonl, tools/sweep-log.jsonl, tools/drift-report.json, tools/reply-watch-state.json, tools/posting-time-rollup.json, tools/drift-check.py.

## Test evidence (all green, local)
- Unit: `bun run tools/classify-test.ts` → 29 passed, 0 failed.
- Integration: `python3 tools/paid-guaranteed-test.py` → 31 passed, 0 failed.
- Selftest: `bash server/selftest.sh` → SELFTEST: 189 passed, 0 failed.
- Backfill (319 live opps): selectivity guaranteed 7→17, selective 15→34, unknown 297→268; 10 unknown→guaranteed, 19 unknown→selective, ZERO guaranteed→selective regressions. PAID GUARANTEED = 0 for both Joseph and Mona-Lisa (0 paid+guaranteed in South Florida even before keyword/floor gates — the class is live and will catch one the moment it arrives).

## Cron bodies — ALREADY LIVE (updated via cron.update, verified via cron.view)
- ttt-reply-watch: steps 4b (reply→outcome hookup) + 4c (nudge-stale run, dryRun:false). Next run Wed 2026-11-25 13:16:58 EST.
- ttt-auto-runner: step 7b (follow-ups listing in the report). Next run Wed 2026-11-25 14:00:00 EST.
- TIMING NOTE: both new steps call endpoints that 404 until this deploy lands. Deploy before 13:16 EST if possible; if a run fires first, the new step fails non-fatally (core reply-watch / runner steps still work) — the run should note "v1.3.3 endpoints not live yet" and move on.

## Deploy steps (browser web UI)
1. GitHub web UI → repo moocho954-afk/top-tea-talents → main → upload/replace the 10 files above (new files via Add file → Upload files; modified files via the file's edit/upload-replace). Commit to main.
2. Render dashboard → service top-tea-talents-api → Manual Deploy → Deploy latest commit (autoDeploy is OFF, so the push alone does not deploy). Wait for Live.
3. If the deploy fails, do NOT re-run a failed Pages/deploy job — trigger a fresh manual deploy.

## Verify live (after deploy)
1. `python3 ~/workspace/custom-connectors/custom.top-tea-talents/bin/ttt.py health` → ok:true, version **1.3.3**, live_mode:true, test_mode:false.
2. `ttt.py api GET /api/v1/talent/tal_a8e01279ace84ed4/jobs-for-you` → rows carry `keywords`, `keywordScore`, `paidGuaranteed`; guaranteed-selectivity rows sort first. (paidGuaranteed will be false on every current row — 0 exist in the pool; the check is the fields + ordering.)
3. Dry-run send on an existing application → `ttt.py api POST /api/v1/applications/<id>/send --body '{"dryRun":true}'` → preview shows the richer email lines (hours, deadline, contact, source link, bring-line when stated). Sends nothing.
4. `ttt.py api GET /api/v1/applications/follow-ups` → 200, rows for SENT apps with no reply (age in days + nextAction).
5. `ttt.py api POST /api/v1/applications/nudge-stale --body '{"dryRun":true}'` → 200, `nudged: []`, `dryRun: true`. Sends nothing.
6. Drift watch next run should go IN_SYNC once GitHub matches disk (VERSION.json + server files now pushed).

## Guards (unchanged — verify nothing regressed)
Gender hard gate, unpaid/TFP never auto-sent, undisclosed pay needs approval, caps 3/day + 10/week per talent, auto-runner only sends automationEligible. No live backend data was touched by this build except through the tested code paths. No secret/token in any file or report. $0 — no card, no paid tier.

## Rollback
If health is not 1.3.3 or any verify step fails: re-deploy the previous commit on Render (manual deploy → pick the prior commit) and report. The cron bodies (4b/4c/7b) tolerate the old server — the new endpoints 404 and the runs note it and continue.
