"""Assemble the static GitHub Pages site into ``_site/``.

    python web/build.py                # from the repo root
    python -m http.server -d _site     # → http://127.0.0.1:8000/

Copies the hand-written client in ``web/`` and packs the canonical
engine (``research/megagem/``) plus ``research/saved_best_weights/*.json``
into ``_site/megagem.zip``, which the Pyodide worker unpacks in the
browser. ``__MEGAGEM_BUILD__`` in any copied .html/.js file is replaced
with a content hash so browsers pick up new engine/weights builds.

Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import shutil
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web"
RESEARCH = REPO / "research"

SITE_FILES = ("*.html", "*.css", "*.js", "*.svg", "*.json")


def build_zip() -> bytes:
    buf = io.BytesIO()
    entries: list[tuple[str, Path]] = []
    for path in sorted((RESEARCH / "megagem").rglob("*.py")):
        entries.append((path.relative_to(RESEARCH).as_posix(), path))
    for path in sorted((RESEARCH / "saved_best_weights").glob("*.json")):
        entries.append((path.relative_to(RESEARCH).as_posix(), path))
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, path in entries:
            # Fixed timestamp → byte-identical zip (and hash) for identical inputs.
            info = zipfile.ZipInfo(arcname, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, path.read_bytes())
    return buf.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=REPO / "_site")
    args = parser.parse_args()
    out: Path = args.out

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    archive = build_zip()
    (out / "megagem.zip").write_bytes(archive)

    sources = sorted({p for pattern in SITE_FILES for p in WEB.glob(pattern)})
    digest = hashlib.sha256(archive)
    for path in sources:
        digest.update(path.read_bytes())
    build_id = digest.hexdigest()[:12]

    for path in sources:
        if path.suffix in (".html", ".js"):
            text = path.read_text().replace("__MEGAGEM_BUILD__", build_id)
            (out / path.name).write_text(text)
        else:
            shutil.copy2(path, out / path.name)
    # GitHub Pages: serve files as-is, no Jekyll processing.
    (out / ".nojekyll").write_text("")

    print(f"Built {out} (build {build_id}, {len(archive) // 1024} KiB engine zip, "
          f"{len(sources)} web files)")


if __name__ == "__main__":
    main()
