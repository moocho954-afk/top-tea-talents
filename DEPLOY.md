# TOP TEA TALENTS — Deploy Guide (owner steps)

The code is already in this repo. Everything below is free ($0). Nothing here
asks for a card except Render's optional prompt — decline it; the free tier
needs no card.

## 0. What is already done

- [x] Repo created (public, `moocho954-afk/top-tea-talents`)
- [x] All files pushed (frontend, backend, seed data, workflows, Blueprint)
- [ ] Everything below — your taps

## 1. Deploy the backend on Render (~5 minutes)

1. Go to https://dashboard.render.com and sign in.
2. Click **New +** → **Blueprint**.
3. Pick the repository **moocho954-afk/top-tea-talents** (connect GitHub first
   if Render asks — it only reads this repo).
4. Render shows one service: **top-tea-talents-api** (Free, Docker, Oregon).
   The Blueprint sets `autoDeployTrigger: off` on purpose — Render will NOT
   redeploy on every push, so the database is never wiped by a deploy.
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
3. Finish the 6 steps, sign the likeness release with the same name, and
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
  sign-ups will not survive a restart until it is.
- **Render URL 404s** — you used the plain name without the -XXXX suffix;
  copy the exact URL from the Render dashboard.
- **Sign-up says "missing field"** — you are on an old cached copy; hard
  refresh the page (or wait a minute for Pages to serve the new build).

## TEST MODE reminder

The public site runs in TEST MODE: submissions paused, nothing sent live,
no payments collected. Lifting TEST MODE is a separate owner decision —
nothing in this deploy changes that.
