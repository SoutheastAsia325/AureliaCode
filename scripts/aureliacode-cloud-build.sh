#!/data/data/com.dsharnessmobile.shell/files/usr/bin/bash
# aureliacode-cloud-build.sh — AureliaCode 云端构建一键流水线。
#
# 为什么要有它：本沙箱**没有 Java SDK 与 Android SDK**，本地编译 APK 必然
# 失败（红线）。因此打包只能在 GitHub Actions 上做。本脚本把「推送源码 →
# 触发 workflow → 等待 → 取回 APK」压成一条命令，把人工步骤降到只剩「创建
# 空仓库」与「设置 Token」两件无法自动化的事。
#
# 用法（Token 只从环境变量读，绝不落盘、绝不回显）：
#   export GITHUB_TOKEN=<你的 token>
#   bash scripts/aureliacode-cloud-build.sh <owner/repo> [abi]
#
#   abi 取值 arm64 | x86_64 | both，默认 arm64（本机与绝大多数真机都是 arm64）。
#
# 依赖：git、curl、python3（均已在沙箱就绪）。不依赖 gh CLI。
set -uo pipefail

REPO="${1:-}"
ABI="${2:-arm64}"

if [ -z "$REPO" ]; then
  echo "用法: GITHUB_TOKEN=<token> bash $0 <owner/repo> [arm64|x86_64|both]" >&2
  exit 2
fi
case "$ABI" in arm64|x86_64|both) ;; *) echo "abi 只能是 arm64/x86_64/both" >&2; exit 2;; esac

# ── 凭据门禁：只认环境变量，且只在内存中使用 ──────────────────────────────
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "错误：未设置 GITHUB_TOKEN。" >&2
  echo "请先 export GITHUB_TOKEN=<token>（本脚本不会把它写进任何文件或日志）。" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then echo "当前处于游离 HEAD，无法推送" >&2; exit 2; fi
SHA="$(git rev-parse --short HEAD)"

echo "== AureliaCode 云端构建 =="
echo "  仓库   : $REPO"
echo "  分支   : $BRANCH"
echo "  提交   : $SHA"
echo "  ABI    : $ABI"
echo

# ── 1. 推送源码 ───────────────────────────────────────────────────────────
# 凭据通过 askpass 临时注入（进程级环境变量），不写入 .git/config，
# 也不出现在命令行参数里 —— 因此不会留痕在 ps 输出或 git 配置中。
ASKPASS="$(mktemp "${TMPDIR:-/tmp}/ac-askpass-XXXXXX")"
chmod 700 "$ASKPASS"
cat > "$ASKPASS" <<'ASKEOF'
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$GITHUB_TOKEN" ;;
  *) echo "" ;;
esac
ASKEOF
cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT

echo "-- 1/4 推送源码"
if ! GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 \
     git push "https://github.com/${REPO}.git" "HEAD:refs/heads/${BRANCH}" --force-with-lease 2>&1 | sed "s|${GITHUB_TOKEN}|***|g"; then
  echo "推送失败。常见原因：" >&2
  echo "  · 仓库不存在（请先在 GitHub 上创建空的 $REPO）" >&2
  echo "  · Token 无 repo 写权限，或已过期" >&2
  echo "  · 分支保护规则拒绝 force-with-lease（首次推送可加 --force）" >&2
  exit 1
fi

# ── 2. 触发 workflow ─────────────────────────────────────────────────────
echo "-- 2/4 触发 build-apk workflow"
API="https://api.github.com/repos/${REPO}/actions/workflows/build-apk.yml/dispatches"
DISPATCH_BODY="$(python3 -c "
import json,sys
print(json.dumps({'ref': sys.argv[1], 'inputs': {'abi': sys.argv[2], 'suffix': ''}}))
" "$BRANCH" "$ABI")"

HTTP_CODE="$(curl -sS -o /tmp/ac-dispatch.out -w '%{http_code}' \
  -X POST "$API" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "$DISPATCH_BODY" 2>/dev/null)"

if [ "$HTTP_CODE" != "204" ]; then
  echo "触发失败（HTTP $HTTP_CODE）：" >&2
  sed "s|${GITHUB_TOKEN}|***|g" /tmp/ac-dispatch.out >&2
  echo >&2
  echo "若为 404：该仓库没有 .github/workflows/build-apk.yml（请确认推送成功）。" >&2
  echo "若为 403：Token 缺少 Actions 写权限（需 repo + workflow 权限）。" >&2
  exit 1
fi
echo "   已触发"

# ── 3. 等待运行完成 ──────────────────────────────────────────────────────
echo "-- 3/4 等待构建（最长 90 分钟；可用 Ctrl-C 中断，构建仍在云端继续）"
RUN_ID=""
for _ in $(seq 1 60); do
  sleep 5
  RUN_ID="$(curl -sS \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/actions/workflows/build-apk.yml/runs?event=workflow_dispatch&per_page=5" \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for r in d.get('workflow_runs', []):
    if r.get('head_sha','').startswith('$SHA'):
        print(r['id']); break
")"
  [ -n "$RUN_ID" ] && break
done

if [ -z "$RUN_ID" ]; then
  echo "未能定位本次运行（可能排队中）。请到以下地址查看：" >&2
  echo "  https://github.com/${REPO}/actions" >&2
  exit 1
fi
echo "   运行 ID: $RUN_ID"
echo "   页面   : https://github.com/${REPO}/actions/runs/${RUN_ID}"

for _ in $(seq 1 540); do
  sleep 10
  STATUS_JSON="$(curl -sS \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}")"
  read -r STATUS CONCLUSION <<<"$(python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('status',''), d.get('conclusion') or '')
" <<<"$STATUS_JSON")"
  case "$STATUS" in
    completed)
      echo "   构建结束: $CONCLUSION"
      if [ "$CONCLUSION" != "success" ]; then
        echo "构建未成功。日志见上面的运行页面。" >&2
        exit 1
      fi
      break
      ;;
    *) printf '\r   状态: %s        ' "$STATUS" ;;
  esac
done

if [ "$STATUS" != "completed" ]; then
  echo "等待超时。构建可能仍在进行，请到运行页面查看。" >&2
  exit 1
fi

# ── 4. 取回 APK ─────────────────────────────────────────────────────────
echo
echo "-- 4/4 下载产物"
OUT_DIR="$ROOT/out/aureliacode"
mkdir -p "$OUT_DIR"
ARTIFACTS="$(curl -sS \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/artifacts")"

COUNT=0
while IFS= read -r line; do
  NAME="${line%%|*}"; URL="${line#*|}"
  [ -z "$URL" ] && continue
  ZIP="$OUT_DIR/${NAME}.zip"
  echo "   下载 $NAME"
  if curl -sSL -H "Authorization: Bearer ${GITHUB_TOKEN}" -o "$ZIP" "$URL"; then
    (cd "$OUT_DIR" && unzip -oq "$ZIP" 2>/dev/null) || echo "     (解压失败，zip 已保留: $ZIP)"
    COUNT=$((COUNT + 1))
  fi
done <<<"$(python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d.get('artifacts', []):
    if not a.get('expired'):
        print(str(a['name']) + '|' + str(a['archive_download_url']))
" <<<"$ARTIFACTS")"

if [ "$COUNT" -eq 0 ]; then
  echo "未取到产物（可能已过期或命名为空）。请到运行页面手动下载。" >&2
  exit 1
fi

echo
echo "== 完成 =="
find "$OUT_DIR" -name "*.apk" -exec ls -lh {} \; 2>/dev/null | sed 's/^/  /'
echo "  APK 目录: $OUT_DIR"
echo
echo "安装（真机 arm64）: adb install -r -t \"$OUT_DIR/<文件名>.apk\""
