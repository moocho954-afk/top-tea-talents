# TOP TEA TALENTS — Listing Sweep (v1.3.0)

**What it is:** a Muse cron that runs `tools/sweep-opportunities.py`,
fetching the fetchable casting sources for new South Florida listings
and upserting the new ones into the live API. It replaces the one-off
Nov 21 collection (437 records) with a standing scan.

## Cron to install (parent)

- **Name:** `ttt-listing-sweep`
- **Schedule (initial):** 4×/day ET — **08:00, 12:00, 16:00, 20:00**.
  After ~1–2 weeks, move the slots onto the observed peaks from
  `tools/posting-time-rollup.py` (floor 2/day — never below that).
- **Owner:** goal `top-tea-talents` (or the main chat if no goal owner).
- **Timeout:** 1800s (the sweep fetches up to ~15 detail pages per
  source with a 0.5s politeness delay; a full run is a few minutes).
- **Job body (the instruction the cron agent follows):**

> You are the TOP TEA TALENTS listing sweep. Admin token: read it from
> the Secure Vault at run time and pass it as the TTT_ADMIN_TOKEN
> environment variable to the script — never write it to a file.
> 1. `cd ~/workspace/top-tea-talents-public && git pull --ff-only`
>    (the repo package must be current; if the pull fails, run the
>    checkout as-is and say so in the report).
> 2. Run: `TTT_ADMIN_TOKEN=<token from vault> python3
>    tools/sweep-opportunities.py`
>    (default log: tools/sweep-log.jsonl in the repo).
> 3. Run: `python3 tools/posting-time-rollup.py` — it prints the
>    per-source × hour table and the recommended slots.
> 4. Report to the main chat, one line per source: harvested / new /
>    inserted / skipped / errors. Name any source that failed (403,
>    timeout) — a failed source is a fact, not a reason to stop the
>    others. If the rollup's recommended slots differ from the current
>    cron schedule AND at least 7 days of sweep data exist, say so and
>    propose the new slots (do not re-schedule without the owner's tap).
> 5. If the sweep inserted new listings, run the ledger-mirror recorder
>    the same way the drift-watch does (fresh workflow_dispatch of
>    ttt-ledger-recorder — never re-run a failed job) so the branch
>    mirror stays current.

## Sources (what the script fetches)

| Source | How | Notes |
|---|---|---|
| AllCasting | sitemap | castingcall/<id> URLs; newest-first by lastmod |
| ProjectCasting | sitemap | sitemap_index.xml (www sitemap 404s); flaky from this VM — logged, not fatal |
| AuditionsFree | HTML index | front page + /page/2/ + /page/3/ + Florida page; its Yoast sitemap is STALE (newest lastmod 2012), do not use it |
| CastingAndActing | sitemap | /castings/<slug>-<id>/ + /en/ twin (same id, dedupes); mostly Latin America/Spain — Florida hits rare but real |
| HeyBooker | HTML index | refuses connections from this VM — failure logged every run |
| Actors and Extras | HTML index | 502 from this VM — failure logged every run |
| ProductionBeast | HTML index | app.productionbeast.com/jobs/ (server-rendered /jobs/<id>-<slug>); the marketing sitemap is blog-only |
| Craigslist Miami | RSS | gigs + talent-gigs feeds; 403 from this VM — failure logged every run |

Sources that are NOT fetchable (login walls, no public feed) stay NOT
CONNECTED and are never faked: Backstage, Casting Networks, Central
Casting, Mandy, Casting TaylorMade, Instagram. The script logs per-source
failures; a 403 from this VM (seen before for Craigslist) means that
source stays down until the egress path changes — report it, do not
work around it by inventing listings.

## Honesty rules (in the script, not just this doc)

- A field the page does not state stays null. Pay, deadline, location,
  roles: null when absent — never guessed.
- A listing with no Florida location is skipped as out-of-scope.
- New records are UNVERIFIED with a verification note saying they were
  swept and unconfirmed.
- Dedupe is by opportunity id against the live API; existing records
  are never overwritten by a thinner sweep copy.
- Every run stamps `discovered_at` + source on each new record and in
  the log — that is what the posting-time rollup learns from.

## The rollup (learning the posting times)

`tools/posting-time-rollup.py` buckets first-seen times by source × hour
ET and writes `tools/posting-time-rollup.json`. With fewer than 7 days of
data it recommends keeping the initial 4×/day schedule; with 7+ days it
recommends the union of per-source peak hours (max 4 slots, floor 2/day).
The cron agent proposes slot moves; the owner taps to move them.
