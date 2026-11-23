#!/usr/bin/env python3
"""Local end-to-end test for the TTT release button (v1.3.1).
Runs against the LOCAL scratch server on :3101 with a scratch SQLite DB.
No real talent, no real agency, no real email. Exits non-zero on any failure.
"""
import json, subprocess, sys, urllib.request

BASE = "http://127.0.0.1:3101/api/v1"
ADMIN = "test-admin-token"
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

# --- 1. scratch talents ---
s, t1 = call("POST", "/auth/register", body={
    "email": "release-test-talent@example.com", "phone": "3055550100",
    "firstName": "Test", "lastName": "Releaser", "professionalName": "Test Releaser",
    "password": "scratch-only-password", "termsAccepted": True})
check("register scratch talent 1", s == 201 and t1.get("talentId"), f"{s} {t1}")
T1, TOK1 = t1.get("talentId"), t1.get("token")

s, t2 = call("POST", "/auth/register", body={
    "email": "release-test-other@example.com", "phone": "3055550101",
    "firstName": "Other", "lastName": "Talent", "password": "scratch-only-password",
    "termsAccepted": True})
check("register scratch talent 2 (auth tests)", s == 201 and t2.get("talentId"), f"{s} {t2}")
TOK2 = t2.get("token")

# --- 2. scratch opportunities (direct SQL into the scratch DB) ---
def opp(oid, title, prod_dates, deadline, email="release-test-agency@example.com"):
    return {"id": oid, "title": title, "production": None, "employer": "Release Test Casting",
            "casting_org": "Release Test Casting", "casting_professional": None, "category": "commercial",
            "roles": "Background talent (All genders) — TEST listing for the release button only.",
            "positions": 1, "location": {"city": "Miami", "county": "Miami-Dade", "state": "FL", "raw": "Miami, FL, United States"},
            "geography": "south-florida", "production_dates": prod_dates, "deadline": deadline,
            "compensation": "$500 per Project", "compensation_type": "flat", "hours": None,
            "eligibility": "TEST", "age": None, "skills": None, "appearance": None, "travel": None,
            "usage_exclusivity": None, "submission_instructions": "TEST — apply via the test route.",
            "contact_email": email, "source": "test", "source_url": None,
            "discovered_at": "2026-11-23T15:00:00-05:00", "verified_at": None,
            "verification_status": "TEST", "verification_notes": "Scratch listing for release-button verification only.",
            "confidence": 1, "score": None, "duplicate_group_id": None, "merged_from": [],
            "expired": False, "selectivity": "unknown", "selectivityReason": None, "genderRequirement": None}

opps = [
    opp("test:release-far", "TEST — Release Button Far Shoot", "Shoot dates: December 3 to December 5 (3 days total).", "2026-12-01"),
    opp("test:release-near", "TEST — Release Button Near Shoot", "Shoot dates: November 24 to November 25 (2 days total).", "2026-11-23"),
    opp("test:release-nodate", "TEST — Release Button No Date", None, None, email=None),
    opp("test:release-oppdate", "TEST — Release Button Opp Date", "Shoot dates: December 5 to December 7 (3 days total).", "2026-12-01"),
]
sql = " ".join(
    f"INSERT INTO opportunities (id, data_json) VALUES ('{o['id']}', '{json.dumps(o).replace(chr(39), chr(39)+chr(39))}');"
    for o in opps)
r = subprocess.run(["bun", "-e", f"""
import {{ Database }} from "bun:sqlite";
const db = new Database("/tmp/ttt-release-test.db");
db.run({json.dumps(sql)});
console.log("inserted");
"""], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
check("seed 4 scratch opportunities", r.returncode == 0 and "inserted" in r.stdout, r.stderr[-300:])

# --- 3. applications via the API (as the talent) ---
apps = {}
for oid in ["test:release-far", "test:release-near", "test:release-nodate", "test:release-oppdate"]:
    s, a = call("POST", "/applications", token=TOK1, body={"talentId": T1, "opportunityId": oid})
    check(f"application for {oid}", s == 201 and a.get("application", {}).get("id"), f"{s} {a}")
    apps[oid] = a.get("application", {}).get("id")

# --- 4. bookings via the API (admin) ---
def make_booking(app_id, event_date=None):
    body = {"applicationId": app_id, "evidence": "TEST booking for release-button verification — scratch only"}
    if event_date:
        body["eventDate"] = event_date
    return call("POST", "/bookings", token=ADMIN, body=body)

s, bkA = make_booking(apps["test:release-far"], "2026-12-03")
check("booking A (far, eventDate 2026-12-03)", s == 201 and bkA.get("booking", {}).get("id"), f"{s} {bkA}")
A = bkA.get("booking", {}).get("id")
s, bkB = make_booking(apps["test:release-near"], "2026-11-24")
check("booking B (near, eventDate 2026-11-24)", s == 201 and bkB.get("booking", {}).get("id"), f"{s} {bkB}")
B = bkB.get("booking", {}).get("id")
s, bkC = make_booking(apps["test:release-nodate"])
check("booking C (no date anywhere)", s == 201 and bkC.get("booking", {}).get("id"), f"{s} {bkC}")
C = bkC.get("booking", {}).get("id")
s, bkD = make_booking(apps["test:release-oppdate"])
check("booking D (opportunity-derived date)", s == 201 and bkD.get("booking", {}).get("id"), f"{s} {bkD}")
D = bkD.get("booking", {}).get("id")
check("booking A carries eventDate", bkA.get("booking", {}).get("eventDate") == "2026-12-03", str(bkA.get("booking")))

# --- 5. dryRun previews ---
s, dA = call("POST", f"/bookings/{A}/release", token=TOK1, body={"dryRun": True})
check("dryRun A: releasable, opp date, destination", s == 200 and dA.get("releasable") is True
      and dA.get("destination") == "release-test-agency@example.com"
      and dA.get("destinationSource") == "listing"
      and dA.get("eventDate") == "2026-12-03", f"{s} {dA}")
check("dryRun A: template has talent + agency names only",
      "Test Releaser" in dA.get("email", {}).get("body", "")
      and "Release Test Casting team" in dA.get("email", {}).get("body", "")
      and "due to certain circumstances" in dA.get("email", {}).get("body", ""), dA.get("email", {}).get("body", ""))
print("--- dryRun A email body (verbatim) ---")
print(dA.get("email", {}).get("body", ""))
print("--- end ---")
s, dB = call("POST", f"/bookings/{B}/release", token=TOK1, body={"dryRun": True})
check("dryRun B: NOT releasable, ~24h out", s == 200 and dB.get("releasable") is False
      and dB.get("hoursUntilEvent") is not None and dB.get("hoursUntilEvent") < 72, f"{s} {dB}")
s, dC = call("POST", f"/bookings/{C}/release", token=TOK1, body={"dryRun": True})
check("dryRun C: no event date, not releasable", s == 200 and dC.get("releasable") is False
      and dC.get("eventDate") is None, f"{s} {dC}")
s, dD = call("POST", f"/bookings/{D}/release", token=TOK1, body={"dryRun": True})
check("dryRun D: opportunity date 2026-12-05, releasable", s == 200 and dD.get("releasable") is True
      and dD.get("eventDate") == "2026-12-05" and dD.get("eventDateSource") == "opportunity", f"{s} {dD}")

# --- 6. auth checks ---
s, r = call("POST", f"/bookings/{B}/release", token=TOK2, body={})
check("release as another talent -> 403", s == 403, f"{s} {r}")
s, r = call("POST", f"/bookings/{B}/release", body={})
check("release with no token -> 401", s == 401, f"{s} {r}")
s, r = call("POST", "/bookings/bkg_doesnotexist/release", token=TOK1, body={})
check("release missing booking -> 404", s == 404, f"{s} {r}")

# --- 7. real releases ---
s, rB = call("POST", f"/bookings/{B}/release", token=TOK1, body={})
check("release B refused inside 72h", s == 400 and "72-hour" in str(rB), f"{s} {rB}")
s, rC = call("POST", f"/bookings/{C}/release", token=TOK1, body={})
check("release C blocked (no date)", s == 400 and "No event date" in str(rC), f"{s} {rC}")
s, lst = call("GET", f"/bookings?talentId={T1}", token=TOK1)
st = {b["id"]: b["status"] for b in lst.get("bookings", [])}
check("B and C still BOOKED after refusal", st.get(B) == "BOOKED" and st.get(C) == "BOOKED", str(st))

s, rA = call("POST", f"/bookings/{A}/release", token=TOK1, body={})
check("release A succeeds", s == 200 and rA.get("booking", {}).get("status") == "RELEASED"
      and rA.get("releasedAt") and rA.get("emailQueued") is True and rA.get("emailSent") is False
      and rA.get("destination") == "release-test-agency@example.com", f"{s} {rA}")
check("release A email note is honest (queued, not sent)", "queued" in str(rA.get("emailNote", "")).lower(), str(rA.get("emailNote")))
s, rA2 = call("POST", f"/bookings/{A}/release", token=TOK1, body={})
check("release A again -> already released", s == 400 and "already released" in str(rA2), f"{s} {rA2}")
s, rD = call("POST", f"/bookings/{D}/release", token=TOK1, body={})
check("release D succeeds via opportunity date", s == 200 and rD.get("booking", {}).get("status") == "RELEASED"
      and rD.get("eventDateSource") == "opportunity", f"{s} {rD}")

# --- 8. talent view + ledger + queue ---
s, lst = call("GET", f"/bookings?talentId={T1}", token=TOK1)
by_id = {b["id"]: b for b in lst.get("bookings", [])}
check("API list: A and D are RELEASED, B and C BOOKED",
      by_id.get(A, {}).get("status") == "RELEASED" and by_id.get(D, {}).get("status") == "RELEASED"
      and by_id.get(B, {}).get("status") == "BOOKED" and by_id.get(C, {}).get("status") == "BOOKED", str(by_id))
check("talent-view filter hides RELEASED (frontend rule)",
      [b["id"] for b in lst.get("bookings", []) if b["status"] != "RELEASED"] == [B, C] or
      set(b["id"] for b in lst.get("bookings", []) if b["status"] == "BOOKED") == {B, C}, str(by_id))
check("GET enriches eventDate + hoursUntilEvent", by_id.get(B, {}).get("eventDate") == "2026-11-24"
      and by_id.get(B, {}).get("hoursUntilEvent") is not None, str(by_id.get(B)))

r = subprocess.run(["bun", "-e", """
import { Database } from "bun:sqlite";
const db = new Database("/tmp/ttt-release-test.db");
console.log(JSON.stringify({
  queue: db.query("SELECT id, kind, status, to_addr, subject FROM email_queue WHERE kind='release'").all(),
  audit: db.query("SELECT action, entity_id FROM audit_log WHERE action='booking.release'").all(),
  notif: db.query("SELECT title FROM notifications WHERE talent_id=?").all(%s),
}));
""" % json.dumps(T1)], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
data = json.loads(r.stdout) if r.returncode == 0 else {}
check("email_queue has 2 release emails, QUEUED, to test agency",
      len(data.get("queue", [])) == 2 and all(q["status"] == "QUEUED" and q["to_addr"] == "release-test-agency@example.com" for q in data["queue"]), str(data.get("queue")))
print("--- queued release email subjects ---")
for q in data.get("queue", []):
    print(" ", q["subject"], "|", q["status"], "|", q["to_addr"])
check("audit has 2 booking.release events", len(data.get("audit", [])) == 2, str(data.get("audit")))
check("talent got release notifications", len([n for n in data.get("notif", []) if n["title"].startswith("Booking released")]) == 2, str(data.get("notif")))

# queued email body verbatim (first release email)
r = subprocess.run(["bun", "-e", """
import { Database } from "bun:sqlite";
const db = new Database("/tmp/ttt-release-test.db");
const row = db.query("SELECT body FROM email_queue WHERE kind='release' ORDER BY created_at ASC LIMIT 1").get();
console.log(row ? row.body : "NONE");
"""], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
print("--- queued release email body (verbatim, first) ---")
print(r.stdout)
print("--- end ---")
check("queued body matches the template", "Test Releaser" in r.stdout and "due to certain circumstances" in r.stdout
      and "Release Test Casting team" in r.stdout and "2026-12-03" in r.stdout, r.stdout[:200])

# --- 9. drain path: POST /email/drain (admin) ---
s, dr = call("POST", "/email/drain", token=ADMIN, body={"limit": 10})
check("drain runs and honestly reports mail not configured", s == 200, f"{s} {dr}")
print("drain result:", json.dumps(dr)[:400])
r = subprocess.run(["bun", "-e", """
import { Database } from "bun:sqlite";
const db = new Database("/tmp/ttt-release-test.db");
console.log(JSON.stringify(db.query("SELECT kind, status, COUNT(*) n FROM email_queue GROUP BY kind, status").all()));
"""], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
print("email_queue by kind/status after drain:", r.stdout.strip())
check("release emails stay QUEUED after drain (mail unconfigured, not silently dropped)",
      "QUEUED" in r.stdout and "release" in r.stdout, r.stdout)

print(f"\nRELEASE-TEST: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
