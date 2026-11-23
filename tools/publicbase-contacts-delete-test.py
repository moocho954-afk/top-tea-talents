#!/usr/bin/env python3
"""Smoke test for the publicBase() fix + DELETE /contacts/:id (2026-11-23).
Starts scratch servers on :3104 with a fresh SQLite DB, three boots with
different PUBLIC_URL values (unset / onrender host / custom non-onrender
origin), and checks:
  (a) missing-info-alert dryRun formUrl lands on the Pages origin when
      PUBLIC_URL is unset AND when it is the onrender API host;
  (b) a non-onrender PUBLIC_URL is honoured as-is;
  (c) the portfolio-link endpoint returns a Pages-origin publicUrl;
  (d) DELETE /contacts/:id: admin delete works + row gone, repeat 404,
      no token 401, unknown id 404.
No real talent, no real contact, no real email. Kills the server and wipes
the scratch DB on exit. Exits non-zero on any failure.
"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:3104/api/v1"
ADMIN = "test-admin-token"
DB = "/tmp/ttt-publicbase-test.db"
PAGES = "https://moocho954-afk.github.io/top-tea-talents"
PASS = 0
FAIL = 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS: {name}")
    else:
        FAIL += 1
        print(f"FAIL: {name} -- {detail}")

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def wipe_db():
    for suffix in ["", "-wal", "-shm"]:
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    try:
        os.remove(DB.replace(".db", "-mirror.jsonl"))
    except FileNotFoundError:
        pass

def boot(public_url):
    """Start a scratch server; public_url None means the env var is unset."""
    wipe_db()
    env = dict(os.environ, PORT="3104", DATABASE_PATH=DB, ADMIN_TOKEN=ADMIN, TTT_LIVE_MODE="true")
    env.pop("PUBLIC_URL", None)
    if public_url is not None:
        env["PUBLIC_URL"] = public_url
    srv = subprocess.Popen(["bun", "run", "src/server.ts"],
                           cwd="/home/hatch/workspace/top-tea-talents-public/server",
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    healthy = False
    for _ in range(60):
        try:
            s, h = call("GET", "/health")
            if s == 200 and h.get("ok"):
                healthy = True
                break
        except Exception:
            pass
        time.sleep(0.5)
    return srv, healthy

def stop(srv):
    try:
        srv.terminate()
        srv.wait(timeout=10)
    except Exception:
        try:
            srv.kill()
        except Exception:
            pass

def register_talent():
    s, t = call("POST", "/auth/register", body={
        "email": "publicbase-test-talent@example.com", "phone": "3055550400",
        "firstName": "Test", "lastName": "Base", "professionalName": "Test Base",
        "password": "scratch-only-password", "termsAccepted": True})
    assert s == 201 and t.get("talentId"), f"register failed: {s} {t}"
    return t["talentId"], t["token"]

def link_checks(label, expected_origin):
    tid, tok = register_talent()
    s, d = call("POST", f"/talent/{tid}/missing-info-alert", token=ADMIN, body={"dryRun": True})
    check(f"{label}: missing-info dryRun returns formUrl", s == 200 and d.get("formUrl"), f"{s} {d}")
    check(f"{label}: formUrl is on {expected_origin}",
          d.get("formUrl") == f"{expected_origin}/#/complete-profile", str(d.get("formUrl")))
    check(f"{label}: formUrl is NOT on the API host",
          "onrender.com" not in str(d.get("formUrl")), str(d.get("formUrl")))
    s, p = call("GET", f"/talent/{tid}/portfolio-link", token=tok)
    check(f"{label}: portfolio-link returns publicUrl", s == 200 and p.get("publicUrl"), f"{s} {p}")
    check(f"{label}: portfolio-link is on {expected_origin}",
          p.get("publicUrl") == f"{expected_origin}/#/talent/{tid}", str(p.get("publicUrl")))
    check(f"{label}: portfolio-link is NOT on the API host",
          "onrender.com" not in str(p.get("publicUrl")), str(p.get("publicUrl")))

# --- (a) PUBLIC_URL unset -> Pages origin ---
srv, healthy = boot(None)
try:
    check("boot 1 (PUBLIC_URL unset): scratch server healthy", healthy)
    link_checks("PUBLIC_URL unset", PAGES)
finally:
    stop(srv)

# --- (a) PUBLIC_URL = onrender API host -> Pages origin ---
srv, healthy = boot("https://top-tea-talents-api.onrender.com")
try:
    check("boot 2 (PUBLIC_URL=onrender): scratch server healthy", healthy)
    link_checks("PUBLIC_URL=onrender", PAGES)
finally:
    stop(srv)

# --- (b) PUBLIC_URL = custom non-onrender origin -> honoured as-is ---
CUSTOM = "https://talents.example.test"
srv, healthy = boot(CUSTOM)
try:
    check("boot 3 (PUBLIC_URL=custom): scratch server healthy", healthy)
    link_checks("PUBLIC_URL=custom", CUSTOM)
finally:
    stop(srv)

# --- (d) DELETE /contacts/:id (fresh boot, PUBLIC_URL unset) ---
srv, healthy = boot(None)
try:
    check("boot 4 (contacts delete): scratch server healthy", healthy)
    s, c = call("POST", "/contacts", token=ADMIN, body={
        "kind": "agency", "name": "Smoke Test Contact",
        "email": "smoke-test-contact@example.com", "source": "smoke-test"})
    check("create scratch contact", s == 201 and c.get("contact", {}).get("id"), f"{s} {c}")
    cid = c["contact"]["id"]
    s, g = call("GET", "/contacts", token=ADMIN)
    check("scratch contact listed before delete",
          s == 200 and any(r.get("id") == cid for r in g.get("contacts", [])), f"{s} {len(g.get('contacts', []))}")
    s, noauth = call("DELETE", f"/contacts/{cid}")
    check("DELETE contact without token -> 401", s == 401, f"{s} {noauth}")
    s, unk = call("DELETE", "/contacts/ctc_doesnotexist0000", token=ADMIN)
    check("DELETE unknown contact -> 404", s == 404, f"{s} {unk}")
    s, d = call("DELETE", f"/contacts/{cid}", token=ADMIN)
    check("DELETE contact (admin) returns deletedId",
          s == 200 and d.get("deletedId") == cid, f"{s} {d}")
    s, g2 = call("GET", "/contacts", token=ADMIN)
    check("scratch contact gone on re-read",
          s == 200 and not any(r.get("id") == cid for r in g2.get("contacts", [])), f"{s}")
    s, again = call("DELETE", f"/contacts/{cid}", token=ADMIN)
    check("DELETE same contact again -> 404", s == 404, f"{s} {again}")
finally:
    stop(srv)

wipe_db()
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
