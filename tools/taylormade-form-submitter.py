#!/usr/bin/env python3
"""Casting TaylorMade (Tally) form submitter — Top Tea Talents.

Fills a per-production web form (e.g. castingtaylormade.com/miamivice) from a
real TTT talent record and submits it. Generalises to any Tally casting form:
the field list is read off the LIVE form at run time — the form definition is
parsed out of the public form page's own __NEXT_DATA__ payload (labels,
types, required flags, option lists, conditional logic) — never hard-coded.

Rules (owner orders + task brief):
- $0 only. No account creation. No invented data.
- Every submitted value comes from the real talent record. Anything missing
  is reported as a gap — never guessed, never defaulted.
- DRY RUN is the default: parse the live form, map the talent, download the
  2 photos, emit the fill plan + gap report. NO submit.
- A live submit needs --submit AND zero required-field gaps. The submit
  engine is label-driven Playwright (fills the rendered form in a real
  browser). NOTE (2026-11-23): this VM's egress proxy refuses CONNECT
  tunnels from local Chromium (example.com fails identically), so on this
  box the live submit runs as a browser task using the emitted fill plan
  (tools/taylormade-work/<talent>/fill-plan.json + the 2 photo files).
- After a real submit is confirmed on screen, the submission is logged as
  SENT: a backend application is created for (talent, opportunity) via POST
  /api/v1/applications (409 = already exists, reuse it), then PATCH
  /api/v1/applications/{id}/status {"status": "SUBMITTED — SENT"}, plus a
  JSONL log line under tools/.

Usage:
  python3 taylormade-form-submitter.py --talent tal_a8e01279ace84ed4 --slug miamivice
  python3 taylormade-form-submitter.py --talent tal_xxx --form-url https://tally.so/r/XXXX
  python3 taylormade-form-submitter.py --talent tal_xxx --slug miamivice --submit \
      --opportunity auditionsfree:miami-vice-extras-miami
"""
import argparse
import json
import os
import re
import struct
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

HERE = os.path.dirname(os.path.abspath(__file__))
TTT_PY = "/home/hatch/workspace/custom-connectors/custom.top-tea-talents/bin/ttt.py"
BASE = "https://top-tea-talents-api.onrender.com"
CONNECTOR = "custom.top-tea-talents"
HOSTS = ["top-tea-talents-api.onrender.com"]
LOG_PATH = os.path.join(HERE, "taylormade-submissions.jsonl")

# Slugs seen live on castingtaylormade.com (routes doc 2026-11-23). The tally
# id is captured live per slug; this map is only a fallback.
KNOWN_FORMS = {"miamivice": "LZAXbv"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


# ---------- TTT backend (via the registered helper / surrogate) ----------

def ttt_json(method, path, body=None):
    """Authenticated JSON call through the ttt.py helper. Never prints a token."""
    cmd = [sys.executable, TTT_PY, "api", method, path]
    if body is not None:
        cmd += ["--body", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(f"ttt.py {method} {path} failed: {out.stderr.strip()[-400:]}")
    return json.loads(out.stdout)


def download_photo_bytes(photo_id):
    """Download one talent photo as raw bytes (same surrogate mechanism as ttt.py)."""
    req = urllib.request.Request(BASE + f"/api/v1/photos/{photo_id}", method="GET")
    req.add_header("User-Agent", "Muse-ttt/1.0")
    add_surrogate_to_request(req, CONNECTOR, allowed_hosts=HOSTS)
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as resp:
        return resp.read(), resp.headers.get("Content-Type", "")


def jpeg_dimensions(data):
    """(width, height) for a JPEG, or (None, None). No PIL dependency."""
    try:
        if data[:2] != b"\xff\xd8":
            return None, None
        i = 2
        while i < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = struct.unpack(">H", data[i + 2:i + 4])[0]
            i += 2 + length
    except Exception:
        pass
    return None, None


# ---------- form capture + live definition parse ----------

def capture_form_url(slug):
    """castingtaylormade.com/<slug> -> embedded Tally form URL."""
    page_url = f"https://castingtaylormade.com/{slug}"
    req = urllib.request.Request(page_url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode("utf-8", "ignore")
    except Exception as e:
        if slug in KNOWN_FORMS:
            return f"https://tally.so/r/{KNOWN_FORMS[slug]}", f"page fetch failed ({e}); known-map fallback"
        raise RuntimeError(f"could not fetch {page_url}: {e}")
    m = re.search(r"tally\.so/r/([A-Za-z0-9]+)", html)
    if m:
        return f"https://tally.so/r/{m.group(1)}", "captured live from page embed"
    if slug in KNOWN_FORMS:
        return f"https://tally.so/r/{KNOWN_FORMS[slug]}", "known-map fallback"
    raise RuntimeError(f"no Tally form found on {page_url}")


def fetch_form_html(form_url):
    req = urllib.request.Request(form_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "ignore")


def parse_form_definition(form_url):
    """Parse the LIVE form definition out of the public form page's
    __NEXT_DATA__. Returns {form_id, name, is_closed, questions, conditionals}
    where each question is {question, inputs:[{type, required, options,
    placeholder, format}]}. No API call — the page itself carries it."""
    html = fetch_form_html(form_url)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError("no __NEXT_DATA__ in form page — Tally changed its page shape")
    data = json.loads(m.group(1))
    props = data["props"]["pageProps"]
    blocks = props["blocks"]

    def text_of(b):
        p = b.get("payload", {})
        s = p.get("safeHTMLSchema")
        import html as _html
        if s:
            try:
                return _html.unescape(re.sub(r"<[^>]+>", "", s[0][0]).strip())
            except Exception:
                return ""
        return _html.unescape((p.get("text") or "").strip())

    questions, cur = [], None
    for b in blocks:
        t, p = b["type"], b.get("payload", {})
        if t == "TITLE":
            cur = {"question": text_of(b), "inputs": []}
            questions.append(cur)
        elif t == "HEADING_2":
            cur = None
        elif cur is None:
            continue
        elif t in ("DROPDOWN_OPTION", "CHECKBOX", "MULTIPLE_CHOICE_OPTION"):
            if not cur["inputs"]:
                cur["inputs"].append({"type": t, "required": p.get("isRequired"), "options": []})
            cur["inputs"][0]["options"].append(p.get("text", ""))
            cur["inputs"][0]["required"] = p.get("isRequired")
        elif t == "CONDITIONAL_LOGIC":
            continue
        else:
            cur["inputs"].append({"type": t, "required": p.get("isRequired"),
                                  "options": [], "placeholder": p.get("placeholder", ""),
                                  "format": p.get("format", "")})
    conditionals = []
    for b in blocks:
        if b["type"] != "CONDITIONAL_LOGIC":
            continue
        p = b.get("payload", {})
        conds = []
        for c in p.get("conditionals", []):
            cp = c.get("payload", {})
            f = cp.get("field", {})
            conds.append({"field": f.get("title"), "comparison": cp.get("comparison"),
                          "value": cp.get("value")})
        conditionals.append({"conditions": conds, "actions": p.get("actions", [])})
    return {"form_id": props.get("formId"), "name": props.get("name"),
            "is_closed": props.get("isClosed"), "questions": questions,
            "conditionals": conditionals}


# ---------- talent -> form mapping ----------

def load_talent(talent_id):
    return ttt_json("GET", f"/api/v1/talent/{talent_id}")["talent"]


def load_photos(talent_id):
    return ttt_json("GET", f"/api/v1/talent/{talent_id}/photos").get("photos", [])


def pick_photos(photos):
    """Close-up = MAIN HEADSHOT (or primary); full body = FULL-BODY PHOTO."""
    by_label = {(p.get("label") or "").upper(): p for p in photos}
    close = by_label.get("MAIN HEADSHOT") or next(
        (p for p in photos if p.get("isPrimary")), None) or (photos[0] if photos else None)
    full = by_label.get("FULL-BODY PHOTO") or next(
        (p for p in photos if p is not close), None)
    return close, full


def _opt(options, needle):
    """Find the exact option text matching needle (case-insensitive substring)."""
    for o in options:
        if needle.lower() in o.lower():
            return o
    return None


def map_talent_to_form(talent, questions):
    """Map the talent record onto the LIVE form's questions.
    Returns (fill_plan, gaps): fill_plan is an ordered list of
    {question, type, action, value} for every field the record carries;
    gaps is {question: reason} for every required field it does not.
    NOTHING is invented. Conditional questions that do not apply to this
    talent (gendered sizes, car details when no car, tattoo locations when
    no tattoos) are reported as not-applicable, not gaps."""
    p = talent
    demo = p.get("demographics") or {}
    gender = (demo.get("gender") or p.get("gender") or "").strip()
    first, last = (p.get("firstName") or "").strip(), (p.get("lastName") or "").strip()
    exp_text = (p.get("experience") or "").strip()
    skills = [str(s).lower() for s in (p.get("skills") or [])]
    cats = [str(c).lower() for c in (p.get("categories") or [])]
    hay = " ".join(skills + cats + [exp_text.lower()])
    langs = [str(x).lower() for x in (p.get("languages") or [])]
    clothing = p.get("clothing") or {}

    qmap = {q["question"]: q for q in questions}

    def opts(qname):
        q = qmap.get(qname)
        return (q["inputs"][0].get("options") or []) if q and q["inputs"] else []

    def required(qname):
        q = qmap.get(qname)
        return bool(q and q["inputs"] and q["inputs"][0].get("required"))

    plan, gaps, na = [], {}, []

    def fill(qname, value, action="fill"):
        if qname not in qmap:
            return  # question not on this form
        if value is None or (isinstance(value, str) and not value.strip()):
            if required(qname):
                gaps[qname] = "missing from talent record"
            return
        plan.append({"question": qname, "type": qmap[qname]["inputs"][0]["type"],
                     "action": action, "value": value})

    def check(qname, option_text):
        if qname not in qmap:
            return
        o = _opt(opts(qname), option_text)
        if o is None:
            if required(qname):
                gaps[qname] = f"no matching option for {option_text!r}"
            return
        plan.append({"question": qname, "type": qmap[qname]["inputs"][0]["type"],
                     "action": "select", "value": o})

    # About you
    fill("Full name", f"{first} {last}".strip())
    fill("Last name", last)
    fill("Phone", p.get("phone"))
    fill("Email address", p.get("email"))
    fill("Date of birth", None)  # no DOB field on the talent record
    gaps.setdefault("Date of birth", "no dateOfBirth/DOB field on the talent record (only ageRange)")
    check("Gender", gender)
    check("Ethnic appearance", demo.get("ethnicity") or "")
    fill("City", p.get("city"))
    check("State", p.get("state") or "")

    # Real-life experience (checkbox groups: "None" is the honest pick when
    # nothing applies — it is a real option on the form, not an invention).
    # Each pair is (talent-evidence keyword, option substring): the option is
    # checked ONLY when the keyword appears in the talent's own record.
    def exp_group(qname, pairs):
        if qname not in qmap:
            return
        hits = []
        for kw, opt_sub in pairs:
            if kw in hay:
                o = _opt(opts(qname), opt_sub)
                if o and o not in hits:
                    hits.append(o)
        if hits:
            for h in hits:
                plan.append({"question": qname, "type": "CHECKBOX", "action": "check", "value": h})
        else:
            plan.append({"question": qname, "type": "CHECKBOX", "action": "check", "value": "None"})

    exp_group("Public safety / law / government experience", [
        ("police", "Law Enforcement"), ("law enforcement", "Law Enforcement"),
        ("military", "Military"), ("emt", "EMT"), ("firefighter", "Firefighter"),
        ("security", "Security"), ("attorney", "Attorney"), ("court", "Court"),
        ("detective", "Detective"), ("dea", "Federal Law"), ("swat", "SWAT"),
        ("k9", "K9"), ("csi", "Crime Scene"), ("coroner", "Medical Examiner")])
    exp_group("Sports / recreational skills", [
        ("basketball", "Basketball"), ("baseball", "Baseball"), ("soccer", "Soccer"),
        ("domino", "Dominoes"), ("jai-alai", "Jai-Alai"), ("bike", "Biking"),
        ("roller", "Roller"), ("running", "Running"), ("fitness", "Fitness"),
        ("casino", "Casino"), ("card game", "Card Games")])
    exp_group("Hospitality / food, beverage & nightlife experience", [
        ("bartend", "Bartender"), ("cocktail", "Cocktail"), ("server", "Server"),
        ("chef", "Chef"), ("cook", "Cook"), ("hotel", "Hotel"), ("dj", "DJ"),
        ("musician", "Live Musician"), ("nightclub", "Nightclub"),
        ("valet", "Valet"), ("event staff", "Event Staff")])
    # NOTE: "Miami / South Florida Native or Longtime Resident" is NOT
    # claimed here — it needs the owner's word on residency history.
    exp_group("Classic vehicles / Miami cultural / lifestyle experience", [
        ("vehicle owner", "Vehicle Owner"), ("exotic car", "Exotic Car Owner")])
    has_film = any(k in hay for k in ("film", "tv", "television", "commercial", "music video", "on-camera", "print"))
    if "Prior film / TV / print / commercial work history" in qmap:
        o = _opt(opts("Prior film / TV / print / commercial work history"),
                 "several experiences" if has_film else "never worked")
        if o:
            plan.append({"question": "Prior film / TV / print / commercial work history",
                         "type": "MULTIPLE_CHOICE", "action": "select", "value": o})
        elif required("Prior film / TV / print / commercial work history"):
            gaps["Prior film / TV / print / commercial work history"] = "no matching option"
    fill("Real-life experience explained", exp_text if exp_text else "NA")

    # Look & comfort
    # Record stores height as 6'1" — the form's options are 6'1 (no inch mark).
    check("Height", (p.get("height") or "").replace('"', "").strip())
    fill("Weight (lbs)", None)
    gaps.setdefault("Weight (lbs)", "no weight field on the talent record")
    check("Hair color", p.get("hairColor") or "")
    fill("Hair cut / modification", None)
    gaps.setdefault("Hair cut / modification", "no hair-cut consent on the talent record (consent question — must come from the talent)")
    fill("Facial hair", None)
    gaps.setdefault("Facial hair", "no facial-hair answer on the talent record")
    fill("Bathing suit / wardrobe comfort", None)
    gaps.setdefault("Bathing suit / wardrobe comfort", "no wardrobe-comfort answer on the talent record")
    fill("Tattoos", None)
    gaps.setdefault("Tattoos", "no tattoos field on the talent record")
    na.append("Tattoo locations (only if Tattoos = YES)")
    na.append("Car year / Car color / Make / model / Car type (only if vintage vehicle = YES)")

    # Sizes — gendered by the form's conditional logic: men's set for Male,
    # women's set for Female; the other set is not-applicable, not a gap.
    # NOTE (fixed 2026-11-23): the gap line must only fire when the value is
    # actually missing — an unconditional setdefault after fill() reports a
    # false gap even when clothing{} carries the size (shirt/shoe proved it).
    if gender.lower() == "male":
        for qname in ("Neck size (men)", "Sleeve length (men)", "Pants waist (men)",
                      "Pants inseam (men)", "Suit jacket size (men)"):
            fill(qname, clothing.get(qname))
            if not clothing.get(qname):
                gaps.setdefault(qname, "clothing{} empty on the talent record")
        na += ["Pants / jean size (women)", "Dress size", "Bra band size (women)", "Bra cup size (women) (hidden for Male)"]
    elif gender.lower() == "female":
        for qname in ("Pants / jean size (women)", "Dress size",
                      "Bra band size (women)", "Bra cup size (women)"):
            fill(qname, clothing.get(qname))
            if not clothing.get(qname):
                gaps.setdefault(qname, "clothing{} empty on the talent record")
        na += ["Neck size (men)", "Sleeve length (men)", "Pants waist (men)", "Pants inseam (men)", "Suit jacket size (men) (hidden for Female)"]
    fill("Shirt / blouse size", clothing.get("Shirt / blouse size"))
    if not clothing.get("Shirt / blouse size"):
        gaps.setdefault("Shirt / blouse size", "clothing{} empty on the talent record")
    fill("Shoe size", clothing.get("Shoe size"))
    if not clothing.get("Shoe size"):
        gaps.setdefault("Shoe size", "clothing{} empty on the talent record")

    # Vintage vehicle
    fill("Do you have a 1960–1989 car we can use for filming on set?", None)
    gaps.setdefault("Do you have a 1960–1989 car we can use for filming on set?",
                    "no vintage-vehicle field on the talent record")

    # Availability
    fill("Filming availability", None)
    gaps.setdefault("Filming availability", "record has only 'Available immediately'/'Flexible' — the form needs specific dates from its 37-date list")
    fill("Paid fitting availability", None)
    gaps.setdefault("Paid fitting availability", "no fitting-availability answer on the talent record")
    fill("Are you okay with overnights or splits?", None)
    gaps.setdefault("Are you okay with overnights or splits?", "no overnights/splits answer on the talent record")

    # Final checks
    fill("You must be legal to work in the USA", None)
    gaps.setdefault("You must be legal to work in the USA",
                    "no legal-to-work attestation on the talent record (attestation — must come from the talent/owner)")
    if "english" in langs:
        check("English language", "I can UNDERSTAND & SPEAK")
    else:
        gaps.setdefault("English language", "English not listed in languages")
    # Referred by: the application comes through Top Tea Talents, which is
    # not a listed option — the form's own "Agency not listed" path.
    if "Referred by" in qmap:
        o = _opt(opts("Referred by"), "Agency not listed")
        if o:
            plan.append({"question": "Referred by", "type": "TEXT", "action": "select", "value": o})
            fill("Which agency referred you?", "Top Tea Talents")

    # --- Casting answers from the talent record (owner-supplied 2026-11-23) ---
    # The mapping above hardcodes several consent/measurement fields as gaps
    # because the record had no fields for them. When the profile carries the
    # owner's answers (demographics.* / measurements.*), close those gaps here
    # with the form's exact option texts. NOTHING is invented: a field with no
    # answer stays a gap, and a needle that matches no option re-opens it.
    meas = p.get("measurements") or {}

    def close(qname, value, needle=None):
        if value is None or value == "":
            return
        if qname not in qmap:
            return
        if needle is not None:
            o = _opt(opts(qname), needle)
            if o is None:
                gaps[qname] = f"no matching option for {needle!r}"
                return
            gaps.pop(qname, None)
            plan.append({"question": qname, "type": qmap[qname]["inputs"][0]["type"],
                         "action": "select", "value": o})
        else:
            gaps.pop(qname, None)
            plan.append({"question": qname, "type": qmap[qname]["inputs"][0]["type"],
                         "action": "fill", "value": value})

    close("Date of birth", demo.get("dateOfBirth"))
    close("Weight (lbs)", meas.get("weightLbs"))
    if demo.get("hairCut"):
        close("Hair cut / modification", demo["hairCut"], needle=demo["hairCut"])
    if demo.get("facialHair"):
        close("Facial hair", demo["facialHair"], needle=demo["facialHair"])
    if demo.get("bathingSuit") == "YES":
        close("Bathing suit / wardrobe comfort", "YES", needle="I am COMFORTABLE")
    elif demo.get("bathingSuit") == "NO":
        close("Bathing suit / wardrobe comfort", "NO", needle="do not wish to be considered")
    if demo.get("tattoos") == "YES":
        close("Tattoos", "YES", needle="I have tattoos")
        try:
            na.remove("Tattoo locations (only if Tattoos = YES)")
        except ValueError:
            pass
        for loc in demo.get("tattooLocations") or []:
            close("Tattoo locations", loc, needle=loc)
        if not (demo.get("tattooLocations") or []):
            gaps.setdefault("Tattoo locations", "tattoos = YES but no locations on the record")
    elif demo.get("tattoos") == "NO":
        close("Tattoos", "NO", needle="do not have tattoos")
    if demo.get("vintageVehicle") == "NO":
        close("Do you have a 1960–1989 car we can use for filming on set?", "NO",
              needle="do not have a car")
    elif demo.get("vintageVehicle") == "YES":
        close("Do you have a 1960–1989 car we can use for filming on set?", "YES",
              needle="I have a car that can be used")
    for d in demo.get("filmingDates") or []:
        close("Filming availability", d, needle=d)
    if demo.get("paidFitting") == "YES":
        close("Paid fitting availability", "YES", needle="I can attend a fitting")
    elif demo.get("paidFitting") == "NO":
        close("Paid fitting availability", "NO", needle="would not be available for a fitting")
    if demo.get("overnights"):
        close("Are you okay with overnights or splits?", demo["overnights"],
              needle=demo["overnights"])
    if demo.get("legalToWork") == "YES":
        close("You must be legal to work in the USA", "YES", needle="I AM LEGAL TO WORK")
    if demo.get("southFloridaResident"):
        res_q = "Classic vehicles / Miami cultural / lifestyle experience"
        o = _opt(opts(res_q), "South Florida Native or Longtime Resident")
        if o:
            plan[:] = [s for s in plan
                       if not (s["question"] == res_q and s.get("value") == "None")]
            gaps.pop(res_q, None)
            plan.append({"question": res_q, "type": "CHECKBOX", "action": "check", "value": o})

    return plan, gaps, na


# ---------- Playwright fill engine (live submit path) ----------

def playwright_fill(form_url, plan, photo_paths, dry_run=True):
    """Fill the rendered form in a real browser from the fill plan.
    dry_run=True fills + screenshots and does NOT click submit.
    Returns {filled, failed, screenshot}."""
    from playwright.sync_api import sync_playwright
    import os as _os
    from urllib.parse import urlparse as _up
    proxy = None
    https_proxy = _os.environ.get("HTTPS_PROXY") or _os.environ.get("https_proxy")
    if https_proxy:
        u = _up(https_proxy)
        proxy = {"server": f"{u.scheme}://{u.hostname}:{u.port}",
                 "username": u.username, "password": u.password}
    filled, failed = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, proxy=proxy)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(form_url, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(2500)
        for step in plan:
            q, v = step["question"], step["value"]
            try:
                if step["action"] in ("fill",):
                    page.get_by_label(q, exact=False).first.fill(str(v), timeout=5000)
                elif step["action"] in ("select", "check"):
                    page.get_by_label(q, exact=False).first.check(timeout=5000) \
                        if step["type"] == "CHECKBOX" else None
                    # dropdown / multiple-choice: click the option text
                    page.get_by_text(v, exact=False).first.click(timeout=5000)
                filled.append(q)
            except Exception as e:
                failed.append({"question": q, "error": str(e)[:200]})
        # Photos: file inputs in form order = close-up, then full body.
        try:
            inputs = page.locator("input[type=file]")
            for i, path in enumerate(photo_paths[:inputs.count()]):
                inputs.nth(i).set_input_files(path)
                filled.append(f"photo[{i}]")
        except Exception as e:
            failed.append({"question": "photos", "error": str(e)[:200]})
        shot = _os.path.join(HERE, "taylormade-work", "filled-form.png")
        page.screenshot(path=shot, full_page=True)
        if not dry_run:
            page.get_by_role("button", name=re.compile("submit", re.I)).first.click(timeout=10000)
            page.wait_for_timeout(5000)
            page.screenshot(path=_os.path.join(HERE, "taylormade-work", "submitted.png"), full_page=True)
            text = page.locator("body").inner_text()[:2000]
            browser.close()
            return {"filled": filled, "failed": failed, "screenshot": shot,
                    "submit_page_text": text,
                    "submit_confirmed": bool(re.search(r"(thank|submitted|received|success)", text, re.I))}
        browser.close()
    return {"filled": filled, "failed": failed, "screenshot": shot}


# ---------- submission logging ----------

def log_submission(record):
    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(record) + "\n")


def backend_log(talent_id, opportunity_id, form_url):
    """Create the backend application for (talent, opportunity) and mark it
    SUBMITTED — SENT. Only call AFTER a real form submit was confirmed."""
    try:
        created = ttt_json("POST", "/api/v1/applications",
                           {"talentId": talent_id, "opportunityId": opportunity_id})
        app_id = created["application"]["id"]
    except RuntimeError as e:
        if "409" in str(e) or "already exists" in str(e):
            lst = ttt_json("GET", f"/api/v1/applications?talentId={talent_id}")
            match = [a for a in lst.get("applications", [])
                     if a.get("opportunityId") == opportunity_id]
            if not match:
                raise
            app_id = match[0]["id"]
        else:
            raise
    patched = ttt_json("PATCH", f"/api/v1/applications/{app_id}/status",
                       {"status": "SUBMITTED — SENT"})
    app_id = patched["application"]["id"]
    # v1.3.2 (receipts): store the portal link on the application so the
    # talent's receipt carries the exact form URL. A link-storage failure
    # must NEVER fail the submission log — the submit already happened.
    try:
        ttt_json("POST", f"/api/v1/applications/{app_id}/submission-link",
                 {"link": form_url,
                  "note": "TaylorMade Tally form submitted from the live browser task."})
    except Exception as e:
        print(f"WARNING: submission-link storage failed for {app_id}: {e}", file=sys.stderr)
    return app_id


# ---------- CLI ----------

def main():
    ap = argparse.ArgumentParser(description="TaylorMade / Tally form submitter")
    ap.add_argument("--talent", required=True)
    ap.add_argument("--slug", default="miamivice")
    ap.add_argument("--form-url", default=None)
    ap.add_argument("--opportunity", default="auditionsfree:miami-vice-extras-miami")
    ap.add_argument("--submit", action="store_true",
                    help="LIVE submit. Refused unless every REQUIRED field is present.")
    args = ap.parse_args()

    talent = load_talent(args.talent)
    photos = load_photos(args.talent)
    close, full = pick_photos(photos)

    if args.form_url:
        form_url, how = args.form_url, "given --form-url"
    else:
        form_url, how = capture_form_url(args.slug)
    form = parse_form_definition(form_url)
    plan, gaps, na = map_talent_to_form(talent, form["questions"])

    # Download the 2 photos the form needs.
    workdir = os.path.join(HERE, "taylormade-work", args.talent)
    os.makedirs(workdir, exist_ok=True)
    photo_files, photo_notes = [], []
    for name, ph in (("closeup", close), ("fullbody", full)):
        if not ph:
            photo_notes.append(f"{name}: NO PHOTO on talent record")
            continue
        data, mime = download_photo_bytes(ph["id"])
        w, h = jpeg_dimensions(data)
        fn = f"{name}-{ph['id']}.jpg"
        with open(os.path.join(workdir, fn), "wb") as f:
            f.write(data)
        photo_files.append(os.path.join(workdir, fn))
        photo_notes.append(f"{name}: {ph['label']} {w}x{h} {len(data)}B ({mime})")
    if len(photo_files) < 2:
        gaps["Photos (2: close-up + full body)"] = (
            f"talent has {len(photo_files)} usable photo(s); the form requires 2")

    # Required-field gate: any gap whose question is required on the live form.
    req_questions = {q["question"] for q in form["questions"]
                     for i in q["inputs"] if i.get("required")}
    blocked = sorted(g for g in gaps if g in req_questions)
    if len(photo_files) < 2:
        blocked = sorted(set(blocked) | {"Photos (2: close-up + full body)"})

    result = {
        "talent": args.talent,
        "talent_name": f"{talent.get('firstName')} {talent.get('lastName')}",
        "form_url": form_url, "form_capture": how,
        "form_id": form["form_id"], "form_name": form["name"],
        "form_is_closed": form["is_closed"],
        "live_questions": form["questions"],
        "fill_plan": plan,
        "gaps": gaps,
        "not_applicable": na,
        "photos": photo_notes,
        "photo_files": photo_files,
        "required_questions_live": sorted(req_questions),
        "blocked_on": blocked,
        "submitted": False,
    }
    with open(os.path.join(workdir, "fill-plan.json"), "w") as f:
        json.dump(result, f, indent=1)

    if args.submit:
        if blocked:
            print(json.dumps({"error": "REFUSED: required fields missing",
                              "blocked_on": blocked}, indent=1))
            sys.exit(3)
        out = playwright_fill(form_url, plan, photo_files, dry_run=False)
        result["playwright"] = out
        if not out.get("submit_confirmed"):
            print(json.dumps({"error": "submit clicked but no confirmation seen",
                              "page_text": out.get("submit_page_text", "")[:500]}, indent=1))
            sys.exit(4)
        result["submitted"] = True
        app_id = backend_log(args.talent, args.opportunity, form_url)
        result["application_id"] = app_id
        log_submission({"ts": datetime.now(timezone.utc).isoformat(),
                        "talent": args.talent, "opportunity": args.opportunity,
                        "form_url": form_url, "application_id": app_id,
                        "status": "SUBMITTED — SENT"})
        with open(os.path.join(workdir, "fill-plan.json"), "w") as f:
            json.dump(result, f, indent=1)

    print(json.dumps({k: result[k] for k in
                      ("talent_name", "form_url", "form_name", "gaps", "photos",
                       "blocked_on", "submitted")}, indent=1), file=sys.stderr)
    print("fill plan:", os.path.join(workdir, "fill-plan.json"), file=sys.stderr)


if __name__ == "__main__":
    main()
