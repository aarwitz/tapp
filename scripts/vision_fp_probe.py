#!/usr/bin/env python3
"""Vision false-positive probe — reviews screenshots with the SAME prompt/model AutoTap's vision
pass uses, and tallies the visual findings it returns.

Why: the vision pass (VisionInspector.swift) is disabled by default. Before defaulting it on we must
know its FALSE-POSITIVE rate — how often it invents a "defect" on a screen that's actually fine. Our
corpus apps are standard SwiftUI (visually clean; their fixtures are LOGICAL/interaction bugs, not
visual ones), so on that corpus every returned finding is a candidate false positive. This probe
reports that count so the rate is measurable.

Source of truth for the prompt/parse is AutoTap/Services/VisionInspector.swift — kept in sync here
(same pattern as coverage_eval_parse.py mirroring the Swift parse, and the MCP regression mirror).

Usage:
    ANTHROPIC_API_KEY=... python3 vision_fp_probe.py IMG.png [IMG2.png ...]
    ANTHROPIC_API_KEY=... python3 vision_fp_probe.py --title-map manifest.json IMG.png ...

Emits a JSON report to stdout: per-image findings + an aggregate {reviewed, flagged, findings,
by_severity}. Exit 0 always (diagnostic, not a gate).
"""
import base64
import json
import os
import ssl
import sys
import urllib.request

# macOS system Python often can't verify TLS against the system keychain — use certifi's CA bundle so
# the API calls actually connect. Without this, every request fails SSL and the probe would silently
# report "0 findings" (a false clean). If certifi is missing, fall back to SSL_CERT_FILE/default.
def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()

_SSL_CTX = _ssl_context()

# Mirror of AnthropicVisionInspector.systemPrompt (VisionInspector.swift) — keep in sync.
SYSTEM_PROMPT = (
    "You are a meticulous mobile-app visual QA inspector reviewing ONE iOS app screenshot captured "
    "during automated exploration. Report only real, SHIPPED visual defects a user would hit: text "
    "overlapping other text, text clipped mid-character with no ellipsis, text running off-screen, "
    "broken or missing images/icons, controls misaligned or overlapping other controls, unreadable "
    "contrast, lorem/placeholder copy shipped in labels, or a broken empty/error state.\n\n"
    "The screen was captured MID-INTERACTION, so do NOT report these EXPECTED, non-defect states:\n"
    "- The on-screen keyboard covering the lower part of the screen (normal when a field is focused).\n"
    "- An open menu, dropdown, picker, popover, or sheet overlapping the content beneath it — and "
    "text or controls partially COVERED by that open element are occluded, not clipped or broken; "
    "report neither the overlap nor the covered text as a defect.\n"
    "- A navigation back button that shows the previous screen's title next to the chevron.\n"
    "- Values typed into fields during testing (e.g. \"test\", \"test@example.com\", \"5551234567\") "
    "— that is test input, not shipped placeholder text.\n"
    "- A disabled or greyed-out button/control — that is a valid state, not a defect.\n"
    "- A field showing its own label as placeholder, or text cleanly truncated with an ellipsis (…) "
    "— that is intentional.\n"
    "- Text or a card cut off at the very TOP or BOTTOM edge of a scrollable screen — that content "
    "simply continues off-screen when scrolled; only flag text clipped WITHIN its own container.\n\n"
    "You may also be given ACCESSIBILITY CONTEXT — the text/fields/actions the a11y tree reports on "
    "this screen. Use it to REJECT false positives: if the COMPLETE text appears in that context, it "
    "is rendered and available — NEVER report it as clipped, truncated, or cut off, no matter how it "
    "looks to you; if a field is listed with no "
    "value, an empty field showing just its label is expected. Report a defect only when you can SEE "
    "it and the accessibility context does not explain it away.\n\n"
    "Content is NEVER a rendering defect, no matter how it looks. You cannot know if a name, word, "
    "email address, or other text is \"correct\" — you only know what pixels are rendered. NEVER "
    "report a name or word as \"misspelled\", \"wrong\", or a data/binding error, and NEVER file it "
    "under text_clipping/visual_regression/etc., because it looks unusual, made-up, or like a typo "
    "(e.g. an odd client name, an auto-generated email/relay address, a random ID, two different "
    "people sharing a first name) — that may be real content rendering exactly as intended, not a "
    "rendering bug, even if it looks strange. Only report text_clipping when you can see an ACTUAL "
    "rendering artifact: characters physically cut off mid-glyph, text overflowing its container "
    "with no ellipsis, or overlapping other elements — never based on what the text says. A "
    "text_clipping report MUST name, in \"detail\", the exact visible characters or words that are "
    "missing or cut; if you cannot say what is missing, it is not clipped — do not report it.\n\n"
    "You MAY separately flag content that looks unusual enough to be worth a human glance — use the "
    "\"content_flag\" category for this, ALWAYS at \"low\" severity, and phrase it as a question, not "
    "a diagnosis (e.g. \"Verify this client name is intentional: 'Daviad'\" — NOT \"Client name "
    "misspelled\"). A content_flag is not a bug report: it says \"a human should confirm this is real "
    "data\", nothing more. Use it sparingly — only for content a reasonable person would pause on, "
    "not every name that isn't a common English word.\n\n"
    "Do NOT report subjective style opinions or anything you are unsure is a defect. When in doubt, "
    "do not report it. Respond with ONLY a JSON array (no prose) of objects: {\"severity\":"
    "\"low|medium|high\",\"category\":\"layout_overlap|text_clipping|missing_asset|blank_screen|"
    "visual_regression|content_flag\",\"title\":\"short\",\"detail\":\"what and where\"}. If the "
    "screen looks fine, respond with []."
)

# Sonnet default mirrors makeVisionInspector (VisionInspector.swift): Haiku hallucinated a
# clipping defect 6/6 trials on a clean settled screenshot across two prompt variants; Sonnet
# was clean 6/6 on both. Model-bound FP class — keep the eval on the product's real default.
MODEL = os.environ.get("AUTOTAP_VISION_MODEL", "claude-sonnet-4-6")
ENDPOINT = "https://api.anthropic.com/v1/messages"


def parse_findings(text):
    """Mirror of parseVisionFindings: extract the first top-level JSON array, tolerate fences/prose."""
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end <= start:
        return []
    try:
        arr = json.loads(text[start:end + 1])
    except Exception:
        return []
    out = []
    for obj in arr if isinstance(arr, list) else []:
        if not isinstance(obj, dict):
            continue
        title = str(obj.get("title", "")).strip()
        if not title:
            continue
        category = str(obj.get("category", "visual_regression")).lower()
        # content_flag is never a confirmed defect — cap it at low regardless of what the model
        # said (mirrors parseVisionFindings' clamp in VisionInspector.swift).
        severity = "low" if category == "content_flag" else str(obj.get("severity", "medium")).lower()
        out.append({
            "severity": severity,
            "category": category,
            "title": title,
            "detail": str(obj.get("detail", obj.get("description", ""))).strip(),
        })
    return out


def review(image_path, title, key, summary=""):
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    user_text = f"Screen title: {title}."
    if summary:
        user_text += f"\nAccessibility context (what the a11y tree reports here): {summary}"
    user_text += "\nReview this screenshot and report visual defects as the JSON array."
    body = {
        "model": MODEL,
        "max_tokens": 1024,
        "system": SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": user_text},
            ],
        }],
    }
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST", headers={
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=90, context=_SSL_CTX) as resp:
            data = json.load(resp)
    except Exception as e:
        return {"error": str(e)}, []
    text = "\n".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return {"raw": text}, parse_findings(text)


def main():
    args = sys.argv[1:]
    title_map = {}
    summary_map = {}
    while args and args[0] in ("--title-map", "--summary-map"):
        flag, path = args[0], args[1]
        with open(path) as f:
            data = json.load(f)
        if flag == "--title-map":
            title_map = data
        else:
            summary_map = data
        args = args[2:]
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        print(json.dumps({"error": "ANTHROPIC_API_KEY not set"}))
        return 2
    if not args:
        print(json.dumps({"error": "no images given"}))
        return 2

    per_image = []
    by_sev = {"high": 0, "medium": 0, "low": 0}
    flagged = 0
    errors = 0
    first_error = None
    for path in args:
        title = title_map.get(os.path.basename(path)) or title_map.get(path) or os.path.splitext(os.path.basename(path))[0]
        summary = summary_map.get(os.path.basename(path)) or summary_map.get(path) or ""
        meta, findings = review(path, title, key, summary=summary)
        if meta.get("error"):
            errors += 1
            first_error = first_error or meta["error"]
            per_image.append({"image": os.path.basename(path), "title": title, "findings": [], "error": meta["error"]})
            continue
        if findings:
            flagged += 1
            for fnd in findings:
                by_sev[fnd["severity"]] = by_sev.get(fnd["severity"], 0) + 1
        per_image.append({"image": os.path.basename(path), "title": title, "findings": findings})

    reviewed = len(args)
    succeeded = reviewed - errors
    report = {
        "reviewed": reviewed,
        "succeeded": succeeded,      # calls that actually reached the model
        "errors": errors,            # calls that failed (network/SSL/etc.) — NOT clean screens
        "first_error": first_error,
        "flagged": flagged,
        "findings_total": sum(len(x["findings"]) for x in per_image),
        "by_severity": by_sev,
        # FP rate is over SUCCEEDED calls only — a failed call is not evidence of a clean screen.
        "fp_rate_screens": round(flagged / succeeded, 3) if succeeded else None,
        "images": per_image,
    }
    print(json.dumps(report, indent=2))
    # Non-zero exit when NOTHING succeeded, so a total failure can't read as a pass.
    return 3 if succeeded == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
