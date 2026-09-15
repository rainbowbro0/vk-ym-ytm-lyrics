from pathlib import Path
import json, shutil, zipfile

ROOT = Path(__file__).resolve().parent
PROJECTS = ["vk-lyrics", "ym-lyrics", "yt-music-lyrics"]
TARGETS = ["chromium", "firefox"]

for project in PROJECTS:
    base = ROOT / project
    src = base / "src"
    dist = base / "dist"
    for target in TARGETS:
        out = dist / target
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        manifest = base / f"manifest.{target}.json"
        shutil.copy2(manifest, out / "manifest.json")
        for item in src.iterdir():
            dest = out / item.name
            if item.is_dir():
                shutil.copytree(item, dest)
            else:
                shutil.copy2(item, dest)
        with open(out / "manifest.json", encoding="utf-8") as f:
            json.load(f)
    print(f"Built {project}")
