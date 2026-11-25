// ---------- v1.3.3: shared listing classification + profile keywords ----------
// Single source of truth for selectivity, profile-keyword scoring and the
// PAID GUARANTEED class. Used by the matcher, Jobs For You and the
// opportunities list — all three derive on read, so the sweep stores no
// selectivity and a new listing is classified the moment it arrives.
// (Owner order 2026-11-25: listings must be better — keywords from the
// agency profiles, matched to real gigs; gigs must be PAID and NOT
// auditions: sign-up-and-show background/extras work, not fights for a
// callback. The live pool carried selectivity "unknown" on 297 of 319
// listings, so the classifier is the thing that has to tell them apart.)

export type SelectivityClass = "guaranteed" | "selective" | "unknown";

// Guaranteed = the text says everybody gets picked. Extended 2026-11-25:
// "no experience necessary/required" (a no-barrier listing), "sign up" /
// "register" (you join, you work), "walk-on", and background/extras calls
// ("background actors needed", "extras needed") — the sign-up-and-show
// jobs the owner asked for. "All ethnicities/ages welcome" is NOT a
// guarantee on its own (it is an inclusivity statement, as before) — it
// only counts inside an open-call context, i.e. when another open-call
// cue is already present; a bare inclusivity line stays unknown.
const GUARANTEED_SIGNALS =
  /\b(open call|open casting|walk[\s-]?in|walk[\s-]?on|everyone welcome|all welcome|all are welcome|everyone hired|immediate hire|hiring immediately|no audition|all sizes welcome|all types welcome|open to all(?!\s+(ethnicities|ages))|everyone who (shows? up|applies|attends)|guaranteed (hire|work|pay|booking)|no experience (necessary|required)|experience not (necessary|required)|sign[\s-]?up|register (now|today|online|to|for)?|background (actors?|talent|extras?|performers?|artists?) (needed|wanted|welcome)|extras (needed|wanted|welcome))\b/i;
const ALL_WELCOME_SIGNAL = /\ball (ethnicities|ages) welcome\b/i;
const OPEN_CALL_CONTEXT = /\b(open call|open casting|open audition|walk[\s-]?in|walk[\s-]?on|everyone welcome|sign[\s-]?up|register)\b/i;

// Selective = you have to win a spot. Extended 2026-11-25: self-tape /
// video audition, a required audition, and "submit … for consideration"
// (the classic choose-me phrasing). A bare "submit headshot and resume"
// is NOT a signal — background jobs ask for that too.
const SELECTIVE_SIGNALS =
  /\b(audition|callback|call back|limited spots?|limited openings?|only (a )?few|only \d+ (will be|to be) (selected|chosen|picked)|competitive|by invitation|invite only|invitation only|screening|must have experience|experienced only|highly selective|shortlist|self[\s-]?tape|video audition|must audition|audition (is )?required|auditions? (will be )?held|in-person audition|submit[^.;\n]{0,80}for consideration)\b/i;

export function deriveSelectivity(o: any): { class: SelectivityClass; reason: string | null } {
  const text = [o.title, o.roles, o.eligibility, o.positions, o.skills, o.appearance, o.category, o.submission_instructions]
    .map((x) => String(x || ""))
    .join(" ");
  const g = GUARANTEED_SIGNALS.exec(text);
  const s = SELECTIVE_SIGNALS.exec(text);
  // Audition language wins ties: an "open casting call" that still holds
  // auditions is selective, not guaranteed.
  if (s) return { class: "selective", reason: s[0] };
  if (g) return { class: "guaranteed", reason: g[0] };
  // "All ethnicities/ages welcome" only counts inside an open-call
  // context — otherwise it is inclusivity, not a hire guarantee.
  if (ALL_WELCOME_SIGNAL.test(text) && OPEN_CALL_CONTEXT.test(text)) {
    const m = ALL_WELCOME_SIGNAL.exec(text);
    return { class: "guaranteed", reason: m ? m[0] : "all welcome" };
  }
  return { class: "unknown", reason: null };
}

export const SELECTIVITY_RANK: Record<SelectivityClass, number> = { guaranteed: 0, unknown: 1, selective: 2 };

// ---------- geography (moved here from server.ts so the matcher can use it) ----------
export const SOUTH_FLORIDA_COUNTIES = ["miami-dade", "broward", "palm beach"];
export const SOUTH_FLORIDA_CITIES = ["miami", "miami beach", "fort lauderdale", "hollywood", "hialeah", "coral gables", "boca raton", "west palm beach", "pompano beach", "pembroke pines", "miramar", "davie", "plantation", "sunrise", "tamarac", "delray beach", "boynton beach", "deerfield beach", "doral", "kendall", "homestead", "aventura", "hallandale beach", "north miami", "north miami beach", "sunny isles beach", "key biscayne", "coconut creek", "margate", "lauderhill", "weston", "cooper city", "dania beach", "lake worth", "palm beach gardens", "jupiter", "wellington", "royal palm beach", "greenacres", "riviera beach", "lake park", "parkland", "miami gardens", "miami lakes", "miami springs", "opa-locka", "sweetwater", "palmetto bay", "pinecrest", "cutler bay", "florida city", "lighthouse point", "southwest ranches", "medley", "el portal", "biscayne park", "golden beach", "surfside", "bal harbour", "bay harbor islands", "indian creek"];

export function normName(s: string): string {
  // Identical to server.ts's normName (lowercase + collapse whitespace;
  // hyphens KEPT — "Miami-Dade" must stay "miami-dade" to match the
  // county list). Do not "improve" this.
  return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

export function locationInGeography(o: any, geography: string | null | undefined): boolean {
  const geo = String(geography || "").trim().toLowerCase();
  if (!geo) return true;
  if (geo === "nationwide") return true;
  const loc = o.location || {};
  const city = normName(String(loc.city || ""));
  const county = normName(String(loc.county || ""));
  const state = normName(String(loc.state || ""));
  const raw = normName(String(loc.raw || ""));
  if (!city && !county && !state && !raw) return true;
  if (/\bremote\b|\bvirtual\b|work from home/i.test(raw) || /\bremote\b|\bvirtual\b/i.test(city)) return true;
  if (geo === "south-florida") {
    if (state && state !== "fl" && state !== "florida") return false;
    if (SOUTH_FLORIDA_COUNTIES.includes(county)) return true;
    if (SOUTH_FLORIDA_CITIES.includes(city)) return true;
    const hay = ` ${raw} `;
    for (const name of [...SOUTH_FLORIDA_COUNTIES, ...SOUTH_FLORIDA_CITIES].sort((a, b) => b.length - a.length)) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)) return true;
    }
    return false;
  }
  if (geo === "florida") {
    if (state === "fl" || state === "florida") return true;
    if (SOUTH_FLORIDA_COUNTIES.includes(county)) return true;
    if (/\bflorida\b|, fl\b/.test(raw)) return true;
    return false;
  }
  return true;
}

// ---------- profile keyword dissection ----------
// Keywords come straight from the talent's LIVE profile — never invented:
// gender, age range, ethnicity, height/build, hair/eyes, beard, tattoos,
// languages, city/state, categories, skills, experience. Work keywords
// (categories/skills/experience) are tracked separately: a PAID GUARANTEED
// match needs at least one of them, so a listing does not qualify on
// "Miami + female" alone.
export interface ProfileKeywords {
  all: string[];
  work: string[];
}

function pushKw(list: string[], work: string[], v: any, isWork: boolean): void {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return;
  if (!list.includes(s)) list.push(s);
  if (isWork && !work.includes(s)) work.push(s);
}

export function deriveProfileKeywords(profile: any): ProfileKeywords {
  const all: string[] = [];
  const work: string[] = [];
  const d = profile?.demographics || {};
  const g = String(d.gender || profile?.gender || "").trim().toLowerCase();
  if (g === "male" || g === "female") pushKw(all, work, g, false);
  const age = String(profile?.ageRange || "").replace(/[–—]/g, "-").trim();
  if (/^\d+\s*-\s*\d+$/.test(age)) pushKw(all, work, age.replace(/\s+/g, ""), false);
  const eth = String(d.ethnicity || "").split(/[\/,]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const e of eth) pushKw(all, work, e, false);
  pushKw(all, work, profile?.height, false);
  const w = profile?.measurements?.weightLbs;
  if (w) pushKw(all, work, `${w} lbs`, false);
  if (profile?.hairColor) pushKw(all, work, `${profile.hairColor} hair`, false);
  if (profile?.eyeColor) pushKw(all, work, `${profile.eyeColor} eyes`, false);
  const facial = String(d.facialHair || d.beard || profile?.facialHair || "").trim().toLowerCase();
  if (/beard|mustache|facial hair/.test(facial)) pushKw(all, work, "beard", false);
  if (String(d.tattoos || "").trim().toLowerCase() === "yes") pushKw(all, work, "tattoos", false);
  for (const l of profile?.languages || []) pushKw(all, work, l, false);
  if (profile?.city) pushKw(all, work, profile.city, false);
  if (profile?.state) {
    pushKw(all, work, profile.state, false);
    pushKw(all, work, "florida", false);
    if (String(profile.state).trim().toLowerCase() === "fl") pushKw(all, work, "south florida", false);
  }
  for (const c of profile?.categories || []) pushKw(all, work, c, true);
  for (const s of profile?.skills || []) pushKw(all, work, s, true);
  // Experience phrases are work keywords — except a "no experience"
  // answer, which describes the ABSENCE of experience, not a skill.
  const exp = String(profile?.experience || "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const e of exp) {
    if (/^(no experience|none|n\/a|not applicable)/i.test(e)) continue;
    pushKw(all, work, e, true);
  }
  return { all, work };
}

export interface KeywordScore {
  matched: string[];
  workMatched: string[];
  score: number;
  workScore: number;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scoreKeywords(profile: any, opp: any, kws?: ProfileKeywords): KeywordScore {
  const k = kws || deriveProfileKeywords(profile);
  const hay = [opp.title, opp.roles, opp.eligibility, opp.positions, opp.skills, opp.category, opp.appearance, opp.submission_instructions]
    .map((x) => String(x || ""))
    .join(" ")
    .toLowerCase();
  const matched: string[] = [];
  for (const kw of k.all) {
    // Singular/plural tolerant: "music videos" must match a listing that
    // says "music video", and "background extras" must match "extra".
    // Single words get (s|es)?; phrases get it on the last word only.
    const words = kw.split(/\s+/);
    const last = words[words.length - 1].replace(/s$/, "");
    const pat = words.length === 1
      ? `\\b${escRe(kw)}(s|es)?\\b`
      : `\\b${words.slice(0, -1).map(escRe).join("\\s+")}\\s+${escRe(last)}(s|es)?\\b`;
    if (new RegExp(pat, "i").test(hay)) matched.push(kw);
  }
  const workMatched = matched.filter((m) => k.work.includes(m));
  return { matched, workMatched, score: matched.length, workScore: workMatched.length };
}

// ---------- PAID GUARANTEED ----------
// The sign-up-and-show class: paid + guaranteed + in the talent's
// geography + meets their daily floor + keyword score above threshold.
// Unpaid / TFP / deferred / expense-only / undisclosed pay never qualifies.
const PAID_COMP_TYPES = new Set(["daily", "flat", "hourly", "session", "residual"]);
export function isPaidCompType(o: any): boolean {
  return PAID_COMP_TYPES.has(String(o.compensation_type || "").trim().toLowerCase());
}

export const KEYWORD_THRESHOLD = 2;
export const WORK_KEYWORD_THRESHOLD = 1;

export function derivePaidGuaranteed(
  o: any,
  profile: any,
  geography: string | null | undefined,
  opts?: { sel?: { class: SelectivityClass; reason: string | null }; kw?: KeywordScore; daily?: number | null },
): { paidGuaranteed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const sel = opts?.sel || deriveSelectivity(o);
  const kw = opts?.kw || scoreKeywords(profile, o);
  const daily = opts?.daily !== undefined ? opts.daily : null;
  const minDaily = profile?.minCompensation != null ? Number(profile.minCompensation) : null;
  if (!isPaidCompType(o)) return { paidGuaranteed: false, reasons: [] };
  if (sel.class !== "guaranteed") return { paidGuaranteed: false, reasons: [] };
  if (!locationInGeography(o, geography)) return { paidGuaranteed: false, reasons: [] };
  if (minDaily !== null && daily !== null && daily < minDaily) return { paidGuaranteed: false, reasons: [] };
  if (daily === null) return { paidGuaranteed: false, reasons: [] };
  if (kw.score < KEYWORD_THRESHOLD || kw.workScore < WORK_KEYWORD_THRESHOLD) return { paidGuaranteed: false, reasons: [] };
  reasons.push(`Paid guaranteed: ${sel.reason || "open call"}; pay $${daily}/day meets the $${minDaily}/day floor; keywords: ${kw.matched.join(", ")}`);
  return { paidGuaranteed: true, reasons };
}
