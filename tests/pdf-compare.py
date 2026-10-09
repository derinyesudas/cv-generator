#!/usr/bin/env python3
"""
PDF fidelity check (2 Oct 2026): lays the app's own PDF (js/render-pdf.js)
over LibreOffice's PDF of the very same .docx - LibreOffice being the
renderer every measured height in data._blockHeightMeta came from - and
reports, line by line, whether the text breaks in the same places and how
far each baseline and left edge has moved.

    python3 tests/pdf-compare.py <app.pdf> <same.docx> [--png out-prefix]

Exit status 1 if any line's text differs, the page counts differ, or a
baseline is off by more than --tol points (default 1.5pt).
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

import pdfplumber

DESCENT = 443 / 2048  # Liberation Serif / Times New Roman descent, em


def lines_of(pdf_path):
    out = []
    with pdfplumber.open(pdf_path) as pdf:
        pages = len(pdf.pages)
        for pno, page in enumerate(pdf.pages):
            for ln in page.extract_text_lines(layout=False, strip=True, return_chars=True):
                chars = [c for c in ln["chars"] if c["text"].strip()]
                if not chars:
                    continue
                # the body text's own size, not a bullet glyph's
                sizes = sorted(round(c["size"], 2) for c in chars)
                size = sizes[len(sizes) // 2]
                body = [c for c in chars if round(c["size"], 2) == size]
                baseline = max(c["bottom"] for c in body) - DESCENT * size
                out.append({
                    "page": pno,
                    "text": re.sub(r"\s+", " ", ln["text"]).strip(),
                    "baseline": baseline + pno * 10000,
                    "x0": min(c["x0"] for c in chars),
                    "size": size,
                })
    return pages, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("app_pdf")
    ap.add_argument("docx")
    ap.add_argument("--tol", type=float, default=1.5)
    ap.add_argument("--png", default=None)
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="pdfcmp-")
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, args.docx],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    lo_pdf = os.path.join(tmp, os.path.splitext(os.path.basename(args.docx))[0] + ".pdf")

    app_pages, app = lines_of(args.app_pdf)
    lo_pages, lo = lines_of(lo_pdf)
    problems = []
    if app_pages != lo_pages:
        problems.append(f"page count: app {app_pages}, LibreOffice {lo_pages}")
    worst_b = 0.0
    worst_x = 0.0
    for i in range(max(len(app), len(lo))):
        a = app[i] if i < len(app) else None
        b = lo[i] if i < len(lo) else None
        if not a or not b:
            problems.append(f"line {i + 1}: only in {'app' if a else 'LibreOffice'}: {(a or b)['text'][:80]!r}")
            continue
        if a["text"] != b["text"]:
            problems.append(f"line {i + 1}: breaks differently\n    app: {a['text'][:110]!r}\n    LO : {b['text'][:110]!r}")
            continue
        db = a["baseline"] - b["baseline"]
        dx = a["x0"] - b["x0"]
        worst_b = max(worst_b, abs(db))
        worst_x = max(worst_x, abs(dx))
        if abs(db) > args.tol:
            problems.append(f"line {i + 1}: baseline {db:+.2f}pt  {a['text'][:70]!r}")
    print(f"{os.path.basename(args.app_pdf)}: {len(app)} lines (LibreOffice {len(lo)}), pages {app_pages}/{lo_pages}, "
          f"worst baseline {worst_b:.2f}pt, worst left edge {worst_x:.2f}pt, "
          f"last baseline app {app[-1]['baseline'] if app else 0:.1f} vs LO {lo[-1]['baseline'] if lo else 0:.1f}")
    for p in problems:
        print("  - " + p)

    if args.png:
        for name, path in (("app", args.app_pdf), ("lo", lo_pdf)):
            subprocess.run(["pdftoppm", "-png", "-r", "110", "-f", "1", "-l", "1", path, f"{args.png}-{name}"], check=True)
        try:
            from PIL import Image, ImageChops
            a = Image.open(f"{args.png}-app-1.png").convert("RGB")
            b = Image.open(f"{args.png}-lo-1.png").convert("RGB")
            w, h = max(a.width, b.width), max(a.height, b.height)
            side = Image.new("RGB", (w * 2 + 20, h), (255, 0, 255))
            side.paste(a, (0, 0))
            side.paste(b, (w + 20, 0))
            side.save(f"{args.png}-side.png")
            # red = only in the app's PDF, cyan = only in LibreOffice's
            ga, gb = a.convert("L"), b.convert("L")
            diff = Image.merge("RGB", (gb, ga, ga))
            diff.save(f"{args.png}-overlay.png")
        except Exception as e:  # pragma: no cover - imaging is a convenience
            print("  (png compose skipped:", e, ")")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
