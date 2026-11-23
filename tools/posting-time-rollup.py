#!/usr/bin/env python3
"""TOP TEA TALENTS — posting-time rollup (v1.3.0).

Reads tools/sweep-log.jsonl (written by tools/sweep-opportunities.py),
buckets each NEW listing's first-seen time by source x hour of day in
America/New_York, and writes tools/posting-time-rollup.json plus a
readable table on stdout.

WHY: casting calls are not posted uniformly — the sweep should run when
new listings actually appear ("learn as we go", owner order Nov 21).
After ~1-2 weeks of sweeps, move the sweep slots onto the observed
peaks. Until the data is thick enough the recommendation stays at the
initial 4x/day schedule with a floor of 2/day.

Usage:
  python3 tools/posting-time-rollup.py
  python3 tools/posting-time-rollup.py --log tools/sweep-log.jsonl --out tools/posting-time-rollup.json
"""
import argparse
import collections
import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
INITIAL_SLOTS = ["08:00", "12:00", "16:00", "20:00"]
MIN_DAYS_FOR_PEAKS = 7
FLOOR_SLOTS = ["08:00", "20:00"]


def main():
    ap = argparse.ArgumentParser(description="Roll up first-seen times by source x hour ET.")
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--log", default=os.path.join(here, "sweep-log.jsonl"))
    ap.add_argument("--out", default=os.path.join(here, "posting-time-rollup.json"))
    args = ap.parse_args()

    by_source_hour = collections.defaultdict(collections.Counter)
    by_source_total = collections.Counter()
    days = set()
    runs = set()
    if os.path.exists(args.log):
        with open(args.log, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("run_id"):
                    runs.add(r["run_id"])
                if r.get("event") != "opportunity.inserted":
                    continue
                ts = r.get("discovered_at") or r.get("ts")
                if not ts:
                    continue
                try:
                    dt = datetime.fromisoformat(ts)
                except ValueError:
                    continue
                if dt.tzinfo is None:
                    continue
                et = dt.astimezone(ET)
                days.add(et.date().isoformat())
                by_source_hour[r.get("source", "?")][et.hour] += 1
                by_source_total[r.get("source", "?")] += 1

    sources = {}
    for src, hours in sorted(by_source_hour.items()):
        total = by_source_total[src]
        peak = [h for h, _ in hours.most_common(3)]
        sources[src] = {
            "total_first_seen": total,
            "by_hour_et": {str(h): hours[h] for h in sorted(hours)},
            "peak_hours_et": peak,
        }

    n_days = len(days)
    if n_days >= MIN_DAYS_FOR_PEAKS:
        # Union of per-source peak hours, capped at 4 slots, floor 2.
        votes = collections.Counter()
        for src, s in sources.items():
            for h in s["peak_hours_et"]:
                votes[h] += 1
        ranked = sorted(votes, key=lambda h: (-votes[h], h))
        slots = sorted(f"{h:02d}:00" for h in ranked[:4])
        if len(slots) < 2:
            slots = FLOOR_SLOTS
        recommendation = f"Observed peaks over {n_days} days: move sweep slots to {', '.join(slots)} ET."
    else:
        slots = INITIAL_SLOTS
        recommendation = (f"Only {n_days} day(s) of sweep data — too thin to move slots. "
                          f"Keep the initial schedule {', '.join(INITIAL_SLOTS)} ET; "
                          f"re-run this rollup after {MIN_DAYS_FOR_PEAKS} days. Floor: 2/day.")

    out = {
        "generated_at_et": datetime.now(ET).isoformat(timespec="seconds"),
        "days_of_data": n_days,
        "sweep_runs": len(runs),
        "total_first_seen": sum(by_source_total.values()),
        "sources": sources,
        "recommended_slots_et": slots,
        "recommendation": recommendation,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
        f.write("\n")

    print(f"posting-time rollup: {out['total_first_seen']} first-seen listings over {n_days} day(s), {len(runs)} sweep runs")
    for src, s in sorted(sources.items()):
        hours = " ".join(f"{h}:00={s['by_hour_et'][h]}" for h in sorted(s["by_hour_et"], key=int))
        print(f"  {src:18s} total={s['total_first_seen']:4d}  peaks={s['peak_hours_et']}  {hours}")
    print(f"recommended slots (ET): {', '.join(slots)}")
    print(recommendation)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
