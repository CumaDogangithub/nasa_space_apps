"""SPHEREx Blink Tree - builds the report.

One layout (``template.html``) and one text file per language (``text_tr.json``,
``text_en.json``). For each language this writes ``report_<lang>.html`` next to
this file and prints it to PDF with headless Chrome or Edge.

    python report/build.py            both languages
    python report/build.py tr         one language
    python report/build.py --html     the HTML only, no PDF

The pictures in ``figures/<lang>/`` are screenshots of the running tool, taken
by ``figures.cjs``. The report must stay within PAGES pages; the build fails if
the PDF has a different number.

A copy of each finished PDF is put in the project folder (one level up), where
a visitor of the repository looks first, so that copy is always the current one.

Template syntax: ``{{ a.b }}`` puts in a text, ``{% for x in a.list %} ...
{% endfor x %}`` repeats a block for every item of a list.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent                # the PDFs are copied here as well
PAGES = 8                            # the cover, the title page and six pages of content
BROWSERS = [
    os.environ.get("CHROME", ""),
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
]

LOOP = re.compile(r"\{% for (\w+) in ([\w.]+) %\}(.*?)\{% endfor \1 %\}", re.S)
VALUE = re.compile(r"\{\{ *([\w.]+) *\}\}")


def lookup(context: dict, path: str):
    """The value at a dotted path such as ``p2.boxes``; a missing text stops the build."""
    value = context
    for part in path.split("."):
        try:
            value = value[int(part)] if isinstance(value, list) else value[part]
        except (KeyError, IndexError, ValueError):
            raise KeyError(f"the text file has no '{path}'") from None
    return value


def render(template: str, context: dict) -> str:
    def loop(match: re.Match) -> str:
        name, path, body = match.groups()
        return "".join(render(body, {**context, name: item}) for item in lookup(context, path))

    template = LOOP.sub(loop, template)
    return VALUE.sub(lambda m: str(lookup(context, m.group(1))), template)


def count_pages(pdf: Path) -> int:
    return len(re.findall(rb"/Type\s*/Page\b(?!s)", pdf.read_bytes()))


def build(lang: str, with_pdf: bool) -> None:
    text = json.loads((HERE / f"text_{lang}.json").read_text(encoding="utf-8"))
    text.setdefault("lang", lang)
    text["pages"] = PAGES
    html = render((HERE / "template.html").read_text(encoding="utf-8"), text)

    missing = [src for src in re.findall(r'<img[^>]+src="([^"]+)"', html) if not (HERE / src).exists()]
    if missing:
        raise SystemExit(f"{lang}: missing pictures (run figures.cjs): " + ", ".join(sorted(set(missing))))

    page = HERE / f"report_{lang}.html"
    page.write_text(html, encoding="utf-8", newline="\n")
    print(f"{lang}: wrote {page.name}")
    if not with_pdf:
        return

    browser = next((b for b in BROWSERS if b and Path(b).exists()), None)
    if not browser:
        raise SystemExit("No Chrome or Edge found; set CHROME to its path, or print the HTML to PDF by hand.")
    pdf = HERE / text["pdf"]
    subprocess.run(
        [browser, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--print-to-pdf-no-header",
         f"--print-to-pdf={pdf}", page.as_uri()],
        check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pages = count_pages(pdf)
    print(f"{lang}: wrote {pdf.name}, {pages} pages, {pdf.stat().st_size / 1e6:.1f} MB")
    if pages != PAGES:
        raise SystemExit(f"{lang}: the report must have {PAGES} pages, the PDF has {pages}")
    shutil.copyfile(pdf, PROJECT / pdf.name)          # only a PDF that passed the page check replaces the copy
    print(f"{lang}: copied {pdf.name} to the project folder")


if __name__ == "__main__":
    args = sys.argv[1:]
    pdf_wanted = "--html" not in args
    for code in [a for a in args if not a.startswith("--")] or ["tr", "en"]:
        build(code, pdf_wanted)
