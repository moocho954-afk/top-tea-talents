// Unit tests for server/src/classify.ts — run: bun run tools/classify-test.ts
// No server, no network: pure functions only.
import { deriveSelectivity, deriveProfileKeywords, scoreKeywords, derivePaidGuaranteed, isPaidCompType } from "../server/src/classify.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`, extra ?? ""); }
}

const JOSEPH = JSON.parse(await Bun.file("/tmp/ttt-profile-joseph.json").text()).talent;
const MONA = JSON.parse(await Bun.file("/tmp/ttt-profile-mona.json").text()).talent;

// --- deriveSelectivity ---
check("open call + background actors needed => guaranteed",
  deriveSelectivity({ title: "Open call — background actors needed", roles: "No experience necessary" }).class === "guaranteed");
check("extras needed + sign up => guaranteed",
  deriveSelectivity({ title: "Extras needed for film shoot", submission_instructions: "Sign up today, walk on set" }).class === "guaranteed");
check("no experience necessary + register => guaranteed",
  deriveSelectivity({ title: "Crowd scene", roles: "No experience necessary, register online" }).class === "guaranteed");
check("auditions will be held => selective",
  deriveSelectivity({ title: "Lead role", submission_instructions: "Auditions will be held Saturday" }).class === "selective");
check("self-tape => selective",
  deriveSelectivity({ title: "Commercial", roles: "Please send a self-tape by Friday" }).class === "selective");
check("submit headshot for consideration => selective",
  deriveSelectivity({ title: "Drama", submission_instructions: "Submit your headshot and resume for consideration" }).class === "selective");
check("open call that still holds auditions => selective (tie rule)",
  deriveSelectivity({ title: "Open casting call", roles: "Auditions will be held on site, must audition" }).class === "selective");
check("all ethnicities welcome ALONE => unknown",
  deriveSelectivity({ title: "Fashion shoot", roles: "All ethnicities welcome" }).class === "unknown");
check("open casting + all ethnicities welcome => guaranteed",
  deriveSelectivity({ title: "Open casting", roles: "All ethnicities welcome, everyone who shows up" }).class === "guaranteed");
check("plain commercial listing => unknown",
  deriveSelectivity({ title: "Seeking male lead for commercial", roles: "Must be available Dec 7" }).class === "unknown");
check("background actors needed via positions field => guaranteed",
  deriveSelectivity({ title: "Film", positions: "Background actors needed" }).class === "guaranteed");
check("must audition => selective",
  deriveSelectivity({ title: "Stage play", eligibility: "Must audition in person" }).class === "selective");

// --- profile keywords ---
const jk = deriveProfileKeywords(JOSEPH);
check("Joseph keywords include work phrases", jk.work.includes("music videos") && jk.work.includes("commercials"));
check("Joseph keywords include male + 35-44 + hollywood + florida",
  jk.all.includes("male") && jk.all.includes("35-44") && jk.all.includes("hollywood") && jk.all.includes("florida"));
check("Joseph keywords include tattoos", jk.all.includes("tattoos"));
const mk = deriveProfileKeywords(MONA);
check("Mona keywords include female + background extras + haitian creole",
  mk.all.includes("female") && mk.work.includes("background extras") && mk.all.includes("haitian creole"));
check("Mona has no experience-derived work keywords", mk.work.includes("background extras") && !mk.work.includes("no experience"));

// --- keyword scoring ---
const oppBg = { title: "Background extras needed — Miami music video", roles: "Background extras for a music video shoot in Miami, FL", skills: "On-camera", category: "music-video" };
const js = scoreKeywords(JOSEPH, oppBg, jk);
check("Joseph scores background music-video opp (>=2, >=1 work)", js.score >= 2 && js.workScore >= 1, js);
check("Joseph matched keywords name the fit", js.matched.includes("music videos") && js.matched.includes("fl"), js.matched);
const ms = scoreKeywords(MONA, oppBg, mk);
check("Mona scores the same background opp", ms.score >= 2 && ms.workScore >= 1, ms);

// --- PAID GUARANTEED ---
const sfBg = { ...oppBg, compensation_type: "daily", compensation: "$150/day", location: { city: "Miami", county: "Miami-Dade", state: "FL", raw: "Miami, FL" }, hours: "12 hours" };
check("paid daily $150 guaranteed SF bg opp is PAID GUARANTEED for Joseph",
  derivePaidGuaranteed(sfBg, JOSEPH, "south-florida", { daily: 150 }).paidGuaranteed === true);
check("same opp is PAID GUARANTEED for Mona",
  derivePaidGuaranteed(sfBg, MONA, "south-florida", { daily: 150 }).paidGuaranteed === true);
check("unpaid version is NOT paid guaranteed",
  derivePaidGuaranteed({ ...sfBg, compensation_type: "unpaid", compensation: null }, JOSEPH, "south-florida", { daily: null }).paidGuaranteed === false);
check("undisclosed pay is NOT paid guaranteed",
  derivePaidGuaranteed({ ...sfBg, compensation_type: "undisclosed", compensation: null }, JOSEPH, "south-florida", { daily: null }).paidGuaranteed === false);
check("Savannah version is NOT paid guaranteed for a south-florida talent",
  derivePaidGuaranteed({ ...sfBg, location: { city: "Savannah", county: "Chatham", state: "GA", raw: "Savannah, GA" } }, JOSEPH, "south-florida", { daily: 150 }).paidGuaranteed === false);
check("selective version is NOT paid guaranteed",
  derivePaidGuaranteed({ ...sfBg, roles: "Auditions will be held, submit headshot for consideration" }, JOSEPH, "south-florida", { daily: 150 }).paidGuaranteed === false);
check("pay below the $100 floor is NOT paid guaranteed",
  derivePaidGuaranteed({ ...sfBg, compensation: "$80/day" }, JOSEPH, "south-florida", { daily: 80 }).paidGuaranteed === false);
check("keyword-thin opp is NOT paid guaranteed (score < 2 or no work kw)",
  derivePaidGuaranteed({ title: "Open call — drivers needed", roles: "Drivers needed, no experience necessary", compensation_type: "daily", compensation: "$200/day", location: { city: "Miami", county: "Miami-Dade", state: "FL", raw: "Miami, FL" } }, JOSEPH, "south-florida", { daily: 200 }).paidGuaranteed === false);
check("isPaidCompType: daily/flat/hourly/session/residual paid; unpaid/deferred/undisclosed not",
  isPaidCompType({ compensation_type: "daily" }) && isPaidCompType({ compensation_type: "session" })
  && !isPaidCompType({ compensation_type: "unpaid" }) && !isPaidCompType({ compensation_type: "deferred" })
  && !isPaidCompType({ compensation_type: "undisclosed" }) && !isPaidCompType({ compensation_type: "expense-only" }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
