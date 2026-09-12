#!/usr/bin/env bash
# materialize-base-lfs.sh — 在 CI 内把 base/*.tar.xz 的 LFS 指针实体化。
#
# 为什么需要它：本项目是**派生仓库**，推送时 Git LFS 对象并不会随普通 git 对象
# 一起转移 —— 新仓库的 LFS 存储是空的，因此 `actions/checkout` 的 `lfs: true`
# 会在 "Fetching LFS objects" 直接失败（本项目首次云端构建即栽在这里，两个 ABI
# 的 job 都在检出步骤就 red，后续全部 skipped）。
#
# 为什么不把归档直接提交进 git：三个归档合计 186 MB，而 GitHub 对单个文件有
# 100 MB 硬限（base-usr-x86_64 已 77 MB），且二进制入库会让仓库体积翻倍。
#
# 因此采取的方案：**从上游 LFS 拉取 + 按指针元数据严格校验 sha256**。
# 校验通过才落盘，绝不把「看起来下载完了」的坏文件交给构建链。
#
# 上游 = kelai141/dsh-mobile-apk（public，MIT）。这是构建期的一次性取用，
# 不改变本仓库任何源码内容。

set -uo pipefail

BASE_DIR="${1:-base}"
UPSTREAM="${UPSTREAM_LFS_REPO:-kelai141/dsh-mobile-apk}"
LFS_ENDPOINT="https://github.com/${UPSTREAM}.git/info/lfs"

if [ ! -d "$BASE_DIR" ]; then
  echo "错误：目录不存在 $BASE_DIR" >&2
  exit 2
fi

# 需要实体化的指针。
#
# 判定用**正向特征**：真实 .tar.xz 的魔数是 0xFD 0x37 0x7A 0x58 0x5A 0x00
# （".7zXZ\0"）。凡不以该魔数开头的，就是待实体化的东西。
#
# 为什么不用「匹配 LFS 指针文本」的反向判定：早先版本写的是
# `head -c 20 | grep -q "version https://git-lfs"` —— 而
# "version https://git-lfs" 恰好 22 字节，被 head 截到 20 字节后是
# "version https://git-lf"，永远匹配不上，于是脚本误报「无需实体化」，
# 把未实体化的指针留给了构建链（云端实证：xz 报 File format not recognized）。
# 正向魔数判定没有这类长度陷阱。
XZ_MAGIC_HEX="fd377a585a00"
FILES=()
for f in "$BASE_DIR"/*.tar.xz; do
  [ -f "$f" ] || continue
  magic="$(head -c 6 "$f" | od -An -tx1 | tr -d ' \n')"
  if [ "$magic" != "$XZ_MAGIC_HEX" ]; then
    FILES+=("$f")
  fi
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "无需实体化：$BASE_DIR/*.tar.xz 已是真实归档（没有 LFS 指针）"
  exit 0
fi

echo "需要实体化的 LFS 指针：${#FILES[@]} 个"

fail=0
for f in "${FILES[@]}"; do
  oid="$(grep -oP 'oid sha256:\K\w+' "$f" | head -1)"
  size="$(grep -oP 'size \K\d+' "$f" | head -1)"
  name="$(basename "$f")"

  if [ -z "$oid" ] || [ -z "$size" ]; then
    echo "  ✗ $name：指针缺少 oid/size，无法实体化" >&2
    fail=1
    continue
  fi

  echo "  · $name（sha256 ${oid:0:12}…, ${size} 字节）"

  # LFS 批量 API：只申请下载地址，不直接取内容（便于带重试）
  href=""
  for attempt in 1 2 3 4 5; do
    href="$(curl -sS --max-time 60 -X POST "${LFS_ENDPOINT}/objects/batch" \
      -H "Accept: application/vnd.git-lfs+json" \
      -H "Content-Type: application/vnd.git-lfs+json" \
      -d "{\"operation\":\"download\",\"transfers\":[\"basic\"],\"objects\":[{\"oid\":\"${oid}\",\"size\":${size}}]}" \
      2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
objs=d.get('objects') or []
if not objs: sys.exit(0)
act=(objs[0].get('actions') or {}).get('download') or {}
print(act.get('href',''))
")"
    [ -n "$href" ] && break
    echo "    批量请求第 $attempt 次未取得地址，重试…"
    sleep 5
  done

  if [ -z "$href" ]; then
    echo "    ✗ 无法取得下载地址（上游 LFS 不可达或对象已过期）" >&2
    fail=1
    continue
  fi

  # 下载到临时文件后校验，再原子替换 —— 校验不过绝不落盘
  tmp="${f}.download"
  ok=0
  for attempt in 1 2 3 4 5; do
    if curl -sSL --max-time 1800 --retry 5 --retry-all-errors --retry-delay 5 \
         -o "$tmp" "$href" 2>/dev/null; then
      actual="$(sha256sum "$tmp" | awk '{print $1}')"
      actual_size="$(wc -c < "$tmp" | tr -d ' ')"
      if [ "$actual" = "$oid" ] && [ "$actual_size" = "$size" ]; then
        ok=1
        break
      fi
      echo "    第 $attempt 次校验不符（size ${actual_size}/${size}），重试…"
    else
      echo "    第 $attempt 次下载失败，重试…"
    fi
    sleep 5
  done

  if [ "$ok" != "1" ]; then
    echo "    ✗ $name 下载或校验失败，已放弃" >&2
    rm -f "$tmp"
    fail=1
    continue
  fi

  mv -f "$tmp" "$f"
  chmod 644 "$f"
  echo "    ✓ 已实体化并通过 sha256 校验"
done

if [ "$fail" != "0" ]; then
  echo "实体化未全部成功 —— 拒绝继续构建（宁可不构建，也不拿坏底座打包）" >&2
  exit 1
fi

echo "全部底座归档已就绪"
ls -lh "$BASE_DIR"/*.tar.xz
