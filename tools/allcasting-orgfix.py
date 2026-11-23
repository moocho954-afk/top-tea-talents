#!/usr/bin/env python3
"""One-off data fix (2026-11-23): AllCasting records swept/verified before
the email harvest carry casting_org = "AllCasting" (the platform) instead
of the poster. The backend's contacts fallback (resolveDestination) looks
contacts up by casting_org, so the poster name must live there for the
fallback to work. This pass sets casting_org = the live page's agent_name
(posters only, verified from the castingCall object) wherever the current
value is the platform name or null. It never invents a name: listings
whose page carries no agent name keep their current org.

Calls the API only through ttt.py (vault credential surrogate). Resumable
via tools/allcasting-orgfix-progress.jsonl. Run:
  python3 tools/allcasting-orgfix.py
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TTT = "/home/hatch/workspace/custom-connectors/custom.top-tea-talents/bin/ttt.py"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
CHECKPOINT = os.path.join(HERE, "allcasting-orgfix-progress.jsonl")
DERIVED = ("expired", "selectivity", "selectivityReason", "genderRequirement")
PLATFORM_ORG = {"allcasting"}


def api(method, path, body=None):
    cmd = ["python3", TTT, "api", method, path]
    if body is not None:
        cmd += ["--body", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout)


def main():
    sys.path.insert(0, HERE)
    import importlib.util
    spec = importlib.util.spec_from_file_location("sweep", os.path.join(HERE, "sweep-opportunities.py"))
    sw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sw)

    done = {}
    if os.path.exists(CHECKPOINT):
        for line in open(CHECKPOINT, encoding="utf-8"):
            try:
                e = json.loads(line)
                done[e["opportunity_id"]] = e
            except Exception:
                continue
    rows = [json.loads(l) for l in open(os.path.join(HERE, "allcasting-backfill-progress.jsonl"), encoding="utf-8")]
    last = {}
    for r in rows:
        last[r["opportunity_id"]] = r
    targets = [k for k, v in last.items() if v["status"] in ("updated_email", "updated_instructions")]
    print(f"orgfix: {len(targets)} records to check, {len(done)} already done")
    counts = {"fixed": 0, "already_ok": 0, "no_agent_name": 0, "error": 0}
    ck = open(CHECKPOINT, "a", encoding="utf-8")

    def record(oid, status, detail=None):
        ck.write(json.dumps({"opportunity_id": oid, "status": status, "detail": detail}) + "\n")
        ck.flush()

    for oid in targets:
        if oid in done and done[oid].get("status") in ("fixed", "already_ok", "no_agent_name"):
            counts[done[oid]["status"]] += 1
            continue
        try:
            rec = api("GET", f"/api/v1/opportunities/{oid}")["opportunity"]
        except Exception as e:
            counts["error"] += 1
            record(oid, "error", f"GET failed: {e}"[:200])
            continue
        cur_org = (rec.get("casting_org") or "").strip()
        agent_name = (rec.get("casting_professional") or "").strip() or None
        if not agent_name:
            # Re-fetch the live page for the agent name.
            num_m = re.search(r"/castingcall/(\d+)", rec.get("source_url") or "")
            num = num_m.group(1) if num_m else None
            if num:
                try:
                    req = urllib.request.Request(f"https://allcasting.com/castingcall/{num}", headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=20) as r:
                        cc, _ = sw.extract_casting_call(r.read().decode("utf-8", "ignore"), want_id=num)
                    if cc:
                        agent_name = cc.get("agent_name") or None
                    time.sleep(0.5)
                except Exception as e:
                    counts["error"] += 1
                    record(oid, "error", f"detail fetch failed: {e}"[:200])
                    continue
        needs_org = cur_org.lower() in PLATFORM_ORG or not cur_org
        if agent_name and needs_org:
            for k in DERIVED:
                rec.pop(k, None)
            rec["casting_org"] = agent_name
            if not rec.get("casting_professional"):
                rec["casting_professional"] = agent_name
            r = api("POST", "/api/v1/opportunities", rec)
            if r.get("ok"):
                counts["fixed"] += 1
                record(oid, "fixed", agent_name)
            else:
                counts["error"] += 1
                record(oid, "error", f"POST failed: {str(r)[:150]}")
        elif agent_name and not needs_org:
            counts["already_ok"] += 1
            record(oid, "already_ok", cur_org)
        else:
            counts["no_agent_name"] += 1
            record(oid, "no_agent_name", "live page carries no agent name")
        time.sleep(0.2)
    ck.close()
    print(f"orgfix done: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
