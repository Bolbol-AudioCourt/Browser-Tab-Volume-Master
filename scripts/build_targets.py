#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
FILES_TO_COPY = ['popup', 'content', 'README.md']
TARGETS = {
    'firefox': ROOT / 'manifest.json',
    'chrome': ROOT / 'manifest.chrome.json',
}

for target, manifest_path in TARGETS.items():
    target_dir = DIST / target
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    for name in FILES_TO_COPY:
        source = ROOT / name
        destination = target_dir / name
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)

    manifest = json.loads(manifest_path.read_text())
    (target_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Built {target} -> {target_dir}')
