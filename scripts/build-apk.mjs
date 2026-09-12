// build-apk.mjs — 跨平台 APK 编排（复用已平台化的 gate 脚本；Windows 走 WSL、Linux 原生）
//
// 对应本地 scripts/build-apk-013.ps1（PowerShell + wsl，仅 Windows）。本脚本是「可移植版」：
// 在云端的 GHA ubuntu（原生 Linux）跑，也可在本地 Windows 跑（gate 脚本自带平台感知）。
// 共享的 gate/注入脚本（inject-snapshot.py / check-third-party.mjs / check-snapshot-secrets.mjs /
// elf-check.mjs / check-patch-mounts.mjs / patch-marketplace.mjs / patch-undo-mobile.mjs）均为跨平台。
//
// 用法：node scripts/build-apk.mjs --abi arm64|x86_64 [--suffix "-v3"] [--snapshot <snap.tar.xz>] [--skip-inject]
// 依赖：node、python 在 PATH；dsh-mobile-apk/ 子仓库在 ROOT；vendor/{dsh-undo-savepoint,dshmarketplace-plugin} 在场。
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, existsSync, rmSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// apk 仓库目录：默认 ROOT/dsh-mobile-apk（本仓库布局）；云端 workflow 宿主若=apk 仓库（GITHUB_WORKSPACE），
// 用 DSH_APK_DIR 覆盖（此时 ROOT 指向作为依赖签出的协调库子目录）。
const apkDir = process.env.DSH_APK_DIR || join(ROOT, 'dsh-mobile-apk')
const OUT = join(ROOT, 'out', 'aureliacode')
const SUFFIX_DEFAULT = '-ci'
/**
 * 版本号单一来源 = app/build.gradle.kts 的 versionName。
 *
 * 为什么从 gradle 读而不是在这里写字面量：产物名若与实际版本号各说各话，
 * 下载页上就会出现「文件名说 v0.13.0、装上去是 1.0.0」这种误导。上游此处
 * 硬编码 '0.13.0'，版本一升就漂移，故本项目改为读源码。
 */
const VER = (() => {
  try {
    const g = readFileSync(join(apkDir, 'app', 'build.gradle.kts'), 'utf8')
    const m = /versionName\s*=\s*"([^"]+)"/.exec(g)
    if (m) return m[1]
  } catch {
    // gradle 文件读不到时退回占位，不阻断构建
  }
  return '0.0.0-unknown'
})()

// ---- 参数解析 ----
const args = process.argv.slice(2)
function opt(name, def) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] ?? def) : def
}
const ABI = opt('abi', 'arm64')
const SUFFIX = opt('suffix', SUFFIX_DEFAULT)
const SKIP_INJECT = args.includes('--skip-inject')
const SNAP = opt('snapshot', '')

if (!['arm64', 'x86_64'].includes(ABI)) { console.error(`未知 ABI: ${ABI}`); process.exit(2) }

const pluginDirs = [
  join(ROOT, 'dsh-shell-termux'),
  join(ROOT, 'dsh-client-ui-responsive'),
  join(ROOT, 'dsh-host-web-compat'),
  join(ROOT, 'plugins', 'dsh-android-bridge'),
  join(ROOT, 'plugins', 'dsh-android-manage'),
  join(ROOT, 'plugins', 'dsh-android-linux-env'),
  join(ROOT, 'plugins', 'dsh-android-file-open'),
  join(ROOT, 'plugins', 'dsh-llm-agnes'),
]
const undo = join(ROOT, 'vendor', 'dsh-undo-savepoint')
const market = join(ROOT, 'vendor', 'dshmarketplace-plugin')
const modelSync = join(ROOT, 'vendor', 'dsh-model-sync') // 0.13.3 W7：@aiwayds/dsh-model-sync 0.3.1 固化副本
const work = join(ROOT, '.deploy-tmp', `build-${ABI}`)
const snapSrc = SNAP || join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')

function log(m) { console.log(`[build-apk/${ABI}] ${m}`) }
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} 失败 (${r.status})`)
  return r
}
function requires(name, p) { if (!existsSync(p)) { console.error(`缺 ${name}: ${p}`); process.exit(2) } }

try {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(work, { recursive: true })

  // ---- 0. 前置：基座/插件/vendor 在场 ----
  requires('snapshot 源', snapSrc)
  pluginDirs.forEach((p) => requires('插件', p))
  requires('vendor undo', join(undo, 'package.json'))
  requires('vendor market', join(market, 'package.json'))
  requires('vendor model-sync', join(modelSync, 'lib', 'index.js'))

  let snapIn
  if (!SKIP_INJECT) {
    // ---- 1. 插件注入链（python，跨平台）----
    // 统一补丁门禁（Phase 2a）：undo E1-E7 + marketplace A-D 幂等施加与校验（registry.json）
    run('node', [join(ROOT, 'scripts', 'patches', 'apply-patches.mjs'), join(ROOT, 'vendor')])
    log('单 pass 注入（@dsh-android + undo/market + 权威 patch）…')
    run('python', [join(ROOT, 'scripts', 'inject-all.py'), snapSrc, join(work, 'snap-final2.tar.xz'), join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'), '--dsh-android', ...pluginDirs, '--external', undo, market, modelSync])
    snapIn = join(work, 'snap-final2.tar.xz')
  } else {
    snapIn = snapSrc
  }

  // ---- 2. 门禁（全部跨平台脚本）----
  log('门禁：patch 挂载集校验…')
  run('node', [join(ROOT, 'scripts', 'check-patch-mounts.mjs'), join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'), ...pluginDirs, undo, market, modelSync])
  log('门禁：第三方许可…')
  run('node', [join(ROOT, 'scripts', 'check-third-party.mjs'), 'x', '--tar', snapIn])
  log('门禁：机密…')
  run('node', [join(ROOT, 'scripts', 'check-snapshot-secrets.mjs'), snapIn])
  log('门禁：ELF 架构…')
  run('node', [join(ROOT, 'scripts', 'elf-check.mjs'), snapIn, ABI])

  // ---- 3. 许可资产（LICENSES + notices -> APK assets/licenses）----
  const licAssets = join(apkDir, 'app', 'src', 'main', 'assets', 'licenses')
  mkdirSync(licAssets, { recursive: true })
  for (const f of readdirSync(join(ROOT, 'LICENSES'))) if (f.endsWith('.txt')) copyFileSync(join(ROOT, 'LICENSES', f), join(licAssets, f))
  copyFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(licAssets, 'THIRD_PARTY_NOTICES.md'))
  log('许可资产就位')

  // ---- 4. 快照 + 指纹写入 assets（防增量叠加缓存：先清 intermediates/输出）----
  rmSync(join(apkDir, 'app', 'build', 'intermediates', 'assets'), { recursive: true, force: true })
  rmSync(join(apkDir, 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true, force: true })
  copyFileSync(snapIn, join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz'))
  const sha = createHash('sha256').update(readFileSync(snapIn)).digest('hex')
  writeFileSync(join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.sha256'), sha, 'ascii')
  log(`snapshot.sha256 = ${sha}`)

  // ---- 5. gradle assembleDebug（跨平台 gradlew）----
  log('构建 APK…')
  const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const gr = spawnSync(gradleCmd, [':app:assembleDebug', '--no-daemon', `-PversionNameSuffix=${SUFFIX}`], { cwd: apkDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (gr.status !== 0) { console.error(`gradle 失败 (${gr.status})`); process.exit(1) }

  // ---- 6. 产物拷贝 ----
  const name = `aureliacode-v${VER}${SUFFIX}-${ABI}.apk`
  copyFileSync(join(apkDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), join(OUT, name))
  log(`产物: ${join(OUT, name)}`)
  console.log(`=== 完成（${ABI} ${SUFFIX}）===\nAPK=${join(OUT, name)}`)
} catch (e) {
  console.error(`[build-apk/${ABI}] ${e.message}`)
  process.exit(1)
}
