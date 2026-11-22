# TOP TEA TALENTS — Deploy Guide (owner steps)

The code is already in this repo. Everything below is free ($0). Nothing here
asks for a card except Render's optional prompt — decline it; the free tier
needs no card.

## 0. What is already done

- [x] Repo created (public, `moocho954-afk/top-tea-talents`)
- [x] First 20 files pushed (frontend, backend, seed data, workflows, Blueprint)
- [ ] Mirror files pushed (server/src/mirror.ts, MIRROR.md,
  prototype/ledger-mirror-recorder.yml, updated server.ts/selftest.sh/
  render.yaml/DEPLOY.md, plus VERSION.json and tools/drift-check.py) —
  see "everything live" push, 2026-11-21
- [ ] Everything below — your taps

## 1. Deploy the backend on Render (~5 minutes)

1. Go to https://dashboard.render.com and sign in.
2. Click **New +** → **Blueprint**.
3. Pick the repository **moocho954-afk/top-tea-talents** (connect GitHub first
   if Render asks — it only reads this repo).
4. Render shows one service: **top-tea-talents-api** (Free, Docker, Oregon).
   The Blueprint sets `autoDeployTrigger: off` on purpose — Render will NOT
   redeploy on every push, so the database is never wiped by a deploy.
   (Fixed 2026-11-21: the first Blueprint apply failed because four env vars
   specified both a value and `sync: false`; render.yaml now carries no value
   on those entries. If Blueprint still refuses, skip it and create the
   service manually from the repo URL instead — same Free/Docker/Oregon
   settings, then deploy from the dashboard by hand.)
5. Click **Apply**. Wait for the deploy to finish (a few minutes).
6. When it is live, Render shows a URL like
   `https://top-tea-talents-api-XXXX.onrender.com` — **copy it exactly,
   including the -XXXX suffix** (Render adds one; the plain name will 404).
7. Open `https://<your-url>/api/v1/health` in your browser. You should see
   `"ok":true`, `"test_mode":true`, `opportunities: 423`. Note whether it
   says `"storage_durable": false` — that means step 2 is still needed.

## 2. Make sign-ups durable with Turso (free, ~10 minutes — do this, or sign-ups vanish on restart)

Without this step the backend stores sign-ups in a file on Render's free
server, and **Render wipes that file every time the service restarts**.
Turso's free tier is the durable $0 fix.

1. Go to https://turso.tech and sign up (free).
2. Create a database called `top-tea-talents`.
3. In the Turso dashboard, copy the **database URL** (starts `libsql://`)
   and create an **auth token** (Database → Auth Tokens → Create).
4. Back in Render, open the **top-tea-talents-api** service → **Environment**.
5. Add two variables:
   - `TURSO_DATABASE_URL` = the libsql:// URL
   - `TURSO_AUTH_TOKEN` = the token
6. Click **Save** — Render restarts the service.
7. Open `/api/v1/health` again. It should now say `"storage": "turso"` and
   `"storage_durable": true`. That is the proof sign-ups will survive restarts.

## 2b. The other durable path: the ledger mirror (optional, ~10 minutes — do this instead of, or as well as, Turso)

The backend now keeps a wipe-proof ledger mirror: every sign-up, consent,
review, booking, and application is written to a second log file with the
full record, and the server rebuilds itself from that log after a wipe
(full design + live test proof in `MIRROR.md`). The mirror file alone does
NOT survive a Render restart — it lives on the same server — until a
recorder copies it to GitHub every 5 minutes. Activate it:

1. On GitHub, create a branch named `ledger` (branch dropdown → type
   `ledger` → Create branch). Put one file on it: copy the current mirror
   to `ledger/top-tea-talents-mirror.jsonl` on that branch. The mirror
   download is admin-only and takes the token as a **Bearer header — a plain
   browser open returns 401**, so fetch it with curl (replace the URL and
   token with yours):
   `curl -sf -H "Authorization: Bearer <ADMIN_TOKEN>" https://<your-render-url>/api/v1/ledger/mirror -o top-tea-talents-mirror.jsonl`
   (The token is the `ADMIN_TOKEN` from step 6 — Render → service →
   Environment, click the eye icon. Never paste it into chat.)
2. Add the admin token as a repo **secret** (not a variable): repo →
   Settings → Secrets and variables → Actions → Secrets → New repository
   secret. Name: `TTT_ADMIN_TOKEN`. Value: the `ADMIN_TOKEN` from Render →
   service → Environment (click the eye icon).
3. Copy `prototype/ledger-mirror-recorder.yml` to
   `.github/workflows/ledger-mirror-recorder.yml` and push it to main.
4. In Render → service → Environment, set `MIRROR_URL` to
   `https://raw.githubusercontent.com/moocho954-afk/top-tea-talents/ledger/ledger/top-tea-talents-mirror.jsonl`
   and Save (Render restarts the service once).
5. Prove it: watch the Actions tab run green, then open the raw URL in a
   browser and confirm it shows mirror lines. The real proof is the wipe
   test: delete the database and restart — sign-ups come back.

Honest limit: GitHub's raw file lags the commit by minutes, so a restart
seconds after a sign-up may restore a mirror a few minutes old. Turso
(step 2) has no such lag. Either path alone is durable; both together is
the safest.

## 3. Connect the frontend to the backend (~2 minutes)

1. On GitHub, open this repo → **Settings** → **Secrets and variables** →
   **Actions** → **Variables** tab → **New repository variable**.
2. Name: `TTT_API_URL`
3. Value: the exact Render URL from step 1.6 (e.g.
   `https://top-tea-talents-api-XXXX.onrender.com` — no trailing slash).
4. Click **Add variable**.

## 4. Turn on GitHub Pages (~1 minute)

1. On GitHub, open this repo → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the repo's **Actions** tab → **Deploy Top Tea Talents to GitHub Pages**
   → **Run workflow** → **Run workflow** (fresh run — never re-run a failed
   job; always start a fresh one).
4. Wait for the green check. GitHub shows the public URL at the top of the
   Pages settings page, like `https://moocho954-afk.github.io/top-tea-talents/`.

## 5. Verify the public link (the proof it works)

1. Open the Pages URL on your phone. You should see the gold TOP TEA TALENTS
   logo, the big gold SIGN UP button, and live counts (423 opportunities,
   23 sources, and the live South Florida count — the numbers move as
   listing deadlines pass, which is the honest behavior).
2. Tap **SIGN UP** and register a test talent (any name/email you control).
3. Finish the 3 quick signup screens, verify the email with the 6-digit code
   (check the inbox — the code expires in 15 minutes), complete the profile
   and 8-photo portfolio, sign the likeness release with the same name, and
   check the dashboard shows 100% and PROFILE UNDER REVIEW.
4. In a browser, open `https://<your-render-url>/api/v1/stats` — `talentCount`
   should be 1. That proves the sign-up actually saved.
5. Delete the test talent from Edit My Profile → Delete my account if you
   want the launch clean.

## 6. Admin token (for reviews, settings, bookings)

Render auto-generated `ADMIN_TOKEN` for the service. Read it in Render →
service → Environment (click the eye icon). It is the only way to approve
agency reviews, change settings, and record bookings. Never share it in
chat or post it anywhere.

## If something is wrong

- **Pages site shows "Backend not configured"** — the `TTT_API_URL` variable
  is missing or wrong; re-do step 3, then run the workflow again.
- **Health says `storage_durable: false`** — step 2 (Turso) is not done;
  sign-ups will not survive a restart until it is (or until step 2b, the
  ledger mirror recorder, is activated and `MIRROR_URL` is set).
- **Render URL 404s** — you used the plain name without the -XXXX suffix;
  copy the exact URL from the Render dashboard.
- **Sign-up says "missing field"** — you are on an old cached copy; hard
  refresh the page (or wait a minute for Pages to serve the new build).

## TEST MODE reminder

The public site runs in TEST MODE: submissions paused, nothing sent live,
no payments collected. Lifting TEST MODE is a separate owner decision —
nothing in this deploy changes that.
