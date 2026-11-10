#!/bin/bash
# 在一个全新的临时 Zotero 配置里加载插件源码目录并跑自测，不碰你自己的文献库。
# 用法：test/run-selftest.sh [临时目录]
# 第一阶段测各项功能，然后退出；第二阶段用同一个配置重新启动，测分屏能不能从会话里恢复。
# 结果：<临时目录>/report1.json、report2.json 和几张截图。会弹出 Zotero 窗口，跑完自己关掉。
set -euo pipefail

PLUGIN_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/split-reader-test.XXXXXX")}
ROOT=$(cd "$ROOT" && pwd)
ZOTERO=/Applications/Zotero.app/Contents/MacOS/zotero
PLUGIN_ID=split-reader@naasi-lf.local

rm -rf "$ROOT/profile" "$ROOT/data" "$ROOT"/report*.json "$ROOT"/*.png
mkdir -p "$ROOT/profile/extensions" "$ROOT/data" "$ROOT/pdfs"

# 三个测试 PDF
python3 -I - "$ROOT/pdfs" <<'PY'
import sys, os
out = sys.argv[1]
def make_pdf(path, title, pages):
    objs = [None, None, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for p in range(pages):
        text = f"BT /F1 28 Tf 72 700 Td ({title} - page {p + 1}) Tj ET".encode()
        objs.append(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
        content_id = len(objs)
        objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R "
                    b"/Resources << /Font << /F1 3 0 R >> >> >>" % content_id)
        kids.append(len(objs))
    objs[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    data = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(data))
        data += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(data)
    data += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    data += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    data += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    with open(path, "wb") as f:
        f.write(data)
make_pdf(os.path.join(out, "original.pdf"), "Original paper", 3)
make_pdf(os.path.join(out, "zh_translation.pdf"), "Translation", 3)
make_pdf(os.path.join(out, "other.pdf"), "Another paper", 2)
PY

# 用代理文件让临时配置直接加载源码目录
echo "$PLUGIN_DIR/" > "$ROOT/profile/extensions/$PLUGIN_ID"

cat > "$ROOT/profile/prefs.js" <<EOF
user_pref("extensions.zotero.dataDir", "$ROOT/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("intl.locale.requested", "zh-CN");
user_pref("extensions.splitreader.selftest", true);
user_pref("extensions.splitreader.selftestRoot", "$ROOT");
user_pref("extensions.splitreader.selftestPDFs", "$ROOT/pdfs/original.pdf|$ROOT/pdfs/zh_translation.pdf|$ROOT/pdfs/other.pdf");
user_pref("extensions.splitreader.selftestQuit", true);
user_pref("extensions.splitreader.selftestPhase", 1);
EOF

run_phase() {
  local phase=$1
  "$ZOTERO" -profile "$ROOT/profile" -no-remote -purgecaches -ZoteroDebugText > "$ROOT/zotero$phase.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 240); do
    [ -f "$ROOT/report$phase.json" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  # 等它自己正常退出（第一阶段要把会话写盘）
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
}

run_phase 1
echo 'user_pref("extensions.splitreader.selftestPhase", 2);' >> "$ROOT/profile/prefs.js"
run_phase 2

echo "临时目录：$ROOT"
for phase in 1 2; do
  if [ -f "$ROOT/report$phase.json" ]; then
    echo "== 第 $phase 阶段"
    cat "$ROOT/report$phase.json"
  else
    echo "第 $phase 阶段没有生成报告，看 $ROOT/zotero$phase.log"
    exit 1
  fi
done
