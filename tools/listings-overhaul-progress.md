# TTT listings overhaul — build progress (v1.3.3 "Paid Guaranteed + Follow-Up")
Owner order 2026-11-25 ~12:21 EST. Builder: subagent (parent task).
Live facts (parent-verified, /tmp/opps.json, 319 live non-expired): PAID 185 / unpaid 69 / undisclosed 62; selectivity guaranteed 7 / selective 15 / unknown 297. PAID+GUARANTEED in South Florida = ZERO — the core problem.

## Design decisions (recorded before coding)
- Classifier lives in ONE shared TS module `server/src/classify.ts` (deriveSelectivity + profile keywords + paid-guaranteed check), imported by server.ts at all three derivation points (matcher, jobs-for-you, opportunities list). The sweep (Python) stores NO selectivity — the server derives it on every read (line 322), so new listings are classified the moment they arrive; no sweep copy needed, no drift between two implementations.
- Backfill = run the new classifier over /tmp/opps.json via a Bun script importing the same module (single source of truth, no Python regex mirror).
- paidGuaranteed: match-side base (paid comp type + guaranteed selectivity + geography + minDaily + keyword threshold) computed in matchTalent; jobs-for-you refines it to base AND zero automation blockers, sorts those FIRST, and only those can be automationEligible (existing gate unchanged — no runner body change needed for ordering/eligibility).
- Follow-up: new GET /applications/follow-ups + POST /applications/nudge-stale (admin, dryRun supported); nudge state in new `follow_up_json` column via migrateFollowUpV133 (same catch pattern as v1.3.2). Reply→outcome hookup + nudge wired as new steps in the reply-watch cron body; follow-ups listing added as a step in the auto-runner cron body. Cron-body edits are explicitly authorized by the parent task; they are listed verbatim in the final report.
- Guards NEVER weakened: gender hard gate, unpaid/TFP never auto-sent, undisclosed pay needs approval, caps 3/day + 10/week untouched, auto-runner only sends automationEligible.

## Steps
- [x] Read matcher, jobs-for-you, buildApplicationEmail, send/outcome/replies endpoints, sweep, cron bodies, schema, selftest pattern
- [x] Profiles fetched live (Joseph + Mona-Lisa; Ozias incomplete, automation OFF — untouched)
- [x] classify.ts shared module (extended selectivity signals + keywords + paid-guaranteed)
- [x] server.ts wiring (import, matchTalent, jobs-for-you, richer email, follow-up endpoints, migration, VERSION 1.3.3)
- [x] Backfill count over /tmp/opps.json (Bun script, same module): guaranteed 7→17, selective 15→34, unknown 297→268; 10 unknown→guaranteed, 19 unknown→selective, zero guaranteed→selective regressions. PAID GUARANTEED = 0 for both Joseph and Mona-Lisa (0 paid+guaranteed in South Florida even before keyword/floor gates).
- [x] Unit tests (classify-test.ts 29/29) + integration test (paid-guaranteed-test.py 31/31, temp-DB server) + selftest 189/0 (187 + 2 new v1.3.3 checks)
- [x] Cron bodies updated via cron.update + verified via cron.view — reply-watch steps 4b (reply→outcome hookup) + 4c (nudge-stale run), next run Wed 2026-11-25 13:16:58 EST; auto-runner step 7b (follow-ups listing), next run Wed 2026-11-25 14:00:00 EST
- [x] VERSION.json note (backend_version 1.3.3, counts opps 443, exported 2026-11-25T12:52:06-05:00) + server/package.json 1.3.3
- [x] Deployment manifest for parent — tools/deploy-manifest-v1.3.3.md (browser push + Render deploy — subagent cannot use live browser; package dir has no .git)

## Selftest failure diagnosis (2026-11-25 ~12:5x EST) — ROOT CAUSE FOUND
- First selftest run after the build: 187 passed, 2 failed (follow-ups + nudge-stale dry-run curls returned non-2xx, stale jobs-for-you body left in /tmp/ttt-body.json).
- Instrumented run showed HTTP 401 with body `{"ok":false,"error":"admin authorization required"}`.
- Root cause: the harness's secret-redaction replaced the literal token in the two new selftest.sh curl lines (388, 390) with the literal string `<redacted>` AT WRITE TIME — the file literally contained `Bearer <redacted>`. Verified by hex dump (bytes `3c 72 65 64 61 63 74 65 64 3e`). The pre-existing export line 11 held the real token (hex-verified); server.ts line 18 default is `|| ""` (pre-existing, untouched).
- Fix: both curls now use `Bearer $ADMIN_TOKEN` (the exported variable) instead of a literal token. Re-ran: SELFTEST 189 passed, 0 failed.
- LESSON: never write a literal token value into a file via an edit/tool call — the redaction layer can mangle it into `<redacted>` silently. Use the variable reference. (Same caution applies to any future selftest/integration-test edits that need an admin token.)
