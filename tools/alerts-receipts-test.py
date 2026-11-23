#!/usr/bin/env python3
"""Local end-to-end test for the TALENT ALERTS + RECEIPTS package (v1.3.2).
Starts its own scratch server on :3103 with a fresh SQLite DB and
TTT_LIVE_MODE=true (so the package-ready send branch runs), runs the checks,
kills the server, wipes the scratch DB. No real talent, no real agency, no
real email — the mailer has no transport on scratch, so every drain reports
sent=false and the tests assert on the QUEUED rows + stored records instead.
Exits non-zero on any failure.
"""
import json, os, signal, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:3103/api/v1"
ADMIN = "test-admin-token"
DB = "/tmp/ttt-alerts-receipts-test.db"
PASS = 0
FAIL = 0
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

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

def dbq(sql):
    r = subprocess.run(["bun", "-e", f"""
import {{ Database }} from "bun:sqlite";
const db = new Database({json.dumps(DB)});
console.log(JSON.stringify(db.query({json.dumps(sql)}).all()));
"""], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
    if r.returncode != 0:
        return []
    try:
        return json.loads(r.stdout)
    except Exception:
        return []

def seed_opp(opp):
    sql = f"INSERT INTO opportunities (id, data_json) VALUES ('{opp['id']}', '{json.dumps(opp).replace(chr(39), chr(39)+chr(39))}');"
    r = subprocess.run(["bun", "-e", f"""
import {{ Database }} from "bun:sqlite";
const db = new Database({json.dumps(DB)});
db.run({json.dumps(sql)});
console.log("inserted");
"""], capture_output=True, text=True, cwd="/home/hatch/workspace/top-tea-talents-public/server")
    return r.returncode == 0 and "inserted" in r.stdout

def opp_doc(oid, title, contact_email, source_url, production_dates, comp):
    return {"id": oid, "title": title,
            "production": None, "employer": "Alerts Test Casting", "casting_org": "Alerts Test Casting",
            "casting_professional": None, "category": "commercial",
            "roles": "TEST listing for the alerts+receipts check only.",
            "positions": 1, "location": {"city": "Miami", "county": "Miami-Dade", "state": "FL", "raw": "Miami, FL, United States"},
            "geography": "south-florida", "production_dates": production_dates,
            "deadline": "2026-12-01", "compensation": comp, "compensation_type": "flat", "hours": None,
            "eligibility": "TEST", "age": None, "skills": None, "appearance": None, "travel": None,
            "usage_exclusivity": None, "submission_instructions": "TEST — apply via the test route.",
            "contact_email": contact_email, "source": "test", "source_url": source_url,
            "discovered_at": "2026-11-23T16:00:00-05:00", "verified_at": None,
            "verification_status": "TEST", "verification_notes": "Scratch listing for alerts+receipts verification only.",
            "confidence": 1, "score": None, "duplicate_group_id": None, "merged_from": [],
            "expired": False, "selectivity": "unknown", "selectivityReason": None, "genderRequirement": None}

for suffix in ["", "-wal", "-shm"]:
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
try:
    os.remove(DB.replace(".db", "-mirror.jsonl"))
except FileNotFoundError:
    pass
env = dict(os.environ, PORT="3103", DATABASE_PATH=DB, ADMIN_TOKEN=ADMIN, TTT_LIVE_MODE="true")
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
    check("scratch server healthy (live mode on)", healthy)
    s, h = call("GET", "/health")
    check("health says live_mode true", h.get("live_mode") is True, str(h))

    # --- 1. scratch talents: F (sparse female, Mona-Lisa-like) + G (other) ---
    s, tF = call("POST", "/auth/register", body={
        "email": "alerts-test-talent@example.com", "phone": "3055550300",
        "firstName": "Test", "lastName": "Alerta", "professionalName": "Test Alerta",
        "password": "scratch-only-password", "termsAccepted": True})
    check("register scratch talent F", s == 201 and tF.get("talentId"), f"{s} {tF}")
    F, TOKF = tF.get("talentId"), tF.get("token")
    s, tG = call("POST", "/auth/register", body={
        "email": "alerts-test-other@example.com", "phone": "3055550301",
        "firstName": "Test", "lastName": "Other", "professionalName": "Test Other",
        "password": "scratch-only-password", "termsAccepted": True})
    check("register scratch talent G", s == 201 and tG.get("talentId"), f"{s} {tG}")
    G, TOKG = tG.get("talentId"), tG.get("token")

    s, pF = call("PATCH", f"/talent/{F}", token=ADMIN, body={
        "demographics": {"gender": "Female", "ethnicity": "Black / African American"}})
    check("PATCH F demographics (sparse profile)", s == 200, f"{s} {pF}")

    # --- 2. seed opportunities: no-email (package-ready) + with-email ---
    check("seed opp-noemail", seed_opp(opp_doc("test:alerts-noemail", "TEST — Alerts No-Email Role", None, None,
                                               "Shoot dates: January 5 to January 7 (3 days total).", "$300 per Project")))
    check("seed opp-email", seed_opp(opp_doc("test:alerts-email", "TEST — Alerts With-Email Role",
                                             "alerts-test-agency@example.com", "https://example.com/apply",
                                             "Shoot dates: December 3 to December 5 (3 days total).", "$500 per Project")))
    check("seed opp-email2", seed_opp(opp_doc("test:alerts-email2", "TEST — Alerts With-Email Role 2",
                                              "alerts-test-agency@example.com", "https://example.com/apply2",
                                              "Shoot dates: December 10 to December 12 (3 days total).", "$400 per Project")))

    # --- 3. applications A (email opp) + B (no-email opp) ---
    s, aA = call("POST", "/applications", token=ADMIN, body={"talentId": F, "opportunityId": "test:alerts-email"})
    check("application A created", s == 201 and aA.get("application", {}).get("id"), f"{s} {aA}")
    A = aA.get("application", {}).get("id")
    s, aB = call("POST", "/applications", token=ADMIN, body={"talentId": F, "opportunityId": "test:alerts-noemail"})
    check("application B created", s == 201 and aB.get("application", {}).get("id"), f"{s} {aB}")
    B = aB.get("application", {}).get("id")

    # --- 4. missing-info: gaps for the sparse female profile ---
    s, mi = call("GET", f"/talent/{F}/missing-info", token=ADMIN)
    gaps = mi.get("gaps", [])
    gap_ids = [g["id"] for g in gaps]
    qs = mi.get("questions", [])
    q_ids = [q["id"] for q in qs]
    check("missing-info GET 200", s == 200, f"{s} {mi}")
    check("gaps = 21 questions + photos (22)", len(gaps) == 22 and "photos" in gap_ids, str(gap_ids))
    check("first gap is height (easy first)", gap_ids[0] == "height", str(gap_ids[:5]))
    check("men's sizes NOT in questions (gender filter)", not any(x in q_ids for x in ["neckSize", "sleeveLength", "waistSize", "inseam", "jacketSize"]), str(q_ids))
    check("women's sizes ARE in questions", all(x in q_ids for x in ["pantsJean", "dress", "braBand", "braCup"]), str(q_ids))
    check("tattooLocations NOT shown (tattoos unanswered)", "tattooLocations" not in q_ids, str(q_ids))
    check("carYear NOT shown (vintage unanswered)", "carYear" not in q_ids, str(q_ids))
    check("gender itself answered (not a gap)", "gender" not in gap_ids, str(gap_ids))
    fd = [q for q in qs if q["id"] == "filmingDates"][0]
    check("filmingDates free-text when no opp (options null)", fd.get("options") is None and fd.get("optionsSource") == "free-text", str(fd))
    hq = [q for q in qs if q["id"] == "height"][0]
    check("height options are the exact casting texts", "5'3" in (hq.get("options") or []), str(hq.get("options")))

    s, mi2 = call("GET", f"/talent/{F}/missing-info?opportunityId=test:alerts-noemail", token=ADMIN)
    fd2 = [q for q in mi2.get("questions", []) if q["id"] == "filmingDates"][0]
    check("filmingDates options from opportunity dates", fd2.get("options") == ["January 5, 2026", "January 7, 2026"] and fd2.get("optionsSource") == "opportunity", str(fd2))
    s, mi3 = call("GET", f"/talent/{F}/missing-info?formSlug=miamivice", token=ADMIN)
    fd3 = [q for q in mi3.get("questions", []) if q["id"] == "filmingDates"][0]
    check("filmingDates = 37 Miami Vice dates for miamivice",
          len(fd3.get("options") or []) == 37 and "12/7 (MON)" in fd3["options"] and "2/6 (SAT)" in fd3["options"] and fd3.get("optionsSource") == "taylormade-miamivice", str(fd3.get("options")))

    # auth guards on missing-info
    s, _ = call("GET", f"/talent/{F}/missing-info", token=TOKG)
    check("missing-info as other talent -> 403", s == 403, str(s))
    s, _ = call("GET", f"/talent/{F}/missing-info")
    check("missing-info with no token -> 401", s == 401, str(s))

    # --- 5. answers: validation + atomicity ---
    s, bad = call("POST", f"/talent/{F}/answers", token=ADMIN, body={"answers": {
        "height": "7 feet tall", "dateOfBirth": "2030-01-01", "weightLbs": 5}})
    check("invalid batch -> 400 with all three errors",
          s == 400 and "Height" in str(bad) and "Date of birth" in str(bad) and "Weight" in str(bad), f"{s} {bad}")
    s, mi4 = call("GET", f"/talent/{F}/missing-info", token=ADMIN)
    g4 = [g["id"] for g in mi4.get("gaps", [])]
    check("invalid batch saved NOTHING (atomic)", "height" in g4 and "dateOfBirth" in g4 and "weightLbs" in g4, str(g4))
    # tattoos first (exact casting text "YES — I have tattoos" — the form
    # shows the casting text, the record stores the short code), so
    # tattooLocations applies for the bad-multi check below
    s, ok0 = call("POST", f"/talent/{F}/answers", token=ADMIN, body={"answers": {"tattoos": "YES — I have tattoos"}})
    check("tattoos=YES saved (full option text in, short code stored)",
          s == 200 and ok0.get("saved") == ["tattoos"], f"{s} {ok0}")
    s, bad2 = call("POST", f"/talent/{F}/answers", token=ADMIN, body={"answers": {
        "height": "5'3", "tattooLocations": ["Moon"]}})
    check("bad multi option + good answer -> 400, good one NOT saved",
          s == 400 and "Moon" in str(bad2), f"{s} {bad2}")
    s, mi5 = call("GET", f"/talent/{F}/missing-info", token=ADMIN)
    check("height still a gap after the refused batch", "height" in [g["id"] for g in mi5.get("gaps", [])], str(mi5.get("gaps")))
    s, bad3 = call("POST", f"/talent/{F}/answers", token=ADMIN, body={"answers": {"nope": "x"}})
    check("unknown question -> 400", s == 400, f"{s} {bad3}")

    # valid answers, as the talent herself
    s, ok1 = call("POST", f"/talent/{F}/answers", token=TOKF, body={"answers": {
        "height": "5'3", "hairColor": "Black", "dateOfBirth": "1990-05-14"}})
    check("valid answers as talent -> 200, 3 saved",
          s == 200 and sorted(ok1.get("saved", [])) == ["dateOfBirth", "hairColor", "height"], f"{s} {ok1}")
    s, mi6 = call("GET", f"/talent/{F}/missing-info", token=ADMIN)
    g6 = [g["id"] for g in mi6.get("gaps", [])]
    check("tattooLocations APPEARS after tattoos=YES", "tattooLocations" in g6, str(g6))
    check("answered items leave the gaps", "height" not in g6 and "dateOfBirth" not in g6, str(g6))
    s, ok2 = call("POST", f"/talent/{F}/answers", token=ADMIN, body={"answers": {"tattooLocations": ["Ribs", "Chest"]}})
    check("tattoo locations saved", s == 200 and ok2.get("saved") == ["tattooLocations"], f"{s} {ok2}")
    s, bad4 = call("POST", f"/talent/{F}/answers", token=TOKF, body={"answers": {}})
    check("empty answers -> 400", s == 400, f"{s} {bad4}")
    s, bad5 = call("POST", f"/talent/{F}/answers", token=TOKG, body={"answers": {"height": "5'3"}})
    check("answers as other talent -> 403", s == 403, f"{s} {bad5}")

    # answers land on the record in the submitter's storage convention:
    # top-level height/hairColor, demographics short codes
    prof = dbq("SELECT profile_json FROM talents WHERE id = '" + F + "'")
    pj = json.loads(prof[0]["profile_json"]) if prof else {}
    check("record stores answers where the submitter reads them",
          pj.get("height") == "5'3" and pj.get("hairColor") == "Black"
          and pj.get("demographics", {}).get("tattoos") == "YES"
          and pj.get("demographics", {}).get("dateOfBirth") == "1990-05-14"
          and "profile" not in pj, str(pj)[:300])

    # --- 6. missing-info alert: dry-run, then real ---
    s, dry = call("POST", f"/talent/{F}/missing-info-alert", token=ADMIN, body={"dryRun": True})
    em = dry.get("email", {})
    check("alert dry-run -> 200, gaps listed",
          s == 200 and dry.get("dryRun") is True and len(dry.get("gaps", [])) > 0, f"{s} {dry}")
    check("alert email subject names the count",
          "detail" in em.get("subject", "") and str(len(dry.get("gaps", []))) in em.get("subject", ""), em.get("subject"))
    check("alert email body lists the gaps + reply option",
          "Weight (lbs)" in em.get("body", "") and "reply to this email" in em.get("body", ""), em.get("body", ""))
    # publicBase() fix (2026-11-23): the form link is ALWAYS present now —
    # with no PUBLIC_URL it falls back to the Pages origin, never a dead
    # API-host link. The old assertion ("NO form link on scratch") tested
    # the bug.
    check("alert email carries a Pages-origin form link even with no PUBLIC_URL",
          "Answer them here" in em.get("body", "")
          and "https://moocho954-afk.github.io/top-tea-talents/#/complete-profile" in em.get("body", "")
          and "onrender.com" not in em.get("body", ""), em.get("body", ""))
    s, al = call("POST", f"/talent/{F}/missing-info-alert", token=ADMIN, body={})
    check("alert real -> alerted, email queued not sent (no transport), notification made",
          s == 200 and al.get("alerted") is True and al.get("emailQueued") is True
          and al.get("emailSent") is False and al.get("notificationId"), f"{s} {al}")
    s, nt = call("GET", f"/talent/{F}/notifications", token=ADMIN)
    titles = [n.get("title", "") for n in nt.get("notifications", [])]
    check("notification landed on the profile",
          any("Details needed" in t for t in titles), str(titles))
    s, al2 = call("POST", f"/talent/{F}/missing-info-alert", token=TOKG, body={"dryRun": True})
    check("alert as talent (non-admin) -> 401", s == 401, f"{s} {al2}")

    # fill every remaining question gap, then 2 photos -> alert says nothing missing
    s, mi7 = call("GET", f"/talent/{F}/missing-info", token=ADMIN)
    batch = {}
    for q in mi7.get("questions", []):
        if q.get("answered") or q["id"] == "filmingDates":
            continue
        if q["kind"] == "choice":
            # vintageVehicle: pick NO so the car-detail follow-ups never open
            batch[q["id"]] = q["options"][1] if q["id"] == "vintageVehicle" else q["options"][0]
        elif q["kind"] == "multi":
            batch[q["id"]] = [q["options"][0]]
        elif q["kind"] == "date":
            batch[q["id"]] = "1990-05-14"
        elif q["kind"] == "number":
            batch[q["id"]] = 180 if q["id"] == "weightLbs" else 1985
        elif q["kind"] == "text":
            batch[q["id"]] = "Test"
        elif q["kind"] == "bool":
            batch[q["id"]] = True
    # filmingDates needs the Miami Vice list to be a valid multi
    batch["filmingDates"] = ["12/7 (MON)"]
    s, ok3 = call("POST", f"/talent/{F}/answers", token=ADMIN, body={"answers": batch, "formSlug": "miamivice"})
    check("fill-all batch saved", s == 200 and len(ok3.get("saved", [])) == len(batch), f"{s} {ok3}")
    for slot in (1, 2):
        s, ph = call("POST", f"/talent/{F}/photos", token=ADMIN, body={"slot": slot, "dataUrl": TINY_PNG})
        check(f"upload photo slot {slot}", s == 201, f"{s} {ph}")
    s, al3 = call("POST", f"/talent/{F}/missing-info-alert", token=ADMIN, body={"dryRun": True})
    check("alert with no gaps -> alerted false",
          s == 200 and al3.get("alerted") is False and al3.get("gaps") == [], f"{s} {al3}")

    # --- 7. submission link + manual snapshot ---
    s, badlink = call("POST", f"/applications/{A}/submission-link", token=ADMIN, body={"link": "not-a-url"})
    check("bad submission link -> 400", s == 400, f"{s} {badlink}")
    s, lk = call("POST", f"/applications/{A}/submission-link", token=ADMIN,
                 body={"link": "https://tally.so/r/TEST123", "note": "TaylorMade Tally form submitted from the live browser task."})
    check("submission link stored",
          s == 200 and lk.get("application", {}).get("submissionLink") == "https://tally.so/r/TEST123", f"{s} {lk}")
    s, lk2 = call("POST", f"/applications/{A}/submission-link", token=TOKF, body={"link": "https://tally.so/r/TEST123"})
    check("submission link as talent -> 401", s == 401, f"{s} {lk2}")
    s, sn = call("POST", f"/applications/{A}/snapshot", token=ADMIN, body={})
    snap = sn.get("snapshot", {})
    check("manual snapshot -> 200, receipt stored",
          s == 200 and snap.get("applicationId") == A and snap.get("source") == "manual"
          and snap.get("jobTitle") == "TEST — Alerts With-Email Role"
          and snap.get("referenceCode", "").startswith("TTT-")
          and snap.get("photosSent") == 2, f"{s} {sn}")
    check("manual snapshot email queued (not sent, no transport)",
          sn.get("snapshotEmailQueued") is True and sn.get("snapshotEmailSent") is False, f"{s} {sn}")
    s, one = call("GET", f"/applications/{A}", token=ADMIN)
    check("GET single application shows link + full snapshot",
          s == 200 and one.get("application", {}).get("submissionLink") == "https://tally.so/r/TEST123"
          and one.get("application", {}).get("snapshot", {}).get("source") == "manual", f"{s} {one}")
    s, one2 = call("GET", f"/applications/{A}", token=TOKG)
    check("GET single as other talent -> 403", s == 403, f"{s} {one2}")
    s, lst = call("GET", f"/applications?talentId={F}", token=ADMIN)
    rowA = [a for a in lst.get("applications", []) if a["id"] == A][0]
    check("list carries snapshot SUMMARY (not the full snapshot)",
          rowA.get("snapshotSummary", {}).get("source") == "manual"
          and "emailBody" not in json.dumps(rowA), str(rowA))
    check("list carries submissionLink + outcome null",
          rowA.get("submissionLink") == "https://tally.so/r/TEST123" and rowA.get("outcome") is None, str(rowA))
    s, sn2 = call("POST", "/applications/app_doesnotexist/snapshot", token=ADMIN, body={})
    check("snapshot on missing app -> 404", s == 404, f"{s} {sn2}")

    # snapshot email text (from the queue): exactly what went out
    qrows = dbq("SELECT subject, body, status, kind FROM email_queue WHERE application_id = '" + A + "' AND kind = 'snapshot' ORDER BY created_at DESC LIMIT 1")
    check("snapshot email queued with receipt subject",
          qrows and "submission receipt" in qrows[0]["subject"] and qrows[0]["status"] == "QUEUED", str(qrows))
    check("snapshot email body names the job + ref + destination",
          qrows and "TEST — Alerts With-Email Role" in qrows[0]["body"]
          and snap.get("referenceCode", "") in qrows[0]["body"], str(qrows[0].get("body", ""))[:400])

    # --- 8. send flow: package-ready stores a snapshot; queued-unsent stores none ---
    s, _ = call("PATCH", f"/applications/{B}/status", token=ADMIN, body={"status": "APPROVED"})
    s, _ = call("PATCH", f"/applications/{A}/status", token=ADMIN, body={"status": "APPROVED"})
    s, sndB = call("POST", f"/applications/{B}/send", token=ADMIN, body={})
    check("send B (no destination) -> PACKAGE READY",
          s == 200 and sndB.get("packageReady") is True and sndB.get("status") == "PACKAGE READY", f"{s} {sndB}")
    s, oneB = call("GET", f"/applications/{B}", token=ADMIN)
    snapB = oneB.get("application", {}).get("snapshot", {})
    check("package-ready snapshot stored (source package-ready, full email text kept)",
          snapB.get("source") == "package-ready" and snapB.get("status") == "PACKAGE READY"
          and snapB.get("emailBody") and "TEST — Alerts No-Email Role" in snapB.get("emailBody", ""), str(snapB)[:300])
    qB = dbq("SELECT kind, status FROM email_queue WHERE application_id = '" + B + "' AND kind = 'snapshot'")
    check("package-ready snapshot email queued to the talent", len(qB) == 1 and qB[0]["status"] == "QUEUED", str(qB))
    s, sndA = call("POST", f"/applications/{A}/send", token=ADMIN, body={})
    check("send A (has destination, no transport) -> queued, not sent",
          s == 200 and sndA.get("sent") is False and sndA.get("queued") is True, f"{s} {sndA}")
    s, oneA = call("GET", f"/applications/{A}", token=ADMIN)
    check("queued-unsent send stored NO new snapshot (manual one intact)",
          oneA.get("application", {}).get("snapshot", {}).get("source") == "manual", str(oneA.get("application", {}).get("snapshot", {}).get("source")))

    # --- 9. outcomes: accepted / callback / rejected + guards ---
    s, ocB = call("POST", f"/applications/{B}/outcome", token=ADMIN, body={
        "outcome": "accepted", "fromName": "Test Casting",
        "details": {"callTime": "9:00 AM", "eventDate": "2026-12-03", "location": "Test Studio, Miami",
                    "whatToBring": "ID + headshot", "contact": "casting@example.com",
                    "notes": "Park in the back lot."}})
    check("outcome accepted -> 200, booking created",
          s == 200 and ocB.get("application", {}).get("outcome") == "accepted"
          and ocB.get("booking", {}).get("status") == "BOOKED"
          and ocB.get("booking", {}).get("eventDate") == "2026-12-03", f"{s} {ocB}")
    check("accepted booking math: $300 gross, fee <= gross",
          ocB.get("booking", {}).get("grossCents") == 30000
          and ocB.get("booking", {}).get("netCents", 0) <= 30000, str(ocB.get("booking")))
    check("outcome email queued, notification made",
          ocB.get("emailQueued") is True and ocB.get("emailSent") is False and ocB.get("notificationId"), f"{s} {ocB}")
    qoc = dbq("SELECT body FROM email_queue WHERE application_id = '" + B + "' AND kind = 'outcome' ORDER BY created_at DESC LIMIT 1")
    check("accepted email carries the agency's facts, no 'still to come'",
          qoc and "9:00 AM" in qoc[0]["body"] and "Test Studio, Miami" in qoc[0]["body"]
          and "Still to come" not in qoc[0]["body"], str(qoc[0].get("body", ""))[:400])
    s, oneB2 = call("GET", f"/applications/{B}", token=ADMIN)
    check("GET B shows outcome + details",
          oneB2.get("application", {}).get("outcome") == "accepted"
          and oneB2.get("application", {}).get("outcomeDetails", {}).get("callTime") == "9:00 AM", str(oneB2))
    s, lstB = call("GET", f"/applications?talentId={F}", token=ADMIN)
    rowB = [a for a in lstB.get("applications", []) if a["id"] == B][0]
    check("list shows outcome accepted for B", rowB.get("outcome") == "accepted", str(rowB))

    # accepted again: updates the same booking, no duplicate
    s, ocB2 = call("POST", f"/applications/{B}/outcome", token=ADMIN, body={
        "outcome": "accepted", "fromName": "Test Casting",
        "details": {"eventDate": "2026-12-04"}})
    bkrows = dbq("SELECT id, event_date FROM bookings WHERE application_id = '" + B + "'")
    check("second accepted updates the same booking (no duplicate)",
          s == 200 and len(bkrows) == 1 and bkrows[0]["event_date"] == "2026-12-04", f"{s} {bkrows}")
    qoc2 = dbq("SELECT body FROM email_queue WHERE application_id = '" + B + "' AND kind = 'outcome' ORDER BY created_at DESC LIMIT 1")
    check("accepted with missing details lists them as still to come",
          qoc2 and "Still to come from the agency: call time, location, what to bring." in qoc2[0]["body"], str(qoc2[0].get("body", ""))[:400])

    # callback: ask quoted, nothing invented
    s, ocA = call("POST", f"/applications/{A}/outcome", token=ADMIN, body={
        "outcome": "callback", "fromName": "Test Casting",
        "details": {"ask": "Can she do a fitting on December 2?"}})
    check("outcome callback -> 200, no booking",
          s == 200 and ocA.get("application", {}).get("outcome") == "callback" and ocA.get("booking") is None, f"{s} {ocA}")
    qocA = dbq("SELECT body FROM email_queue WHERE application_id = '" + A + "' AND kind = 'outcome' ORDER BY created_at DESC LIMIT 1")
    check("callback email quotes the ask and invents no call time",
          qocA and "Can she do a fitting on December 2?" in qocA[0]["body"]
          and "Call time:" not in qocA[0]["body"], str(qocA[0].get("body", ""))[:400])

    # rejected (a third application on its own listing — one application per
    # talent+opportunity, so C uses opp-email2)
    s, aC = call("POST", "/applications", token=ADMIN, body={"talentId": F, "opportunityId": "test:alerts-email2"})
    check("application C created", s == 201 and aC.get("application", {}).get("id"), f"{s} {aC}")
    C = aC.get("application", {}).get("id")
    s, ocC = call("POST", f"/applications/{C}/outcome", token=ADMIN, body={"outcome": "rejected", "fromName": "Test Casting"})
    check("outcome rejected -> 200, no booking",
          s == 200 and ocC.get("application", {}).get("outcome") == "rejected" and ocC.get("booking") is None, f"{s} {ocC}")
    qocC = dbq("SELECT body FROM email_queue WHERE application_id = '" + C + "' AND kind = 'outcome' ORDER BY created_at DESC LIMIT 1")
    check("rejected email says not selected, no booking language",
          qocC and "not selected" in qocC[0]["body"] and "Call time:" not in qocC[0]["body"], str(qocC[0].get("body", ""))[:300])

    # reply linkage
    s, rp = call("POST", "/application-replies", token=ADMIN, body={
        "applicationId": C, "fromName": "Test Casting", "channel": "email",
        "body": "She is booked for Dec 3 — call time 9 AM."})
    check("record a reply for C", s in (200, 201) and rp.get("reply", {}).get("id"), f"{s} {rp}")
    RID = rp.get("reply", {}).get("id")
    s, ocC2 = call("POST", f"/applications/{C}/outcome", token=ADMIN, body={
        "outcome": "accepted", "fromName": "Test Casting", "replyId": RID,
        "details": {"eventDate": "2026-12-03"}})
    check("outcome with a matching replyId links it",
          s == 200 and ocC2.get("application", {}).get("outcomeDetails", {}).get("replyId") == RID, f"{s} {ocC2}")

    # outcome guards
    s, g1 = call("POST", f"/applications/{A}/outcome", token=ADMIN, body={"outcome": "maybe"})
    check("outcome 'maybe' -> 400", s == 400, f"{s} {g1}")
    s, g2 = call("POST", f"/applications/{A}/outcome", token=ADMIN, body={"outcome": "accepted", "details": {"eventDate": "Dec 3"}})
    check("bad eventDate -> 400", s == 400, f"{s} {g2}")
    s, g3 = call("POST", f"/applications/{A}/outcome", token=ADMIN, body={"outcome": "accepted", "replyId": "rpl_doesnotexist"})
    check("replyId not on this application -> 400", s == 400, f"{s} {g3}")
    s, g4 = call("POST", f"/applications/{A}/outcome", token=TOKF, body={"outcome": "rejected"})
    check("outcome as talent -> 401", s == 401, f"{s} {g4}")
    s, g5 = call("POST", "/applications/app_doesnotexist/outcome", token=ADMIN, body={"outcome": "rejected"})
    check("outcome on missing app -> 404", s == 404, f"{s} {g5}")
    s, g6 = call("POST", f"/applications/{A}/outcome", token=ADMIN, body={})
    check("outcome with no outcome field -> 400", s == 400, f"{s} {g6}")

    # --- 10. audit trail ---
    acts = dbq("SELECT action FROM audit_log WHERE action IN ('application.snapshot','application.outcome','talent.missing-info.alert','talent.answers','application.submission-link')")
    got = sorted(set(a["action"] for a in acts))
    check("audit log carries all five new actions",
          got == ["application.outcome", "application.snapshot", "application.submission-link", "talent.answers", "talent.missing-info.alert"], str(got))
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

print(f"\nALERTS-RECEIPTS-TEST: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
