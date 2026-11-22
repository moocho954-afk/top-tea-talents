#!/usr/bin/env node
// TOP TEA TALENTS frontend unit tests — signup-flow fix (v19).
// Extracts the REAL pure functions from frontend/app.js by source location
// (never a copy) and tests them, plus static checks that the wizard markup
// and the server checklist carry the fix. Run: node tools/frontend-unit-test.cjs
// Exit code non-zero on any failure. No network, no server needed.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP_JS = path.join(ROOT, "frontend", "app.js");
const SERVER_TS = path.join(ROOT, "server", "src", "server.ts");
const appSrc = fs.readFileSync(APP_JS, "utf8");
const serverSrc = fs.readFileSync(SERVER_TS, "utf8");

let PASS = 0, FAIL = 0;
function check(name, fn) {
  try { fn(); PASS++; console.log("PASS: " + name); }
  catch (e) { FAIL++; console.log("FAIL: " + name + " — " + (e && e.message)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), (msg || "not equal") + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b)); }

// --- extract a top-level function/var statement by balanced braces ---
function extractFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("not found in app.js: " + sig);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced braces for " + sig);
}
function extractVar(src, name) {
  const i = src.indexOf("var " + name + " = ");
  if (i < 0) throw new Error("not found in app.js: " + name);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1) + ";"; }
  }
  throw new Error("unbalanced braces for " + name);
}

// Evaluate the real functions via a factory (direct eval in strict mode
// would scope them to the eval call). PROFILE_KEY_MAP is a dependency.
const factorySrc =
  extractVar(appSrc, "PROFILE_KEY_MAP") + "\n" +
  extractFn(appSrc, "function toApiProfile") + "\n" +
  extractFn(appSrc, "function completionPct") + "\n" +
  extractFn(appSrc, "function mergeDraftWithProfile") + "\n" +
  extractFn(appSrc, "function photoEncodeSteps") + "\n" +
  extractFn(appSrc, "function dataUrlByteSize") + "\n" +
  "return { toApiProfile, completionPct, mergeDraftWithProfile, photoEncodeSteps, dataUrlByteSize };";
const { toApiProfile, completionPct, mergeDraftWithProfile, photoEncodeSteps, dataUrlByteSize } = new Function(factorySrc)();

// --- toApiProfile: wizard mode must never send empty arrays (Fix 3) ---
check("toApiProfile wizard mode skips empty arrays (no wipe)", () => {
  const b = toApiProfile({ height: "5ft 9in", zip: "33101", age_range: "25-34", availability: [], languages: [], skills: [], categories: [] }, true);
  assert(!("languages" in b) && !("skills" in b) && !("categories" in b) && !("availability" in b), "empty arrays leaked: " + JSON.stringify(b));
  eq(b.height, "5ft 9in");
});
check("toApiProfile wizard mode keeps non-empty arrays", () => {
  const b = toApiProfile({ languages: ["English", "Spanish"], skills: ["Acting"], categories: ["Background extras"], availability: ["Weekdays"] }, true);
  eq(b.languages, ["English", "Spanish"]);
  eq(b.skills, ["Acting"]);
  eq(b.categories, ["Background extras"]);
  eq(b.availability, ["Weekdays"]);
});
check("toApiProfile default mode keeps empty arrays (Edit My Profile deliberate clear)", () => {
  const b = toApiProfile({ languages: [], skills: [] });
  assert("languages" in b && Array.isArray(b.languages) && b.languages.length === 0, "default mode must still send []");
});
check("toApiProfile maps snake_case to camelCase", () => {
  const b = toApiProfile({ age_range: "25-34", first_name: "Testy", travel_radius: 50 });
  eq(b.ageRange, "25-34"); eq(b.firstName, "Testy"); eq(b.travelRadius, 50);
});

// --- completionPct (fallback, v1.2.0): core items only, on the richness
// scale — core is worth 60 of 100, so a bare 6-core record reads 60, never
// 100. Photos never count here; the server adds photos/categories/
// availability/gender/verified-social on top. ---
const SIX_CORE = { email: "a@b.c", phone: "3055550100", first_name: "Testy", last_name: "Talent", city: "Miami", state: "FL", zip: "33101", height: "5ft 9in", age_range: "25-34", experience: "5 years" };
check("completionPct: 6 core items only, zero optionals -> 60 (core is 60 of 100)", () => {
  eq(completionPct(SIX_CORE), 60);
});
check("completionPct: optional groups filled or empty never change it", () => {
  const withOpt = { ...SIX_CORE, languages: ["English"], skills: ["Acting"], categories: ["Background extras"], availability: ["Weekdays"] };
  eq(completionPct(withOpt), 60);
  eq(completionPct({ ...SIX_CORE, languages: [], skills: [], categories: [], availability: [] }), 60);
});
check("completionPct: missing ageRange -> 50", () => {
  const t = { ...SIX_CORE }; delete t.age_range;
  eq(completionPct(t), 50);
});
check("completionPct: missing height + experience -> 40", () => {
  const t = { ...SIX_CORE }; delete t.height; delete t.experience;
  eq(completionPct(t), 40);
});
check("completionPct: photos never count", () => {
  eq(completionPct({ ...SIX_CORE, photos: [{}, {}, {}, {}, {}, {}, {}, {}] }), 60);
  const t = { ...SIX_CORE }; delete t.height;
  eq(completionPct({ ...t, photos: [{}, {}, {}] }), 50);
});
check("completionPct: camelCase profile also works", () => {
  eq(completionPct({ email: "a@b.c", phone: "1", firstName: "T", lastName: "T", city: "M", state: "FL", zip: "1", height: "5", ageRange: "25-34", experience: "x" }), 60);
});

// --- mergeDraftWithProfile: repopulation (new requirement) ---
const SERVER_PROFILE = { email: "a@b.c", phone: "3055550100", firstName: "Testy", lastName: "Talent", city: "Miami", state: "FL", zip: "33101", height: "5ft 9in", ageRange: "25-34", experience: "5 years", languages: ["English", "Spanish"], skills: ["Acting"], categories: ["Background extras"], availability: ["Weekdays"], demographics: { gender: "Female", ethnicity: "Black / African American" } };
check("mergeDraftWithProfile: empty draft + full server profile -> everything present", () => {
  const d = mergeDraftWithProfile({ availability: [], categories: [], skills: [], languages: [] }, JSON.parse(JSON.stringify(SERVER_PROFILE)));
  eq(d.first_name, "Testy"); eq(d.last_name, "Talent"); eq(d.city, "Miami"); eq(d.zip, "33101");
  eq(d.height, "5ft 9in"); eq(d.age_range, "25-34"); eq(d.experience, "5 years");
  eq(d.languages, ["English", "Spanish"]); eq(d.skills, ["Acting"]);
  eq(d.categories, ["Background extras"]); eq(d.availability, ["Weekdays"]);
  eq(d.gender, "Female"); eq(d.ethnicity, "Black / African American");
});
check("mergeDraftWithProfile: unsaved draft chip picks win over server arrays", () => {
  const d = mergeDraftWithProfile({ availability: ["Evenings"], categories: [], skills: [], languages: [] }, JSON.parse(JSON.stringify(SERVER_PROFILE)));
  eq(d.availability, ["Evenings"]);
  eq(d.categories, ["Background extras"]); // server fills the blank
});
check("mergeDraftWithProfile: server scalar wins over stale draft scalar", () => {
  const d = mergeDraftWithProfile({ height: "5ft 1in", availability: [], categories: [], skills: [], languages: [] }, JSON.parse(JSON.stringify(SERVER_PROFILE)));
  eq(d.height, "5ft 9in");
});
check("mergeDraftWithProfile: null profile is a no-op", () => {
  const d = { height: "x" };
  eq(mergeDraftWithProfile(d, null), { height: "x" });
});

// --- photo encode ladder (HEIC fix): steps descend, sizes decode right ---
check("photoEncodeSteps: 3 steps, 1200/0.82 -> 900/0.70 -> 700/0.60", () => {
  const steps = photoEncodeSteps();
  eq(steps.length, 3);
  eq(steps[0], { max: 1200, quality: 0.82 });
  eq(steps[1], { max: 900, quality: 0.70 });
  eq(steps[2], { max: 700, quality: 0.60 });
});
check("dataUrlByteSize: decodes base64 size with padding handled", () => {
  const b64 = (s) => "data:image/jpeg;base64," + Buffer.from(s).toString("base64");
  eq(dataUrlByteSize(b64("hello")), 5);
  eq(dataUrlByteSize(b64("ab")), 2);
  eq(dataUrlByteSize(b64("a")), 1);
  eq(dataUrlByteSize(b64("")), 0);
  eq(dataUrlByteSize(""), 0);
  eq(dataUrlByteSize(null), 0);
  // 480KB of bytes -> 640KB of base64 chars, size must round-trip
  const big = Buffer.alloc(480 * 1024, 0x41).toString("base64");
  eq(dataUrlByteSize("data:image/jpeg;base64," + big), 480 * 1024);
});
check("downscalePhoto accepts HEIC/HEIF and never rejects them up front", () => {
  const fn = appSrc.slice(appSrc.indexOf("function downscalePhoto"), appSrc.indexOf("function uploadPhoto"));
  assert(fn.includes('"image/heic"') && fn.includes('"image/heif"'), "HEIC/HEIF not in accepted types");
  assert(!fn.includes("Only JPG, PNG, or WEBP photos are accepted."), "old upfront rejection still present");
  assert(fn.includes("Most Compatible"), "friendly iPhone guidance missing");
});
check("downscalePhoto falls through to the next step when a step throws", () => {
  const fn = appSrc.slice(appSrc.indexOf("function downscalePhoto"), appSrc.indexOf("function uploadPhoto"));
  const loop = fn.slice(fn.indexOf("while(i < steps.length)"));
  assert(loop.includes("try{"), "encode step not guarded");
  assert(loop.includes("catch(e)"), "failed step does not fall through");
  assert(fn.includes("best = canvas.toDataURL"), "no last-good-encode fallback");
  assert(fn.includes("if(!best)"), "all-steps-failed case not handled");
  assert(fn.includes("Could not process that photo"), "all-steps-failed friendly error missing");
});
check("downscalePhoto walks the ladder and enforces the 500KB hard limit", () => {
  const fn = appSrc.slice(appSrc.indexOf("function downscalePhoto"), appSrc.indexOf("function uploadPhoto"));
  assert(fn.includes("photoEncodeSteps()"), "ladder not used by downscalePhoto");
  assert(fn.includes("PHOTO_MAX_BYTES"), "480KB target not enforced");
  assert(fn.includes("PHOTO_HARD_LIMIT"), "500KB hard limit not enforced");
  assert(fn.includes("still too large"), "over-limit friendly error missing");
});

// --- static checks: the shipped code carries the fix ---
check("server COMPLETION_ITEMS is exactly the 6 core items", () => {
  const m = serverSrc.match(/const COMPLETION_ITEMS[\s\S]*?\n\];/);
  assert(m, "COMPLETION_ITEMS block not found");
  const keys = [...m[0].matchAll(/key: "([a-z_]+)"/g)].map((x) => x[1]);
  eq(keys, ["contact", "name", "location", "height", "age_range", "experience"]);
  assert(!/languages|skills|categories|availability/.test(m[0]), "optional groups still in COMPLETION_ITEMS");
});
check("wizard step 3 has the inline photo uploader (not just the side-link)", () => {
  assert(appSrc.includes('id="join-photo-grid"'), "join-photo-grid missing");
  assert(appSrc.includes('id="join-photo-add"'), "join-photo-add missing");
  assert(appSrc.includes("wireJoinPhotos()"), "wireJoinPhotos not wired into step 3");
  assert(appSrc.includes("uploadPhoto(id, slot, f, PHOTO_SLOTS[slot-1]"), "wizard does not reuse uploadPhoto");
  assert(appSrc.includes('href="#/portfolio">Manage all photos'), "portfolio link kept as secondary");
});
check("screenJoin repopulates from the server profile on entry", () => {
  const join = appSrc.slice(appSrc.indexOf("function screenJoin"), appSrc.indexOf("function renderJoin"));
  assert(join.includes("mergeDraftWithProfile"), "screenJoin does not merge the server profile");
  assert(join.includes('apiGet("/api/v1/talent/"'), "screenJoin does not fetch the server profile");
});
check("wizard labels mark the optional groups Optional", () => {
  assert((appSrc.match(/\(optional/g) || []).length >= 6, "fewer than 6 (optional) labels, found " + (appSrc.match(/\(optional/g) || []).length);
});
check("wizard step submits use toApiProfile(d, true)", () => {
  assert((appSrc.match(/toApiProfile\(d, true\)/g) || []).length >= 2, "wizard PATCH calls do not pass skipEmptyArrays");
});

console.log("\nFRONTEND-UNIT: " + PASS + " passed, " + FAIL + " failed");
process.exit(FAIL === 0 ? 0 : 1);
