# Top Tea Talents — Email Source Audit
**Date:** 2026-11-23 (checked live ~12:00–12:20 EST)
**Why:** the auto-runner keeps landing PACKAGE READY because most listings carry no submission email. This audit checks every source for where an email actually exists.
**Rule followed throughout:** an address appears below ONLY if it was seen on a live page. Anything not seen is recorded as null with the reason.

## Headline findings
1. **AllCasting DOES publish a submission email on many listings — our harvester just never reads it.** Every AllCasting detail page embeds a `castingCall` JSON object with `agent_email` and `type`. In a live sample of 8 listings, 3 were `type:"email"` (submit by email). Capturing that one field would convert roughly a third of AllCasting listings from PACKAGE READY to sendable. No backend change is needed to use it (see below).
2. **The backend already supports emailed destinations.** `resolveDestination` (server.ts ~2974) reads an email from `submission_instructions`, `contact_email`, or `casting_professional`, then falls back to a `contacts` table lookup by org name. `POST /api/v1/opportunities` stores the whole record as JSON, so a `contact_email` field posted by the sweeper persists with zero server change.
3. **Every other fetchable source has no per-listing email by design.** ProjectCasting, AuditionsFree, HeyBooker, ActorsAndExtras, ProductionBeast (unverified — 500s) and Craigslist route applications through on-site forms, in-app apply, login walls, or a reply button. There is no email to harvest from them.
4. **Platform support addresses are NOT submission destinations.** `support@allcasting.com`, `support@projectcasting.com`, `support@productionbeast.com`, `hello@heybooker.app`, `casting@backstage.com` are all verified on live pages — but they are for site support / posting a casting, not for applying. They must never be used as a per-listing destination or seeded into the contacts table as an org fallback.
5. **Casting Networks / Central Casting per-project emails DO exist in public call text** (e.g. `jeffreywsubmissions@centralcasting.com`, `vpcastingsubmissions@gmail.com` visible on public castingnetworks.com call pages), but those sources are login-walled and not fetchable by the sweeper today.

## What the harvester captures today
`tools/sweep-opportunities.py` — `parse_detail()` builds each record with: title, category, location/geography, production_dates, deadline, compensation. It hard-codes `submission_instructions: None` and sets `employer`, `casting_org`, `casting_professional`, `roles`, `positions` to None. **It contains no email regex, no `mailto:` scan, and no `contact_email` field at all** (the only email-adjacent strings in the file are the Craigslist `submission_instructions` text "Reply via the Craigslist posting (link below)."). The Craigslist branch sets that instruction text but no address. So today, 0% of swept records can carry a destination email — every send depends on the backend's contacts table or an admin-supplied address.

Live DB state at audit time: 434 opportunities. By source: projectcasting 229, allcasting 122, backstage 27 (seed), castingnetworks 13 (seed), instagram 10 (seed), mandy 10 (seed), other-social 6, actorsandextras 5, heybooker 4, castingandacting 3, other 2, auditionsfree 1, castingtaylormade 1, centralcasting 1. `contact_email` is null on every record checked; `submission_instructions` is null on all swept records (only seed records carry instruction text).

---

## Fetchable sources

### 1. AllCasting — EMAIL AVAILABLE (partial, ~3/8 sampled)
- **Sample listings checked live:** `allcasting.com/castingcall/325887` (Female Athlete, Miami Beach), `/325884`, `/295773` (AutoZone), `/308586`, `/324595`, `/324815`, `/324878`, `/325026` (Margaritaville Couples).
- **Listing email:** YES, when `type:"email"`. Each detail page embeds a JSON blob with a `castingCall` object for the page's own listing: `{"id":325887, "title":"Now Casting Female Talent: Paid Role as Female Athlete", "agent_name":"Julia Ulanova", "agent_email":"submit@utalentsmiami.com", "type":"email", ...}`. The listing description itself says "Submit by email for instructions!". Verified submission addresses seen: `submit@utalentsmiami.com` (325887), `miamitalentcasting@gmail.com` (295773 AutoZone + 308586, agent "Miami Talent Casting Inc").
- **Sample breakdown (8 listings):** 3 `type:"email"`, 4 `type:"web"`, 1 `type:"url"` (325026, empty `agent_email`). Web-type listings still expose an `agent_email` (e.g. `madeline@madelinestrum.com` on 325884) but the listing instructs on-site apply — that address is the poster's contact, NOT the submission route, and must not be used as the destination.
- **Apply flow:** `type:"email"` → email the agent address. `type:"web"` → apply on allcasting.com (account). `type:"url"` → apply via an external/on-page apply link; no email exists.
- **Platform contact (verified, support only — NOT a submission address):** `support@allcasting.com` (seen on `allcasting.com/contact`, HTTP 200).
- **Harvester change needed:** parse the embedded `castingCall` JSON (note: quotes are backslash-escaped in the page source, `\"castingCall\"`), capture `agent_email` + `type`. When `type == "email"`, set `contact_email` = agent_email and `submission_instructions` = "Submit by email to {agent_email}". When `type` is web/url, record the method and leave `contact_email` null. No backend change needed.

### 2. ProjectCasting — NO email on listings
- **Sample checked live:** `projectcasting.com/job/miss-florida-us-nation-2027` (HTTP 200, ~444KB fetched). Zero email addresses in the page HTML (the only `@` matches were asset filenames). No "Apply Now" button exists in the server-rendered HTML — the apply module (`.td-job-module-apply`) is JS-rendered.
- **Apply flow:** on-site application form, account/login required; submission instructions are behind the login wall.
- **Platform contact (verified, support only):** `support@projectcasting.com` (seen on `projectcasting.com/contact-us`, HTTP 200).
- **Harvester change needed:** none available — there is no email on the listing page to capture. A logged-in fetch is out of scope (no credentials, and the task forbids account creation).

### 3. AuditionsFree — NO email on listings
- **Sample checked live:** `auditionsfree.com/2026/now-casting-miami-extras-for-miami-vice-movie/` (HTTP 200). Zero emails on the page. The post names "Casting TaylorMade" and its "early casting interest list" in plain text with **no hyperlink and no email** — the application lives off-site at the named casting company.
- **Apply flow:** follow the named casting company off-site (in this case Casting TaylorMade's own web form).
- **Platform contact:** null — `auditionsfree.com/contact/` (HTTP 200) shows a contact form only, no email address anywhere on the page.
- **Harvester change needed:** none available. Optional: capture the named casting company from the post text into `casting_org` (currently always null) so the backend's contacts-table lookup has something to match against — but that only helps once contacts are seeded.

### 4. CastingAndActing — NO email; apply = click through to the ORIGINAL listing
- **Sample checked live:** `castingandacting.com/en/castings/singers-and-dancers-including-latin-pop-artists-who-sing-in-spanish-876/` (HTTP 200). Only emails on the page were form placeholders (`name@example.com`, `you@email.com`). The page's apply route is a "See the original listing" button → `api.castingandacting.com/api/casting-click.php?id=876`, which redirects to the original posting — in this case a Playbill job page. The Playbill page (fetched live) has **no email and no mailto**; the audition is in-person (bring headshot/CV).
- **Apply flow:** click-through to the original source; submission method depends on that source.
- **Platform contact:** null — `castingandacting.com/en/contact/` (HTTP 200) shows no email address.
- **Harvester change needed:** small — follow the `casting-click.php?id=` redirect and store the final original-listing URL as the apply destination (the record's `source_url` is currently the CastingAndActing summary page). Low value: the original sources checked so far don't publish emails either.

### 5. HeyBooker — NO email on listings; platform contact verified
- **Sample checked live:** `heybooker.app/casting-calls/miami/` (HTTP 200). The only email on the page is `hello@heybooker.app` (a `mailto:` link, site-wide contact). No per-listing email; listings are applied to in-app (one-tap apply, match scores).
- **Apply flow:** in-app one-tap application; account required.
- **Platform contact (verified, general contact — NOT a submission address):** `hello@heybooker.app`.
- **Harvester change needed:** none available. Note: `heybooker.com` (bare domain) does not resolve from this VM; the app lives at `heybooker.app`.

### 6. ActorsAndExtras — NO email; full details behind free login
- **Sample checked live:** `actorsandextras.com/casting-calls` (HTTP 200 via text fetch; the VM's direct fetch 502s, so the sweeper's harvest of this source is fragile). The page states: "join as a free Talent Member to unlock full details and apply." Hosted castings use on-site "Register Interest" (host reviews your profile); linked castings send you to an external site. No email appears anywhere on the public index.
- **Apply flow:** free Talent Member account → "Register Interest" on-site, or follow the external link for linked castings.
- **Platform contact:** null — `actorsandextras.com/contact-us` (HTTP 200) is a join/pricing page with no email address.
- **Harvester change needed:** none available without an account. The sweeper's index fetch already fails from this VM (502) — the source is effectively unharvestable right now except via the text-fetch route.

### 7. ProductionBeast — UNVERIFIED (detail pages 500; index returns spam content to crawlers)
- **Checked live:** `app.productionbeast.com/jobs/5855-slope-2` and `/5854-drift-boss` both return HTTP 500 from this VM (same 500s the noon sweep logged as detail-fetch errors). The jobs index `app.productionbeast.com/jobs/` fetched via text crawl returns SEO-spam content (game articles, "Slope Game", etc.) — no job listings and no emails visible; the real board is JS-rendered.
- **Apply flow (from platform docs):** free account, apply on-site for jobs. No per-listing email observed anywhere.
- **Platform contact (verified, support only):** `support@productionbeast.com` (seen on `productionbeast.com/privacy/` and `/terms/`).
- **Harvester change needed:** none until the 500s resolve. The 500s may be transient or bot-gating; worth one re-probe next sweep. If detail pages start returning 200, scan the job JSON for a contact/recruiter email field before assuming none exists.

### 8. Craigslist — NO email by design; reply via the posting
- **Checked:** `miami.craigslist.org` RSS returns 403 from this VM (datacenter egress blocked); the browser policy blocks `miami.craigslist.org` entirely, so no live page check was possible this round. The RSS feed carries no email field.
- **Apply flow (known mechanics, not re-verified live this round):** each posting has a "reply" button that reveals a per-post anonymized relay address (`<hash>@craigslist.org`); replies go through Craigslist's relay, and the address only works for that post. There is no stable submission email to harvest.
- **Platform contact:** null — Craigslist publishes no contact email (help pages + web forms only).
- **Harvester change needed:** none. The sweeper already sets the correct instruction ("Reply via the Craigslist posting (link below)."). Keep as-is.

---

## Not fetchable / not connected

### 9. Backstage — PARTIAL: per-notice email exists, but behind login
- **Platform contact (verified, for POSTING a casting — NOT for applying):** `casting@backstage.com` (seen on `faq.backstage.com` casting-overview deck: "CONTACT: casting@backstage.com ... to post a notice").
- **Listing email:** partial. Backstage's own casting-director help states each notice has Email fields for "the email address you want to use for receiving submissions" — so individual notices CAN carry a submission email, but notices are login-walled; the harvester cannot fetch them. The one email ever sent by the system was a Backstage listing (3335382, 06:21 UTC 2026-11-23) — proof a destination can exist on a Backstage record. (That record could not be re-fetched for this audit — the API returned 404 for it — so which field supplied the destination is unverified.)
- **Apply flow:** on-site Application Manager; talent applies inside Backstage with an account; casting directors manage submissions there.
- **Harvester change needed:** none without credentials. If a Backstage account is ever connected, the per-notice email field is the thing to capture.

### 10. Casting Networks — PARTIAL: per-project emails visible in public call text
- **Listing email:** partial/yes. Public call pages on `castingnetworks.com` show submission emails in the visible text — verified in live search results: "If available please email jeffreywsubmissions@centralcasting.com ..." and "you must ALSO send us a selfie to: vpcastingsubmissions@gmail.com". Full details (including the apply button) require joining/logging in.
- **Platform contact:** null for submissions. `BILLING@CASTINGNETWORKS.COM` (refunds only) and `talentsupport@castitsystems.com` (Cast It Talent support) were seen, but neither is a submissions address.
- **Apply flow:** on-site via Casting Billboard; account required.
- **Harvester change needed:** if a fetch route is ever added, the public call pages are regex-able for emails (they sit in plain text). Blocked today: not connected, no fetchable route, login wall for full details.

### 11. Central Casting — NO platform email; per-project emails circulate inside call notices
- **Listing email:** partial. No submissions inbox exists. Individual background calls name a per-project email inside the notice — verified examples: `centralcastingalexis@gmail.com` (in a ProjectCasting repost of a Central Casting call) and `jeffreywsubmissions@centralcasting.com` (on a Casting Networks call page). Those addresses are per-project and expire with the call.
- **Platform contact:** null. `uigroup@ep.com` (seen on centralcasting.com support pages) is for employment verification only — NOT submissions. Registration is digital at `centralcasting.com` (sign-up + profile); jobs for CA/NY/GA/LA are at `centralcasting.com/jobs`. Florida has a casting-services page but no talent submissions inbox.
- **Harvester change needed:** none directly. Indirect lever: when a reposted Central Casting call is swept from ProjectCasting/Casting Networks, an email regex over the listing body would catch the per-project address (see recommendation 4).

### 12. Mandy — NO email; submission instructions behind login
- **Checked live (search results):** Mandy listing pages show "Become a Mandy member or log in to view additional details, including key audition and/or submission instructions." No public contact email was found anywhere.
- **Apply flow:** on-site, account required (Mandy is part of the Backstage network).
- **Platform contact:** null.
- **Harvester change needed:** none without an account.

### 13. Casting TaylorMade — NO email; apply = per-production web forms
- **Checked live (search results):** no email address found anywhere for Casting TaylorMade. Applications run through per-production web forms on their own site — verified live links: `castingtaylormade.com/miamivice` (Miami Vice background + specialty), `/mv-kids`, `/classicsmiami`, `/baseball`. Contact is by text (Heather, (305) 951-8291, seen on their MIA pages) — not email.
- **Apply flow:** fill the production's web form with info + photos; booked talent is contacted directly.
- **Platform contact:** null.
- **Harvester change needed:** none. Note: Casting TaylorMade is the casting company behind the AuditionsFree Miami Vice listing — the chain is AuditionsFree post → TaylorMade web form, with no email at any step.

### 14. Instagram — NO email route
- **Listing email:** none. Casting posts on Instagram take applications by DM or link-in-bio forms. No email field exists on a post.
- **Platform contact:** null.
- **Harvester change needed:** none. Any Instagram route would be DM-based, which is a different capability (and needs an account), not an email harvest.

---

## Summary table

| Source | Listing email? | Apply destination | Platform contact (verified) | Harvester change needed |
|---|---|---|---|---|
| AllCasting | YES — ~3/8 sampled (`type:"email"`) | Email the agent, or on-site / external link | support@allcasting.com (support only) | Parse `castingCall` JSON → `contact_email` when type=email |
| ProjectCasting | No | On-site JS form, login required | support@projectcasting.com (support only) | None available |
| AuditionsFree | No | Named casting company off-site | null (contact form only) | None available |
| CastingAndActing | No | Click-through to original listing | null | Follow click-through; low value |
| HeyBooker | No | In-app one-tap apply | hello@heybooker.app (general contact) | None available |
| ActorsAndExtras | No | On-site "Register Interest" / external link, free login | null | None available; VM fetch 502s |
| ProductionBeast | Unverified (500s) | On-site apply, account required | support@productionbeast.com (support only) | None until 500s resolve |
| Craigslist | No (by design) | Reply button → per-post relay | null | None |
| Backstage | Partial (per-notice email, login-walled) | On-site Application Manager | casting@backstage.com (posting only) | None without account |
| Casting Networks | Partial (per-project email in public call text) | On-site Casting Billboard, login | null for submissions | None without fetch route |
| Central Casting | Partial (per-project email inside notices) | Register on-site; per-call email | null (uigroup@ep.com is verification only) | None directly; see rec. 4 |
| Mandy | No | On-site, login required | null | None without account |
| Casting TaylorMade | No | Per-production web form | null (contact by text) | None |
| Instagram | No | DM / link-in-bio | null | None (DM capability, not email) |

## Recommended harvester changes, ordered by impact
1. **AllCasting `castingCall` JSON parse (HIGH — the only change that converts PACKAGE READY to sent).** In `parse_detail()`, extract the embedded `castingCall` object (quotes are backslash-escaped in page source). Capture `agent_email` and `type`. If `type == "email"`: set `contact_email` = agent_email and `submission_instructions` = "Submit by email to {agent_email}". If `type` is `web`/`url`: set `submission_instructions` to "Apply on AllCasting" / "Apply via the listing link" and leave `contact_email` null (do NOT use the agent email — it is not the submission route for those). No server change needed: `POST /api/v1/opportunities` persists the whole record and `resolveDestination` already reads `contact_email`. Expected yield: ~35–40% of AllCasting listings (3/8 sampled). AllCasting is 122 of 434 live records and the largest email-capable source.
2. **Backfill existing AllCasting records (HIGH — same code, one pass).** Re-fetch detail pages for the 122 live AllCasting ids, run the same extraction, and PATCH `contact_email` / `submission_instructions` where `type == "email"`. This converts already-packaged AllCasting applications (e.g. the AutoZone + Male+Female commercial packages) from portal-link to emailable without waiting for new sweeps.
3. **Seed the `contacts` table from verified agent emails (MEDIUM).** Every `type:"email"` AllCasting listing also yields a verified org→email pair (e.g. "Miami Talent Casting Inc" → `miamitalentcasting@gmail.com`). Store those in the backend `contacts` table (keyed by normalized org name) so repeat posters resolve even when a later listing is `type:"web"`. Only seed from listing data actually seen — never guessed, never platform support addresses.
4. **Add a body-email regex as a second net for reposted calls (MEDIUM, small code).** In `parse_detail()`, after the main parse, run an email regex over the listing body and — only when the body text explicitly frames it as a submission address (near "submit", "send to", "email your", "apply by email") — set `contact_email`. This would catch Central Casting per-project emails that circulate inside ProjectCasting/Casting Networks reposts. Guard: never take the first email on the page (AllCasting pages carry other listings' agent emails in the same JSON feed — scoping to the page's own `castingCall` object is what makes change 1 safe).
5. **Capture `casting_org` from post text where the source names it (LOW).** AuditionsFree posts name the casting company (e.g. Casting TaylorMade). Filling `casting_org` gives the backend's contacts lookup something to match. Only helps after change 3 seeds contacts.
6. **Re-probe ProductionBeast 500s next sweep (LOW).** If detail pages return 200, scan for a contact/recruiter email field before concluding none exists. No code change until then.
7. **Do NOT do:** do not use platform support addresses (`support@allcasting.com`, `support@projectcasting.com`, `support@productionbeast.com`, `hello@heybooker.app`, `casting@backstage.com`) as submission destinations or contacts-table entries — they are for site support / posting castings, and emailing applications there would spam platform support. Do not email `uigroup@ep.com` (employment verification only). Do not scrape the first email found on a page — on AllCasting that picks up other listings' agents.

## What this does NOT fix
Even with change 1 + 2, most sources will stay PACKAGE READY: ProjectCasting (229 records, the largest source) publishes no email by design, and neither do AuditionsFree, HeyBooker, ActorsAndExtras, Mandy, or Casting TaylorMade. For those, the honest submission route remains the portal/app link in the package — email is not the channel those platforms use. The realistic ceiling from email harvesting is AllCasting (~35–40% of its listings) plus occasional per-project emails caught by change 4.
