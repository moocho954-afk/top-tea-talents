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
- [ ] classify.ts shared module (extended selectivity signals + keywords + paid-guaranteed)
- [ ] server.ts wiring (import, matchTalent, jobs-for-you, richer email, follow-up endpoints, migration, VERSION 1.3.3)
- [ ] Backfill count over /tmp/opps.json (Bun script, same module)
- [ ] Unit tests (classify-test.ts) + integration test (paid-guaranteed-test.py, temp-DB server)
- [ ] Cron bodies updated (reply-watch 4b/4c, auto-runner 7b)
- [ ] VERSION.json note
- [ ] Deployment manifest for parent (browser push + Render deploy — subagent cannot use live browser)
