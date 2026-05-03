"""One-off: fetch Google Fonts CSS, download every woff2, rewrite to local paths."""
from __future__ import annotations

import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

SOURCES = {
    "google-fonts.css": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
    "material-symbols.css": "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap",
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def main() -> None:
    counter = [0]

    def rewrite(css: str, prefix: str) -> str:
        urls = re.findall(r"url\((https://[^)]+\.woff2)\)", css)
        for u in urls:
            counter[0] += 1
            local = f"{prefix}-{counter[0]}.woff2"
            print(f"  fetch {u} -> {local}")
            data = fetch(u)
            with open(os.path.join(HERE, local), "wb") as fh:
                fh.write(data)
            css = css.replace(u, f"/fonts/{local}")
        return css

    for name, url in SOURCES.items():
        print(f"[{name}] fetching CSS from {url}")
        css = fetch(url).decode("utf-8")
        prefix = name.removesuffix(".css")
        rewritten = rewrite(css, prefix)
        out = os.path.join(HERE, name)
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(rewritten)
        print(f"  wrote {out}")


if __name__ == "__main__":
    main()
