"""Statically extract release samples on Linux; never execute their contents."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request


SAMPLES = {
    "0.9.1": "893438647667a4f6aeb2929897a0131dd95e5c0686ec2958e5968cdb75f3496b",
    "0.9.2": "fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb",
}


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


output = Path("defender-components")
output.mkdir()
manifest = []
with tempfile.TemporaryDirectory(prefix="synara-defender-") as temporary:
    for version, expected in SAMPLES.items():
        root = Path(temporary) / version
        root.mkdir()
        installer = root / "installer.exe"
        urllib.request.urlretrieve(
            f"https://github.com/Emanuele-web04/synara/releases/download/v{version}/Synara-{version}-x64.exe",
            installer,
        )
        if digest(installer) != expected:
            raise RuntimeError(f"Installer hash mismatch: {version}")
        nsis = root / "nsis"
        payload = root / "payload"
        subprocess.run(["7z", "x", str(installer), f"-o{nsis}", "-y"], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["7z", "x", str(nsis / "$PLUGINSDIR/app-64.7z"), f"-o{payload}", "-y"], check=True, stdout=subprocess.DEVNULL)
        for source in sorted(root.rglob("*")):
            if not source.is_file() or source == installer:
                continue
            if source.suffix.lower() not in {".exe", ".dll", ".node", ".asar", ".7z"}:
                continue
            relative = source.relative_to(root)
            target = output / version / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            manifest.append({"version": version, "path": relative.as_posix(), "sha256": digest(source), "bytes": source.stat().st_size})
        if version == "0.9.2":
            shutil.copytree(payload, "defender-full-payload")
(output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
