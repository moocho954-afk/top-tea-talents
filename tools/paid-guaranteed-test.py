#!/usr/bin/env python3
"""v1.3.3 integration test: PAID GUARANTEED ordering + keywords, richer
dry-run email, follow-ups + nudge-stale (dry-run only — no mail is ever
sent from this test). Boots the real server on a temp SQLite DB, seeds a
talent + 4 test opportunities by direct insert, and checks the live API.
Run: python3 tools/paid-guaranteed-test.py
Exits non-zero on any failure. No tokens or secrets are written anywhere.
"""
import json, os, signal, sqlite3, subprocess, sys, time, urllib.request, urllib.error

PORT = 3461
BASE = f"http://127.0.0.1:{PORT}/api/v1"
TOKEN = "test-admin-token-133"
DB = "/tmp/ttt-pg-test.db"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS = 0
FAIL = 0

def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS: {name}")
    else:
        FAIL += 1
        print(f"FAIL: {name} {extra}")

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

PROFILE = {
    "firstName": "Test", "lastName": "Talent", "professionalName": "TEST TALENT",
    "email": "test-talent@example.com", "city": "Hollywood", "state": "FL", "zip": "33322",
    "height": "6'1\"", "ageRange": "35-44", "languages": ["English"],
    "skills": ["Music videos", "Commercials", "On-camera"],
    "experience": "Music videos, Commercials",
    "categories": ["Music videos", "Commercials", "Brand activations", "Film and television"],
    "minCompensation": "100",
    "demographics": {"gender": "Male", "ethnicity": "Black / African American",
                     "tattoos": "YES", "tattooLocations": ["Ribs", "Chest", "Arm"]},
    "hairColor": "Black", "eyeColor": "Brown",
    "measurements": {"weightLbs": 180},
    "availability": ["Available immediately", "Flexible"],
}
AUTOMATION = {"enabled": True, "agencySendEmail": True, "ccTalent": True,
              "replyToTalent": True, "categories": PROFILE["categories"],
              "geography": "south-florida", "minDaily": 100}

def opp(oid, title, comp_type, comp, city, county, state, roles, extra=None):
    o = {"id": oid, "title": title, "compensation_type": comp_type, "compensation": comp,
         "location": {"city": city, "county": county, "state": state, "raw": f"{city}, {state}"},
         "geography": "south-florida" if state == "FL" and county in ("Miami-Dade", "Broward", "Palm Beach") else "florida",
         "roles": roles, "source": "test", "source_url": f"https://example.com/{oid}",
         "verification_status": "UNVERIFIED", "deadline": "2026-12-15",
         "production_dates": "December 20, 2026", "hours": "12 hours",
         "casting_professional": "Test Casting", "casting_org": "Test Casting Co",
         "submission_instructions": "Bring a valid ID and wear all black. Register at the link."}
    if extra: o.update(extra)
    return o

OPPS = [
    opp("test:pg-miami", "Background extras needed — Miami music video", "daily", "$150/day",
        "Miami", "Miami-Dade", "FL", "Background extras for a music video shoot in Miami, FL. No experience necessary, sign up today."),
    opp("test:sel-miami", "Lead role — Miami commercial", "daily", "$500/day",
        "Miami", "Miami-Dade", "FL", "Auditions will be held Saturday. Submit headshot and resume for consideration."),
    opp("test:unpaid-guar", "Open call — background extras Miami", "unpaid", None,
        "Miami", "Miami-Dade", "FL", "Open call, everyone welcome, background extras needed."),
    opp("test:pg-savannah", "Open casting call for extras — Savannah", "flat", "$150 per 12 hours",
        "Savannah", "Chatham", "GA", "Open casting call for extras, no experience necessary."),
]

def cleanup_files():
    # The wipe-proof ledger mirror lives next to the DB — it must go too,
    # or boot-restore resurrects the previous run's applications.
    for f in (DB, DB + "-wal", DB + "-shm", DB.replace(".db", "-mirror.jsonl"),
              DB.replace(".db", "-mirror.jsonl") + ".fetch-tmp",
              DB.replace(".db", "-mirror.jsonl") + ".rebuild-tmp"):
        try: os.remove(f)
        except FileNotFoundError: pass

def main():
    cleanup_files()
    env = dict(os.environ, PORT=str(PORT), DATABASE_PATH=DB, ADMIN_TOKEN=TOKEN)
    srv = subprocess.Popen(["bun", "run", "src/server.ts"], cwd=os.path.join(ROOT, "server"),
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                s, _ = api("GET", "/health")
                if s == 200: break
            except Exception: pass
            time.sleep(0.5)
        s, health = api("GET", "/health")
        check("health ok + version 1.3.3", s == 200 and health.get("ok") is True and str(health.get("version")) == "1.3.3", str(health)[:200])
        # seed talent + automation + opps directly in the temp DB
        con = sqlite3.connect(DB)
        con.execute("INSERT INTO talents (id, email, password_hash, profile_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                    ("tal_test133", "test-talent@example.com", "x", json.dumps(PROFILE), "2026-11-25T00:00:00Z", "2026-11-25T00:00:00Z"))
        con.execute("INSERT INTO automation_settings (talent_id, data_json, updated_at) VALUES (?,?,?)",
                    ("tal_test133", json.dumps(AUTOMATION), "2026-11-25T00:00:00Z"))
        for o in OPPS:
            con.execute("INSERT INTO opportunities (id, data_json) VALUES (?,?)", (o["id"], json.dumps(o)))
        con.commit(); con.close()
        # jobs-for-you: PAID GUARANTEED first, with keywords
        s, jfy = api("GET", "/talent/tal_test133/jobs-for-you")
        check("jobs-for-you 200", s == 200, str(jfy)[:200])
        jobs = jfy.get("jobs", [])
        by_id = {j["opportunityId"]: j for j in jobs}
        pg = by_id.get("test:pg-miami")
        check("paid-guaranteed Miami opp present", pg is not None)
        if pg:
            check("paid-guaranteed flag true", pg.get("paidGuaranteed") is True, str(pg))
            check("paid-guaranteed is automationEligible", pg.get("automationEligible") is True, str(pg.get("automationBlockers")))
            check("keywords carried on the row", "music videos" in (pg.get("keywords") or []) and (pg.get("keywordScore") or 0) >= 2, str(pg.get("keywords")))
            check("selectivity guaranteed + reason", pg.get("selectivity") == "guaranteed", str(pg.get("selectivityReason")))
            check("paid-guaranteed sorts FIRST", jobs[0]["opportunityId"] == "test:pg-miami", jobs[0]["opportunityId"])
        # /match returns ALL matches (no top-25 slice) — presence + base flags
        s, m = api("POST", "/talent/tal_test133/match", {})
        check("match endpoint 200", s == 200, str(m)[:200])
        mm = {x["opportunityId"]: x for x in m.get("matches", [])}
        sel = mm.get("test:sel-miami")
        check("selective Miami opp present + not paid-guaranteed",
              sel is not None and sel.get("paidGuaranteed") is False and sel.get("selectivity") == "selective", str(sel))
        unp = mm.get("test:unpaid-guar")
        check("unpaid guaranteed opp present + not paid-guaranteed",
              unp is not None and unp.get("paidGuaranteed") is False and unp.get("selectivity") == "guaranteed", str(unp))
        sav = mm.get("test:pg-savannah")
        check("Savannah paid-guaranteed opp present + not flagged (geography)",
              sav is not None and sav.get("paidGuaranteed") is False, str(sav))
        # create the application directly (queue-selected needs the full
        # rotation gate — consents, review, fast-track — which this temp
        # talent does not have; POST /applications is the direct path)
        s, created = api("POST", "/applications", {"talentId": "tal_test133", "opportunityId": "test:pg-miami"})
        check("create application", s in (200, 201) and (created.get("application") or {}).get("id"), str(created)[:300])
        app_id = (created.get("application") or {}).get("id")
        s, st = api("PATCH", f"/applications/{app_id}/status", {"status": "APPROVED"})
        check("approve application", s == 200, str(st)[:200])
        s, dry = api("POST", f"/applications/{app_id}/send", {"dryRun": True})
        body = (dry.get("email") or {}).get("body", "") if isinstance(dry, dict) else ""
        check("dry-run send 200", s == 200, str(dry)[:200])
        check("richer email carries hours", "Hours: 12 hours" in body, body[:400])
        check("richer email carries deadline", "Apply by: 2026-12-15" in body, body[:400])
        check("richer email carries contact", "Contact: Test Casting" in body, body[:400])
        check("richer email carries listing link", "Listing: https://example.com/test:pg-miami" in body, body[:400])
        check("richer email carries what-to-bring quote", "What to bring (per the posting): Bring a valid ID and wear all black." in body, body[:600])
        check("richer email carries pay + rate type", "Listed pay: $150/day (daily)" in body, body[:400])
        # follow-ups: empty to start
        s, fu = api("GET", "/applications/follow-ups")
        check("follow-ups empty initially", s == 200 and fu.get("total") == 0, str(fu)[:200])
        s, nudge = api("POST", "/applications/nudge-stale", {"dryRun": True})
        check("nudge-stale dry-run empty initially", s == 200 and nudge.get("nudged") == [] and nudge.get("failed") == [], str(nudge)[:200])
        # fabricate a stale SENT application (6 days ago, no reply)
        con = sqlite3.connect(DB)
        snap = {"status": "SUBMITTED — SENT", "destination": "casting@example.com",
                "destinationSource": "listing", "sentAt": "2026-11-19T12:00:00Z",
                "messageId": "test-msg-1", "source": "email-sent"}
        con.execute("UPDATE applications SET status='SUBMITTED — SENT', snapshot_json=? WHERE id=?",
                    (json.dumps(snap), app_id))
        con.commit(); con.close()
        s, fu = api("GET", "/applications/follow-ups")
        rows = fu.get("followUps", [])
        check("follow-ups lists the stale SENT app", s == 200 and len(rows) == 1, str(fu)[:300])
        if rows:
            check("days since sent >= 5", (rows[0].get("daysSinceSent") or 0) >= 5, str(rows[0]))
            check("next action is nudge due", rows[0].get("nextAction") == "nudge due — send the one follow-up email", str(rows[0].get("nextAction")))
        s, nudge = api("POST", "/applications/nudge-stale", {"dryRun": True})
        check("nudge-stale dry-run previews one nudge", s == 200 and len(nudge.get("nudged", [])) == 1, str(nudge)[:400])
        if nudge.get("nudged"):
            nb = nudge["nudged"][0].get("body", "")
            check("nudge body carries ref code + receipt ask",
                  "Ref " in nb and "confirm you received it" in nb, nb[:300])
        s, app = api("GET", f"/applications/{app_id}")
        check("nudge dry-run marks nothing", s == 200 and (app.get("application") or {}).get("followUp") is None, str(app)[:200])
        # live nudge attempt with no mail transport: must FAIL honestly and mark nothing
        s, nudge2 = api("POST", "/applications/nudge-stale", {})
        check("live nudge without mail fails honestly, marks nothing",
              s == 200 and len(nudge2.get("nudged", [])) == 0 and len(nudge2.get("failed", [])) == 1, str(nudge2)[:300])
        s, app = api("GET", f"/applications/{app_id}")
        check("failed nudge still unmarked", s == 200 and (app.get("application") or {}).get("followUp") is None, str(app)[:200])
    finally:
        srv.send_signal(signal.SIGTERM)
        try: srv.wait(timeout=10)
        except Exception: srv.kill()
        cleanup_files()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
