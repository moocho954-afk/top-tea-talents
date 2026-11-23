# Casting TaylorMade form submitter — build report
**Date:** 2026-11-23 (built ~13:05–13:30 EST)
**Owner order:** "Send everything out, everything should be on auto run" + "If they have no contact how do we contact them… you have to figure that part out" (2026-11-23).
**Basis:** `tools/no-contact-apply-routes-2026-11-23.md` §11 (best next build) + live form.

## Headline: BLOCKED ON GAPS — nothing submitted, nothing invented

The submitter is built and verified against the live form. **No real submission happened for either talent.** Both are blocked on required fields that are not on their talent records. The submit gate was tested and refuses correctly (exit 3, exact blocked list).

- **Joseph (BIGG MOOCHO): 18 required fields missing.** 19 fields mapped from his record.
- **Mona Lisa: 18 required fields missing** (incl. both photos — she has 0 on file). 19 fields mapped.

## What was built

**`tools/taylormade-form-submitter.py`** (single file, stdlib + Playwright):

1. **Capture** — `capture_form_url(slug)`: fetches `castingtaylormade.com/<slug>` and extracts the embedded `tally.so/r/<id>` (verified live: `miamivice` → `LZAXbv`). Known-map fallback for slugs already seen.
2. **Live definition parse** — `parse_form_definition(form_url)`: fetches the public form page and parses the form's own `__NEXT_DATA__` payload — labels, input types, `isRequired` flags, full option lists, and conditional logic. No Tally API call (the API endpoint returns 401 from here; the page itself carries the whole definition). This is the field-by-field verification against the live form.
3. **Talent mapping** — `map_talent_to_form()`: maps the TTT talent record onto the live questions, conditional-aware (men's sizes for Male, women's for Female; car-detail questions only if vehicle = YES; tattoo locations only if tattoos = YES; agency-name only if referred-by = agency). Experience checkbox groups check "None" when the record gives no positive evidence — "None" is a real option on the form, not an invention.
4. **Photos** — downloads the talent's 2 photos as bytes through the same surrogate credential mechanism as `ttt.py` (close-up = MAIN HEADSHOT, full body = FULL-BODY PHOTO).
5. **Fill plan** — writes `tools/taylormade-work/<talentId>/fill-plan.json` (form URL, live questions, ordered fill steps, gaps, photo files). This is the executable artifact for the live-submit step.
6. **Submit engine** — label-driven Playwright filler (fill/select/check/upload + submit click + on-screen confirmation check). **Live submit is refused unless zero required gaps** (tested: exit 3).
7. **Logging** — after a confirmed submit: POST `/api/v1/applications` `{talentId, opportunityId}` (409 = already exists, reuse it) then PATCH `/api/v1/applications/{id}/status` `{"status": "SUBMITTED — SENT"}` (verified from the backend source: the PATCH endpoint accepts any status except CONFIRMED, which needs a SENT email first), plus a JSONL line in `tools/taylormade-submissions.jsonl`.

**Generalisation:** the same pattern works for any Tally form — the definition parser reads that form's own `__NEXT_DATA__`, so the field list, required flags and options are per-form. Google Forms would need a different definition reader (their pages do not carry `__NEXT_DATA__`); the fill-plan + Playwright engine is form-agnostic, the parser is Tally-specific. Stated honestly, not claimed as done.

## Live form verified (Miami Vice, form open, `isClosed: false`)

Parsed live 2026-11-23 from `tally.so/r/LZAXbv`: ~50 questions. Everything the routes doc listed, **plus three the doc missed**: **Facial hair** (required, 3 options), **Tattoo locations** (conditional on Tattoos = YES), and **Last name** (separate optional input). Corrections to the doc: **Paid fitting availability is a YES/NO choice, not dates**; **Referred by is REQUIRED** (14 options, incl. "Agency not listed (tell us below!)" + a conditional agency-name input); **filming availability is 37 specific dates** (12/7–2/6); car-detail fields (year/color/make/model/type) are conditional on vehicle = YES; the legal-to-work NO answer disables the submit button by conditional logic.

## Fields mapped (from the real talent records)

Both talents map 19 steps, all exact-option matches where the form uses a dropdown:

- Full name, Last name, Phone, Email, Gender, Ethnic appearance (Black / African American), City, State (Florida), Height (Joseph 6'1, Mona Lisa 5'3 — both exact options), Hair color (Black), English language (YES), Referred by ("Agency not listed" + "Which agency referred you?" = "Top Tea Talents" — the application genuinely comes through the agency; the form's own path for an unlisted agency), Real-life experience explained (Joseph: his experience text; Mona Lisa: "No experience" verbatim from her record), Prior film/TV (Joseph: YES several experiences; Mona Lisa: NO never worked), all four experience checkbox groups ("None" — no positive evidence on either record).

## Exact gaps — Joseph (18, all required)

Date of birth · Weight (lbs) · Hair cut / modification · Facial hair · Bathing suit / wardrobe comfort · Tattoos · Shirt / blouse size · Neck size (men) · Sleeve length (men) · Pants waist (men) · Pants inseam (men) · Suit jacket size (men) · Shoe size · Vintage vehicle (1960–1989) · Filming availability (specific dates from the 37-date list) · Paid fitting availability (YES/NO) · Overnights / splits · Legal to work in the USA (attestation).

**DOB note:** Joseph's DOB (1987-10-16) exists in the Credit Omega enrollment record in memory — it was NOT used, because it is not on the TTT talent record and the task forbids cross-record assumptions. If the owner confirms it, it goes on the profile and the gap closes.

## Exact gaps — Mona Lisa (18, all required)

Same 18 minus the men's sizes, plus the women's sizes instead — **plus both photos**: she has **0 photos** on her talent record (photoCount 0), and the form requires a close-up + a full body. Her gaps: Date of birth · Weight · Hair cut / modification · Facial hair · Bathing suit / wardrobe comfort · Tattoos · Shirt / blouse size · Pants / jean size (women) · Dress size · Bra band size (women) · Bra cup size (women) · Shoe size · Vintage vehicle · Filming availability · Paid fitting availability · Overnights / splits · Legal to work in the USA · **Photos (2)**.

## Photo findings

- Joseph close-up (MAIN HEADSHOT, slot 1) is stored as a **150×150, 4,957-byte JPEG** — a thumbnail. It uploads, but it is weak for a casting close-up. His full-body (slot 2) is **539×1200, 54KB** — a real photo. Recommendation: upload a full-resolution current close-up to his profile before submitting.
- Mona Lisa: no photos at all. She cannot be submitted to any photo-requiring form until 2 current photos (close-up + full body) are on her record.

## What unblocks submission

The owner (or the talents) supplies the 18 answers per talent — most are one-word answers (sizes, yes/no consents, dates). The fastest path: add them to the talent records (the `clothing{}` object holds sizes; the rest need profile fields or a gaps form), then re-run:

```
python3 tools/taylormade-form-submitter.py --talent <id> --slug miamivice --submit \
    --opportunity auditionsfree:miami-vice-extras-miami
```

The gate then passes, the form submits, and the backend application is logged SENT. Two judgment calls are flagged for the owner, not decided by the machine: (1) "Miami / South Florida Native or Longtime Resident" in the Classic-vehicles experience group — left as "None" pending his word on residency history; (2) Paid fitting availability — his record says "Available immediately / Flexible", which suggests YES but was not inferred.

## Submit-path limitation (honest)

The Playwright engine is built, but **local Chromium cannot reach the internet on this VM**: the egress proxy refuses CONNECT tunnels from Chromium (`ERR_TUNNEL_CONNECTION_FAILED`, identical for example.com — not Tally-specific). Python HTTP through the same proxy works fine, which is why the capture + definition parse + photo download all run locally. So on this box the live submit executes as a **browser task** (parent's seat) using the emitted fill plan + the 2 downloaded photo files per talent. The engine itself is correct for any environment with working browser egress. No Tally API endpoint was used or probed for submission (the GET form endpoint 401s from here; per instruction no alternate API endpoint was attempted).

## Files

- `tools/taylormade-form-submitter.py` — the submitter (capture, parse, map, fill plan, Playwright engine, backend logging).
- `tools/taylormade-work/tal_a8e01279ace84ed4/fill-plan.json` + `closeup-*.jpg` + `fullbody-*.jpg` — Joseph's fill plan + photos.
- `tools/taylormade-work/tal_4915800fb8534d44/fill-plan.json` — Mona Lisa's fill plan (no photos).
- `tools/taylormade-submissions.jsonl` — submission log (empty; created on first real submit).
- This report: `tools/taylormade-submitter-report-2026-11-23.md`.

## Verification done this run

- Live form parsed from `tally.so/r/LZAXbv` (form open, 50 questions, required flags + full option lists + conditional logic).
- Both talent records read live via `ttt.py`; photos downloaded live (Joseph 2, Mona Lisa 0).
- Dry-run mapping for both talents; fill plans written.
- Submit gate tested: `--submit` for Joseph refused with exit 3 and the exact 18-field blocked list. No form was submitted, no email sent, no settings touched.
