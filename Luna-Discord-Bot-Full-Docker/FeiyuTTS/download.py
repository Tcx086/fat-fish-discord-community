"""Pinned public snapshot; bounded ranged downloads survive stalled large transfers."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.request

MODEL = "Esmerubphire/FeiyuVoice-CosyVoice3"
REVISION = "f37e9d1dda26e8b45b4e9f1b4c347c0a07b797e2"


def digest(path, algorithm="sha256"):
    with path.open("rb") as f:
        return hashlib.file_digest(f, algorithm).hexdigest()


def download(destination):
    if os.environ.get("ALLOW_EXTERNAL_ASSETS") != "true":
        raise PermissionError("External assets require rights review and explicit ALLOW_EXTERNAL_ASSETS=true")
    root = Path(destination).resolve()
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{MODEL}/revision/{REVISION}?blobs=true", timeout=30) as r:
        metadata = json.load(r)
    assert metadata["sha"] == REVISION
    assert sum(x["size"] for x in metadata["siblings"]) < 8_000_000_000
    for item in metadata["siblings"]:
        target = (root / item["rfilename"]).resolve()
        assert target.is_relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        expected = item.get("lfs", {}).get("sha256")
        size = item["size"]
        if target.exists() and target.stat().st_size == size and (not expected or digest(target) == expected):
            continue
        url = f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{item['rfilename']}"
        temporary = target.with_name(target.name + ".download")
        if expected and size > 32 * 1024 * 1024:
            parts = root / ".parts" / expected
            parts.mkdir(parents=True, exist_ok=True)
            ranges = [(start, min(start + 32 * 1024 * 1024, size) - 1) for start in range(0, size, 32 * 1024 * 1024)]
            def fetch(bounds):
                first, last = bounds
                path = parts / str(first)
                if path.exists() and path.stat().st_size == last - first + 1:
                    return path
                for attempt in range(3):
                    try:
                        request = urllib.request.Request(url + f"?segment={first}&attempt={attempt}",
                            headers={"Range": f"bytes={first}-{last}"})
                        with urllib.request.urlopen(request, timeout=40) as r, path.open("wb") as out:
                            assert r.headers.get("Content-Range") == f"bytes {first}-{last}/{size}"
                            shutil.copyfileobj(r, out, 1024 * 1024)
                        assert path.stat().st_size == last - first + 1
                        return path
                    except Exception:
                        if attempt == 2:
                            raise
                        time.sleep(1)
            with ThreadPoolExecutor(max_workers=4) as pool:
                paths = list(pool.map(fetch, ranges))
            with temporary.open("wb") as out:
                for part in paths:
                    with part.open("rb") as source:
                        shutil.copyfileobj(source, out)
        else:
            with urllib.request.urlopen(url, timeout=40) as r, temporary.open("wb") as out:
                shutil.copyfileobj(r, out)
        assert temporary.stat().st_size == size
        if expected:
            assert digest(temporary) == expected, target.name
        temporary.replace(target)
        if expected and size > 32 * 1024 * 1024:
            for part in paths:
                part.unlink()
            parts.rmdir()
        print(f"Verified {item['rfilename']}: {size} bytes", flush=True)
    (root / "download-snapshot.json").write_text(json.dumps(metadata, indent=2))
    # The publisher's checks include source, configuration, licenses and references.
    for filename, spec in json.loads((root / "files_sha256.json").read_text()).items():
        path = (root / filename).resolve()
        assert path.is_relative_to(root)
        assert path.stat().st_size == spec["bytes"] and digest(path) == spec["sha256"], filename
    print("ALL PUBLISHER CHECKSUMS VERIFIED", flush=True)


if __name__ == "__main__":
    download(sys.argv[1])
