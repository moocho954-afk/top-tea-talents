#!/usr/bin/env python3
"""Local end-to-end test for DELETE /api/v1/bookings/:id (v1.3.1).
Starts its own scratch server on :3102 with a fresh SQLite DB, runs the
checks, kills the server, wipes the scratch DB. No real talent, no real
agency, no real email. Exits non-zero on any failure.
"""
import json, os, signal, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:3102/api/v1"
ADMIN = "test-admin-token"
DB = "/tmp/ttt-booking-delete-test.db"
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

# --- start the scratch server ---
for suffix in ["", "-wal", "-shm"]:
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
try:
    os.remove(DB.replace(".db", "-mirror.jsonl"))
except FileNotFoundError:
    pass
env = dict(os.environ, PORT="3102", DATABASE_PATH=DB, ADMIN_TOKEN=ADMIN)
srv = subprocess.Popen(["bun", "run", "src/server.ts"], cwd="/home/hatch/workspace/top-tea-talents-public/server",
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
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
    check("scratch server healthy", healthy)

    # --- 1. scratch talent ---
    s, t1 = call("POST", "/auth/register", body={
        "email": "delete-test-talent@example.com", "phone": "3055550200",
        "firstName": "Test", "lastName": "Deleter", "professionalName": "Test Deleter",
        "password": "scratch-only-password", "termsAccepted": True})
    check("register scratch talent", s == 201 and t1.get("talentId"), f"{s} {t1}")
    T1, TOK1 = t1.get("talentId"), t1.get("token")

    # --- 2. scratch opportunity (direct SQL into the scratch DB) ---
    opp = {"id": "test:delete-proof", "title": "TEST — Booking Delete Proof",
           "production": None, "employer": "Delete Test Casting", "casting_org": "Delete Test Casting",
           "casting_professional": None, "category": "commercial",
           "roles": "Background talent — TEST listing for the booking-delete check only.",
           "positions": 1, "location": {"city": "Miami", "county": "Miami-Dade", "state": "FL", "raw": "Miami, FL, United States"},
           "geography": "south-florida", "production_dates": "Shoot dates: December 3 to December 5 (3 days total).",
           "deadline": "2026-12-01", "compensation": "$500 per Project", "compensation_type": "flat", "hours": None,
           "eligibility": "TEST", "age": None, "skills": None, "appearance": None, "travel": None,
           "usage_exclusivity": None, "submission_instructions": "TEST — apply via the test route.",
           "contact_email": "delete-test-agency@example.com", "source": "test", "source_url": None,
           "discovered_at": "2026-11-23T16:00:00-05:00", "verified_at": None,
           "verification_status": "TEST", "verification_notes": "Scratch listing for booking-delete verification only.",
           "confidence": 1, "score": None, "duplicate_group_id": None, "merged_from": [],
           "expired": False, "selectivity": "unknown", "selectivityReason": None, "genderRequirement": None}
    sql = f"INSERT INTO opportunities (id, data_json) VALUES ('{opp['id']}', '{json.dumps(opp).replace(chr(39), chr(39)+chr(39))}');"
    r = subprocess.run(["bun", "-e", f"""
import {{ Database }} from "bun:sqlite";
const db = new Database({json.dumps(DB)});
db.run({json.dumps(sql)});
console.log("inserted");
"""], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
    check("seed scratch opportunity", r.returncode == 0 and "inserted" in r.stdout, r.stderr[-300:])

    # --- 3. application + two bookings ---
    s, a = call("POST", "/applications", token=TOK1, body={"talentId": T1, "opportunityId": "test:delete-proof"})
    check("application created", s == 201 and a.get("application", {}).get("id"), f"{s} {a}")
    APP = a.get("application", {}).get("id")

    def make_booking():
        return call("POST", "/bookings", token=ADMIN, body={
            "applicationId": APP, "evidence": "TEST booking for booking-delete verification — scratch only",
            "eventDate": "2026-12-03"})

    s, bkA = make_booking()
    check("booking A (to be released then deleted)", s == 201 and bkA.get("booking", {}).get("id"), f"{s} {bkA}")
    A = bkA.get("booking", {}).get("id")
    s, bkB = make_booking()
    check("booking B (stays BOOKED, delete refused)", s == 201 and bkB.get("booking", {}).get("id"), f"{s} {bkB}")
    B = bkB.get("booking", {}).get("id")

    # --- 4. release A, then delete it ---
    s, rA = call("POST", f"/bookings/{A}/release", token=TOK1, body={})
    check("release A succeeds (far date)", s == 200 and rA.get("booking", {}).get("status") == "RELEASED", f"{s} {rA}")

    s, dA = call("DELETE", f"/bookings/{A}", token=ADMIN)
    check("DELETE released booking A -> 200 + deletedId", s == 200 and dA.get("ok") is True and dA.get("deletedId") == A, f"{s} {dA}")
    s, lst = call("GET", "/bookings", token=ADMIN)
    ids = [b["id"] for b in lst.get("bookings", [])]
    check("GET /bookings: A is gone, B remains", A not in ids and B in ids, str(ids))

    # --- 5. guards ---
    s, dA2 = call("DELETE", f"/bookings/{A}", token=ADMIN)
    check("DELETE A again -> 404", s == 404, f"{s} {dA2}")
    s, dB = call("DELETE", f"/bookings/{B}", token=ADMIN)
    check("DELETE BOOKED booking B -> 400, release-first message",
          s == 400 and "release a booked one first" in str(dB), f"{s} {dB}")
    s, lst = call("GET", "/bookings", token=ADMIN)
    st = {b["id"]: b["status"] for b in lst.get("bookings", [])}
    check("B still BOOKED after refused delete", st.get(B) == "BOOKED", str(st))
    s, dB2 = call("DELETE", f"/bookings/{B}", token=TOK1)
    check("DELETE as talent (non-admin) -> 401", s == 401, f"{s} {dB2}")
    s, dB3 = call("DELETE", f"/bookings/{B}")
    check("DELETE with no token -> 401", s == 401, f"{s} {dB3}")
    s, dM = call("DELETE", "/bookings/bkg_doesnotexist", token=ADMIN)
    check("DELETE missing booking -> 404", s == 404, f"{s} {dM}")

    # COMPLETED guard: complete B, then delete must refuse
    s, cB = call("POST", f"/bookings/{B}/complete", token=ADMIN)
    check("complete B", s == 200 and cB.get("booking", {}).get("status") == "COMPLETED", f"{s} {cB}")
    s, dC = call("DELETE", f"/bookings/{B}", token=ADMIN)
    check("DELETE COMPLETED booking B -> 400, release-first message",
          s == 400 and "release a booked one first" in str(dC), f"{s} {dC}")
    s, lst = call("GET", "/bookings", token=ADMIN)
    st = {b["id"]: b["status"] for b in lst.get("bookings", [])}
    check("B still COMPLETED after refused delete", st.get(B) == "COMPLETED", str(st))

    # --- 6. direct DB check: exactly 1 booking.delete audit, bookings table holds only B ---
    r = subprocess.run(["bun", "-e", f"""
import {{ Database }} from "bun:sqlite";
const db = new Database({json.dumps(DB)});
console.log(JSON.stringify({{
  audit: db.query("SELECT action, entity_id FROM audit_log WHERE action='booking.delete'").all(),
  bookings: db.query("SELECT id, status FROM bookings").all(),
}}));
"""], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
    data = json.loads(r.stdout) if r.returncode == 0 else {}
    check("audit has exactly 1 booking.delete event for A",
          len(data.get("audit", [])) == 1 and data["audit"][0]["entity_id"] == A, str(data.get("audit")))
    check("bookings table holds only B",
          [b["id"] for b in data.get("bookings", [])] == [B], str(data.get("bookings")))
finally:
    srv.send_signal(signal.SIGTERM)
    try:
        srv.wait(timeout=10)
    except subprocess.TimeoutExpired:
        srv.kill()
    for suffix in ["", "-wal", "-shm"]:
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    try:
        os.remove(DB.replace(".db", "-mirror.jsonl"))
    except FileNotFoundError:
        pass

print(f"\nBOOKING-DELETE-TEST: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
