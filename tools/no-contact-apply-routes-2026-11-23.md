# Top Tea Talents — How We Actually Contact the No-Email Listings
**Date:** 2026-11-23 (researched ~12:55–13:05 EST)
**Owner order:** "If they have no contact how do we contact them I don't understand you have to figure that part out." (2026-11-23 ~12:55 EST)
**Basis:** `tools/email-source-audit-2026-11-23.md` + `tools/email-harvest-build-report-2026-11-23.md` (both read first), plus live web searches and live page fetches done for this report.

## The short answer
Most of these platforms were **never email channels**. The contact IS the platform's own apply button or form — email doesn't exist because the platform is designed to keep the application inside itself. So "no contact" was the wrong frame: the routes are (a) email where an address exists (AllCasting 41, per-project emails in reposted calls), (b) the platform's own form/button submitted with a **free** account where the platform is free, and (c) a public web form or a reply-relay address where no account exists at all. Three platforms are genuinely paywalled — Backstage, Casting Networks, Mandy — there is **no free route** to submit there; the only free contact is when their public call text names an email address.

**Rules this report follows:** $0 only — a paid membership is recorded as BLOCKED with its price, never proposed as the fix. No account was created and nothing was submitted — identity-bearing sign-ups need the owner's go-ahead; what each signup needs is recorded instead. No real application, email, DM or text was sent. Platform support addresses are never destinations.

## Per-source routes

### 1. ProjectCasting — 229 records (largest source) — FREE ACCOUNT, 1/DAY CAP
- **How a talent applies:** Free account at projectcasting.com/signup (email + verification code, full name). Complete the profile (headshot, resume, video reel, skills, experience). On a job page click **"Apply now"** → if the profile is complete, review it and click **"Submit Application"** — the profile goes to the casting company. Tracked under "Job Applications". Help center: support.projectcasting.com "How to Apply for a Job on Project Casting".
- **Account / cost:** Free account, $0. **Free tier limit: 1 application per day** (per the platform's own help center). Unlimited needs Premium — price conflicts across sources: the talent page lists **$19.99/month billed annually**; Project Casting's own 2026 comparison lists **$50/month or $239.99/year** (confirmed Sept 2026). The 1/day free fact is consistent everywhere; the Premium price is not — verify on the pricing page before quoting it.
- **Fields needed:** profile (headshot, resume, video reel, skills, experience). Our prepared package (ref code + portfolio link + talent profile) covers it — the profile IS the application; no per-job cover letter is described.
- **Automatability:** **Automatable with a free account, throttled to 1/day per talent.** Build: logged-in browser session, navigate to the job, click Apply now → Submit Application. Needs its own 1/day throttle per talent (the auto-runner's 3/day cap already exceeds it — do not apply it). **Blocker: the accounts don't exist yet.** Creating them is an identity-bearing sign-up (owner's email + verification code) — needs the owner's go-ahead; the machine cannot create them on its own.
- **Verified:** help-center apply flow + free-account signup pages, fetched via live search 2026-11-23.

### 2. AuditionsFree — apply follows the NAMED CASTING COMPANY off-site
- **How a talent applies:** Each post names the casting company and the application lives on that company's own site. Example (verified in the audit): the Miami Vice post names **Casting TaylorMade** and its early casting interest list — no hyperlink and no email on the post itself. Other posts name other companies (Hylton Casting, C&J, GSN, etc.) and some link out to the company's form.
- **Account / cost:** No AuditionsFree account exists or is needed. Cost depends on the destination company — TaylorMade's form is free (see §13).
- **Fields needed:** Whatever the destination company's form asks (TaylorMade: full profile + 2 photos — see §13).
- **Automatability:** **Automatable per destination company, no account.** The sweeper change is: capture `casting_org` (already built) **and any outbound apply link on the detail page** (not yet built — the Miami Vice post had none, so the org name is the link). Then route by company: TaylorMade → Tally form submitter (§13); other companies → their own form/email.
- **Verified:** auditionsfree.com homepage fetched live 2026-11-23 (posts are summaries; detail pages carry the company name). Miami Vice detail page checked in the audit (no link, no email).

### 3. HeyBooker — AGGREGATOR, NOT A DESTINATION (4 records)
- **How a talent applies:** HeyBooker does not submit anyone itself. Its own words: "It finds casting calls that fit you, scores them against your profile and helps you prepare applications you review and send yourself." In the app, Booker (AI assistant) drafts the application in the talent's voice; the talent sends it **by email with comp card attached, by copying it into a DM, by filling the form, or by submitting directly on a connected platform**. "Applications through a connected platform go out under your own account."
- **Account / cost:** Free profile, $0. **Free tier: 3 applications a month**, each drafted for you, 1 comp card. Plus **$7.99/month** = unlimited applications (you send them). Pro (price not shown on the public page) submits Casting Networks applications for you. Pro free for the first 30 days, no card needed.
- **Fields needed:** the drafted application + comp card (photos) — our package covers it.
- **Automatability:** **Semi — the original route is the automation.** HeyBooker is not a submit endpoint; each listing "keeps a link to its original post". The harvester fix is: capture the **original-post link** per HeyBooker listing (the public Miami index page fetched live shows titles only — no per-listing links in the text; the link lives inside the app), then apply via the original source's route (email / DM / form). Using HeyBooker's own free tier directly is capped at 3/month.
- **Verified:** heybooker.app homepage + /casting-calls/miami/ (152 open) fetched live 2026-11-23.

### 4. ActorsAndExtras — FREE ACCOUNT, ONE-CLICK "REGISTER INTEREST" (5 records)
- **How a talent applies:** Join as a **free Talent Member** (profile: photos, bio, experience, location). Hosted castings: click **"Register Interest"** — the host reviews your profile and contacts you directly. Linked castings: follow the direct link and apply on the external site.
- **Account / cost:** Free, $0, no cap mentioned anywhere. "Completely free to use for both parties. No commissions or hidden charges."
- **Fields needed:** the profile itself (headshot + full-body photo recommended, name, location, age range, height, appearance, skills).
- **Automatability:** **Automatable with a free account.** Build: logged-in browser session, open the casting, click Register Interest. One click per casting, profile-based, no form to fill. **Blocker: the account doesn't exist yet** — identity-bearing sign-up, needs the owner's go-ahead. Note: the VM's direct fetch of actorsandextras.com 502s (sweeper harvest is fragile here); the text-fetch route works.
- **Verified:** actorsandextras.com/casting-calls copy fetched via live search 2026-11-23 ("Join as a Talent Member to create your profile… Register Interest").

### 5. ProductionBeast — FREE ACCOUNT, BUT PAGES ARE DOWN (500)
- **How a talent applies:** Free account ("Sign up and apply for jobs for FREE! Create Free Profile"), on-site apply, profile-based. Under StudioBinder since 2017: "completely free to post jobs and apply to jobs."
- **Account / cost:** Free, $0.
- **Fields needed:** freelancer profile (role, credits, resume).
- **Automatability:** **Blocked at fetch, not at price.** Detail pages `app.productionbeast.com/jobs/5855-slope-2` and `/5854-drift-boss` return **HTTP 500** — re-verified just now via browser text fetch (3 attempts, still 500). The jobs index returns SEO spam to crawlers. Until the 500s resolve there is nothing to apply to. Also low value: ProductionBeast is mostly **crew/production jobs** (PA, grip, editor), not talent casting — marginal for Joseph/Mona Lisa.
- **Verified:** 500 re-probed live 2026-11-23; free-account copy from the platform's own pages + 2017 StudioBinder acquisition release.

### 6. Craigslist — REPLY RELAY, NO ACCOUNT (reach currently blocked)
- **How a talent applies:** Every posting has a **Reply** button. Clicking it reveals the poster's contact method — usually a per-post anonymized relay address like `<hash>@sale.craigslist.org` (replies come back via `<hash>@reply.craigslist.org`). You send a normal email to that address from your own mail client; Craigslist relays it to the poster's real inbox without exposing either address. Some posters instead put a phone number or a direct email in the ad body. Conversations persist up to ~4 months after the ad is removed.
- **Account / cost:** No account, $0.
- **Fields needed:** an email with headshot/resume attached (our prepared package fits exactly — the relay just delivers the email).
- **Automatability:** **Fully automatable with zero account — once the page is reachable.** Build: browser task opens the posting → clicks Reply → copies the relay address → the existing Gmail mailer sends the prepared application to it. **Current blocker is reach, not the mechanism:** the VM's RSS fetch returns 403 and the browser policy blocks `miami.craigslist.org`, so today we cannot open a posting page at all. Needs a fetch workaround (search-engine cache, alternate route, or a policy exception) before the relay step can run. Also: when a posting body contains a direct email/phone, the sweeper should regex it (needs the same fetch fix first).
- **Verified:** relay mechanics confirmed across multiple 2026 sources (itstillworks, techwalla, copyprogramming 2026 guides). Reach block confirmed in the audit and unchanged.

### 7. Backstage — PAID TO APPLY (27 seed records) — BLOCKED
- **How a talent applies:** In-platform **Apply** button on the casting notice (select the role → Apply). Profile-based; casting directors manage submissions in the Application Manager. Per-notice submission emails exist (casting directors set "the email address you want to use for receiving submissions") but they sit **behind the login wall**.
- **Account / cost:** Browse free; **applying needs a paid membership — $24.99/month, $74.99/3 months, $119.99/6 months, $199.99/year** (US App Store listing, checked Nov 20, 2026). Older sources quote $19.99/mo / $149.99/yr — price has risen; current is $24.99/mo. One stale source mentions "six months free, no card required" — unverified promo copy, do not rely on it.
- **Fields needed:** Backstage talent profile (headshots, resume, media).
- **Automatability:** **BLOCKED (paid).** No free route to submit. The only free contact is a per-notice email — unreachable without a paid account. Do not build around this source under the $0 rule.
- **Verified:** Serpastra Nov 2026 price check + Backstage help (apply flow).

### 8. Casting Networks — PAID TO SELF-SUBMIT (13 seed records) — BLOCKED, EMAIL BYPASS EXISTS
- **How a talent applies:** Free basic profile (2 photos, 1 video, 1 audio). Roles live on the **Casting Billboard**; to self-submit you click the breakdown, pick a headshot, add a brief cover note, Submit. **Agents can submit free-profile talent at no cost to the talent.**
- **Account / cost:** Free account, $0 — but **self-submit needs Premium: $29.99/month or $299.90/year**. Free tier can browse the Billboard and answer direct audition/media requests, but cannot self-submit.
- **Fields needed:** profile + headshot choice + 1–2 sentence cover note.
- **Automatability:** **BLOCKED for self-submit (paid). Email bypass (free):** public call pages carry per-project submission emails in plain text — verified examples `jeffreywsubmissions@centralcasting.com` and `vpcastingsubmissions@gmail.com`. Those are already caught by the body-email regex net built in the harvest. So the free route here is email-only, when the call text names one.
- **Verified:** actingresources setup guide + castingandacting comparison, Oct–Nov 2026.

### 9. Central Casting — REGISTRATION FREE (1 record)
- **How a talent applies:** Register free at centralcasting.com (online application: contact info, appearance details, measurements, headshot + full-body photo). **Form I-9** required in CA/NY/GA/LA before eligibility; for other states the sign-up path is the "any other state" link. Applications are **open Mon 9:30 AM EST – Fri 8:30 PM EST**; staff review takes 7–10 business days. Work comes two ways: **booking messages** from casting (email/text — "respond fast, calls are often filled the day before") and the **Open Roles** page. Per-call emails also circulate inside notices (e.g. `jeffreywsubmissions@centralcasting.com`).
- **Account / cost:** Free, $0. "Legitimate casting never charges you a fee to get work. Central Casting registration is free."
- **Fields needed:** profile (photos, sizes, playing age, skills, vehicles) + I-9 documents (identity step).
- **Automatability:** **Automatable with a free account, after a human registration.** Registration itself needs the owner (photos + I-9 docs are identity-bearing). After that: (a) email replies to per-call addresses are fully automatable with the existing mailer; (b) Open Roles monitoring needs a logged-in session watch. Florida note: Central Casting announced July 2026 that background casting is now open in **all 50 states** (was CA/NY/NJ/GA/LA only) — Florida talent registers via the other-states path.
- **Verified:** centralcasting.com Get Cast page + 2026 background-actor guides, fetched via live search 2026-11-23.

### 10. Mandy — PAID TO APPLY (10 seed records) — BLOCKED
- **How a talent applies:** On-site apply; submissions go through the platform with profile materials attached automatically.
- **Account / cost:** Browse free; **applying needs a subscription — $14.99/month, $75/6 months, $119.99/year** (US App Store listing, checked Nov 10 + Nov 20, 2026). Older sources quote $7.95/mo or $50/yr — price has risen. Some review sites claim a limited free application allowance on the free tier; the current App Store listing says a subscription is needed to apply — treat as paid.
- **Fields needed:** Mandy profile (headshot, resume/CV, demo reel).
- **Automatability:** **BLOCKED (paid).** No free route. Do not build around this source under the $0 rule.
- **Verified:** Serpastra + ProductionHelp Nov 2026 App Store price checks.

### 11. Casting TaylorMade — PUBLIC WEB FORM, NO ACCOUNT — VERIFIED LIVE
- **How a talent applies:** Per-production web form on their own site — **no account, no cost**. Verified live 2026-11-23: `castingtaylormade.com/miamivice` embeds the Tally form `tally.so/r/LZAXbv` ("MIAMI VICE x casting™ | open call | submission form"). Other live form URLs seen: `/mv-kids`, `/classicsmiami`, `/baseball`, `/rjd-casting-call/august-2026`, `/daytona`, `/challenger-bars`. Also contact by **text: Heather, (305) 951-8291** (already in the contacts seed file).
- **Account / cost:** None. $0.
- **Fields needed (full list, read off the live form):** full name, phone, email, date of birth, gender, ethnic appearance, city, state; real-life experience (multi-select: public safety/law, sports, hospitality/nightlife, classic vehicles/Miami culture, prior film/TV/print/commercial work + free-text explanation); height, weight (lbs), hair color, hair-cut/modification consent, bathing-suit/wardrobe comfort, tattoos; shirt/blouse size, shoe size; vintage vehicle (1960–1989 car, +$250 / +$200); filming availability dates, paid-fitting availability, overnights/splits OK; **2 photos — 1 current close-up + 1 current full body, ≤10 MB each, no videos**; legal-to-work-in-USA attestation; English-language confirmation; referred-by; booking-texts opt-in.
- **Coverage check:** our talent profile covers name/phone/email/DOB/gender/city/state/photos. **Gaps to fill on the talent record:** height, weight, hair color, tattoos, shirt/shoe sizes, hair-cut consent, availability dates, vintage-vehicle ownership. Joseph's profile is 90% complete — confirm these fields exist before the first submit; add them to the profile if missing.
- **Automatability:** **FULLY AUTOMATABLE WITH ZERO ACCOUNT — the single best next build.** Build: sweeper captures the per-production form URL (`castingtaylormade.com/<slug>`); a form-submitter (browser task, or Tally's own submission endpoint once inspected) fills it from the talent record + the 2 profile photos and submits; the submission is logged as SENT with the form URL + timestamp. Each production has its own form, so the submitter must read the field list per form (Tally forms share the same structure — verify per form). Live value right now: Miami Vice '85, filming Dec 2026–Feb 2027 in Miami, **$212/12 hrs + $50/3 hr fitting**.
- **Verified:** form fetched live twice (tally.so + castingtaylormade.com) 2026-11-23; every field above is quoted from the live form.

### 12. Instagram — DM / LINK-IN-BIO (10 seed records)
- **How a talent applies:** Casting posts take applications by **DM to the poster** (intro + headshot) or via a **link-in-bio form**. No email route exists on a post.
- **Account / cost:** Needs an Instagram account (the user has one; the system has an `instagram_messages` connector that can read/send DMs). $0.
- **Fields needed:** whatever the post asks — usually name, look, photos, availability. Our package covers it.
- **Automatability:** **Semi — per-post, human-reviewed.** The sweeper must capture the poster handle + the post's stated instructions; the DM goes out through the Instagram connector as the user. Risks: unsolicited DMs at volume trip spam flags, and a DM is visibly from the user's own account. Recommend: DM only for strong matches, one at a time, with the owner able to see each. Not a bulk channel.
- **Verified:** mechanism as stated in the audit (DM/link-in-bio); not re-verified live this round — no new evidence needed, the mechanism is the platform's design.

### 13. CastingAndActing — CLICK-THROUGH, PASS-THROUGH (3 records)
- **How a talent applies:** The "See the original listing" button follows `api.castingandacting.com/api/casting-click.php?id=N` to the original posting (verified live: id 876 → a Playbill page; audition in-person, bring headshot/CV, no email). The apply route is whatever the original source says.
- **Account / cost:** None on CastingAndActing itself.
- **Fields needed:** Per the original source.
- **Automatability:** **Pass-through.** The harvester already resolves the click-through to the original URL (built in the harvest). No further build; value is low (3 records, originals so far have no remote route).
- **Verified:** audit + harvest build report.

### 14. AllCasting type=web / type=url — ACCOUNT, PAID TIER UNCERTAIN (81 of 122 records)
- **How a talent applies:** `type:"web"` → apply on allcasting.com with an account (one-click profile submit). `type:"url"` → apply via the external link on the listing.
- **Account / cost:** **Conflicting sources — needs a live pricing check before relying on it.** ActorsJunction (2026) claims "completely free… no subscription fees, premium tiers, per-submission charges." AllCasting's own 2018 interview says membership/subscription covers "seamless application to an unlimited amount of casting calls" with a fee depending on plan. A third review lists free vs premium: free = profile + limited viewing, **apply = premium only, ~$29.99/month**. The safe reading: free account lets you create a profile and browse; **applying on-site may need premium (~$29.99/mo)**. The 41 `type:"email"` listings are unaffected — email needs no account at all.
- **Fields needed:** AllCasting profile (photos, physical stats, experience, skills, reel).
- **Automatability:** **Email part: fully automated already. Web part: verify pricing live first** (browser task on allcasting.com pricing/onboarding). If free to apply → browser-session apply, same pattern as ProjectCasting. If premium → record BLOCKED (paid) for the web-type listings.
- **Verified:** price conflict documented from three live sources 2026-11-23; no live pricing-page check done in this report.

## Summary table

| Source | Records | Apply mechanism | Account | Cost | Automatability |
|---|---|---|---|---|---|
| AllCasting (email-type) | 41/122 | Email the agent | None | $0 | **Fully automated (done)** |
| AllCasting (web/url-type) | 81/122 | On-site apply / external link | Yes | Uncertain — maybe ~$29.99/mo premium | Verify pricing first |
| ProjectCasting | 229 | "Apply now" → profile submit | Yes, free | $0 (1/day); Premium $19.99–$50/mo | **Automatable, 1/day, needs accounts** |
| AuditionsFree | 1 live | Named company off-site | None | $0 | Per-company route |
| CastingAndActing | 3 | Click-through to original | None | $0 | Pass-through (done) |
| HeyBooker | 4 | Aggregator — drafts, talent sends | Yes, free | $0 (3/mo); Plus $7.99/mo | Capture original link, route there |
| ActorsAndExtras | 5 | "Register Interest" (one click) | Yes, free | $0 | **Automatable, needs accounts** |
| ProductionBeast | 0 live | On-site apply | Yes, free | $0 | Blocked — pages 500 |
| Craigslist | 0 live | Reply → per-post relay email | None | $0 | **Automatable once reachable** |
| Backstage | 27 seed | In-platform Apply | Yes | **$24.99/mo — BLOCKED** | Paid only |
| Casting Networks | 13 seed | Casting Billboard self-submit | Yes, free profile | **Premium $29.99/mo — BLOCKED** | Email bypass only |
| Central Casting | 1 | Free registration → booking msgs / Open Roles / per-call email | Yes, free | $0 | **Automatable after owner registration** |
| Mandy | 10 seed | On-site apply | Yes | **$14.99/mo — BLOCKED** | Paid only |
| Casting TaylorMade | 1 | Per-production web form (Tally) | None | $0 | **Fully automatable — BEST NEXT BUILD** |
| Instagram | 10 seed | DM / link-in-bio | Yes (have it) | $0 | Semi, per-post reviewed |

## Recommended build order
1. **Casting TaylorMade Tally-form submitter (BEST NEXT BUILD).** Zero account, zero cost, every field mapped from the live form, live high-value production (Miami Vice, $212/day, filming now). Same submitter pattern generalizes to every Tally/Google-Form casting form. Needs: sweeper captures the form URL per TaylorMade listing; talent-record gaps filled (height/weight/sizes/tattoos/availability); form-submitter + SENT logging.
2. **Craigslist relay.** Zero account, zero cost. Blocked only by reach — solve the fetch (RSS 403 + browser policy block on miami.craigslist.org), then: browser task reveals the relay address per post → existing Gmail mailer sends the prepared package. No new sending infrastructure needed.
3. **ProjectCasting free accounts (1/day).** Biggest source (229). Needs the owner to create the two free accounts (identity sign-up + email verification code). Then a logged-in browser session submits the profile, throttled to 1/day per talent.
4. **ActorsAndExtras free accounts.** Same pattern as #3, one-click Register Interest, zero friction after signup. Small source (5 live) but nearly free to add once the session pattern exists.
5. **Central Casting free registration.** Needs the owner (I-9 docs + photos). After that: email replies to per-call addresses (existing mailer) + Open Roles watch.
6. **HeyBooker original-link capture.** Harvester change: store the original-post link per listing; apply via the original route. (HeyBooker's own free tier is capped at 3/month — don't rely on it as a channel.)
7. **AllCasting web-apply pricing check.** Browser task on allcasting.com pricing/onboarding to settle free-vs-premium. If free → browser-session apply for web-type listings. If premium → mark BLOCKED.
8. **ProductionBeast re-probe.** Keep probing the 500s on sweeps; free account + apply when pages resolve. Low value (crew jobs).
9. **Instagram DMs.** Via the existing connector, strong matches only, human-reviewed. Not a bulk channel.
10. **Do NOT build (paid, $0 rule):** Backstage ($24.99/mo), Casting Networks Premium ($29.99/mo), Mandy ($14.99/mo). Free contact on those platforms is email-only, when their public call text names an address — already covered by the body-email regex net.

## What still needs the owner
- **Create the free accounts** (ProjectCasting ×2 talents, ActorsAndExtras ×2, Central Casting ×2): identity-bearing sign-ups — the machine cannot do these alone. Each needs an email + verification code from his inbox, and Central Casting needs I-9 documents + photos.
- **Fill the talent-record gaps** for the TaylorMade form: height, weight, hair color, tattoos, shirt/shoe sizes, hair-cut consent, availability dates, vintage-vehicle ownership (Joseph + Mona Lisa).
- **AllCasting pricing check** is a browser task, not an owner step — no owner action needed.
- **Nothing to pay for.** Every automatable route above is $0; the three paid platforms stay blocked unless he ever decides otherwise.
