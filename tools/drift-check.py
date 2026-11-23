#!/usr/bin/env python3
"""TOP TEA TALENTS drift check — keeps the live public page honest.

Compares, from the public package on disk (the source of truth for "latest
exported"):
  1. GitHub repo tree (main) vs disk files — is everything pushed?
  2. Live Pages site vs disk frontend — is the served page the latest export?
     (md5 of index.html + the window.__TTT_BUILD__ stamp)
  3. Live api-config.js — does it point at the real Render backend?
  4. Live backend /health + /ledger/verify + /ledger/mirror — version, counts,
     storage durability, and whether the mirror code is actually deployed.

Exit codes: 0 = in sync, 1 = drift found, 2 = a check errored/unknown.
Prints a human summary on stdout and writes a JSON report to
tools/drift-report.json (plus one line per run to tools/drift-history.jsonl).

Stdlib only. No secrets. Read-only against every live service (GET only).
Render's free tier sleeps after 15 min idle, so backend fetches allow 90s
and retry once — a slow wake is not drift, it is a slow wake.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

PACKAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "moocho954-afk/top-tea-talents"
SITE = "https://moocho954-afk.github.io/top-tea-talents/"
API = "https://top-tea-talents-api.onrender.com"
EXPECTED_API = API  # exact Render URL, -XXXX suffix included
REPORT = os.path.join(PACKAGE, "tools", "drift-report.json")
HISTORY = os.path.join(PACKAGE, "tools", "drift-history.jsonl")

# Files tracked for repo-vs-disk comparison (node_modules and .git excluded).
# taylormade-work holds a real talent's portfolio photos + per-run work files
# for the form submitter — local-only by design, never pushed to the public
# repo (owner decision 2026-11-23: photos stay out of git).
SKIP_DIRS = {"node_modules", ".git", "__pycache__", "taylormade-work"}
# Runtime-generated state/logs mutate every run (reply-watch ~30 min, sweep
# ~4 h) and can never stay byte-identical to a pushed snapshot; the page
# does not depend on them, so they are not tracked for drift.
SKIP_FILES = {"drift-report.json", "drift-history.jsonl",
              "reply-watch-state.json", "sweep-log.jsonl"}


def fetch(url, timeout=90, retries=1):
    """GET url; returns (status, bytes) or raises on final failure."""
    req = urllib.request.Request(url, headers={"User-Agent": "ttt-drift-check/1.0"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception:
            if attempt == retries:
                raise
            time.sleep(5)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha(path):
    out = subprocess.run(["git", "hash-object", path],
                         capture_output=True, text=True, cwd=PACKAGE)
    return out.stdout.strip() if out.returncode == 0 else None


def disk_files():
    out = []
    for root, dirs, files in os.walk(PACKAGE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name in SKIP_FILES:
                continue
            out.append(os.path.relpath(os.path.join(root, name), PACKAGE))
    return sorted(out)


def main():
    drift = []
    unknown = []
    notes = []
    checks = {}

    # ---- 0. VERSION.json (the export manifest) ----
    version_path = os.path.join(PACKAGE, "VERSION.json")
    try:
        version = json.load(open(version_path))
    except Exception as e:
        version = {}
        unknown.append(f"VERSION.json unreadable: {e}")
    checks["version_manifest"] = version

    # ---- 1. Repo tree vs disk (raw-content comparison) ----
    # The GitHub REST API is rate-limited for unauthenticated calls from this
    # shared VM IP, so compare against the raw file CDN instead: fetch each
    # tracked file from raw.githubusercontent.com/main and compare bytes.
    # 404 = on disk but not pushed (NEW); mismatch = CHANGED.
    try:
        new_files, changed, unchanged, missing = [], [], [], []
        for rel in disk_files():
            try:
                status, body = fetch(
                    f"https://raw.githubusercontent.com/{REPO}/main/{rel}",
                    timeout=30)
            except Exception as e:
                unknown.append(f"raw fetch failed for {rel}: {e}")
                continue
            if status == 404:
                new_files.append(rel)
            elif status == 200:
                disk_bytes = open(os.path.join(PACKAGE, rel), "rb").read()
                if body != disk_bytes:
                    changed.append(rel)
                else:
                    unchanged.append(rel)
            else:
                unknown.append(f"raw fetch for {rel} returned HTTP {status}")
        checks["repo"] = {"new": new_files, "changed": changed,
                          "unchanged": len(unchanged)}
        for rel in new_files:
            drift.append(f"REPO BEHIND: {rel} is on disk but not pushed to GitHub")
        for rel in changed:
            drift.append(f"REPO BEHIND: {rel} differs between disk and GitHub")
    except Exception as e:
        unknown.append(f"Repo comparison failed: {e}")
        checks["repo"] = {"status": "error"}

    # ---- 2. Live site vs disk frontend ----
    try:
        status, body = fetch(SITE)
        if status == 200:
            live_md5 = hashlib.md5(body).hexdigest()
            disk_md5 = hashlib.md5(
                open(os.path.join(PACKAGE, "frontend", "index.html"), "rb").read()
            ).hexdigest()
            checks["site"] = {"http": 200, "live_index_md5": live_md5,
                              "disk_index_md5": disk_md5}
            if live_md5 != disk_md5:
                drift.append("SITE STALE: live index.html md5 differs from disk frontend")
            text = body.decode("utf-8", "replace")
            m = re.search(r"window\.__TTT_BUILD__\s*=\s*(\{[^;]*\});", text)
            if m:
                try:
                    stamp = json.loads(m.group(1))
                except Exception:
                    # The stamp is a JS object literal (unquoted keys), not
                    # strict JSON — parse key: "value" pairs instead of
                    # giving up and reporting artifact None (false SITE
                    # STALE on every run; the live stamp really says v14).
                    stamp = {"raw": m.group(1)}
                    for k, v in re.findall(r'(\w+)\s*:\s*"([^"]*)"', m.group(1)):
                        stamp[k] = v
                checks["site"]["stamp"] = stamp
                want = version.get("artifact_version")
                if want and stamp.get("artifact_version") != want:
                    drift.append(
                        f"SITE STALE: live stamp says artifact {stamp.get('artifact_version')}, "
                        f"package is {want}")
            else:
                checks["site"]["stamp"] = None
                drift.append("SITE STALE: live page carries no __TTT_BUILD__ version stamp")
            if "Backend not configured" in text:
                drift.append("SITE: 'Backend not configured' banner is showing")
        else:
            unknown.append(f"Live site returned HTTP {status}")
            checks["site"] = {"http": status}
    except Exception as e:
        unknown.append(f"Live site fetch failed: {e}")
        checks["site"] = {"status": "error"}

    # ---- 3. api-config.js ----
    try:
        status, body = fetch(SITE + "api-config.js")
        if status == 200:
            text = body.decode("utf-8", "replace")
            m = re.search(r'window\.__TTT_API__\s*=\s*"([^"]*)"', text)
            api_url = m.group(1) if m else None
            checks["api_config"] = {"http": 200, "api_url": api_url}
            if api_url != EXPECTED_API:
                drift.append(f"API CONFIG: live api-config.js points at {api_url!r}, "
                             f"expected {EXPECTED_API!r}")
        else:
            unknown.append(f"api-config.js returned HTTP {status}")
            checks["api_config"] = {"http": status}
    except Exception as e:
        unknown.append(f"api-config.js fetch failed: {e}")
        checks["api_config"] = {"status": "error"}

    # ---- 4. Live backend ----
    try:
        status, body = fetch(API + "/api/v1/health")
        if status == 200:
            health = json.loads(body)
            checks["backend"] = health
            try:
                pkg = json.load(open(os.path.join(PACKAGE, "server", "package.json")))
                disk_version = pkg.get("version")
            except Exception:
                disk_version = None
            if disk_version and health.get("version") != disk_version:
                drift.append(f"BACKEND STALE: live backend version "
                             f"{health.get('version')}, package is {disk_version}")
            if health.get("storage_durable") is not True:
                drift.append("BACKEND: storage_durable is not true "
                             "(sign-ups do not survive a restart yet)")
            counts = health.get("counts", {})
            if counts.get("opportunities") != 434:
                drift.append(f"BACKEND: opportunity count is "
                             f"{counts.get('opportunities')}, expected 434")
        else:
            unknown.append(f"Backend /health returned HTTP {status}")
            checks["backend"] = {"http": status}
    except Exception as e:
        unknown.append(f"Backend /health fetch failed: {e}")
        checks["backend"] = {"status": "error"}

    # Mirror presence: 401 = endpoint exists but admin-gated (good);
    # 404 = pre-mirror code still deployed (drift); 200 = public (unexpected).
    try:
        status, _ = fetch(API + "/api/v1/ledger/mirror")
        checks["mirror_endpoint"] = {"http": status}
        if status == 404:
            drift.append("BACKEND STALE: /ledger/mirror 404s — mirror code is not deployed")
        elif status not in (200, 401):
            unknown.append(f"/ledger/mirror returned HTTP {status}")
    except Exception as e:
        unknown.append(f"/ledger/mirror fetch failed: {e}")
        checks["mirror_endpoint"] = {"status": "error"}

    try:
        status, body = fetch(API + "/api/v1/ledger/verify")
        if status == 200:
            v = json.loads(body)
            checks["ledger_verify"] = v
            if "mirror" not in v:
                drift.append("BACKEND STALE: /ledger/verify carries no mirror field — "
                             "mirror code is not deployed")
    except Exception as e:
        unknown.append(f"/ledger/verify fetch failed: {e}")

    result = {
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "drift" if drift else ("unknown" if unknown else "in_sync"),
        "drift": drift,
        "unknown": unknown,
        "notes": notes,
        "checks": checks,
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w") as f:
        json.dump(result, f, indent=2)
    with open(HISTORY, "a") as f:
        f.write(json.dumps({"at": result["checked_at"], "status": result["status"],
                            "drift": drift, "unknown": unknown}) + "\n")

    print(f"TOP TEA TALENTS drift check — {result['checked_at']}")
    print(f"STATUS: {result['status'].upper()}")
    if drift:
        print(f"\nDRIFT ({len(drift)}):")
        for d in drift:
            print(f"  ! {d}")
    if unknown:
        print(f"\nUNKNOWN ({len(unknown)}):")
        for u in unknown:
            print(f"  ? {u}")
    if not drift and not unknown:
        print("Live site, repo, and backend all match the package on disk. No drift.")
    return 1 if drift else (2 if unknown else 0)


if __name__ == "__main__":
    sys.exit(main())
