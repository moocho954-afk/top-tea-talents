// Backfill report: run the v1.3.3 classifier over the live dump
// (/tmp/opps.json, 319 non-expired opportunities) and report what flips
// vs the stored (old-rule) selectivity, plus PAID GUARANTEED counts per
// talent. Run: bun run tools/backfill-classify.ts
// Derivation is on-read in the server, so this IS the backfill — no data
// migration is needed; these numbers are what the live API will return.
import { deriveSelectivity, deriveProfileKeywords, scoreKeywords, derivePaidGuaranteed, isPaidCompType, locationInGeography } from "../server/src/classify.ts";

const dump = JSON.parse(await Bun.file("/tmp/opps.json").text());
const opps: any[] = Array.isArray(dump) ? dump : dump.opportunities;
const JOSEPH = JSON.parse(await Bun.file("/tmp/ttt-profile-joseph.json").text()).talent;
const MONA = JSON.parse(await Bun.file("/tmp/ttt-profile-mona.json").text()).talent;

function daily(o: any): number | null {
  // Same normalization the server uses, simplified for the report:
  // parse the first $ amount in the compensation text.
  const t = String(o.compensation || "");
  const m = t.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  const type = String(o.compensation_type || "").toLowerCase();
  const hours = parseFloat(String(o.hours || "").match(/(\d+(?:\.\d+)?)/)?.[1] || "");
  if (type === "hourly" && hours) return Math.round(v * hours);
  if (type === "flat" || type === "session") return v; // flat/session treated as the day figure by normalizedDaily when hours are absent
  return v;
}

const flips: Record<string, number> = {};
const newSel: Record<string, number> = { guaranteed: 0, selective: 0, unknown: 0 };
const oldSel: Record<string, number> = { guaranteed: 0, selective: 0, unknown: 0 };
const flipExamples: Record<string, string[]> = {};
for (const o of opps) {
  const old = String(o.selectivity || "unknown");
  const nw = deriveSelectivity(o);
  oldSel[old] = (oldSel[old] || 0) + 1;
  newSel[nw.class] = (newSel[nw.class] || 0) + 1;
  if (old !== nw.class) {
    const key = `${old}->${nw.class}`;
    flips[key] = (flips[key] || 0) + 1;
    (flipExamples[key] = flipExamples[key] || []).push(`${o.id} | ${String(o.title || "").slice(0, 60)} | signal: ${nw.reason}`);
  }
}
console.log(`opportunities: ${opps.length}`);
console.log("selectivity BEFORE (stored):", JSON.stringify(oldSel));
console.log("selectivity AFTER  (v1.3.3):", JSON.stringify(newSel));
console.log("flips:", JSON.stringify(flips));
for (const [k, ex] of Object.entries(flipExamples)) {
  console.log(`\n${k} (${flips[k]}):`);
  for (const e of ex.slice(0, 8)) console.log("  -", e);
  if (ex.length > 8) console.log(`  ... and ${ex.length - 8} more`);
}

// PAID GUARANTEED per talent (south-florida geography, $100 floor)
for (const [name, profile] of [["Joseph", JOSEPH], ["Mona-Lisa", MONA]] as const) {
  const kws = deriveProfileKeywords(profile);
  let pg = 0, pgSf = 0;
  const pgList: string[] = [];
  let paidUnknown = 0, paidSelective = 0;
  for (const o of opps) {
    const sel = deriveSelectivity(o);
    const kw = scoreKeywords(profile, o, kws);
    const d = daily(o);
    const r = derivePaidGuaranteed(o, profile, "south-florida", { sel, kw, daily: d });
    if (r.paidGuaranteed) { pg++; pgList.push(`${o.id} | ${String(o.title || "").slice(0, 60)} | $${d}/day | kw: ${kw.matched.join(", ")}`); }
    if (isPaidCompType(o) && sel.class === "unknown") paidUnknown++;
    if (isPaidCompType(o) && sel.class === "selective") paidSelective++;
    if (isPaidCompType(o) && sel.class === "guaranteed" && locationInGeography(o, "south-florida")) pgSf++;
  }
  console.log(`\n${name}: PAID GUARANTEED (all gates) = ${pg}; paid+guaranteed+SF (before keyword/floor gates) = ${pgSf}; paid but selectivity unknown = ${paidUnknown}; paid but selective = ${paidSelective}`);
  for (const e of pgList.slice(0, 10)) console.log("  PG:", e);
  if (pgList.length > 10) console.log(`  ... and ${pgList.length - 10} more`);
}
