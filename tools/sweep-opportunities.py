#!/usr/bin/env python3
"""TOP TEA TALENTS — listing sweep (v1.3.0).

Fetches the fetchable casting sources, normalizes new South Florida
listings to the opportunity record shape, dedupes by id against the live
API, and upserts the new ones via POST /api/v1/opportunities.

HONESTY RULES (the whole point of this script):
- A field the page does not state stays null. Never guessed, never
  invented. Pay, deadline, location, roles: null when absent.
- A listing whose location cannot be tied to Florida is skipped as
  out-of-scope (the agency is South Florida first). Skips are logged.
- Every run appends JSON lines to sweep-log.jsonl (next to this script):
  one line per source + one line per inserted record, each stamped with
  discovered_at + source. The posting-time rollup reads that log.
- Sources that refuse this VM (403, timeout, DNS) are logged as failed
  and the run continues with the rest. Exit 0 when at least one source
  succeeded; exit 1 when every source failed; exit 2 on config error.
- Email harvest (2026-11-23): an address enters a record ONLY if it was
  seen on the live listing page. AllCasting detail pages embed a
  castingCall object with agent_email + type — type "email" listings get
  contact_email set; web/url listings never take the agent email (it is
  the poster's contact, not the submission route). A second net runs an
  email regex over the listing body, but only when the surrounding text
  frames it as a submission address. Platform support addresses are
  never destinations (see BLOCKED_DESTINATION_EMAILS).

Credentials: the admin token comes ONLY from the TTT_ADMIN_TOKEN
environment variable, supplied at run time from the Secure Vault by the
caller (a Muse cron agent). It is never read from a file and never
written to the log. --dry-run fetches + parses without posting.

Usage:
  TTT_ADMIN_TOKEN=<token from vault> python3 tools/sweep-opportunities.py
  python3 tools/sweep-opportunities.py --dry-run --sources allcasting,projectcasting
  python3 tools/sweep-opportunities.py --max-detail 10
"""
import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

API_DEFAULT = "https://top-tea-talents-api.onrender.com"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
TIMEOUT = 20
DETAIL_DELAY = 0.5

# South Florida place names -> canonical city. First match wins.
SF_PLACES = [
    ("Miami", "Miami"), ("Fort Lauderdale", "Fort Lauderdale"),
    ("Hollywood", "Hollywood"), ("Miramar", "Miramar"),
    ("Pompano Beach", "Pompano Beach"), ("Coral Gables", "Coral Gables"),
    ("Doral", "Doral"), ("Hialeah", "Hialeah"), ("Kendall", "Kendall"),
    ("Homestead", "Homestead"), ("Boca Raton", "Boca Raton"),
    ("West Palm Beach", "West Palm Beach"), ("Delray Beach", "Delray Beach"),
    ("Davie", "Davie"), ("Plantation", "Plantation"),
    ("Sunrise", "Sunrise"), ("Pembroke Pines", "Pembroke Pines"),
    ("Hallandale", "Hallandale Beach"), ("Aventura", "Aventura"),
    ("North Miami", "North Miami"), ("Miami Beach", "Miami Beach"),
    ("Broward", None), ("Miami-Dade", None), ("Palm Beach", None),
]
SF_RE = re.compile(r"\b(" + "|".join(re.escape(p) for p, _ in SF_PLACES) + r")\b", re.I)
FL_RE = re.compile(r"\bFlorida\b|\bFL\b", re.I)

CATEGORY_KEYWORDS = [
    (r"music\s+video", "music-video"),
    (r"commercial", "commercial"),
    (r"brand\s+ambassador|promo(tion(al)?)?", "promo"),
    (r"\bmodel(ing|s)?\b", "modeling"),
    (r"\bextras?\b|background", "extras"),
    (r"featured\s+extra", "featured-extras"),
    (r"reality\s+(tv|show)", "reality-tv"),
    (r"live\s+event|concert|festival", "live-event"),
    (r"advertis", "advertising"),
    (r"corporate", "corporate"),
    (r"audience", "paid-audience"),
]
PAY_RE = re.compile(r"\$\s?([\d,]+(?:\.\d{2})?)\s*(?:per|/)?\s*(day|hour|hr|week|project|session|shoot|flat|total)?", re.I)
DATE_RE = re.compile(r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:\s*,\s*20\d\d)?\b", re.I)


def fetch(url, retries=1):
    """GET a URL with a browser UA. Returns (status, bytes) or (None, error).
    A truncated (IncompleteRead) response still returns its partial bytes
    with status 200 — a sitemap index that closed early usually still
    parses. One retry on transient connection errors."""
    import http.client
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.status, r.read()
        except http.client.IncompleteRead as e:
            if e.partial:
                return 200, e.partial
            if attempt < retries:
                time.sleep(1)
                continue
            return None, b"incomplete read, no bytes"
        except urllib.error.HTTPError as e:
            return e.code, b""
        except Exception as e:
            if attempt < retries:
                time.sleep(1)
                continue
            return None, str(e).encode()


def strip_tags(text):
    text = re.sub(r"<script.*?</script>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(re.sub(r"\s+", " ", text)).strip()


def classify_category(title, body):
    hay = (title + " " + body[:2000]).lower()
    for pat, cat in CATEGORY_KEYWORDS:
        if re.search(pat, hay):
            return cat
    return "film-tv"


def parse_pay(text):
    """Returns (compensation, compensation_type). Nulls when unstated."""
    m = PAY_RE.search(text or "")
    if not m:
        return None, "undisclosed"
    amount = m.group(1).replace(",", "")
    unit = (m.group(2) or "").lower()
    if unit in ("day",):
        return f"${amount} per day", "daily"
    if unit in ("hour", "hr"):
        return f"${amount} per hour", "hourly"
    if unit in ("week",):
        return f"${amount} per week", "daily"
    if unit in ("project", "flat", "total", "session", "shoot"):
        return f"${amount} per project", "flat" if unit != "session" else "session"
    return f"${amount}", "flat"


def parse_location(text):
    """Returns (location dict, geography) or (None, None) when unknown."""
    if not text:
        return None, None
    m = SF_RE.search(text)
    if m:
        place = next(p for p, _ in SF_PLACES if p.lower() == m.group(1).lower())
        city = next((c for p, c in SF_PLACES if p == place), None)
        county = "Broward" if place in ("Fort Lauderdale", "Hollywood", "Miramar", "Pompano Beach", "Davie", "Plantation", "Sunrise", "Pembroke Pines", "Hallandale") else ("Palm Beach" if place in ("Boca Raton", "West Palm Beach", "Delray Beach") else "Miami-Dade")
        return {"city": city or place, "county": county, "state": "FL",
                "raw": f"{city or place}, FL, United States"}, "south-florida"
    if FL_RE.search(text):
        return {"city": None, "county": None, "state": "FL", "raw": "Florida, United States"}, "florida"
    return None, None


def extract_main_content(page_text):
    """Scope parsing to the listing's own body, not the chrome around it.
    Sidebars, related-post widgets, post-navigation ("previous: Casting
    People in S. Florida...") and comment forms all mention places that
    are NOT this listing's location — parsing the whole page once turned
    a 2012 Long Island post into a Florida listing. Prefer, in order:
    the entry-content div (WordPress), <article>, <main>; cut the region
    at the first nav/comments/footer marker; fall back to the full page."""
    m = re.search(r'<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>', page_text, flags=re.I)
    if m:
        region = page_text[m.end():m.end() + 30000]
        cut = re.search(r"post-navigation|nav-links|entry-footer|class=\"comment|id=\"comments\"|</article>|<footer", region, flags=re.I)
        return region[:cut.start()] if cut else region
    m = re.search(r"<article[^>]*>(.*?)</article>", page_text, flags=re.S | re.I)
    if m:
        region = m.group(1)
        cut = re.search(r"post-navigation|nav-links|entry-footer|class=\"comment|id=\"comments\"|<footer", region, flags=re.I)
        return region[:cut.start()] if cut else region
    m = re.search(r"<main[^>]*>(.*?)</main>", page_text, flags=re.S | re.I)
    if m:
        return m.group(1)
    return page_text


# ---------------------------------------------------------------- email harvest (2026-11-23)
# An address enters a record ONLY if it was seen on the live listing page.
# Platform support / general-contact addresses are NEVER destinations.
BLOCKED_DESTINATION_EMAILS = {
    "support@allcasting.com", "support@projectcasting.com",
    "support@productionbeast.com", "hello@heybooker.app",
    "casting@backstage.com", "uigroup@ep.com",
    "billing@castingnetworks.com", "talentsupport@castitsystems.com",
}
PLACEHOLDER_EMAIL_DOMAINS = {"example.com", "example.org", "example.net",
                             "email.com", "domain.com", "yoursite.com", "test.com"}
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
SUBMISSION_HINTS = ("submit", "send to", "send your", "send us", "send it to",
                    "email your", "email us", "please email", "apply by email",
                    "submissions to", "submissions via", "send submissions")


def _brace_match(page_text, start):
    """Return the raw substring of the {...} object starting at start.
    Escape-aware: a quote toggles in-string only when preceded by an even
    number of backslashes; braces count only outside strings."""
    depth = 0
    in_str = False
    i = start
    while i < len(page_text):
        ch = page_text[i]
        if ch == '"':
            bs = 0
            j = i - 1
            while j >= 0 and page_text[j] == "\\":
                bs += 1
                j -= 1
            if bs % 2 == 0:
                in_str = not in_str
        elif not in_str:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return page_text[start:i + 1]
        i += 1
    return None


def extract_casting_call(page_text, want_id=None):
    """Extract the page's OWN castingCall object from an AllCasting detail
    page. The page embeds one JSON blob that is itself a JSON string, so
    quotes are backslash-escaped (\\"key\\"). The blob ALSO carries OTHER
    listings' agent emails in a preceding feed array — scoping is enforced
    by taking only the single castingCall object and verifying its id
    matches the URL id. Decode is two-step: json.loads the region as a
    JSON string (outer level), then json.loads the result (inner level).
    Returns ({"id","agent_name","agent_email","type"}, None) or (None, reason)."""
    m = re.search(r'\\*"castingCall\\*"\s*:\s*\{', page_text)
    if not m:
        m = re.search(r'"castingCall"\s*:\s*\{', page_text)
    if not m:
        return None, "no castingCall key"
    start = page_text.find("{", m.start())
    region = _brace_match(page_text, start)
    if region is None:
        return None, "unbalanced braces"
    try:
        inner = json.loads('"' + region + '"')
    except Exception as e:
        return None, f"outer decode failed: {e}"
    try:
        obj = json.loads(inner)
    except Exception as e:
        return None, f"inner decode failed: {e}"
    if want_id is not None and str(obj.get("id")) != str(want_id):
        return None, f"id mismatch: object id {obj.get('id')} != url id {want_id}"
    return {
        "id": obj.get("id"),
        "agent_name": (obj.get("agent_name") or "").strip() or None,
        "agent_email": (obj.get("agent_email") or "").strip() or None,
        "type": (obj.get("type") or "").strip().lower() or None,
    }, None


def find_submission_email(body):
    """Second net: an email in the listing body that the surrounding text
    explicitly frames as a submission address (e.g. a Central Casting
    per-project email inside a reposted call). Never the first email on
    the page — the hint framing is what qualifies it. Blocked and
    placeholder addresses are skipped."""
    if not body:
        return None
    for m in EMAIL_RE.finditer(body):
        email = m.group(0)
        if email.lower() in BLOCKED_DESTINATION_EMAILS:
            continue
        if email.partition("@")[2].lower() in PLACEHOLDER_EMAIL_DOMAINS:
            continue
        window = body[max(0, m.start() - 150):m.end() + 150].lower()
        if any(h in window for h in SUBMISSION_HINTS):
            return email
    return None


def find_casting_org(body):
    """A casting company named in the post text (e.g. AuditionsFree posts
    naming Casting TaylorMade, or a Central Casting repost). Generic
    phrases (Casting Call, Casting Director) are not an org."""
    if not body:
        return None
    if re.search(r"\bCentral Casting\b", body):
        return "Central Casting"
    m = re.search(r"\bCasting\s+([A-Z][A-Za-z0-9&'’\-]{2,30}(?:\s+[A-Z][A-Za-z0-9&'’\-]{2,30})?)", body)
    if m:
        name = ("Casting " + m.group(1).strip()).rstrip(".,;:")
        # Reject if ANY captured word is generic nav text ("Casting Calls"
        # in a page header is not an org).
        generic = {"call", "calls", "casting", "director", "directors",
                   "company", "companies", "agency", "agencies", "notice",
                   "notices", "team", "office", "audition", "auditions",
                   "website", "websites", "sites", "list", "lists", "board",
                   "boards", "jobs", "job"}
        if any(w.lower() in generic for w in name.split()[1:]):
            return None
        return name
    return None


def resolve_casting_click(page_text):
    """CastingAndActing apply route: a 'See the original listing' button
    to api.castingandacting.com/api/casting-click.php?id=N, which
    redirects to the original posting. Follow it once; return the final
    URL, or None when the link is absent / unresolvable."""
    m = re.search(r"(?:https?:)?//api\.castingandacting\.com/api/casting-click\.php\?id=\d+", page_text)
    if not m:
        return None
    url = m.group(0)
    if url.startswith("//"):
        url = "https:" + url
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.geturl()
    except Exception:
        return None


def parse_detail(url, page_text):
    """Parse a listing detail page into an opportunity record (or None to skip)."""
    title_m = re.search(r"<h1[^>]*>(.*?)</h1>", page_text, flags=re.S | re.I)
    title = strip_tags(title_m.group(1)) if title_m else None
    if not title:
        t = re.search(r"<title[^>]*>(.*?)</title>", page_text, flags=re.S | re.I)
        title = strip_tags(t.group(1)).split("|")[0].split("-")[0].strip() if t else None
    if not title:
        return None, "no title on page"
    body = strip_tags(extract_main_content(page_text))
    loc, geo = parse_location(body)
    if geo is None:
        return None, "out of scope: no Florida location on the page"
    comp, comp_type = parse_pay(body)
    deadline = None
    dm = re.search(r"(?:deadline|apply\s+by|submissions?\s+(?:close|due))[^.]{0,80}?" + DATE_RE.pattern, body, flags=re.I)
    if dm:
        deadline = dm.group(0)
    prod = None
    pm = re.search(r"(?:shoot(?:ing)?\s+dates?|filming\s+dates?|production\s+dates?)[^.;]{0,120}", body, flags=re.I)
    if pm:
        prod = pm.group(0).strip()
    # --- email harvest (2026-11-23): an address enters a record ONLY if
    # it was seen on this live listing page.
    contact_email = None
    submission_instructions = None
    casting_org = None
    casting_professional = None
    is_allcasting = "allcasting.com" in url
    cc_type = None
    if is_allcasting:
        idm = re.search(r"/castingcall/(\d+)", url)
        cc, _cc_err = extract_casting_call(page_text, want_id=idm.group(1) if idm else None)
        if cc:
            cc_type = cc.get("type")
            agent_email = cc.get("agent_email")
            agent_name = cc.get("agent_name")
            if agent_name:
                # The poster identity; drives the backend contacts-table
                # fallback for this org's later listings.
                casting_org = agent_name
                casting_professional = agent_name
            if cc_type == "email" and agent_email and EMAIL_RE.fullmatch(agent_email) \
                    and agent_email.lower() not in BLOCKED_DESTINATION_EMAILS:
                contact_email = agent_email
                submission_instructions = f"Submit by email to {agent_email}"
            elif cc_type == "web":
                # The agent email on a web-type listing is the poster's
                # contact, NOT the submission route — never use it.
                submission_instructions = "Apply on AllCasting"
            elif cc_type == "url":
                submission_instructions = "Apply via the listing link"
    if contact_email is None and (not is_allcasting or cc_type == "email" or cc_type is None):
        # Second net: a submission-framed email in the listing body
        # (reposted Central Casting / Casting Networks calls). Skipped for
        # AllCasting web/url listings — their type is authoritative.
        found = find_submission_email(body)
        if found:
            contact_email = found
            submission_instructions = f"Submit by email to {found}"
    if casting_org is None:
        casting_org = find_casting_org(body)
    return {
        "title": title[:200],
        "production": None,
        "employer": None,
        "casting_org": casting_org,
        "casting_professional": casting_professional,
        "category": classify_category(title, body),
        "roles": None,
        "positions": None,
        "location": loc,
        "geography": geo,
        "production_dates": prod,
        "deadline": deadline,
        "compensation": comp,
        "compensation_type": comp_type,
        "hours": None,
        "eligibility": None,
        "age": None,
        "skills": None,
        "appearance": None,
        "travel": None,
        "usage_exclusivity": None,
        "contact_email": contact_email,
        "submission_instructions": submission_instructions,
        "source_url": url,
        "verification_status": "UNVERIFIED",
        "verification_notes": "Swept by tools/sweep-opportunities.py: listing page parsed; fields not found on the page are null, never guessed." + (
            " Submission email harvested from the listing page." if contact_email else ""),
    }, None


# ---------------------------------------------------------------- sources
def sitemap_urls(base_url, link_re, cap=300):
    """Walk a sitemap (or sitemap index, one level deep); return casting URLs.
    Entries carry <lastmod> — the result is newest-first so the detail
    budget always spends on the freshest listings first (Yoast indexes
    list oldest-first, so taking the head without sorting would burn the
    budget on decade-old posts)."""
    out, seen, queue = [], set(), [base_url]
    fetches = 0
    while queue and fetches < 12:
        url = queue.pop(0)
        fetches += 1
        status, data = fetch(url)
        if status != 200 or not data:
            continue
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            continue
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        for entry in list(root.findall("s:url", ns)) + list(root.findall("s:sitemap", ns)):
            loc_el = entry.find("s:loc", ns)
            if loc_el is None:
                continue
            u = (loc_el.text or "").strip()
            if not u or u in seen:
                continue
            seen.add(u)
            if u.endswith(".xml"):
                queue.append(u)
            elif re.search(link_re, u):
                lm_el = entry.find("s:lastmod", ns)
                lm = (lm_el.text or "").strip() if lm_el is not None else ""
                out.append((u, lm))
    out.sort(key=lambda pair: pair[1], reverse=True)
    return [u for u, _ in out[:cap]]


def html_index_urls(page_urls, link_re, cap=100):
    """Harvest casting links from HTML index pages. The regex is tested
    against the JOINED (absolute) URL, not the raw href — most of these
    pages link relatively (/jobs/5855-...) and testing the raw href
    matches nothing."""
    out, seen = [], set()
    for page_url in page_urls:
        status, data = fetch(page_url)
        if status != 200 or not data:
            continue
        text = data.decode("utf-8", "ignore")
        for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', text, flags=re.S | re.I):
            href, anchor = m.group(1), strip_tags(m.group(2))
            full = urljoin(page_url, href)
            if not re.search(link_re, full):
                continue
            if full in seen:
                continue
            seen.add(full)
            out.append(full)
            if len(out) >= cap:
                return out
    return out


def rss_items(feed_urls):
    """Parse Craigslist-style RSS feeds. Returns [{title, link, pubDate, desc}]."""
    items = []
    for feed_url in feed_urls:
        status, data = fetch(feed_url)
        if status != 200 or not data:
            continue
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            continue
        for it in root.findall(".//item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            pub = (it.findtext("pubDate") or "").strip()
            desc = strip_tags(it.findtext("description") or "")
            if title and link:
                items.append({"title": title, "link": link, "pubDate": pub, "desc": desc})
    return items


SOURCES = [
    {"key": "allcasting", "kind": "sitemap",
     "url": "https://www.allcasting.com/sitemap.xml",
     "link_re": r"allcasting\.com/castingcall/(\d+)",
     "id_from_url": lambda u: "allcasting:" + re.search(r"/castingcall/(\d+)", u).group(1)},
    {"key": "projectcasting", "kind": "sitemap",
     # robots.txt: Sitemap: https://projectcasting.com/sitemap_index.xml
     # (the www sitemap.xml 404s). Flaky from this VM — logged, not fatal.
     "url": "https://projectcasting.com/sitemap_index.xml",
     "link_re": r"projectcasting\.com/casting-call/([^\"'<>/?#]+)",
     "id_from_url": lambda u: "projectcasting:" + re.search(r"/casting-call/([^\"'<>/?#]+)", u).group(1)},
    {"key": "auditionsfree", "kind": "html-index",
     # WordPress front page + Florida page list current posts. The Yoast
     # sitemap is STALE (newest lastmod 2012) — do not use it. Post URLs
     # are /YYYY/<slug>/ (2026 posts carry no month segment).
     "urls": ["https://www.auditionsfree.com/",
              "https://www.auditionsfree.com/page/2/",
              "https://www.auditionsfree.com/page/3/",
              "https://www.auditionsfree.com/auditions-in-florida/"],
     "link_re": r"auditionsfree\.com/\d{4}/[^\"'<> ]+",
     "id_from_url": lambda u: "auditionsfree:" + re.sub(r"[^a-z0-9]+", "-", urlparse(u).path.strip("/"))[:120]},
    {"key": "castingandacting", "kind": "sitemap",
     # Astro sitemap index; casting URLs are /castings/<slug>-<id>/ and
     # /en/castings/<slug>-<id>/ (same numeric id — dedupes across langs).
     # Mostly Latin America / Spain — Florida hits are rare but real.
     "url": "https://castingandacting.com/sitemap.xml",
     "link_re": r"castingandacting\.com/(en/)?castings/.+-\d+/?$",
     "id_from_url": lambda u: "castingandacting:" + re.search(r"-(\d+)/?$", urlparse(u).path).group(1)},
    {"key": "heybooker", "kind": "html-index",
     # Refuses connections from this VM (remote end closes) — kept in the
     # list so the failure is logged every run instead of silently dropped.
     "urls": ["https://heybooker.com/", "https://heybooker.com/jobs?location=Miami%2C+FL"],
     "link_re": r"heybooker\.com/(jobs?/[^\"'<> ]+|gigs?/[^\"'<> ]+)",
     "id_from_url": lambda u: "heybooker:" + re.sub(r"[^a-z0-9]+", "-", urlparse(u).path.strip("/"))[:120]},
    {"key": "actorsandextras", "kind": "html-index",
     # 502 from this VM at last check — kept so the failure is logged.
     "urls": ["https://www.actorsandextras.com/"],
     "link_re": r"actorsandextras\.com/(casting|audition|job)[^\"'<> ]*",
     "id_from_url": lambda u: "actorsandextras:" + re.sub(r"[^a-z0-9]+", "-", urlparse(u).path.strip("/"))[:120]},
    {"key": "productionbeast", "kind": "html-index",
     # Jobs live on the app subdomain, server-rendered: /jobs/<id>-<slug>.
     # The marketing site's sitemap is blog-only — do not use it.
     "urls": ["https://app.productionbeast.com/jobs/"],
     "link_re": r"app\.productionbeast\.com/jobs/(\d+)-[^\"'<> ]*",
     "id_from_url": lambda u: "productionbeast:" + re.search(r"/jobs/(\d+)-", u).group(1)},
    {"key": "craigslist", "kind": "rss",
     # 403 from this VM (Craigslist blocks the datacenter egress) — kept
     # so the failure is logged every run instead of silently dropped.
     "urls": ["https://miami.craigslist.org/search/ggg?format=rss",
              "https://miami.craigslist.org/search/tlg?format=rss"],
     "id_from_url": None},
]


def craigslist_record(item):
    m = re.search(r"/(\d+)\.html", item["link"])
    post_id = m.group(1) if m else re.sub(r"[^a-z0-9]+", "-", item["link"])[:80]
    comp, comp_type = parse_pay(item["title"] + " " + item["desc"])
    return {
        "id": "craigslist:" + post_id,
        "title": item["title"][:200],
        "production": None, "employer": None, "casting_org": "Craigslist (Miami)",
        "casting_professional": None,
        "category": classify_category(item["title"], item["desc"]) if re.search(r"music|model|commercial|extra|actor|actress", item["title"], re.I) else "other",
        "roles": None, "positions": None,
        "location": {"city": "Miami", "county": None, "state": "FL", "raw": "Miami area, FL (Craigslist Miami feed)"},
        "geography": "south-florida",
        "production_dates": None, "deadline": None,
        "compensation": comp, "compensation_type": comp_type,
        "hours": None, "eligibility": None, "age": None, "skills": None,
        "appearance": None, "travel": None, "usage_exclusivity": None,
        "submission_instructions": "Reply via the Craigslist posting (link below).",
        "source": "craigslist", "source_url": item["link"],
        "verification_status": "UNVERIFIED",
        "verification_notes": "Swept from the Craigslist Miami RSS feed; the feed covers the Miami area — per-gig location inside the area is not stated on the feed item.",
    }


# ---------------------------------------------------------------- API
def api_get(api, path, token):
    req = urllib.request.Request(api + path, headers={"User-Agent": UA, "Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def api_post(api, path, token, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(api + path, data=data, method="POST",
                                 headers={"User-Agent": UA, "Authorization": "Bearer " + token,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")[:300]


def existing_ids(api, token):
    ids, offset = set(), 0
    while True:
        d = api_get(api, f"/api/v1/opportunities?status=all&limit=500&offset={offset}", token)
        for o in d.get("opportunities", []):
            ids.add(o["id"])
        if len(d.get("opportunities", [])) < 500 or offset + 500 >= d.get("total", 0):
            break
        offset += 500
    return ids


def et_now():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


DERIVED_OPP_KEYS = ("expired", "selectivity", "selectivityReason", "genderRequirement")


def backfill_allcasting(api, token, checkpoint_path):
    """Rec 2: re-fetch every live AllCasting detail page, run the same
    castingCall extraction as the sweeper, and PATCH (via POST upsert)
    contact_email / submission_instructions / casting_org where the page
    supplies them. Resumable: one JSON line per record is appended to the
    checkpoint file as it is processed; a re-run skips finished ids.
    Also writes tools/allcasting-contacts-seed.json — verified org->email
    pairs from type=email listings only (rec 3 input)."""
    done = {}
    if os.path.exists(checkpoint_path):
        with open(checkpoint_path, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                    done[e["opportunity_id"]] = e
                except Exception:
                    continue
    print(f"backfill: checkpoint has {len(done)} finished records")
    try:
        d = api_get(api, "/api/v1/opportunities?source=allcasting&status=all&limit=500", token)
    except Exception as e:
        print(f"ERROR: cannot list AllCasting opportunities ({e})", file=sys.stderr)
        return 1
    opps = d.get("opportunities", [])
    before_with_email = sum(1 for o in opps if o.get("contact_email"))
    print(f"backfill: {len(opps)} AllCasting records, {before_with_email} already carry contact_email")
    contacts = {}
    counts = {"updated_email": 0, "updated_instructions": 0, "skipped_already": 0,
              "skipped_no_email": 0, "error": 0, "no_change": 0}
    ck = open(checkpoint_path, "a", encoding="utf-8")

    def record_checkpoint(oid, status, detail=None):
        ck.write(json.dumps({"opportunity_id": oid, "status": status,
                             "detail": detail, "ts": et_now()}) + "\n")
        ck.flush()

    for opp in opps:
        oid = opp["id"]
        if oid in done and done[oid].get("status") in ("updated_email", "updated_instructions", "skipped_already", "skipped_no_email", "no_change"):
            counts[done[oid]["status"]] += 1
            continue
        # Numeric listing id: prefer the source_url (/castingcall/NNNNN) —
        # some older records carry slug ids (musicvideo:allcasting:<slug>)
        # with no digits at all.
        num_m = re.search(r"/castingcall/(\d+)", opp.get("source_url") or "")
        num = num_m.group(1) if num_m else None
        if not num:
            num_m = re.search(r"(\d+)$", oid)
            num = num_m.group(1) if num_m else None
        url = opp.get("source_url") or (f"https://allcasting.com/castingcall/{num}" if num else None)
        if not num or not url:
            counts["error"] += 1
            record_checkpoint(oid, "error", "no numeric id / url")
            continue
        try:
            row = api_get(api, f"/api/v1/opportunities/{oid}", token)
            rec = row.get("opportunity") or {}
        except Exception as e:
            counts["error"] += 1
            record_checkpoint(oid, "error", f"GET record failed: {e}"[:200])
            continue
        if rec.get("contact_email"):
            counts["skipped_already"] += 1
            record_checkpoint(oid, "skipped_already", rec.get("contact_email"))
            continue
        status, data = fetch(url)
        time.sleep(DETAIL_DELAY)
        if status != 200 or not data:
            counts["error"] += 1
            record_checkpoint(oid, "error", f"GET detail -> {status}")
            continue
        cc, cc_err = extract_casting_call(data.decode("utf-8", "ignore"), want_id=num)
        if cc is None:
            counts["error"] += 1
            record_checkpoint(oid, "error", f"extract failed: {cc_err}"[:200])
            continue
        for k in DERIVED_OPP_KEYS:
            rec.pop(k, None)
        changed = False
        agent_email = cc.get("agent_email")
        agent_name = cc.get("agent_name")
        cc_type = cc.get("type")
        if agent_name and (not rec.get("casting_org")
                           or str(rec.get("casting_org")).strip().lower() == "allcasting"):
            # Older records carry the platform name as casting_org; the
            # poster name is what the contacts fallback needs.
            rec["casting_org"] = agent_name
            changed = True
        if agent_name and not rec.get("casting_professional"):
            rec["casting_professional"] = agent_name
            changed = True
        if cc_type == "email" and agent_email and EMAIL_RE.fullmatch(agent_email) \
                and agent_email.lower() not in BLOCKED_DESTINATION_EMAILS:
            rec["contact_email"] = agent_email
            rec["submission_instructions"] = f"Submit by email to {agent_email}"
            rec["verification_notes"] = (rec.get("verification_notes") or "") + \
                " Submission email harvested from the listing page (backfill 2026-11-23)."
            changed = True
            status_kind = "updated_email"
            if agent_name:
                contacts[agent_name] = agent_email
        elif cc_type == "web":
            if not rec.get("submission_instructions"):
                rec["submission_instructions"] = "Apply on AllCasting"
                changed = True
            status_kind = "updated_instructions"
        elif cc_type == "url":
            if not rec.get("submission_instructions"):
                rec["submission_instructions"] = "Apply via the listing link"
                changed = True
            status_kind = "updated_instructions"
        else:
            counts["skipped_no_email"] += 1
            record_checkpoint(oid, "skipped_no_email", f"type={cc_type}")
            continue
        if not changed:
            counts["no_change"] += 1
            record_checkpoint(oid, "no_change")
            continue
        st, resp = api_post(api, "/api/v1/opportunities", token, rec)
        if st in (200, 201):
            counts[status_kind] += 1
            record_checkpoint(oid, status_kind, agent_email or cc_type)
        else:
            counts["error"] += 1
            record_checkpoint(oid, "error", f"POST -> {st}: {str(resp)[:150]}")
        time.sleep(0.2)
    ck.close()
    seed_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "allcasting-contacts-seed.json")
    # Merge with any existing seed file (a resume run must not wipe the
    # pairs a previous run collected).
    merged = {}
    if os.path.exists(seed_path):
        try:
            for e in json.load(open(seed_path, encoding="utf-8")):
                merged[(e.get("name"), e.get("email"))] = e
        except Exception:
            pass
    seed = []
    for name, email in sorted(contacts.items()):
        org_like = bool(re.search(r"\b(Inc|LLC|Ltd|Casting|Studios|Productions|Media|Entertainment|Talent|Agency|Group)\b", name))
        seed.append({"name": name, "kind": "agency" if org_like else "casting-professional",
                     "email": email, "phone": None, "source": "allcasting castingCall (backfill 2026-11-23)",
                     "verified_on": "live listing page"})
    # Casting TaylorMade: no email anywhere; contact is by text (Heather),
    # verified in the 2026-11-23 audit on their MIA pages.
    seed.append({"name": "Casting TaylorMade", "kind": "agency", "email": None,
                 "phone": "(305) 951-8291", "source": "castingtaylormade.com MIA pages (audit 2026-11-23)",
                 "verified_on": "live page", "note": "Contact by text (Heather) — no email published"})
    for e in seed:
        merged[(e.get("name"), e.get("email"))] = e
    with open(seed_path, "w", encoding="utf-8") as f:
        json.dump(sorted(merged.values(), key=lambda e: (e.get("name") or "")), f, indent=1)
    print(f"backfill done: {counts} | contacts seed: {len(seed)} entries -> {seed_path}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Sweep casting sources for new South Florida listings.")
    ap.add_argument("--api", default=os.environ.get("TTT_API_URL", API_DEFAULT))
    ap.add_argument("--log", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "sweep-log.jsonl"))
    ap.add_argument("--dry-run", action="store_true", help="fetch + parse only; post nothing")
    ap.add_argument("--sources", default="all", help="comma list of source keys, or 'all'")
    ap.add_argument("--max-detail", type=int, default=15, help="detail pages fetched per source per run")
    ap.add_argument("--backfill-allcasting", action="store_true",
                    help="rec 2: re-fetch all live AllCasting detail pages and upsert harvested contact emails (resumable via tools/allcasting-backfill-progress.jsonl)")
    args = ap.parse_args()
    api = args.api.rstrip("/")
    token = os.environ.get("TTT_ADMIN_TOKEN", "")
    if not args.dry_run and not token:
        print("ERROR: TTT_ADMIN_TOKEN is not set. The token is read from the Secure Vault at run time by the caller — it is never stored in a file.", file=sys.stderr)
        return 2
    if args.backfill_allcasting:
        return backfill_allcasting(api, token, os.path.join(os.path.dirname(os.path.abspath(__file__)), "allcasting-backfill-progress.jsonl"))
    wanted = None if args.sources == "all" else set(args.sources.split(","))
    run_id = f"sweep-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    known = set()
    if not args.dry_run:
        try:
            known = existing_ids(api, token)
            print(f"live API: {len(known)} existing opportunity ids")
        except Exception as e:
            print(f"ERROR: cannot reach the live API ({e}) — aborting, nothing posted.", file=sys.stderr)
            return 1
    log_lines = []

    def log(obj):
        obj.update({"run_id": run_id, "ts": et_now()})
        log_lines.append(obj)

    any_ok = False
    for src in SOURCES:
        if wanted and src["key"] not in wanted:
            continue
        t0 = time.time()
        summary = {"event": "source.run", "source": src["key"], "fetched": 0, "harvested": 0,
                   "new": 0, "inserted": 0, "skipped": 0, "errors": []}
        try:
            if src["kind"] == "rss":
                items = rss_items(src["urls"])
                summary["fetched"] = len(items)
                summary["harvested"] = len(items)
                any_ok = True
                for item in items:
                    rec = craigslist_record(item)
                    rec["discovered_at"] = et_now()
                    if rec["id"] in known:
                        summary["skipped"] += 1
                        continue
                    summary["new"] += 1
                    if args.dry_run:
                        summary["inserted"] += 1
                        continue
                    status, _ = api_post(api, "/api/v1/opportunities", token, rec)
                    if status in (200, 201):
                        summary["inserted"] += 1
                        known.add(rec["id"])
                        log({"event": "opportunity.inserted", "source": src["key"],
                             "opportunity_id": rec["id"], "discovered_at": rec["discovered_at"],
                             "title": rec["title"]})
                    else:
                        summary["errors"].append(f"POST {rec['id']} -> {status}")
                summary["duration_s"] = round(time.time() - t0, 1)
                log(summary)
                print(f"{src['key']}: harvested={summary['harvested']} new={summary['new']} "
                      f"inserted={summary['inserted']} skipped={summary['skipped']} "
                      f"errors={len(summary['errors'])}")
                continue
            if src["kind"] == "sitemap":
                urls = sitemap_urls(src["url"], src["link_re"])
            else:
                urls = html_index_urls(src["urls"], src["link_re"])
            summary["harvested"] = len(urls)
            any_ok = True
            fetched_new = 0
            for url in urls:
                try:
                    oid = src["id_from_url"](url)
                except Exception:
                    summary["skipped"] += 1
                    continue
                if oid in known:
                    summary["skipped"] += 1
                    continue
                if fetched_new >= args.max_detail:
                    summary["skipped"] += 1
                    continue
                status, data = fetch(url)
                summary["fetched"] += 1
                fetched_new += 1
                time.sleep(DETAIL_DELAY)
                if status != 200 or not data:
                    summary["errors"].append(f"GET {url} -> {status}")
                    continue
                rec, skip_reason = parse_detail(url, data.decode("utf-8", "ignore"))
                if rec is None:
                    summary["skipped"] += 1
                    continue
                if src["key"] == "castingandacting":
                    # Follow the click-through to the original listing and
                    # keep it as the apply destination (source_url stays
                    # the CastingAndActing summary page).
                    apply_url = resolve_casting_click(data.decode("utf-8", "ignore"))
                    if apply_url:
                        rec["apply_url"] = apply_url
                rec["id"] = oid
                rec["source"] = src["key"]
                rec["discovered_at"] = et_now()
                summary["new"] += 1
                if args.dry_run:
                    summary["inserted"] += 1
                    continue
                st, _ = api_post(api, "/api/v1/opportunities", token, rec)
                if st in (200, 201):
                    summary["inserted"] += 1
                    known.add(oid)
                    log({"event": "opportunity.inserted", "source": src["key"],
                         "opportunity_id": oid, "discovered_at": rec["discovered_at"],
                         "title": rec["title"]})
                else:
                    summary["errors"].append(f"POST {oid} -> {st}")
            log(summary)
        except Exception as e:
            summary["errors"].append(str(e)[:200])
            log(summary)
        summary["duration_s"] = round(time.time() - t0, 1)
        print(f"{src['key']}: harvested={summary['harvested']} new={summary['new']} "
              f"inserted={summary['inserted']} skipped={summary['skipped']} "
              f"errors={len(summary['errors'])}")
    with open(args.log, "a", encoding="utf-8") as f:
        for line in log_lines:
            f.write(json.dumps(line) + "\n")
    print(f"run {run_id}: log appended to {args.log}")
    return 0 if any_ok else 1


if __name__ == "__main__":
    sys.exit(main())
