# publicBase() + DELETE /contacts fix — 2026-11-23

Two defects found by the v1.3.2 live proof. **Built + verified locally.
NOT pushed, NOT deployed, NO live writes.** The parent pushes + deploys,
then deletes the leftover scratch contact through the new endpoint.

## Defect 1 — the form link in the missing-info alert email 404s

The sent email (Gmail id `1a20a5ecb4298350`) linked
`https://top-tea-talents-api.onrender.com/#/complete-profile`. The API host
serves JSON and 404s at its root — it can never serve the SPA. Cause:
`PUBLIC_URL` on Render points at the API host itself, and `server.ts` used
it raw at three talent-facing link sites. All three are now routed through
one helper.

### Change — `server/src/server.ts:55–70` (new helper)

```ts
const PAGES_ORIGIN = "https://moocho954-afk.github.io/top-tea-talents";
function publicBase(): string {
  const env = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  if (env && !env.includes("onrender.com")) return env;
  return PAGES_ORIGIN;
}
```

`PUBLIC_URL` is honoured only when set AND not an onrender.com host;
anything else (unset, or the API host) falls back to the Pages origin.
A future custom domain still works — any non-onrender `PUBLIC_URL` is
used as-is. The helper can never again produce an API-host SPA link.

### Call sites (all three raw reads replaced)

- `server.ts:1896` — `GET /talent/:id/portfolio-link` (`publicUrl`)
- `server.ts:2173` — `POST /talent/:id/missing-info-alert` (`formUrl`)
- `server.ts:2424` — send handler (`publicUrl` for `buildApplicationEmail`)

Side effect, intended: the link is now ALWAYS present. Previously a
missing `PUBLIC_URL` meant `formUrl`/`publicUrl` was `null` and the email
carried no link at all. Now it always carries the Pages-origin link.

### README doc fix — `README.md` env table

The README described `PUBLIC_URL` as "Public API URL" — that wording is
what steered the setup at the API host in the first place. The row now
says it is the origin of the public site (Pages SPA), must be
`https://moocho954-afk.github.io/top-tea-talents`, never the API host,
and points at `publicBase()`.

## Defect 2 — no way to delete a contact

The proof left scratch row `ctc_76b6de18d9bb35c8` ("Test Proof",
topteatalents@gmail.com) with no API route to remove it.

### Change — `server/src/server.ts:1575–1591` (new route)

`DELETE /api/v1/contacts/:id`, admin-only (`requireAdmin`, same as
`DELETE /api/v1/bookings/:id`), audited as `contact.delete`, returns
`{ok:true, deletedId}`. Contacts have no lifecycle state, so there is no
status guard — admin-only + the audit trail is the guard. The comment on
the route says to check a contact's applications/bookings counts before
deleting one the live system still uses as a submission destination.
The leftover `ctc_76b6de18d9bb35c8` was NOT deleted here — the parent
deletes it through the new endpoint after deploy.

## Verification (all local, scratch only)

- `bun x --package typescript tsc --noEmit`: **clean.** (Plain `npx tsc`
  pulls the wrong `tsc` package on this VM — use the bun form, as the
  v1.3.2 build report documents. `bunx` is not on PATH.)
- **New smoke test `tools/publicbase-contacts-delete-test.py`: 29 passed,
  0 failed.** Four scratch boots on :3104, fresh DB each:
  - (a) `PUBLIC_URL` unset → missing-info dryRun `formUrl` =
    `https://moocho954-afk.github.io/top-tea-talents/#/complete-profile`;
    portfolio-link `publicUrl` on the same origin; no `onrender.com`
    anywhere in either link.
  - (a) `PUBLIC_URL=https://top-tea-talents-api.onrender.com` → same
    Pages-origin links (the API host is ignored).
  - (b) `PUBLIC_URL=https://talents.example.test` → that origin is
    honoured as-is for both links.
  - (d) DELETE contacts: create scratch contact → listed → DELETE
    without token 401 → DELETE unknown id 404 → DELETE admin returns
    `{ok:true, deletedId}` → gone on re-read → DELETE again 404.
- **Regression: `tools/alerts-receipts-test.py`: 87 passed, 0 failed.**
  One assertion had to be updated, not the code: it checked the OLD
  behavior ("alert email has NO form link on scratch (no PUBLIC_URL)").
  That assertion tested the bug. It now checks the email DOES carry a
  Pages-origin form link with no `PUBLIC_URL` set
  (`tools/alerts-receipts-test.py:235–242`). Before the update the suite
  was 86/87 with only that check failing.
- **Regression: `tools/release-button-test.py`: 36 passed, 0 failed**
  (against a scratch server booted on :3101 with
  `DATABASE_PATH=/tmp/ttt-release-test.db`, per the harness quirk in the
  v1.3.2 build report; server killed + DB wiped after).
- **Regression: `tools/booking-delete-test.py`: 20 passed, 0 failed.**
- **Regression: `tools/frontend-unit-test.cjs`: 43 passed, 0 failed.**

## Guards — compliance

- No live writes. All verification on scratch servers + scratch DBs
  (wiped after each run). Joseph, Mona Lisa, every real application /
  booking / contact untouched. The 4 pending-approval applications never
  read or changed. `liveMode` / `submissionsPaused` never flipped.
- The leftover contact `ctc_76b6de18d9bb35c8` still exists on the live
  backend — deliberately, for the parent to delete after deploy.

## Files changed (push manifest)

- EDIT `server/src/server.ts` — helper :55–70, DELETE contacts route
  :1575–1591, three `publicBase()` call sites :1896, :2173, :2424.
  (Version stays 1.3.2 — this is a patch inside the release, same as
  the booking-delete fix shipped under 1.3.1.)
- NEW `tools/publicbase-contacts-delete-test.py` (29 checks).
- EDIT `tools/alerts-receipts-test.py` — one assertion updated to the
  fixed behavior (:235–242).
- EDIT `README.md` — `PUBLIC_URL` row corrected.

## Next steps for the parent

1. Push the four files + deploy (same browser-task route as v1.3.2).
2. Delete the leftover via the new endpoint:
   `DELETE /api/v1/contacts/ctc_76b6de18d9bb35c8` (admin) → expect
   `{ok:true, deletedId:"ctc_76b6de18d9bb35c8"}`, then confirm it is
   gone from `GET /api/v1/contacts` and counts are back to baseline
   (4 talents / 435 opportunities / 19 applications / 0 bookings).
3. Sanity-check one live missing-info dryRun returns a Pages-origin
   `formUrl` (the env value on Render is unchanged — the code now
   ignores the API host — but a dryRun proves it on the deployed build).
