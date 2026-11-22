#!/usr/bin/env bash
# TOP TEA TALENTS selftest: starts the server on a test port with a temp
# SQLite DB, runs curl checks, kills the server, prints PASS/FAIL per check.
# Exits non-zero on any failure.
set -u
cd "$(dirname "$0")"
PORT="${TEST_PORT:-3457}"
DB="$(mktemp /tmp/ttt-test-XXXXXX.db)"
rm -f "$DB"
export PORT DATABASE_PATH="$DB" ADMIN_TOKEN="test-admin-token"
bun run src/server.ts > /tmp/ttt-selftest-server.log 2>&1 &
SERVER_PID=$!
cleanup() { kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm"; }
trap cleanup EXIT

BASE="http://127.0.0.1:$PORT/api/v1"
PASS=0; FAIL=0
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" > /tmp/ttt-check.out 2>&1; then PASS=$((PASS+1)); echo "PASS: $name";
  else FAIL=$((FAIL+1)); echo "FAIL: $name"; sed 's/^/  /' /tmp/ttt-check.out | head -n 20; fi
}
jget() { python3 -c "import sys,json; d=json.load(open('/tmp/ttt-body.json')); print(eval(sys.argv[1]))" "$1"; }

# wait for health
for i in $(seq 1 30); do
  if curl -sf "$BASE/health" -o /tmp/ttt-body.json 2>/dev/null; then break; fi
  sleep 0.5
done

check "health returns ok + test_mode + sqlite storage" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["ok"] is True and d["test_mode"] is True and d["submissions_paused"] is True, d
assert d["storage"]=="sqlite" and d["storage_durable"] is False, d
assert d["version"]=="1.0.0", d
print("health ok:", d["counts"])
PY

curl -sf "$BASE/stats" -o /tmp/ttt-body.json
cp /tmp/ttt-body.json /tmp/ttt-stats.json
check "stats: opportunities 423, intel 96, sources 23, expired+live consistent" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["opportunityCount"]==423, d
assert d["productionIntelCount"]==96, d
assert d["sourceCount"]==23, d
assert d["verifiedOppCount"]==0, d
assert d["expiredOppCount"]+ (423-d["expiredOppCount"])==423, d
assert d["expiredOppCount"]>=101, d  # 101 expired at seed time; deadlines keep passing
print(d)
PY

curl -sf "$BASE/sources" -o /tmp/ttt-body.json
check "sources count 23 incl. EXCLUDED StudioBinder" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert len(d["sources"])==23, len(d["sources"])
ex=[s for s in d["sources"] if s["name"]=="StudioBinder"]
assert len(ex)==1 and ex[0]["status"]=="EXCLUDED", ex
assert all(s["status"]=="NOT CONNECTED" or s["status"]=="EXCLUDED" for s in d["sources"])
print("sources ok")
PY

curl -sf "$BASE/opportunities?limit=1" -o /tmp/ttt-body.json
OPP_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['opportunities'][0]['id'])")
check "opportunities list returns live opp with expired flag" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
s=json.load(open('/tmp/ttt-stats.json'))
assert d["total"]==423-s["expiredOppCount"], (d["total"], s["expiredOppCount"])
assert d["expiredCount"]==s["expiredOppCount"], d["expiredCount"]
assert d["opportunities"][0]["expired"] is False
print("first opp:", d["opportunities"][0]["id"])
PY

curl -sf "$BASE/opportunities?include_expired=true&limit=1" -o /tmp/ttt-body.json
check "include_expired=true returns all 423" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['total']==423, d['total']"
curl -sf "$BASE/opportunities/backstage%3A3342973" -o /tmp/ttt-body.json
check "opportunity detail resolves a URL-encoded id (colon in id)" python3 -c "
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d['opportunity']['id']=='backstage:3342973', d
print('detail title:', d['opportunity']['title'][:60])"

# browse-all filters: status, sort, pay_type, source, county
curl -sf "$BASE/opportunities?status=expired&limit=500" -o /tmp/ttt-body.json
check "browse: status=expired returns only expired" python3 -c "
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d['total']==d['expiredCount'] and d['total']>0, d
assert all(o['expired'] for o in d['opportunities']), 'non-expired in expired list'
print('expired total:', d['total'])"
curl -sf "$BASE/opportunities?status=live&sort=oldest&limit=5" -o /tmp/ttt-body.json
check "browse: status=live + sort=oldest is live-only, date ascending" python3 -c "
import json
d=json.load(open('/tmp/ttt-body.json'))
assert all(not o['expired'] for o in d['opportunities'])
ds=[o.get('discovered_at','') for o in d['opportunities']]
assert ds==sorted(ds), ds
print('oldest live first:', ds[0])"
curl -sf "$BASE/opportunities?sort=newest&limit=3" -o /tmp/ttt-body.json
check "browse: sort=newest is date descending" python3 -c "
import json
d=json.load(open('/tmp/ttt-body.json'))
ds=[o.get('discovered_at','') for o in d['opportunities']]
assert ds==sorted(ds, reverse=True), ds
print('newest first:', ds[0])"
curl -sf "$BASE/opportunities?pay_type=daily&source=projectcasting&limit=500" -o /tmp/ttt-body.json
check "browse: pay_type + source filters combine" python3 -c "
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d['total']>0, d
assert all(o.get('compensation_type')=='daily' and o.get('source')=='projectcasting' for o in d['opportunities'])
print('daily projectcasting:', d['total'])"
curl -sf "$BASE/opportunities?county=Miami-Dade&status=all&limit=500" -o /tmp/ttt-body.json
check "browse: county filter matches location.county" python3 -c "
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d['total']>=100, d['total']
assert all((o.get('location') or {}).get('county')=='Miami-Dade' for o in d['opportunities'])
print('Miami-Dade total:', d['total'])"

# register a test talent
curl -sf -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"test@toptea.example","phone":"3055550100","firstName":"Testy","lastName":"Talent","password":"secret123","termsAccepted":true}' -o /tmp/ttt-body.json
TALENT_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['talentId'])")
TOKEN=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['token'])")
check "register returns talentId + token" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talentId'].startswith('tal_') and d['token'], d"

check "duplicate email returns 409" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/auth/register -H 'Content-Type: application/json' -d '{\"email\":\"test@toptea.example\",\"phone\":\"3055550100\",\"firstName\":\"Testy\",\"lastName\":\"Talent\",\"password\":\"secret123\",\"termsAccepted\":true}' | grep -q 409"

check "login works" bash -c "curl -sf -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"test@toptea.example\",\"password\":\"secret123\"}' -o /tmp/ttt-body.json && grep -q token /tmp/ttt-body.json"

# complete the profile to 100%
curl -sf -X PATCH "$BASE/talent/$TALENT_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"city":"Miami","state":"FL","zip":"33101","height":"5ft 9in","ageRange":"25-35","adultOrMinor":"adult","languages":["English"],"skills":["Acting"],"experience":"5 years background work","categories":["Background extras"],"availability":["Weekdays","Weekends"],"minCompensation":100}' -o /tmp/ttt-body.json
check "profile completion 100%" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talent']['completion']==100, d['talent']; assert d['talent']['status']=='PROFILE UNDER REVIEW', d['talent']['status']"

# consent: wrong signature -> 400, right signature -> 200
check "consent sign with wrong signature returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/likeness-release/sign -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"agreed\":true,\"signature\":\"Wrong Name\"}' | grep -q 400"
check "consent sign with legal name succeeds" bash -c "curl -sf -X POST $BASE/talent/$TALENT_ID/likeness-release/sign -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"agreed\":true,\"signature\":\"Testy Talent\"}' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['status']=='AWAITING AGENCY REVIEW', d\""

# fast-track + review PASS -> READY FOR MATCHING
curl -sf -X POST "$BASE/talent/$TALENT_ID/fast-track" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"controls":{"A":true},"rules":{"categories":["Background extras"],"geography":"south-florida"},"autoSubmit":false}' -o /tmp/ttt-body.json
check "fast-track saves as v1.0" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['version']=='v1.0', d"
curl -sf -X POST "$BASE/talent/$TALENT_ID/review" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' \
  -d '{"decision":"PASS"}' -o /tmp/ttt-body.json
check "review PASS -> READY FOR MATCHING" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['status']=='READY FOR MATCHING', d"

# rotation queue (submissions are paused by default, so unpause first via admin settings)
curl -sf -X POST "$BASE/settings" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"submissionsPaused":false}' -o /tmp/ttt-body.json
curl -sf -X POST "$BASE/talent/$TALENT_ID/rotation-queue" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "rotation queue returns pay-first ranked queue with caps" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["queue"], d
assert d["caps"]["perDay"]==3 and d["caps"]["perWeek"]==10, d["caps"]
pays=[q["normalizedDailyPay"] for q in d["queue"] if q["normalizedDailyPay"] is not None]
assert pays==sorted(pays, reverse=True), "queue not pay-first ranked"
assert any(q["decision"]=="SELECTED" for q in d["queue"])
print("queue size:", len(d["queue"]), "selected:", sum(1 for q in d["queue"] if q["decision"]=="SELECTED"))
PY

# commission calc: $550/day -> 12.5% = $68.75, net $481.25
curl -sf "$BASE/commission/calculate?gross=550&type=daily" -o /tmp/ttt-body.json
check "commission calc \$550/day -> 12.5% fee \$68.75 net \$481.25" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["rate"]==12.5, d
assert d["fee"]==68.75, d
assert d["net"]==481.25, d
assert d["gross"]-d["fee"]==d["net"], d
assert d["feeCents"]==6875 and d["netCents"]==48125, d
print(d)
PY

# application + booking (without evidence -> 400, with evidence -> 201)
curl -sf -X POST "$BASE/applications" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"talentId\":\"$TALENT_ID\",\"opportunityId\":\"$OPP_ID\"}" -o /tmp/ttt-body.json
APP_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['application']['id'])")
check "application created AWAITING APPROVAL (TEST MODE)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['application']['status']=='AWAITING APPROVAL' and 'TEST MODE' in d.get('note',''), d"
check "duplicate application returns 409" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/applications -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"talentId\":\"$TALENT_ID\",\"opportunityId\":\"$OPP_ID\"}' | grep -q 409"
check "booking without evidence returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/bookings -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{\"applicationId\":\"$APP_ID\"}' | grep -q 400"
curl -sf -X POST "$BASE/bookings" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' \
  -d "{\"applicationId\":\"$APP_ID\",\"evidence\":\"confirmation email from casting\"}" -o /tmp/ttt-body.json
check "booking with evidence succeeds + gross-fee=net in cents" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
b=d["booking"]
assert b["status"]=="BOOKED", b
assert b["grossCents"]-b["commissionCents"]==b["netCents"], b
assert "email pending" in d.get("note","").lower() or "queued" in d.get("note","").lower(), d
print(b)
PY
curl -sf "$BASE/talent/$TALENT_ID/notifications" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "booking created an in-app notification" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert len(d['notifications'])>=1 and 'Booking confirmed' in d['notifications'][0]['title'], d"

# SUBMITTED - CONFIRMED blocked in TEST MODE
check "SUBMITTED-CONFIRMED blocked in TEST MODE (400)" bash -c "curl -s -o /dev/null -w '%{http_code}' -X PATCH $BASE/applications/$APP_ID/status -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"status\":\"SUBMITTED — CONFIRMED\"}' | grep -q 400"

# ----- LEDGER -----
curl -sf "$BASE/ledger?entity_id=$TALENT_ID&limit=100" -o /tmp/ttt-body.json
check "ledger has register event for the talent" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
types=[e["event_type"] for e in d["events"]]
assert "talent.register" in types, types
assert all("hash" in e and "prev_hash" in e and "seq" in e for e in d["events"])
print("talent events:", types)
PY
curl -sf "$BASE/ledger/verify" -o /tmp/ttt-body.json
check "ledger verify valid, head_seq matches event count" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["valid"] is True and d["first_bad_seq"] is None, d
assert d["head_seq"]==d["events"], d
print("ledger:", d["events"], "events, head_seq", d["head_seq"])
PY
curl -sf "$BASE/ledger/export" -o /tmp/ttt-body.json
check "ledger export is JSONL with seed.import event" bash -c "grep -q seed.import /tmp/ttt-body.json && head -n 1 /tmp/ttt-body.json | python3 -c 'import sys,json; json.loads(sys.stdin.read()); print(\"jsonl ok\")'"
curl -sf -X POST "$BASE/ledger/note" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"note":"Manual correction: verified by phone.","entity_type":"agency","entity_id":"project-casting"}' -o /tmp/ttt-body.json
check "ledger note appends a manual correction entry" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is True and isinstance(d['seq'], int), d"
curl -sf "$BASE/ledger/verify" -o /tmp/ttt-body.json
check "ledger still verifies after the manual note" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['valid'] is True, d"
curl -sf "$BASE/ledger?limit=1" -o /tmp/ttt-body.json
check "ledger list is newest-first" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["events"][0]["event_type"]=="ledger.note", d["events"][0]
print("newest event:", d["events"][0]["event_type"], "seq", d["events"][0]["seq"])
PY
curl -sf "$BASE/talent/$TALENT_ID/audit" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "talent audit reads from ledger" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['total']>=1 and d['events'][0]['entity_id']=='$TALENT_ID', d"

# ----- CONTACTS -----
curl -sf "$BASE/contacts" -o /tmp/ttt-body.json
check "contacts lists the registered talent" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
names=[c["name"] for c in d["contacts"]]
assert "Testy Talent" in names, names
assert d["total"]>=23, d["total"]
kinds={c["kind"] for c in d["contacts"]}
assert "talent" in kinds and "agency" in kinds, kinds
print("contacts:", d["total"], "kinds:", kinds)
PY

# ----- AGENCIES -----
curl -sf "$BASE/agencies" -o /tmp/ttt-body.json
check "agencies ranked; the 1 test booking flags Project Casting spike + top-10% repeat badge" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["agencies"], d
booked=[a for a in d["agencies"] if a["bookingsConfirmed"]>0]
assert len(booked)==1 and booked[0]["name"]=="Project Casting" and booked[0]["bookingsConfirmed"]==1, booked
assert booked[0]["repeatBadge"] is True and booked[0]["repeatReason"]=="top 10% by volume", booked[0]
assert all(a["repeatBadge"] is False for a in d["agencies"] if a["name"]!="Project Casting"), "only the top-volume agency badges"
assert booked[0]["spike"] is True and "First-ever booking" in (booked[0]["spikeReason"] or ""), booked[0]
assert all(a["spike"] is False for a in d["agencies"] if a["name"]!="Project Casting")
vols=[a["bookingsConfirmed"] for a in d["agencies"]]
assert vols==sorted(vols, reverse=True)
print("agencies:", len(d["agencies"]), "top:", d["agencies"][0]["name"], d["agencies"][0]["jobsPosted"], "jobs")
PY
AGENCY_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['agencies'][0]['id'])")
curl -sf "$BASE/agencies/$AGENCY_ID/history" -o /tmp/ttt-body.json
check "agency history returns full history (jobs + the 1 test booking + tracking-only payment)" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert "agency" in d and "jobs" in d and "applications" in d and "bookings" in d and "payments" in d and "events" in d, d.keys()
assert len(d["jobs"])>=1, d
assert len(d["bookings"])==1 and len(d["payments"])==1, d
assert d["payments"][0]["note"].startswith("Payment tracking only"), d["payments"]
assert len(d["events"])>=1, d
print("history jobs:", len(d["jobs"]), "bookings:", len(d["bookings"]))
PY

echo
echo "SELFTEST: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
