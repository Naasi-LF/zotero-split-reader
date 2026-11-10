#!/bin/bash
# 打包成 build/split-reader-<版本>.xpi（不含 test/、docs/），同时生成 Zotero 自动更新用的 build/updates.json。
# 发布时把这两个文件都上传到 GitHub Release，tag 用 v<版本>。
set -euo pipefail
cd "$(dirname "$0")"
read -r ID VERSION MIN_VERSION < <(python3 -I -c '
import json
m = json.load(open("manifest.json"))
z = m["applications"]["zotero"]
print(z["id"], m["version"], z["strict_min_version"])')
REPO=https://github.com/Naasi-LF/zotero-split-reader
mkdir -p build
OUT="build/split-reader-$VERSION.xpi"
rm -f "$OUT"
zip -q -r -X "$OUT" manifest.json bootstrap.js content locale
python3 -I - "$ID" "$VERSION" "$MIN_VERSION" "$REPO" > build/updates.json <<'PY'
import json, sys
addon_id, version, min_version, repo = sys.argv[1:5]
print(json.dumps({"addons": {addon_id: {"updates": [{
    "version": version,
    "update_link": f"{repo}/releases/download/v{version}/split-reader-{version}.xpi",
    "applications": {"zotero": {"strict_min_version": min_version}}
}]}}}, indent=2))
PY
echo "$OUT"
echo "build/updates.json"
