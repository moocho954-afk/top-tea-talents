#!/usr/bin/env bash
# TOP TEA TALENTS selftest: starts the server on a test port with a temp
# SQLite DB, runs curl checks, kills the server, prints PASS/FAIL per check.
# Exits non-zero on any failure.
set -u
cd "$(dirname "$0")"
PORT="${TEST_PORT:-3457}"
DB="$(mktemp /tmp/ttt-test-XXXXXX.db)"
rm -f "$DB"
MIRROR="${DB%.db}-mirror.jsonl" # wipe-proof ledger mirror lives next to the DB
export PORT DATABASE_PATH="$DB" ADMIN_TOKEN="test-admin-token"
bun run src/server.ts > /tmp/ttt-selftest-server.log 2>&1 &
SERVER_PID=$!
cleanup() { kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm" "$MIRROR" "$MIRROR".fetch-tmp "$MIRROR".rebuild-tmp "$MIRROR".tampered-*; }
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
wait_health() { # reused after every restart in the wipe tests below
  for i in $(seq 1 30); do
    if curl -sf "$BASE/health" -o /tmp/ttt-body.json 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

check "health returns ok + test_mode + sqlite storage" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["ok"] is True and d["test_mode"] is True and d["submissions_paused"] is True, d
assert d["storage"]=="sqlite" and d["storage_durable"] is False, d
assert d["version"]=="1.3.1", d
assert d["live_mode"] is False and d["mail_configured"] is False, d
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
# v7 email verification gate: consent sign + rotation require a verified
# email. TEST MODE: the code comes back once in the register response
# (email is not connected), so verify it here before consent.
VCODE=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['testModeVerificationCode'])")
check "register returns verificationRequired + TEST MODE code (email not connected)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['verificationRequired'] is True and len(d['testModeVerificationCode'])==6 and d['testModeVerificationCode'].isdigit(), d"
curl -sf -X POST "$BASE/auth/verify-email" -H 'Content-Type: application/json' -d "{\"email\":\"test@toptea.example\",\"code\":\"$VCODE\"}" -o /tmp/ttt-body.json
check "email verification with TEST MODE code succeeds" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['verified'] is True, d"

check "verify with wrong code returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/auth/verify-email -H 'Content-Type: application/json' -d '{\"email\":\"test@toptea.example\",\"code\":\"000000\"}' | grep -q 400"
curl -sf "$BASE/auth/verification-status?email=test@toptea.example" -o /tmp/ttt-body.json
check "verification status: verified after code entry" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['verified'] is True, d"

check "duplicate email returns 409" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/auth/register -H 'Content-Type: application/json' -d '{\"email\":\"test@toptea.example\",\"phone\":\"3055550100\",\"firstName\":\"Testy\",\"lastName\":\"Talent\",\"password\":\"secret123\",\"termsAccepted\":true}' | grep -q 409"

check "login works" bash -c "curl -sf -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"test@toptea.example\",\"password\":\"secret123\"}' -o /tmp/ttt-body.json && grep -q token /tmp/ttt-body.json"

# complete the profile to 100%
curl -sf -X PATCH "$BASE/talent/$TALENT_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"city":"Miami","state":"FL","zip":"33101","height":"5ft 9in","ageRange":"25-35","adultOrMinor":"adult","languages":["English"],"skills":["Acting"],"experience":"5 years background work","categories":["Background extras"],"availability":["Weekdays","Weekends"],"minCompensation":100}' -o /tmp/ttt-body.json
check "profile completion 75% richness, 100% core (no photos/gender/social)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talent']['completion']==75, d['talent']; assert d['talent']['coreCompletion']==100, d['talent']; assert d['talent']['status']=='PROFILE UNDER REVIEW', d['talent']['status']"

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
check "rotation queue returns selectivity-first, pay-first-within-class queue with caps" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["queue"], d
assert d["caps"]["perDay"]==3 and d["caps"]["perWeek"]==10, d["caps"]
rank={"guaranteed":0,"unknown":1,"selective":2}
ranks=[rank[q["selectivity"]] for q in d["queue"]]
assert ranks==sorted(ranks), "queue not selectivity-first ranked"
for r in (0,1,2):
    pays=[q["normalizedDailyPay"] for q in d["queue"] if rank[q["selectivity"]]==r and q["normalizedDailyPay"] is not None]
    assert pays==sorted(pays, reverse=True), f"pay not desc within selectivity class {r}"
assert any(q["decision"]=="SELECTED" for q in d["queue"])
assert all("selectivity" in q and "genderRequirement" in q for q in d["queue"])
print("queue size:", len(d["queue"]), "selected:", sum(1 for q in d["queue"] if q["decision"]=="SELECTED"))
PY

# ----- v1.2.0 GENDER FILTER + SELECTIVITY -----
# Fourth talent: male, full profile, READY FOR MATCHING. Anchor:
# allcasting:319858 (Miss Florida US Nation 2027) is female-only, live
# (deadline 2026-12-28) in the seed.
curl -sf -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"male@toptea.example","phone":"3055550103","firstName":"Male","lastName":"Talent","password":"secret123","termsAccepted":true}' -o /tmp/ttt-body.json
MTALENT_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['talentId'])")
MTOKEN=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['token'])")
MVCODE=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['testModeVerificationCode'])")
curl -sf -X POST "$BASE/auth/verify-email" -H 'Content-Type: application/json' -d "{\"email\":\"male@toptea.example\",\"code\":\"$MVCODE\"}" -o /tmp/ttt-body.json
curl -sf -X PATCH "$BASE/talent/$MTALENT_ID" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' \
  -d '{"city":"Miami","state":"FL","zip":"33101","height":"6ft 1in","ageRange":"35-44","adultOrMinor":"adult","experience":"5 years background work","categories":["Commercials"],"availability":["Weekdays"],"demographics":{"gender":"Male","ethnicity":"Black / African American"}}' -o /tmp/ttt-body.json
check "v1.2.0: male talent profile stores gender Male, richness 80" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); t=d['talent']; assert t['demographics']['gender']=='Male' and t['completion']==80 and t['coreCompletion']==100, t"
curl -sf -X POST "$BASE/talent/$MTALENT_ID/likeness-release/sign" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{"agreed":true,"signature":"Male Talent"}' -o /tmp/ttt-body.json
curl -sf -X POST "$BASE/talent/$MTALENT_ID/fast-track" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' \
  -d '{"controls":{"A":true},"rules":{"categories":["Commercials"],"geography":"south-florida"},"autoSubmit":false}' -o /tmp/ttt-body.json
curl -sf -X POST "$BASE/talent/$MTALENT_ID/review" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"decision":"PASS"}' -o /tmp/ttt-body.json
check "v1.2.0: male talent READY FOR MATCHING" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['status']=='READY FOR MATCHING', d"
curl -sf "$BASE/opportunities/allcasting%3A319858" -o /tmp/ttt-body.json
check "v1.2.0: anchor opp is female-only + live, carries selectivity" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))['opportunity']
assert d['genderRequirement']=='female', d
assert d['expired'] is False, d
assert d['selectivity'] in ('guaranteed','selective','unknown'), d
print('anchor:', d['id'], d['title'][:40], 'selectivity:', d['selectivity'])
PY
curl -sf -X POST "$BASE/talent/$MTALENT_ID/match" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "v1.2.0: male talent match EXCLUDES female-only anchor, genderExcluded cites it" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
ids=[m['opportunityId'] for m in d['matches']]
assert 'allcasting:319858' not in ids, 'female-only opp matched a male talent'
assert d['talentGender']=='male' and d['genderSet'] is True, d
gx=[g for g in d['genderExcluded'] if g['opportunityId']=='allcasting:319858']
assert len(gx)==1 and gx[0]['requiredGender']=='female', d['genderExcluded']
assert d['genderExcluded'], 'genderExcluded empty'
print('matches:', len(ids), 'genderExcluded:', len(d['genderExcluded']))
PY
curl -sf "$BASE/talent/$MTALENT_ID/jobs-for-you" -H "Authorization: Bearer $MTOKEN" -o /tmp/ttt-body.json
check "v1.2.0: jobs-for-you also excludes the female-only anchor" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
ids=[j['opportunityId'] for j in d['jobs']]
assert 'allcasting:319858' not in ids, 'female-only opp in jobs-for-you for a male talent'
assert d['genderExcluded']>0, d
assert all('selectivity' in j and 'genderRequirement' in j for j in d['jobs']), 'job rows lack selectivity/genderRequirement'
print('jobs:', len(ids), 'genderExcluded:', d['genderExcluded'])
PY
curl -sf -X POST "$BASE/talent/$MTALENT_ID/rotation-queue" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "v1.2.0: rotation queue never SELECTS a female-only opp for a male talent" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
sel=[q for q in d['queue'] if q['decision']=='SELECTED']
assert all(q.get('genderRequirement')!='female' for q in sel), 'female-only opp SELECTED for a male talent'
row=[q for q in d['queue'] if q['opportunityId']=='allcasting:319858']
assert len(row)==1 and row[0]['decision']=='SKIPPED' and 'Gender requirement' in row[0]['reason'], row
print('queue:', len(d['queue']), 'selected:', len(sel))
PY
check "v1.2.0: manual application male + female-only opp returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/applications -H 'Authorization: Bearer $MTOKEN' -H 'Content-Type: application/json' -d '{\"talentId\":\"$MTALENT_ID\",\"opportunityId\":\"allcasting:319858\"}' | grep -q 400"
# ----- v1.2.1 GENDER DERIVATION FIX (mixed-role listings) -----
# allcasting:307031 "Recruitment for Miami Girl Group" has a Female lead
# vocal + a Both-genders dancer: pre-fix it derived open (the "(Both
# genders; …)" annotation tripped the listing-level open-signal test) and
# showed to male talents. It must derive female-only now, and the symmetric
# Male+Both case must derive male-only; Both-only and Female+Male stay open.
curl -sf "$BASE/opportunities/allcasting%3A307031" -o /tmp/ttt-body.json
check "v1.2.1: mixed Female+Both listing 307031 derives female-only" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json'))['opportunity']; assert d['genderRequirement']=='female', d; assert d['expired'] is False, d"
curl -sf "$BASE/opportunities/allcasting%3A287402" -o /tmp/ttt-body.json
check "v1.2.1: single-Female-role listing 287402 stays female-only" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json'))['opportunity']; assert d['genderRequirement']=='female', d"
curl -sf "$BASE/opportunities/allcasting%3A325773" -o /tmp/ttt-body.json
check "v1.2.1: symmetric Male+Both listing 325773 derives male-only" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json'))['opportunity']; assert d['genderRequirement']=='male', d"
curl -sf "$BASE/opportunities/allcasting%3A325752" -o /tmp/ttt-body.json
check "v1.2.1: Both-only listing 325752 stays open" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json'))['opportunity']; assert d['genderRequirement'] is None, d"
curl -sf "$BASE/opportunities/allcasting%3A325814" -o /tmp/ttt-body.json
check "v1.2.1: Female+Male listing 325814 stays open" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json'))['opportunity']; assert d['genderRequirement'] is None, d"
curl -sf -X POST "$BASE/talent/$MTALENT_ID/match" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "v1.2.1: male talent match EXCLUDES 307031, genderExcluded cites female" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
ids=[m['opportunityId'] for m in d['matches']]
assert 'allcasting:307031' not in ids, 'mixed female-only opp matched a male talent'
gx=[g for g in d['genderExcluded'] if g['opportunityId']=='allcasting:307031']
assert len(gx)==1 and gx[0]['requiredGender']=='female', d['genderExcluded']
print('307031 excluded for male talent, source:', gx[0]['source'])
PY
curl -sf "$BASE/talent/$MTALENT_ID/jobs-for-you" -H "Authorization: Bearer $MTOKEN" -o /tmp/ttt-body.json
check "v1.2.1: jobs-for-you also excludes 307031 for a male talent" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
ids=[j['opportunityId'] for j in d['jobs']]
assert 'allcasting:307031' not in ids, 'mixed female-only opp in jobs-for-you for a male talent'
print('jobs:', len(ids), 'genderExcluded:', d['genderExcluded'])
PY
check "v1.2.1: manual application male + 307031 returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/applications -H 'Authorization: Bearer $MTOKEN' -H 'Content-Type: application/json' -d '{\"talentId\":\"$MTALENT_ID\",\"opportunityId\":\"allcasting:307031\"}' | grep -q 400"
# ----- v1.3.1 AUTOMATION ELIGIBILITY (over-marking fix) -----
# Jobs For You used to mark EVERY job automationEligible=true for a talent
# with automation ON, as long as the match was not NEEDS TALENT APPROVAL —
# the match score alone decided, so Toronto TFP, London/SF undisclosed-pay
# and Savannah jobs were all flagged auto-sendable. The v1.3.1 gate
# (automationBlockers) enforces the Fast-Track hard rules — geography,
# pay, required languages — on top of the classification. Same male talent
# (Miami FL, 35-44), now with languages English + minCompensation 100 on
# file and automation ON (south-florida, minDaily 100).
curl -sf -X PATCH "$BASE/talent/$MTALENT_ID" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{"languages":["English"],"minCompensation":100}' -o /tmp/ttt-body.json
curl -sf -X POST "$BASE/talent/$MTALENT_ID/automation" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{"enabled":true,"categories":["Commercials"],"geography":"south-florida","minDaily":100}' -o /tmp/ttt-body.json
curl -sf "$BASE/talent/$MTALENT_ID/jobs-for-you" -H "Authorization: Bearer $MTOKEN" -o /tmp/ttt-body.json
check "v1.3.1: TFP Toronto job is NOT automation-eligible" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
by={j['opportunityId']: j for j in d['jobs']}
assert 'allcasting:323805' in by, 'TFP Toronto anchor missing from jobs-for-you: ' + str([j['opportunityId'] for j in d['jobs']])
j=by['allcasting:323805']
assert j['automationEligible'] is False, 'Toronto TFP still marked eligible'
assert any('Unpaid' in b or 'TFP' in b for b in j['automationBlockers']), j['automationBlockers']
assert any('outside your south-florida area' in b for b in j['automationBlockers']), j['automationBlockers']
print('Toronto blockers:', j['automationBlockers'])
PY
check "v1.3.1: undisclosed-pay jobs are NOT automation-eligible" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
by={j['opportunityId']: j for j in d['jobs']}
for wid in ['projectcasting:muse-the-agency-model-call-to-join-talent-agency', 'projectcasting:fog-city-sag-feature-film-open-casting-call']:
    assert wid in by, wid + ' missing from jobs-for-you'
    j=by[wid]
    assert j['automationEligible'] is False, wid + ' still marked eligible'
    assert any('undisclosed' in b.lower() for b in j['automationBlockers']), j['automationBlockers']
    print(wid[:40], 'blockers:', j['automationBlockers'])
PY
check "v1.3.1: fixed out-of-area jobs are NOT automation-eligible even when labeled nationwide" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
by={j['opportunityId']: j for j in d['jobs']}
for wid in ['projectcasting:sorry-about-my-friends-open-casting-call-for-extras', 'allcasting:325201']:
    assert wid in by, wid + ' missing from jobs-for-you'
    j=by[wid]
    assert j['automationEligible'] is False, wid + ' still marked eligible'
    assert any('outside your south-florida area' in b for b in j['automationBlockers']), j['automationBlockers']
    print(wid[:40], 'blockers:', j['automationBlockers'])
PY
check "v1.3.1: in-area stated-pay jobs STAY automation-eligible" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
by={j['opportunityId']: j for j in d['jobs']}
# Anchors are the Miami stated-pay jobs in THIS talent's top 25 (the
# Joseph-live-feed anchors — Miami Male Waiter, AutoZone — score below
# the cut for a no-skills test talent; the rule they prove is the same).
for wid in ['allcasting:325814', 'allcasting:325026']:
    assert wid in by, wid + ' missing from jobs-for-you'
    j=by[wid]
    assert j['automationEligible'] is True, wid + ' wrongly blocked: ' + str(j['automationBlockers'])
    assert j['automationBlockers'] == [], j['automationBlockers']
    print(wid[:40], 'eligible, classification:', j['classification'])
PY
check "v1.3.1: language-required jobs are NOT automation-eligible" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
by={j['opportunityId']: j for j in d['jobs']}
# allcasting:325752 is the Money Transfer App casting (same roles as
# commercial:allcasting:325752, which scores below the cut for a
# no-skills test talent): every role requires Hindi/Urdu/Arabic + English.
wid='allcasting:325752'
assert wid in by, wid + ' missing from jobs-for-you'
j=by[wid]
assert j['automationEligible'] is False, 'Money Transfer App still marked eligible for an English-only talent'
assert any('hindi' in b.lower() or 'urdu' in b.lower() or 'arabic' in b.lower() for b in j['automationBlockers']), j['automationBlockers']
print(wid[:40], 'blockers:', j['automationBlockers'])
PY
# Flip the same talent to Female: the anchor MUST now match, with a
# gender-fit reason on the match row.
curl -sf -X PATCH "$BASE/talent/$MTALENT_ID" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{"demographics":{"gender":"Female","ethnicity":"Black / African American"}}' -o /tmp/ttt-body.json
curl -sf -X POST "$BASE/talent/$MTALENT_ID/match" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "v1.2.0: female talent DOES match the female-only anchor, reason cites gender fit" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
m=[x for x in d['matches'] if x['opportunityId']=='allcasting:319858']
assert len(m)==1, 'female-only opp missing for a female talent'
assert any('Gender fit' in r for r in m[0]['reasons']), m[0]['reasons']
assert d['talentGender']=='female', d
print('anchor match classification:', m[0]['classification'])
PY
# Selectivity: guaranteed ranks before selective in /match; seed has both.
curl -sf -X POST "$BASE/talent/$MTALENT_ID/match" -H "Authorization: Bearer $MTOKEN" -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "v1.2.0: match order is guaranteed first, selective last" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
rank={"guaranteed":0,"unknown":1,"selective":2}
ranks=[rank[m['selectivity']] for m in d['matches']]
assert ranks==sorted(ranks), 'match list not selectivity-ranked'
assert any(m['selectivity']=='guaranteed' for m in d['matches']), 'no guaranteed match in seed'
assert any(m['selectivity']=='selective' for m in d['matches']), 'no selective match in seed'
print('matches:', len(d['matches']), 'guaranteed:', sum(1 for m in d['matches'] if m['selectivity']=='guaranteed'), 'selective:', sum(1 for m in d['matches'] if m['selectivity']=='selective'))
PY
curl -sf "$BASE/opportunities?limit=500&status=live" -o /tmp/ttt-body.json
check "v1.2.0: every live opp carries selectivity + genderRequirement" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d['total']>0, d
assert all(o.get('selectivity') in ('guaranteed','selective','unknown') for o in d['opportunities']), 'opp missing selectivity'
assert all('genderRequirement' in o for o in d['opportunities']), 'opp missing genderRequirement'
g=sum(1 for o in d['opportunities'] if o['selectivity']=='guaranteed')
s=sum(1 for o in d['opportunities'] if o['selectivity']=='selective')
print('live:', d['total'], 'guaranteed:', g, 'selective:', s, 'unknown:', d['total']-g-s)
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
  -d "{\"applicationId\":\"$APP_ID\",\"evidence\":\"confirmation email from casting\",\"gross\":550}" -o /tmp/ttt-body.json
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

# ----- v1.3.0 LIVE MAIL PATH -----
# (a) the applications list is no longer public: unauthenticated -> 401,
# a talent sees only their own, an admin sees all.
check "v1.3.0: GET /applications without auth returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' $BASE/applications | grep -q 401"
curl -sf "$BASE/applications" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "v1.3.0: talent sees only their own applications" python3 - "$TALENT_ID" <<'PY'
import sys, json
d=json.load(open('/tmp/ttt-body.json'))
assert d["total"]>=1 and all(a["talentId"]==sys.argv[1] for a in d["applications"]), d
print("own applications:", d["total"])
PY
curl -sf "$BASE/applications" -H 'Authorization: Bearer test-admin-token' -o /tmp/ttt-body.json
check "v1.3.0: admin sees the full applications list" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['total']>=1, d"
# (b) email status: admin only, reports TEST MODE + unconfigured mail.
check "v1.3.0: GET /email/status without admin returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' $BASE/email/status | grep -q 401"
curl -sf "$BASE/email/status" -H 'Authorization: Bearer test-admin-token' -o /tmp/ttt-body.json
check "v1.3.0: email status reports TEST MODE, agency sender, mail unconfigured" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["liveMode"] is False and d["mailConfigured"] is False, d
assert d["agencyEmail"]=="moocho954@gmail.com", d
assert d["mailMissing"], d["mailMissing"]
print("mail missing:", d["mailMissing"])
PY
# (c) dryRun previews the exact email without queueing, sending, or
# changing status — and the email carries the ref code + pay-ask line
# when the posting lists no parseable pay.
curl -sf -X POST "$BASE/applications/$APP_ID/send" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"dryRun":true}' -o /tmp/ttt-body.json
check "v1.3.0: send dryRun previews the email, claims nothing sent" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["dryRun"] is True and d["liveMode"] is False, d
e=d["email"]
assert e["subject"].startswith("Application — ") and "Ref TTT-" in e["subject"], e["subject"]
assert e["referenceCode"].startswith("TTT-"), e["referenceCode"]
assert "Reference code:" in e["body"], e["body"]
assert "confirm the pay rate" in e["body"] or "Listed pay:" in e["body"], e["body"]
assert d.get("sent") is not True, d
print("dryRun ref:", e["referenceCode"], "payAsk:", e["payAsk"], "destination:", d.get("destination"))
PY
# (d) a real send in TEST MODE is refused, 400.
check "v1.3.0: send without dryRun in TEST MODE returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/applications/$APP_ID/send -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{}' | grep -q 400"
# (e) drain in TEST MODE sends nothing and says why.
curl -sf -X POST "$BASE/email/drain" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "v1.3.0: drain in TEST MODE sends 0 and reports TEST MODE" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['sent']==0 and 'TEST MODE' in (d.get('reason') or ''), d"
# (f) flip live mode ON via settings (admin), approve the application,
# then send with NO transport configured: the email QUEUES, nothing is
# claimed sent, and the reason names the missing credentials. The `to`
# is supplied explicitly here because the seed listing carries no email
# address of its own (the real flow resolves it from the listing). Then
# the drain also reports the blocker. Flip live mode back OFF after.
curl -sf -X PATCH "$BASE/applications/$APP_ID/status" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"status":"APPROVED"}' -o /tmp/ttt-body.json
curl -sf -X POST "$BASE/settings" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"liveMode":true}' -o /tmp/ttt-body.json
check "v1.3.0: settings flip turns live mode ON (health confirms)" bash -c "curl -sf $BASE/health -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['live_mode'] is True and d['test_mode'] is False, d\""
curl -sf -X POST "$BASE/applications/$APP_ID/send" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"to":"casting@example.com"}' -o /tmp/ttt-body.json
check "v1.3.0: live-mode send with no transport queues, claims nothing sent" python3 - <<'PY'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["sent"] is False and d["queued"] is True, d
assert "not configured" in (d.get("reason") or ""), d
print("send blocked honestly:", d["reason"])
PY
curl -sf -X POST "$BASE/email/drain" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{}' -o /tmp/ttt-body.json
check "v1.3.0: live-mode drain with no transport sends 0, skips the queue" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['sent']==0 and d['skipped']>=1 and 'not configured' in (d.get('reason') or ''), d"
curl -sf -X POST "$BASE/settings" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"liveMode":false}' -o /tmp/ttt-body.json
check "v1.3.0: live mode flips back OFF (health confirms TEST MODE)" bash -c "curl -sf $BASE/health -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['live_mode'] is False and d['test_mode'] is True, d\""
# (g) SUBMITTED-CONFIRMED is still blocked without a SENT email even
# after the live-mode flip test above (the app was approved, not sent).
check "v1.3.0: SUBMITTED-CONFIRMED still 400 with no SENT email on file" bash -c "curl -s -o /dev/null -w '%{http_code}' -X PATCH $BASE/applications/$APP_ID/status -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"status\":\"SUBMITTED — CONFIRMED\"}' | grep -q 400"

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

# ----- v11 PARITY: verification gate, reset, jobs, automation, earnings, owner, portfolio, social, replies -----
# Second talent: consent is gated on verified email.
curl -sf -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"second@toptea.example","phone":"3055550101","firstName":"Second","lastName":"Talent","password":"secret123","city":"Fort Lauderdale","state":"FL","contactMethod":"text","termsAccepted":true}' -o /tmp/ttt-body.json
TALENT2_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['talentId'])")
TOKEN2=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['token'])")
VCODE2=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['testModeVerificationCode'])")
check "register accepts screen-1 city/state/contactMethod" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talentId'].startswith('tal_') and d['verificationRequired'] is True, d"
curl -sf -X PATCH "$BASE/talent/$TALENT2_ID" -H "Authorization: Bearer $TOKEN2" -H 'Content-Type: application/json' \
  -d '{"city":"Fort Lauderdale","state":"FL","zip":"33301","height":"5ft 6in","ageRange":"25-35","adultOrMinor":"adult","languages":["English"],"skills":["Acting"],"experience":"2 years extras","categories":["Background extras"],"availability":["Weekends"],"minCompensation":100}' -o /tmp/ttt-body.json
check "consent sign BLOCKED before email verification (400)" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT2_ID/likeness-release/sign -H 'Authorization: Bearer $TOKEN2' -H 'Content-Type: application/json' -d '{\"agreed\":true,\"signature\":\"Second Talent\"}' | grep -q 400"
curl -sf -X POST "$BASE/auth/verify-email" -H 'Content-Type: application/json' -d "{\"email\":\"second@toptea.example\",\"code\":\"$VCODE2\"}" -o /tmp/ttt-body.json
check "second talent verifies, then consent sign succeeds" bash -c "curl -sf -X POST $BASE/talent/$TALENT2_ID/likeness-release/sign -H 'Authorization: Bearer $TOKEN2' -H 'Content-Type: application/json' -d '{\"agreed\":true,\"signature\":\"Second Talent\"}' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['status']=='AWAITING AGENCY REVIEW', d\""

# password reset on talent2 (keeps talent1's session alive for later checks)
curl -sf -X POST "$BASE/auth/request-password-reset" -H 'Content-Type: application/json' -d '{"email":"second@toptea.example"}' -o /tmp/ttt-body.json
RCODE=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['testModeResetCode'])")
check "password reset request returns a TEST MODE code" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert len(d['testModeResetCode'])==6 and d['testModeResetCode'].isdigit(), d"
check "reset with wrong code returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/auth/reset-password -H 'Content-Type: application/json' -d '{\"email\":\"second@toptea.example\",\"code\":\"000000\",\"newPassword\":\"newsecret123\"}' | grep -q 400"
curl -sf -X POST "$BASE/auth/reset-password" -H 'Content-Type: application/json' -d "{\"email\":\"second@toptea.example\",\"code\":\"$RCODE\",\"newPassword\":\"newsecret123\"}" -o /tmp/ttt-body.json
check "reset with the right code succeeds" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['reset'] is True, d"
check "login works with the new password, old password fails" bash -c "curl -sf -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"second@toptea.example\",\"password\":\"newsecret123\"}' -o /tmp/ttt-body.json && grep -q token /tmp/ttt-body.json && curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"second@toptea.example\",\"password\":\"secret123\"}' | grep -q 401"
TOKEN2=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['token'])")

# ----- v19 SIGNUP-FLOW FIX: optional checkbox groups, wizard persistence, in-wizard photos -----
# Third talent: only the 6 core items, ZERO of languages/skills/categories/availability.
curl -sf -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"t3@toptea.example","phone":"3055550102","firstName":"Third","lastName":"Talent","password":"secret123","city":"Miami","state":"FL","termsAccepted":true}' -o /tmp/ttt-body.json
TALENT3_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['talentId'])")
TOKEN3=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['token'])")
VCODE3=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['testModeVerificationCode'])")
check "v19: third talent registers" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talentId'].startswith('tal_') and d['token'], d"
# (a) core-only profile -> 100% (optional groups NOT counted)
curl -sf -X PATCH "$BASE/talent/$TALENT3_ID" -H "Authorization: Bearer $TOKEN3" -H 'Content-Type: application/json' \
  -d '{"city":"Miami","state":"FL","zip":"33101","height":"5ft 9in","ageRange":"25-34","experience":"5 years background work"}' -o /tmp/ttt-body.json
check "v19: core-only profile (zero optional groups) reads 60% richness, 100% core" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talent']['completion']==60, d['talent']; assert d['talent']['coreCompletion']==100, d['talent']; assert d['talent']['status']=='PROFILE UNDER REVIEW', d['talent']['status']"
# (a2) release sign accepts a core-only profile (verify email first)
curl -sf -X POST "$BASE/auth/verify-email" -H 'Content-Type: application/json' -d "{\"email\":\"t3@toptea.example\",\"code\":\"$VCODE3\"}" -o /tmp/ttt-body.json
check "v19: core-only talent signs the likeness release" bash -c "curl -sf -X POST $BASE/talent/$TALENT3_ID/likeness-release/sign -H 'Authorization: Bearer $TOKEN3' -H 'Content-Type: application/json' -d '{\"agreed\":true,\"signature\":\"Third Talent\"}' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['status']=='AWAITING AGENCY REVIEW', d\""
# (b) adding optional groups keeps 100% (never hurts)
curl -sf -X PATCH "$BASE/talent/$TALENT3_ID" -H "Authorization: Bearer $TOKEN3" -H 'Content-Type: application/json' \
  -d '{"languages":["English","Spanish"],"skills":["Acting"],"categories":["Background extras"],"availability":["Weekdays"]}' -o /tmp/ttt-body.json
check "v19: optional groups filled -> 75% richness (60 core + 10 categories + 5 availability)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talent']['completion']==75, d['talent']"
# (d) wizard step saves persist: step-2-style PATCH with languages, then a
# step-3-style PATCH that omits languages entirely -> languages survive
curl -sf -X PATCH "$BASE/talent/$TALENT3_ID" -H "Authorization: Bearer $TOKEN3" -H 'Content-Type: application/json' \
  -d '{"languages":["English","Spanish"],"skills":["Acting"],"availability":["Weekdays"]}' -o /tmp/ttt-body.json
curl -sf -X PATCH "$BASE/talent/$TALENT3_ID" -H "Authorization: Bearer $TOKEN3" -H 'Content-Type: application/json' \
  -d '{"experience":"5 years background work","categories":["Background extras"],"minCompensation":100}' -o /tmp/ttt-body.json
check "v19: step-3-style PATCH without languages does not wipe them" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); t=d['talent']; assert t['languages']==['English','Spanish'], t; assert t['skills']==['Acting'], t; assert t['availability']==['Weekdays'], t"
# (d2) a direct empty-array PATCH is a deliberate clear (API semantics kept)
curl -sf -X PATCH "$BASE/talent/$TALENT3_ID" -H "Authorization: Bearer $TOKEN3" -H 'Content-Type: application/json' \
  -d '{"skills":[]}' -o /tmp/ttt-body.json
check "v19: explicit empty-array PATCH still clears (deliberate clear kept)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talent']['skills']==[], d['talent']"
curl -sf -X PATCH "$BASE/talent/$TALENT3_ID" -H "Authorization: Bearer $TOKEN3" -H 'Content-Type: application/json' \
  -d '{"skills":["Acting"]}' -o /tmp/ttt-body.json
# (c) wizard photo upload: POST a 1x1 PNG dataUrl, slot 1 -> 201; GET shows it
T3_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
curl -sf -X POST "$BASE/talent/$TALENT3_ID/photos" -H "Authorization: Bearer $TOKEN3" -H 'Content-Type: application/json' \
  -d "{\"slot\":1,\"dataUrl\":\"data:image/png;base64,$T3_PNG_B64\",\"caption\":\"MAIN HEADSHOT\"}" -o /tmp/ttt-body.json
check "v19: wizard photo upload succeeds (slot 1, PNG)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['photo']['slot']==1 and d['photo']['label']=='MAIN HEADSHOT', d"
curl -sf "$BASE/talent/$TALENT3_ID/photos" -H "Authorization: Bearer $TOKEN3" -o /tmp/ttt-body.json
check "v19: uploaded photo appears on the profile (GET photos)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert len(d['photos'])==1 and d['photos'][0]['slot']==1, d"
check "v19: photo slot 9 rejected (400)" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT3_ID/photos -H 'Authorization: Bearer $TOKEN3' -H 'Content-Type: application/json' -d '{\"slot\":9,\"dataUrl\":\"data:image/png;base64,$T3_PNG_B64\"}' | grep -q 400"
check "v19: photo with bad mime rejected (400)" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT3_ID/photos -H 'Authorization: Bearer $TOKEN3' -H 'Content-Type: application/json' -d '{\"slot\":2,\"dataUrl\":\"data:image/gif;base64,$T3_PNG_B64\"}' | grep -q 400"
# (e) repopulation source: GET talent returns the full profile for the wizard
curl -sf "$BASE/talent/$TALENT3_ID" -H "Authorization: Bearer $TOKEN3" -o /tmp/ttt-body.json
check "v19: GET talent returns full profile (wizard repopulation source)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); t=d['talent']; assert t['languages']==['English','Spanish'] and t['categories']==['Background extras'] and t['availability']==['Weekdays'] and t['completion']==85, t"
# (f) same-email re-registration never creates a second profile; login resumes the original
check "v19: duplicate email returns 409 (no second profile)" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/auth/register -H 'Content-Type: application/json' -d '{\"email\":\"t3@toptea.example\",\"phone\":\"3055550102\",\"firstName\":\"Third\",\"lastName\":\"Talent\",\"password\":\"secret123\",\"termsAccepted\":true}' | grep -q 409"
check "v19: login after duplicate attempt returns the ORIGINAL talent id" bash -c "curl -sf -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"t3@toptea.example\",\"password\":\"secret123\"}' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['talentId']=='$TALENT3_ID', d\""
# frontend unit tests (pure functions extracted from the real app.js)
check "v19: frontend unit tests pass (toApiProfile/completionPct/repopulation)" bash -c "node ../tools/frontend-unit-test.cjs"

# Jobs For You feed
curl -sf "$BASE/talent/$TALENT_ID/jobs-for-you" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "jobs-for-you returns ranked jobs with per-job reference codes" python3 - <<'PYEOF'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["jobs"], d
assert all(j["referenceCode"].startswith("TTT-") for j in d["jobs"]), d["jobs"][0]
assert all("automationEligible" in j for j in d["jobs"])
print("jobs-for-you:", d["total"], "jobs; first ref:", d["jobs"][0]["referenceCode"])
PYEOF

# Automation toggle
curl -sf "$BASE/talent/$TALENT_ID/automation" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "automation defaults OFF" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['automation']['enabled'] is False, d"
curl -sf -X POST "$BASE/talent/$TALENT_ID/automation" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"enabled":true,"geography":"south-florida","minDaily":100}' -o /tmp/ttt-body.json
check "automation toggle turns ON and persists" bash -c "curl -sf $BASE/talent/$TALENT_ID/automation -H 'Authorization: Bearer $TOKEN' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['automation']['enabled'] is True and d['automation']['geography']=='south-florida', d\""
curl -sf -X POST "$BASE/talent/$TALENT_ID/automation" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"enabled":false}' -o /tmp/ttt-body.json

# Talent earnings: own net ONLY — no commission/fee anywhere in the payload
BOOKING_NET=$(curl -sf "$BASE/bookings?talentId=$TALENT_ID" -H 'Authorization: Bearer test-admin-token' | python3 -c "import sys,json; print(json.load(sys.stdin)['bookings'][0]['netCents'])")
curl -sf "$BASE/talent/$TALENT_ID/earnings" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "talent earnings: own net + running total, NO agency money in payload" python3 - "$BOOKING_NET" <<'PYEOF'
import sys, json
d = json.load(open('/tmp/ttt-body.json'))
raw = json.dumps(d)
assert "commission" not in raw.lower() and "fee" not in raw.lower(), raw
assert d["totalNetCents"] == int(sys.argv[1]), d
assert d["jobCount"] == 1 and len(d["jobs"]) == 1 and d["jobs"][0]["netCents"] == int(sys.argv[1]), d
print("talent net:", d["totalNetCents"], "cents; jobs:", d["jobCount"])
PYEOF

# Owner gate + agency earnings
curl -sf "$BASE/owner/gate" -o /tmp/ttt-body.json
check "owner gate: not configured before a passcode is set" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['configured'] is False and d['unlocked'] is False, d"
check "agency earnings without auth returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' $BASE/agency-earnings | grep -q 401"
check "agency earnings as talent returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' $BASE/agency-earnings -H 'Authorization: Bearer $TOKEN' | grep -q 401"
check "set owner passcode without admin returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/owner/set-passcode -H 'Content-Type: application/json' -d '{\"passcode\":\"ownerpass1\"}' | grep -q 401"
curl -sf -X POST "$BASE/owner/set-passcode" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"passcode":"ownerpass1"}' -o /tmp/ttt-body.json
check "owner passcode sets (admin only)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['configured'] is True, d"
check "owner unlock with wrong passcode returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/owner/unlock -H 'Content-Type: application/json' -d '{\"passcode\":\"wrongpass\"}' | grep -q 401"
curl -sf -X POST "$BASE/owner/unlock" -H 'Content-Type: application/json' -d '{"passcode":"ownerpass1"}' -o /tmp/ttt-body.json
OWNER_TOKEN=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['ownerToken'])")
check "owner unlock returns a 12h session token" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['unlocked'] is True and d['ownerToken'], d"
curl -sf "$BASE/agency-earnings" -H "Authorization: Bearer $OWNER_TOKEN" -o /tmp/ttt-body.json
check "agency earnings WITH owner token shows commission totals" python3 - <<'PYEOF'
import json
d=json.load(open('/tmp/ttt-body.json'))
assert d["totalCommissionCents"] > 0 and d["bookingCount"] == 1, d
assert d["totalGrossCents"] - d["totalCommissionCents"] == d["totalNetCents"], d
print("agency commission total:", d["totalCommissionCents"], "cents")
PYEOF
curl -sf -X POST "$BASE/owner/lock" -H "Authorization: Bearer $OWNER_TOKEN" -o /tmp/ttt-body.json
check "owner lock invalidates the session token" bash -c "curl -s -o /dev/null -w '%{http_code}' $BASE/agency-earnings -H 'Authorization: Bearer $OWNER_TOKEN' | grep -q 401"

# Public portfolio: private by default, then public + casting-safe only
check "public portfolio is 404 while private (default)" bash -c "curl -s -o /dev/null -w '%{http_code}' $BASE/public/talent/$TALENT_ID | grep -q 404"
curl -sf "$BASE/talent/$TALENT_ID/portfolio-link" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "portfolio link is #/talent/<id>, never the front page" python3 - "$TALENT_ID" <<'PYEOF'
import sys, json
d=json.load(open('/tmp/ttt-body.json'))
assert d["path"] == "#/talent/" + sys.argv[1], d
assert d["visibility"] == "private", d
print("portfolio path:", d["path"])
PYEOF
curl -sf -X PATCH "$BASE/talent/$TALENT_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"visibility":"public","sharePhotos":true}' -o /tmp/ttt-body.json
curl -sf "$BASE/public/talent/$TALENT_ID" -o /tmp/ttt-body.json
check "public portfolio resolves and hides private fields" python3 - <<'PYEOF'
import json
d=json.load(open('/tmp/ttt-body.json'))["portfolio"]
raw=json.dumps(d)
for banned in ("test@toptea.example", "3055550100", "demographics", "commission", "password"):
    assert banned not in raw, "private field leaked: " + banned
assert d["firstName"]=="Testy" and d["city"]=="Miami" and d["visibility"]=="public", d
print("public portfolio ok:", d["firstName"], d["city"], "credits:", len(d["credits"]))
PYEOF

# v12–v14 social links: begin (code) -> confirm (signature, stays pending) ->
# admin bio-check (authorizes) -> upload photo (traceable to own post) ->
# pull request (unavailable, honest) -> pull callback -> public view ->
# v13 demotion of a forged AUTHORIZED row -> unlink cascades by platform
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
check "social begin without own-account confirmation returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/social-links -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"platform\":\"instagram\",\"handle\":\"@testytalent\"}' | grep -q 400"
curl -sf -X POST "$BASE/talent/$TALENT_ID/social-links" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"platform":"instagram","handle":"@testytalent","ownAccountConfirmed":true}' -o /tmp/ttt-body.json
SOC_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['socialLink']['id'])")
check "social link begins PENDING_VERIFICATION with an ownership code" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['socialLink']['status']=='PENDING_VERIFICATION', d; assert d['socialLink']['verificationStatus']=='code_issued', d; assert d['socialLink']['ownershipCode'].startswith('TTT-'), d"
check "social confirm with wrong signature returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/social-links/$SOC_ID -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"action\":\"confirm\",\"signatureName\":\"Wrong Name\",\"agreed\":true,\"codeInBioConfirmed\":true}' | grep -q 400"
curl -sf -X POST "$BASE/talent/$TALENT_ID/social-links/$SOC_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"action":"confirm","signatureName":"Testy Talent","agreed":true,"codeInBioConfirmed":true}' -o /tmp/ttt-body.json
check "social confirm signs but does NOT authorize (v13)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['socialLink']['status']=='PENDING_VERIFICATION', d; assert d['socialLink']['verificationStatus']=='check_pending', d"
check "social photo before authorization returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/social-photos -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"platform\":\"instagram\",\"dataBase64\":\"'$PNG_B64'\",\"mimeType\":\"image/png\",\"sourcePostUrl\":\"https://instagram.com/p/abc123\"}' | grep -q 400"
check "bio-check with wrong token returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/social-links/$SOC_ID -H 'Authorization: Bearer wrong-token' -H 'Content-Type: application/json' -d '{\"action\":\"bio-check\",\"outcome\":\"found\"}' | grep -q 401"
check "bio-check with a talent token returns 401 (admin only)" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/social-links/$SOC_ID -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"action\":\"bio-check\",\"outcome\":\"found\"}' | grep -q 401"
curl -sf -X POST "$BASE/talent/$TALENT_ID/social-links/$SOC_ID" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"action":"bio-check","outcome":"not_found","detail":"code not in bio"}' -o /tmp/ttt-body.json
check "bio-check not_found keeps the link pending" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['socialLink']['status']=='PENDING_VERIFICATION' and d['socialLink']['verificationStatus']=='code_not_found', d"
curl -sf -X POST "$BASE/talent/$TALENT_ID/social-links/$SOC_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"action":"resend-bio-check"}' -o /tmp/ttt-body.json
check "resend bio-check returns the link to check_pending" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['socialLink']['verificationStatus']=='check_pending', d"
curl -sf -X POST "$BASE/talent/$TALENT_ID/social-links/$SOC_ID" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d '{"action":"bio-check","outcome":"found","detail":"code found in bio"}' -o /tmp/ttt-body.json
check "bio-check found authorizes the account (code_confirmed)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['socialLink']['status']=='AUTHORIZED' and d['socialLink']['verificationStatus']=='code_confirmed' and d['socialLink']['bioChecked'] is True, d"
check "social photo without a source post URL returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/social-photos -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"platform\":\"instagram\",\"dataBase64\":\"'$PNG_B64'\",\"mimeType\":\"image/png\"}' | grep -q 400"
check "social photo with a bad mime type returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/talent/$TALENT_ID/social-photos -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"platform\":\"instagram\",\"dataBase64\":\"'$PNG_B64'\",\"mimeType\":\"image/gif\",\"sourcePostUrl\":\"https://instagram.com/p/abc123\"}' | grep -q 400"
curl -sf -X POST "$BASE/talent/$TALENT_ID/social-photos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"platform":"instagram","dataBase64":"'$PNG_B64'","mimeType":"image/png","sourcePostUrl":"https://instagram.com/p/abc123","caption":"Headshot preview"}' -o /tmp/ttt-body.json
SPH_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['socialPhoto']['id'])")
check "social photo uploads with traceable source post" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['socialPhoto']['source']=='upload', d; assert d['socialPhoto']['sourcePostUrl']=='https://instagram.com/p/abc123', d; assert d['socialPhoto']['photoUrl'].startswith('/api/v1/social-photos/'), d"
curl -sf "$BASE/social-photos/$SPH_ID" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-sph.png
check "uploaded social photo bytes serve back (PNG)" bash -c "python3 -c \"import sys; b=open('/tmp/ttt-sph.png','rb').read(); assert b[:8]==b'\\\\x89PNG\\\\r\\\\n\\\\x1a\\\\n', b[:8]\""
curl -sf -X POST "$BASE/talent/$TALENT_ID/social-links/$SOC_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"action":"request-photo-pull"}' -o /tmp/ttt-body.json
check "photo pull request is honestly unavailable in the standalone (v14)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['requested'] is False and d['pullStatus']=='unavailable', d; assert 'agency app' in d['reason'], d"
check "pull callback with wrong admin token returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/social-photo-pull-callback -H 'Authorization: Bearer wrong-token' -H 'Content-Type: application/json' -d '{\"talentId\":\"'$TALENT_ID'\",\"platform\":\"instagram\",\"outcome\":\"private\"}' | grep -q 401"
curl -sf -X POST "$BASE/social-photo-pull-callback" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d "{\"talentId\":\"$TALENT_ID\",\"platform\":\"instagram\",\"outcome\":\"private\",\"detail\":\"profile is private\"}" -o /tmp/ttt-body.json
check "pull callback private places nothing (v14)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['placed']==0 and d['pullStatus']=='private', d"
curl -sf -X POST "$BASE/social-photo-pull-callback" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d "{\"talentId\":\"$TALENT_ID\",\"platform\":\"instagram\",\"outcome\":\"pulled\",\"detail\":\"visited public profile\",\"photos\":[{\"data_base64\":\"$PNG_B64\",\"mime_type\":\"image/png\",\"source_post_url\":\"https://instagram.com/p/pulled1\",\"selection\":\"first_three\",\"identity_verdict\":\"match\",\"identity_note\":\"face matches portfolio headshot\",\"likes_label\":\"1,204 likes\"},{\"data_base64\":\"$PNG_B64\",\"mime_type\":\"image/png\",\"source_post_url\":\"https://instagram.com/p/pulled2\",\"selection\":\"most_popular\",\"identity_verdict\":\"no_match\",\"identity_note\":\"different person\"}],\"rejectedCount\":1}" -o /tmp/ttt-body.json
check "pull callback places only the identity match, rejects the rest (v14)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['placed']==1 and d['rejected']==2 and d['pullStatus']=='pulled', d"
check "pulled photo shows as browser_pull with its selection" bash -c "curl -sf $BASE/talent/$TALENT_ID/social-links -H 'Authorization: Bearer $TOKEN' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert len(d['socialPhotos'])==2, d; p=[x for x in d['socialPhotos'] if x['source']=='browser_pull']; assert len(p)==1 and p[0]['identityVerdict']=='match' and p[0]['selection']=='first_three' and p[0]['likesLabel']=='1,204 likes', d; assert d['socialLinks'][0]['pullStatus']=='pulled' and d['socialLinks'][0]['pullRejectedCount']==2, d\""
curl -sf "$BASE/public/talent/$TALENT_ID" -o /tmp/ttt-body.json
check "public portfolio shows the AUTHORIZED link + both social photos" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json'))['portfolio']; assert len(d['socialLinks'])==1 and d['socialLinks'][0]['bioChecked'] is True, d; assert len(d['socialPhotos'])==2, d; assert all('test@toptea.example' not in json.dumps(d) for _ in [0]), d"
curl -sf "$BASE/public/social-photos/$SPH_ID" -o /tmp/ttt-sph-pub.png
check "public social photo serves when portfolio is public + authorized" bash -c "python3 -c \"import sys; b=open('/tmp/ttt-sph-pub.png','rb').read(); assert b[:8]==b'\\\\x89PNG\\\\r\\\\n\\\\x1a\\\\n', b[:8]\""
# v13 demotion: forge an inconsistent row directly in the DB (AUTHORIZED
# with no confirmed code) and prove the read path demotes it to pending.
python3 - "$DB" "$TALENT_ID" <<'PYEOF'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("INSERT INTO social_links (id, talent_id, platform, handle, status, verification_status, ownership_code, bio_checked, created_at, updated_at) VALUES ('soc_forged', ?, 'facebook', '@forged', 'AUTHORIZED', '', NULL, 0, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')", (sys.argv[2],))
db.commit()
PYEOF
check "v13: AUTHORIZED without a confirmed code reads as pending (demoted)" bash -c "curl -sf $BASE/talent/$TALENT_ID/social-links -H 'Authorization: Bearer $TOKEN' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); fb=[l for l in d['socialLinks'] if l['platform']=='facebook']; assert len(fb)==1 and fb[0]['status']=='PENDING_VERIFICATION' and fb[0]['verificationStatus']=='', fb\""
curl -sf -X DELETE "$BASE/talent/$TALENT_ID/social-links/facebook" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "unlink facebook by platform removes the forged link" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['deleted'] is True and d['photosRemoved']==0, d"
curl -sf -X DELETE "$BASE/talent/$TALENT_ID/social-links/instagram" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "unlink instagram removes the link + both preview photos at once" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['deleted'] is True and d['photosRemoved']==2, d"
check "social links + photos are empty after unlink" bash -c "curl -sf $BASE/talent/$TALENT_ID/social-links -H 'Authorization: Bearer $TOKEN' -o /tmp/ttt-body.json && python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); assert d['socialLinks']==[] and d['socialPhotos']==[], d\""

# Inbound replies: admin records, talent reads
curl -sf -X POST "$BASE/application-replies" -H 'Authorization: Bearer test-admin-token' -H 'Content-Type: application/json' -d "{\"applicationId\":\"$APP_ID\",\"fromName\":\"Project Casting\",\"channel\":\"email\",\"body\":\"We would like to invite Testy to an audition on Friday.\"}" -o /tmp/ttt-body.json
check "admin records an inbound reply on the application" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['reply']['fromName']=='Project Casting', d"
curl -sf "$BASE/application-replies?talentId=$TALENT_ID" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "talent lists the inbound reply on their application" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['total']==1 and 'audition' in d['replies'][0]['body'].lower(), d"

# Complete the booking -> proof-of-work credits
BOOKING_ID=$(curl -sf "$BASE/bookings?talentId=$TALENT_ID" -H 'Authorization: Bearer test-admin-token' | python3 -c "import sys,json; print(json.load(sys.stdin)['bookings'][0]['id'])")
curl -sf -X POST "$BASE/bookings/$BOOKING_ID/complete" -H 'Authorization: Bearer test-admin-token' -o /tmp/ttt-body.json
check "completebooking marks COMPLETED" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['booking']['status']=='COMPLETED', d"
curl -sf "$BASE/talent/$TALENT_ID/credits" -H "Authorization: Bearer $TOKEN" -o /tmp/ttt-body.json
check "proof-of-work credits list the completed job" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['completedCount']==1 and len(d['credits'])==1, d"

# Mirror must never carry secrets from the new flows
check "mirror carries no passcode hash, code hash, or password hash" bash -c "! grep -q 'owner_passcode_hash' $MIRROR && ! grep -q 'code_hash' $MIRROR && ! grep -q 'password_hash' $MIRROR && echo 'mirror clean of secrets'"

# ----- v16: COMMUNITY BOARD (Phase 0) -----
# Uses TALENT_ID (Testy Talent, @testytalent) + TALENT2_ID (Second Talent,
# @secondtalent) from the v11 section. Runs BEFORE the mirror/wipe
# sections: board posts live in the ephemeral SQLite, not the mirror.
BOARD_BODY="BoardSelftestUnique hello from Testy"
curl -sf "$BASE/board/mentions/search?q=s" -o /tmp/ttt-body.json
check "board mention search: 's' matches Second Talent" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); hs=[p['handle'] for p in d['profiles']]; assert 'secondtalent' in hs, d; assert len(d['profiles'])<=8, d"
curl -sf "$BASE/board/mentions/search?q=second" -o /tmp/ttt-body.json
check "board mention search: 'second' narrows to one profile" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert [p['handle'] for p in d['profiles']]==['secondtalent'], d"
curl -sf "$BASE/board/mentions/search?q=zzzznothing" -o /tmp/ttt-body.json
check "board mention search: no match returns empty" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['profiles']==[], d"
curl -sf "$BASE/board/mentions/search" -o /tmp/ttt-body.json
check "board mention search: empty query lists talents" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert len(d['profiles'])>=2, d"

check "board post without auth returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/board/posts -H 'Content-Type: application/json' -d '{\"talentId\":\"$TALENT_ID\",\"body\":\"nope\"}' | grep -q 401"
check "board empty post returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/board/posts -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"talentId\":\"$TALENT_ID\",\"body\":\"   \"}' | grep -q 400"
curl -sf -X POST "$BASE/board/posts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"talentId\":\"$TALENT_ID\",\"body\":\"$BOARD_BODY @secondtalent — looking for a videographer in Miami!\",\"mentionedTalentIds\":[\"$TALENT2_ID\"]}" -o /tmp/ttt-body.json
BOARD_POST_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['id'])")
check "board text post with @mention creates (201, id + message)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is True and d['id'].startswith('brd_'), d"
curl -sf "$BASE/board/posts?viewerTalentId=$TALENT2_ID" -o /tmp/ttt-body.json
check "board list: post round-trips with author, mention + mentionsViewer" python3 - "$BOARD_POST_ID" <<'PY'
import json, sys
d = json.load(open('/tmp/ttt-body.json'))
ps = [p for p in d["posts"] if p["id"] == sys.argv[1]]
assert len(ps) == 1, d
p = ps[0]
assert p["authorName"] == "Testy Talent" and p["authorHandle"] == "testytalent", p
assert p["mentions"] == [{"talentId": p["mentions"][0]["talentId"], "name": "Second Talent", "handle": "secondtalent"}], p
assert p["mentionsViewer"] is True, p
assert "BoardSelftestUnique" in p["body"], p
print("listed post:", p["id"], "mentions:", p["mentions"])
PY
curl -sf "$BASE/talent/$TALENT2_ID/notifications" -H "Authorization: Bearer $TOKEN2" -o /tmp/ttt-body.json
check "board mention delivers an in-app notification to the named talent" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert any('mentioned you on the Community Board' in n['title'] for n in d['notifications']), d"

# photo post: 1x1 PNG (real bytes), then mime + size rejections
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
curl -sf -X POST "$BASE/board/posts" -H "Authorization: Bearer $TOKEN2" -H 'Content-Type: application/json' \
  -d "{\"talentId\":\"$TALENT2_ID\",\"body\":\"Photo from my last job\",\"photo\":{\"dataBase64\":\"$PNG_B64\",\"mimeType\":\"image/png\"}}" -o /tmp/ttt-body.json
BOARD_PHOTO_POST_ID=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['id'])")
check "board photo post creates with PNG bytes" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is True and d['id'].startswith('brd_'), d"
curl -sf "$BASE/board/posts?viewerTalentId=$TALENT_ID" -o /tmp/ttt-body.json
check "board photo post serves its bytes as image/png" bash -c "PHOTO_URL=\$(python3 -c \"import json; d=json.load(open('/tmp/ttt-body.json')); print([p['photoUrl'] for p in d['posts'] if p['id']=='$BOARD_PHOTO_POST_ID'][0])\"); curl -sf -o /tmp/ttt-board-photo.bin -w '%{content_type}' \"http://127.0.0.1:$PORT\$PHOTO_URL\" | grep -q 'image/png' && python3 -c \"import base64; raw=open('/tmp/ttt-board-photo.bin','rb').read(); assert raw==base64.b64decode('$PNG_B64'), 'photo bytes differ'; print('photo bytes match:', len(raw))\""
check "board photo with bad mime returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/board/posts -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"talentId\":\"$TALENT_ID\",\"body\":\"gif?\",\"photo\":{\"dataBase64\":\"R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==\",\"mimeType\":\"image/gif\"}}' | grep -q 400"
# 600KB of zeros as base64 (~800KB of JSON) exceeds the 128KB single-arg
# limit, so the oversized-photo body is built in a file, not argv.
python3 -c "import base64, json; json.dump({'talentId':'$TALENT_ID','body':'too big','photo':{'dataBase64':base64.b64encode(b'\\x00'*(600*1024)).decode(),'mimeType':'image/jpeg'}}, open('/tmp/ttt-big-photo.json','w'))"
check "board photo over 500KB returns 400" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/board/posts -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' --data @/tmp/ttt-big-photo.json | grep -q 400"

# audio / carousel: honest refusal, creates nothing
curl -sf -X POST "$BASE/board/media-posts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"talentId\":\"$TALENT_ID\",\"kind\":\"audio\",\"body\":\"my song\"}" -o /tmp/ttt-body.json
check "board audio post refused honestly (ok:false, coming soon)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is False and 'coming soon' in d['message'].lower(), d"
curl -sf -X POST "$BASE/board/media-posts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"talentId\":\"$TALENT_ID\",\"kind\":\"carousel\",\"body\":\"my set\"}" -o /tmp/ttt-body.json
check "board carousel post refused honestly (ok:false, coming soon)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is False and 'coming soon' in d['message'].lower(), d"
curl -sf "$BASE/board/posts" -o /tmp/ttt-body.json
check "board refusals created no posts (still 2 posts)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert len(d['posts'])==2, d"

# moderation: delete-other refused, delete-own works, report recorded
check "board delete of another talent's post returns 403" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/board/posts/$BOARD_POST_ID/delete -H 'Authorization: Bearer $TOKEN2' -H 'Content-Type: application/json' -d '{\"talentId\":\"$TALENT2_ID\"}' | grep -q 403"
curl -sf -X POST "$BASE/board/posts/$BOARD_POST_ID/report" -H "Authorization: Bearer $TOKEN2" -H 'Content-Type: application/json' -d "{\"reporterTalentId\":\"$TALENT2_ID\",\"reason\":\"selftest report — please review\"}" -o /tmp/ttt-body.json
check "board report records for owner review (no automated action)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is True and 'owner will review' in d['message'], d"
check "board owner remove without any token returns 401" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/board/posts/$BOARD_PHOTO_POST_ID/remove -H 'Content-Type: application/json' -d '{}' | grep -q 401"
curl -sf -X POST "$BASE/owner/unlock" -H 'Content-Type: application/json' -d '{"passcode":"ownerpass1"}' -o /tmp/ttt-body.json
OWNER_TOKEN2=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['ownerToken'])")
curl -sf -X POST "$BASE/board/posts/$BOARD_PHOTO_POST_ID/remove" -H 'Content-Type: application/json' -d "{\"ownerToken\":\"$OWNER_TOKEN2\"}" -o /tmp/ttt-body.json
check "board owner remove via body ownerToken removes the post" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is True and 'ledger' in d['message'], d"
curl -sf "$BASE/board/posts" -o /tmp/ttt-body.json
check "board removed post no longer lists" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert all(p['id']!='$BOARD_PHOTO_POST_ID' for p in d['posts']) and len(d['posts'])==1, d"
curl -sf "$BASE/talent/$TALENT2_ID/notifications" -H "Authorization: Bearer $TOKEN2" -o /tmp/ttt-body.json
check "board owner remove notifies the post author" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert any('was removed' in n['title'] for n in d['notifications']), d"
curl -sf -X POST "$BASE/board/posts/$BOARD_POST_ID/delete" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"talentId\":\"$TALENT_ID\"}" -o /tmp/ttt-body.json
check "board delete of own post succeeds" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['ok'] is True, d"
curl -sf "$BASE/board/posts" -o /tmp/ttt-body.json
check "board deleted post no longer lists (0 posts)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['posts']==[], d"
check "board report on a deleted post returns 404" bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/board/posts/$BOARD_POST_ID/report -H 'Authorization: Bearer $TOKEN2' -H 'Content-Type: application/json' -d '{\"reporterTalentId\":\"$TALENT2_ID\",\"reason\":\"late\"}' | grep -q 404"

# ledger: all five board event types present + chain valid
curl -sf "$BASE/ledger?limit=500" -o /tmp/ttt-body.json
check "board ledger entries present for all five board actions" python3 -c "
import json
d = json.load(open('/tmp/ttt-body.json'))
types = [e['event_type'] for e in d['events']]
for t in ['BOARD_POST_CREATED', 'BOARD_MENTION_DELIVERED', 'BOARD_POST_REPORTED', 'BOARD_POST_DELETED', 'BOARD_POST_REMOVED_BY_OWNER']:
    assert t in types, (t, types)
print('board events in ledger:', sorted(set(t for t in types if t.startswith('BOARD_'))))"
curl -sf "$BASE/ledger/verify" -o /tmp/ttt-body.json
check "board ledger chain still verifies after board actions" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert d['valid'] is True and d['first_bad_seq'] is None, d"
check "mirror carries no board post body or photo bytes (events only)" bash -c "! grep -q 'BoardSelftestUnique' $MIRROR && ! grep -q 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg' $MIRROR && echo 'mirror has no board bodies/bytes'"

# ----- WIPE-PROOF LEDGER MIRROR (a) append -> verify -----
# The mirror file is written on every ledger append, one line per event,
# each line carrying the full state snapshot + its own mirror hash chain.
check "mirror file exists with one line per ledger event, state carried" python3 - "$MIRROR" "$TALENT_ID" <<'PY'
import sys, json
mirror, talent_id = sys.argv[1], sys.argv[2]
lines = open(mirror).read().splitlines()
assert len(lines) >= 12, f"mirror has {len(lines)} lines, expected >= 12"
parsed = [json.loads(l) for l in lines]
assert all(set(("mirror_prev", "mirror_hash", "state")) <= set(p) for p in parsed), "mirror line missing chain/state keys"
assert [p["seq"] for p in parsed] == list(range(1, len(parsed) + 1)), "mirror seqs not 1..N"
reg = [p for p in parsed if p["event_type"] == "talent.register"]
assert len(reg) == 4, reg  # talent1 + talent2 (v11) + talent3 (v19 signup-flow fix) + male talent (v1.2.0 gender checks)
reg1 = [p for p in reg if p["state"]["talent"]["id"] == talent_id]
assert len(reg1) == 1, reg
assert reg1[0]["state"]["talent"]["email"] == "test@toptea.example", reg1[0]["state"]
bk = [p for p in parsed if p["event_type"] == "booking.create"]
assert len(bk) == 1 and bk[0]["state"]["booking"]["gross_cents"] == bk[0]["data"]["grossCents"], bk
assert bk[0]["state"]["notification"] and bk[0]["state"]["email"], "booking state must carry notification + email rows"
assert all("password_hash" not in json.dumps(p.get("state") or {}) for p in parsed), "mirror must never carry a password hash"
print(f"mirror ok: {len(lines)} lines, register + booking state present, no secrets")
PY
curl -sf -H 'Authorization: Bearer test-admin-token' "$BASE/ledger/mirror/verify" -o /tmp/ttt-body.json
check "mirror verify endpoint: valid, events == ledger events" python3 - <<'PY'
import json
d = json.load(open('/tmp/ttt-body.json'))["mirror"]
assert d["exists"] is True and d["valid"] is True and d["first_bad_seq"] is None, d
assert d["events"] >= 12, d
print("mirror verify:", d)
PY
check "mirror download is admin-only (401 without token)" bash -c "curl -s -o /dev/null -w '%{http_code}' $BASE/ledger/mirror | grep -q 401"
curl -sf -H 'Authorization: Bearer test-admin-token' "$BASE/ledger/mirror" -o /tmp/ttt-body.json
check "mirror download returns NDJSON, one line per event" bash -c "python3 -c \"import json; ls=open('/tmp/ttt-body.json').read().splitlines(); assert len(ls)>=12 and all(json.loads(l)['mirror_hash'] for l in ls); print('mirror download lines:', len(ls))\""

# ----- WIPE-PROOF LEDGER MIRROR (b) wipe simulation -----
# Record exact counts, delete ONLY the DB files (keep the mirror — that is
# the whole point), restart on the same DATABASE_PATH, and prove zero loss.
curl -sf "$BASE/stats" -o /tmp/ttt-stats.json
curl -sf "$BASE/ledger/verify" -o /tmp/ttt-body.json
BEFORE_EVENTS=$(python3 -c "import json; print(json.load(open('/tmp/ttt-body.json'))['events'])")
BEFORE_TALENTS=$(python3 -c "import json; print(json.load(open('/tmp/ttt-stats.json'))['talentCount'])")
BEFORE_BOOKINGS=$(python3 -c "import json; print(json.load(open('/tmp/ttt-stats.json'))['bookingCount'])")
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
rm -f "$DB" "$DB-wal" "$DB-shm"
test -f "$MIRROR" # the mirror must survive the wipe (sanity, not a check)
bun run src/server.ts > /tmp/ttt-selftest-server.log 2>&1 &
SERVER_PID=$!
wait_health
curl -sf "$BASE/stats" -o /tmp/ttt-body.json
check "wipe sim: talent + booking + seed counts restored exactly" python3 - "$BEFORE_TALENTS" "$BEFORE_BOOKINGS" <<'PY'
import sys, json
d = json.load(open('/tmp/ttt-body.json'))
assert d["talentCount"] == int(sys.argv[1]), d
assert d["bookingCount"] == int(sys.argv[2]), d
assert d["opportunityCount"] == 423, d
print(f"restored: talents={d['talentCount']} bookings={d['bookingCount']} opps={d['opportunityCount']}")
PY
curl -sf "$BASE/ledger/verify" -o /tmp/ttt-body.json
check "wipe sim: ledger verifies, events == before + 2 (restore + seed.import)" python3 - "$BEFORE_EVENTS" <<'PY'
import sys, json
d = json.load(open('/tmp/ttt-body.json'))
before = int(sys.argv[1])
assert d["valid"] is True and d["first_bad_seq"] is None, d
assert d["events"] == before + 2, d
assert d["head_seq"] == d["events"], d
assert d["mirror"]["valid"] is True and d["mirror"]["events"] == before + 2, d["mirror"]
print(f"ledger after wipe: {d['events']} events (before {before} + ledger.restore + seed.import), mirror matches")
PY
curl -sf "$BASE/ledger?limit=100" -o /tmp/ttt-body.json
check "wipe sim: ledger.restore event recorded the restore" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); types=[e['event_type'] for e in d['events']]; assert 'ledger.restore' in types, types; print('restore event present')"
curl -sf -H 'Authorization: Bearer test-admin-token' "$BASE/talent/$TALENT_ID" -o /tmp/ttt-body.json
check "wipe sim: talent profile restored (75% richness, READY FOR MATCHING)" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json'))['talent']; assert d['completion']==75 and d['status']=='READY FOR MATCHING' and d['firstName']=='Testy', d"
curl -sf -H 'Authorization: Bearer test-admin-token' "$BASE/bookings" -o /tmp/ttt-body.json
check "wipe sim: booking + notification restored, money reconciles" python3 - <<'PY'
import json
d = json.load(open('/tmp/ttt-body.json'))
assert d["total"] == 1, d
b = d["bookings"][0]
assert b["status"] in ("BOOKED", "COMPLETED") and b["grossCents"] - b["commissionCents"] == b["netCents"], b
print("restored booking:", b["id"], "gross", b["grossCents"], "fee", b["commissionCents"], "net", b["netCents"])
PY
curl -sf -H 'Authorization: Bearer test-admin-token' "$BASE/talent/$TALENT_ID/notifications" -o /tmp/ttt-body.json
check "wipe sim: booking notification restored" python3 -c "import json; d=json.load(open('/tmp/ttt-body.json')); assert len(d['notifications'])>=1 and any('Booking confirmed' in n['title'] for n in d['notifications']), d"

# ----- WIPE-PROOF LEDGER MIRROR (c) tamper test -----
# Corrupt ONE mirror line (change data, do NOT recompute any hash), wipe
# the DB again, restart: the server must REFUSE the tampered mirror, boot
# from seed only, quarantine the tampered file, and say so loudly.
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
rm -f "$DB" "$DB-wal" "$DB-shm"
TAMPERED_SEQ=$(python3 - "$MIRROR" <<'PY'
import sys, json
p = sys.argv[1]
lines = open(p).read().splitlines()
d = json.loads(lines[2])  # seq 3: change data without recomputing any hash
d["data"]["tampered"] = True
lines[2] = json.dumps(d)
open(p, "w").write("\n".join(lines) + "\n")
print(d["seq"])
PY
)
bun run src/server.ts > /tmp/ttt-selftest-server.log 2>&1 &
SERVER_PID=$!
wait_health
curl -sf "$BASE/stats" -o /tmp/ttt-body.json
check "tamper test: nothing restored from the tampered mirror (seed only)" python3 - <<'PY'
import json
d = json.load(open('/tmp/ttt-body.json'))
assert d["talentCount"] == 0 and d["bookingCount"] == 0, d
assert d["opportunityCount"] == 423, d
print("seed-only boot: talents=0 bookings=0 opps=423")
PY
curl -sf "$BASE/ledger/verify" -o /tmp/ttt-body.json
check "tamper test: ledger is just the fresh seed.import, live mirror fresh + valid" python3 - <<'PY'
import json
d = json.load(open('/tmp/ttt-body.json'))
assert d["valid"] is True and d["events"] == 1, d
assert d["mirror"]["valid"] is True and d["mirror"]["events"] == 1, d["mirror"]
print("ledger events:", d["events"], "mirror events:", d["mirror"]["events"])
PY
check "tamper test: refusal + quarantine logged loudly" bash -c "grep -q 'MIRROR REFUSED' /tmp/ttt-selftest-server.log && grep -q 'MIRROR QUARANTINED' /tmp/ttt-selftest-server.log"
check "tamper test: tampered file quarantined for forensics, bytes kept" bash -c "ls $MIRROR.tampered-* >/dev/null 2>&1 && grep -q tampered $MIRROR.tampered-*"

echo
echo "SELFTEST: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
