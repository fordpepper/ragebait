"""Split model files over GitHub's 100 MB limit into 90 MB parts and list them in parts.json.
The site's worker (site/worker.js) streams the parts back together in the browser.

usage: python3 split.py ../site/models/gus
"""
import sys, json, pathlib
root = pathlib.Path(sys.argv[1]); LIMIT = 90 * 1024 * 1024
manifest = {}
for f in sorted(root.rglob("*")):
    if not f.is_file() or ".part" in f.name or f.stat().st_size <= LIMIT: continue
    rel = f.relative_to(root).as_posix(); files = []
    with f.open("rb") as src:
        i = 0
        while chunk := src.read(LIMIT):
            part = f.with_name(f"{f.name}.part{i:02d}"); part.write_bytes(chunk)
            files.append(part.relative_to(root).as_posix()); i += 1
    manifest[rel] = {"size": f.stat().st_size, "files": files}
    f.unlink()
    print(rel, "->", len(files), "parts")
(root / "parts.json").write_text(json.dumps(manifest, indent=1))
