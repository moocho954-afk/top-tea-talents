# Top Tea Talents — Email Harvest Build Report
**Date:** 2026-11-23 (built ~12:11–12:45 EST)
**Owner order:** "fix everything — grab all of the contact from every one of our sources and make sure you have them all there" (12:11 EST) + scope clarification 12:14 EST (every source, per-source coverage in this report).
**Basis:** `tools/email-source-audit-2026-11-23.md` (14 sources, verified live). Implements audit recommendations 1–6.
**Safety:** no real application email was sent as part of this work (email queue still shows exactly 1 SENT — the pre-existing Backstage send). Verification is dry-run only. live_mode / submissionsPaused / talent automation settings were not touched (verified at the end: live_mode true, submissions_paused false, v1.3.1).

## Headline numbers

| Measure | Before | After |
|---|---|---|
| AllCasting records carrying `contact_email` | **0 / 122** | **41 / 122** |
| AllCasting records with usable `submission_instructions` | ~66 (old verified set only) | **122 / 122** (verified live: every record now carries instruction text; 41 of them are email instructions) |
| Contacts-table entries seeded (ready file) | 0 from this harvest | **14 entries** in `tools/allcasting-contacts-seed.json` (13 email + 1 phone) — **NOT yet posted to the live API** (endpoint deploy pending, see §6) |
| Dry-run proof | — | **PASS** — destination resolves to harvested email (see §5) |
| Live contacts table now | 449 rows, only 5 with an email | unchanged until the seed is posted |

## 1. What changed in the sweeper (`tools/sweep-opportunities.py`)

All in `parse_detail()` and its helpers; module docstring updated with the harvest rules.

- **`extract_casting_call()` (NEW).** Parses the embedded `castingCall` JSON object on AllCasting detail pages. The blob is a JSON string inside the page (quotes backslash-escaped), so decoding is two-step (`json.loads` the outer string, then `json.loads` the result). Brace-matching is escape-aware (a quote toggles in-string only when preceded by an even number of backslashes — a naive `replace('\\"', '"')` fails on descriptions containing escaped quotes; two samples proved it). **Scope guard:** exactly one `castingCall` per page, and the object's `id` must match the URL id — the page feed carries other listings' agent emails and they must never leak onto another listing (verified: on listing 325887 the first `agent_email` in the page is a different listing's).
- **Type rules (per the brief).** `type == "email"` → `contact_email = agent_email`, `submission_instructions = "Submit by email to {agent_email}"`. `type == "web"` → instructions `"Apply on AllCasting"`, no email. `type == "url"` → instructions `"Apply via the listing link"`, no email. `type == "phone"` (found once, 325679) → no email by design. A web/url agent email is the poster's contact, never the submission route.
- **`find_submission_email()` (NEW, body-email regex second net).** Runs an email regex over the stripped listing body and accepts an address ONLY when ~150 chars around it contain a submission hint (`submit`, `send to`, `send your`, `send us`, `email your`, `email us`, `please email`, `apply by email`, `submissions to`, …). Blocklist + placeholder domains skipped. Never takes the first email on the page. Unit-tested 5/5: catches both Central Casting per-project examples (`jeffreywsubmissions@centralcasting.com`, `vpcastingsubmissions@gmail.com`); rejects `support@allcasting.com`, `name@example.com`, and a bare email with no submission framing.
- **`find_casting_org()` (NEW).** Captures the named casting company from post text (`Casting TaylorMade`, `Central Casting` special-cased). Rejects a match when ANY captured word is generic nav/label text — `call/calls/casting/director/company/agency/notice/team/office/audition` and, after a live fix during this build, `website/websites/sites/list/lists/board/boards/jobs/job` (the "Casting Websites" footer link was leaking in as an org). Regression-tested 4/4.
- **`resolve_casting_click()` (NEW).** CastingAndActing apply route: follows the `api.castingandacting.com/api/casting-click.php?id=N` button once to the original listing URL, stored as `apply_url` (source_url stays the summary page). Verified live: id 876 → the Playbill original posting.
- **Wiring in `parse_detail()`.** AllCasting → castingCall parse; body regex runs only for non-AllCasting, or AllCasting email-type/unknown-type (never for web/url — the type is authoritative); `casting_org` filled from post text when still null. `casting_org` is set to the agent name only when null or when the existing value is the platform name `"AllCasting"` (older records carried the platform as the org — see §3).
- **`--backfill-allcasting` mode + `backfill_allcasting()` (NEW).** GET record → strip the 4 derived keys the API adds (`expired`, `selectivity`, `selectivityReason`, `genderRequirement`) → fetch detail → extract → POST upsert only when something changed. Progress in `tools/allcasting-backfill-progress.jsonl` (one JSON line per record; resume skips finished statuses; errors are retried). Seed file is now **merged, not overwritten** (a resume run previously wiped it — fixed).
- **One-off fix script `tools/allcasting-orgfix.py`.** Sets `casting_org` = the live page's agent name wherever the record carried the platform name; never invents a name (16 records' pages carry no agent name — they keep the platform value). Checkpoint `tools/allcasting-orgfix-progress.jsonl`.

## 2. Backfill — AllCasting (122 records, run 2026-11-23 ~12:20 EST, ~5 min, exit 0)

| Outcome | Count | Meaning |
|---|---|---|
| `updated_email` | **41** | `contact_email` + instructions set from a `type=email` castingCall |
| `updated_instructions` | **8** | 6 web/url listings got apply instructions + 2 detail-URL resolutions (Dyson 302795, Stone Island 280750 — see below) |
| `no_change` | 66 | Older Nov 21 verified records already carrying rich data (org, professional, instructions, PARTIALLY_VERIFIED) — correctly left alone |
| `skipped_no_email` | 3 | No email by design (incl. `type=phone` listing 325679) |
| `error` | **4** | Unresolvable (see below) |
| **Total** | **122** | |

- **Parse tests before the run:** 5/5 AllCasting samples through `parse_detail` (325887 email/submit@utalentsmiami.com/Julia Ulanova; 295773 + 308586 email/miamitalentcasting@gmail.com/Miami Talent Casting Inc; 325884 web/no email/"Apply on AllCasting"/Madeline Vega; 325026 url/no email/"Apply via the listing link"). Re-run after the final edits: still 5/5.
- **Live dry-run sweep after the patch:** allcasting 300 harvested / 2 new / 0 errors; projectcasting 0 (sitemap flaky, known); auditionsfree 48 harvested / 0 new.
- **Slug-id bug found + fixed during the run:** 6 records carry slug ids (`musicvideo:allcasting:suddenly-stupid`, `commercial:allcasting:dyson-commercial`, …) — the numeric-id regex failed on them. Fixed to derive the numeric id from `source_url` (`/castingcall/(\d+)`) first. **2 of the 6 were resolved by hunting the detail URL:** the Dyson commercial is live as AllCasting 302795 and the Stone Island campaign as 280750 (verified by page title + castingCall id match; both `type=web`, agent name empty, so no email — instructions preserved, `source_url` corrected to the detail page). **4 remain unresolvable:** `suddenly-stupid` (Columbus OH), `you-dont-need-me` (Pittsburgh PA), `double-down`, `hercules-from-the-bottom` — their records point at AllCasting index pages, not detail pages, and all four are non–South Florida listings that should not be in the set. Recorded as errors with reason; not forced.
- **Org correction (`allcasting-orgfix.py`, 49 records):** 31 fixed (casting_org now the poster name), 2 already correct, 16 no agent name on the live page (incl. 325752, Dyson, Stone Island). **Correction to the correction:** the first org pass copied `casting_professional` blindly, which carried two generic Nov 21 labels (`"Casting Professional"` ×8, `"AllCasting (poster; casting company not named)"`). Those were re-checked against the live pages: 8 pages genuinely carry agent_name `"Casting Professional"` (AllCasting's default when the poster sets no name) — they stay that way, are excluded from the seed, and still resolve via their own `contact_email`. One record's live page gave a real name (`rapvideo:allcasting:hispanic-men-music-video-325327` → Miami Talent Casting Inc). The seed now contains only real names (verified by direct API reads: no record carries a `"poster"` org anymore).

## 3. Contacts seeded (ready file — NOT yet posted live)

File: `tools/allcasting-contacts-seed.json` — **14 entries** (13 email + 1 phone), each seen on a live listing page:

| Name | Kind | Contact |
|---|---|---|
| Miami Talent Casting Inc | agency | miamitalentcasting@gmail.com |
| Julia Ulanova | casting-professional | submit@utalentsmiami.com |
| Justin Castillo | casting-professional | 199xfilmsinc@gmail.com |
| Tina Seiler | casting-professional | castingbytina@gmail.com |
| Edward Royal | casting-professional | edwardroyalty@aol.com |
| Christopher Joseph | casting-professional | casting@offposture.com; chris@oppolab.io |
| Alex Spagnoli | casting-professional | contentunlimited01@gmail.com |
| Maria Luisa Sivitilli | casting-professional | info@A-ListInternational.com |
| Michael Mincieli | casting-professional | pretended2bjesus@gmail.com |
| Morgan Shepherd | casting-professional | 3ratsentertainment@gmail.com |
| Satori Models | casting-professional | castings@wearesatori.com |
| Helen Logan | casting-professional | kingdommindedoutreachministry@gmail.com |
| Casting TaylorMade | agency | **(305) 951-8291 — contact by text (Heather), no email published** |

- **Skipped deliberately:** 18 records whose harvested email has no usable org name (16 pages carry no agent name; 8 carry AllCasting's generic `"Casting Professional"` label). A contact with no real name to key on would be unmatchable — and keying it under a generic label would mis-route future listings. Those listings still resolve through their own `contact_email` on the record.
- **Duplicate note:** 41 email records collapse to 13 unique (name, email) pairs — repeat posters (Miami Talent Casting Inc ×2 listings, U Talents Miami ×2) are exactly what the contacts fallback is for: a future `type=web` listing from the same poster will now resolve by org name.
- **Live contacts table today:** 449 rows, only 5 with an email and 5 with a phone (seed-imported, mostly name-only). The 14 above are NOT in it yet — posting them needs the new endpoint deployed (see §6).

## 4. Backend: POST /api/v1/contacts (added, tested locally, pushed to GitHub)

`server/src/server.ts` — new admin-only endpoint after the GET /contacts handler (~line 1491):

- Validates `kind` (agency / employer / casting-professional / production-company) and email format.
- **Refuses the 6 platform support addresses** (`support@allcasting.com`, `support@projectcasting.com`, `support@productionbeast.com`, `hello@heybooker.app`, `casting@backstage.com`, `uigroup@ep.com`) with 400 "platform support addresses are not submission destinations".
- **Merge-safe:** loads the existing row first and passes only non-null keys to `upsertContact` — the internal `upsertContact` UPDATE would otherwise wipe stored email/phone with nulls and poison `data_json` (GET spreads `data_json` over columns). Omitting a field now preserves it.
- Audits `contact.upsert` with the contact snapshot.
- **Local test (temp SQLite DB, `bun run src/server.ts`, all passed):** POST new contact → ok (`ctc_21f004f8f9230885`); POST support@allcasting.com → 400; POST same contact again with email omitted → merge kept the email; POST phone-only TaylorMade → ok (city/state defaulted Miami FL); POST without token → 401. **One bug caught by this test:** the first version had a syntax error (missing `:` in a nested ternary, line 1517) that prevented the server from booting — fixed before pushing. The live Render service was never affected (it runs the previous commit).
- **Pushed to GitHub:** commit `db1aa23f1955c4622a6f547f6f8d2278f14ab75d` on `moocho954-afk/top-tea-talents` main (only `server/src/server.ts`; verified byte-identical via raw fetch, md5 `e3c7d42ebd9de2ab47a279dd183446ce`). First attempt died in a service restart mid-push (verified nothing landed, retried cleanly; approval granted).

## 5. Dry-run proof (no real send)

Application `app_10004378e5c84779` — Mona Lisa, **Brand Ambassadors for Liquor Store Tasting Events** (AllCasting 325626, ref TTT-62790922), status PACKAGE READY.
`POST /api/v1/applications/app_10004378e5c84779/send {"dryRun": true}` returned:

- `"destination": "empromotions333@gmail.com"`, `"destinationSource": "listing"` — the harvested `contact_email` on the record.
- `liveMode: true`, `mailConfigured: true`; full email preview (from topteatalents@gmail.com, cc/replyTo Mona Lisa, subject with ref code, payAsk present).
- Dry-run returns before the APPROVED check and before any queueing/sending, so it is safe on any status. **Nothing was sent, nothing was queued, no status changed.** Email queue still shows exactly 1 SENT (the pre-existing Backstage send).

## 6. What is still pending (needs the owner)

1. **Render manual deploy.** `render.yaml` has autoDeploy OFF by design, so the pushed commit does not deploy itself. The owner taps **Manual Deploy** on service `srv-dc14avff3r2c73bj0oh0` (reacher-api naming aside, the TTT service) in the Render dashboard, branch main, commit `db1aa23f`. After the deploy: rebuild the ledger mirror (`POST /ledger/mirror/rebuild`) + run the recorder (standard post-deploy steps).
2. **Seed the contacts table live.** Once the endpoint is deployed, POST the 14 entries in `tools/allcasting-contacts-seed.json` via `ttt.py api POST /api/v1/contacts` (admin). When seeding, reuse the existing row's `kind` if a row with the same normalized name already exists (the live table already has a `casting-professional` "Miami Talent Casting Inc" row with no email; seeding as `agency` would create a second row — resolution still works because the lookup filters `email IS NOT NULL`, but one row per org is cleaner).
3. **Verify on live:** `GET /api/v1/contacts` should show the 14 seeded entries with emails; a dry-run on a `type=web` listing from a seeded poster (e.g. a future Miami Talent Casting Inc web listing) should resolve via `destinationSource: "contacts"`.

## 7. Per-source coverage — all 14 sources

| Source | What was captured | What stays null, and why |
|---|---|---|
| **AllCasting** (122 live) | `contact_email` on 41 (`type=email`); apply instructions on 115; `casting_org`/`casting_professional` = poster name where the page names one; 14 contacts seeded (pending deploy) | 81 records have no email: 66 already-verified older records that are `type=web/url` (apply on AllCasting / via link — correct, no email exists for them), 3 no-email-by-design, 4 unresolvable slug records, 8 generic-poster-label records (email on the record, no name to key a contact on) |
| **ProjectCasting** (229 live, largest source) | Nothing new harvestable. Sweeper still captures org/apply URL where present; no code change needed | **No per-listing email by design** — apply is a JS form behind login. `contact_email` stays null. This is expected, not a failure |
| **AuditionsFree** | `casting_org` from post text — verified live on the Miami Vice extras post: org = **Casting TaylorMade**, email null (correct) | No email on the page or the site (contact form only). Application lives off-site at the named casting company |
| **CastingAndActing** (3 live) | Click-through resolved — verified live: id 876 → original Playbill posting, stored as `apply_url` | No email (Playbill page has no email/mailto; audition is in-person). `contact_email` stays null |
| **HeyBooker** | Nothing harvestable | In-app apply by design; no per-listing email |
| **ActorsAndExtras** | Nothing harvestable | Free-login "Register Interest" by design; no email |
| **Craigslist** | Nothing harvestable | Reply-button relay by design; RSS 403 from this VM and miami.craigslist.org blocked by browser policy — could not be live-checked in this run (same as audit) |
| **ProductionBeast** | Re-probed 2026-11-23 ~12:13 EST: detail pages 5855-slope-2 and 5854-drift-boss **still HTTP 500** | Unverifiable until the 500s resolve; re-probe on a later sweep. No code change |
| **Backstage** | Nothing harvestable from public pages | Per-notice email exists behind login only. The one email ever sent was a Backstage listing (3335382) — its destination field is unverified (API returned 404 for that record on re-fetch) |
| **Casting Networks** | Body-email regex net now covers reposted calls — unit-tested on the two verified examples (`jeffreywsubmissions@centralcasting.com`, `vpcastingsubmissions@gmail.com`) | Public call pages show emails in plain text but the source is login-walled; not fetchable today |
| **Central Casting** | Same regex net (above); per-project emails circulate inside reposts and are now captured when a body frames them as a submission address | No direct fetch; depends on reposts |
| **Mandy** | Nothing harvestable | Login-walled, no public email |
| **Casting TaylorMade** | **Phone (305) 951-8291 — contact by text (Heather)**, captured as a contacts entry (no email exists anywhere for them; applications via per-production web forms) | Email: none exists |
| **Instagram** | Nothing harvestable | DM / link-in-bio only, no email route |

**Known but NOT usable as destinations (never seeded, never used):** `support@allcasting.com`, `support@projectcasting.com`, `support@productionbeast.com`, `hello@heybooker.app`, `casting@backstage.com` (all platform support/posting addresses), `uigroup@ep.com` (employment verification only), `BILLING@CASTINGNETWORKS.COM` (refunds only), `talentsupport@castitsystems.com` (support). The new endpoint refuses the first six with a 400.

## 8. Remaining PACKAGE READY ceiling (honest)

Even with everything above, most sources stay PACKAGE READY: ProjectCasting (229 records), AuditionsFree, HeyBooker, ActorsAndExtras, Mandy, and Casting TaylorMade don't use email as the application channel at all. **Realistic gain: AllCasting ~35–40% of its listings now sendable by email (41/122 today) + occasional per-project emails via the body regex on reposted calls + future web-type listings from seeded posters resolving through contacts.** The auto-runner will now actually send on the converted AllCasting listings on its normal cycle; everything else still needs the portal/manual route, with the package (ref code + portfolio link) prepared.

## Files changed / created

- `tools/sweep-opportunities.py` — castingCall parse, body-email regex, casting_org, click-through, `--backfill-allcasting` mode (merge-safe seed write).
- `tools/allcasting-orgfix.py` — one-off org correction pass (resumable).
- `tools/allcasting-backfill-progress.jsonl` — 122-line checkpoint (resumable).
- `tools/allcasting-orgfix-progress.jsonl` — 49-line checkpoint.
- `tools/allcasting-contacts-seed.json` — 14 entries, ready to post after deploy.
- `server/src/server.ts` — POST /api/v1/contacts (pushed, commit `db1aa23f`, awaiting Render deploy).
- `tools/email-source-audit-2026-11-23.md` — the audit this implements (unchanged).
