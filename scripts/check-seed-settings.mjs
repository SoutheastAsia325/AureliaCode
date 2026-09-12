#!/usr/bin/env node
/**
 * check-seed-settings.mjs — 出厂设置的**构建期门禁**。
 *
 * 为什么需要它（真实事故）：出厂设置 scripts/snapshot-config/seed-settings.yaml 由构建链
 * 逐字写入快照的 home/.dsh/settings.yaml。我曾给其中自定义供应商路由写了 `models: []`
 * （空列表），而引擎的 provider 校验里有一条：
 *
 *     const entries = configured.length > 0 ? configured : [...defaults.values()]...
 *     if (entries.length === 0) invalid(provider, "resolves no models; ...")
 *
 * 并且 `invalid()` 直接 throw、该分支**不受 strict/deferred 门控**。后果不是
 * 「没有模型可选」，而是新装设备一启动就 llm-pi-ai 插件加载失败 →
 * **整个引擎启动失败**（用户实测「一直启动失败」，引擎日志尾部只剩崩溃堆栈）。
 *
 * 教训：出厂配置是**运行时输入**，必须拿**引擎自己的校验器**验，不能靠人读文档。
 * 因此本脚本不复制引擎的校验规则（那会再次退化成「我的假设 vs 引擎的实现」），
 * 而是直接调用引擎里那份真实代码。
 *
 * 用法：
 *   node scripts/check-seed-settings.mjs <dsh 引擎 node_modules 目录>
 * 例：
 *   node scripts/check-seed-settings.mjs \
 *     .deploy-tmp/snapshot-013/arm64/stage/root/usr/lib/node_modules/@deepseek-ai/dsh/node_modules
 *
 * 退出码：0 = 引擎接受该出厂设置；1 = 被引擎拒绝（拒绝构建）或无法验证（同样拒绝，
 * 因为「验不了」不等于「没问题」）。
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SEED = join(ROOT, 'scripts', 'snapshot-config', 'seed-settings.yaml')

const engineNm = process.argv[2]
if (!engineNm) {
  console.error('用法: node scripts/check-seed-settings.mjs <dsh 引擎 node_modules 目录>')
  process.exit(2)
}
if (!existsSync(engineNm)) {
  console.error(`✗ 引擎 node_modules 目录不存在: ${engineNm}`)
  console.error('  （无法验证出厂设置 = 拒绝构建，因为「验不了」不等于「没问题」）')
  process.exit(1)
}

/** 在若干候选位置查找 @deepseek-ai/dsh-llm-pi-ai。 */
function findPiAi(base) {
  return [
    join(base, '@deepseek-ai', 'dsh-llm-pi-ai'),
    join(base, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'),
  ].find((p) => existsSync(join(p, 'lib', 'index.js')))
}

const piAi = findPiAi(engineNm)
if (!piAi) {
  console.error(`✗ 在 ${engineNm} 下找不到 @deepseek-ai/dsh-llm-pi-ai`)
  process.exit(1)
}

// 目录布局（刻意如此，保证**绝不写入引擎树**）：
//   <work>/patch/node_modules                  -> 软链到引擎 node_modules（供解析依赖）
//   <work>/patch/entry/@deepseek-ai/dsh-llm-pi-ai/  <- 该包的副本（在此追加导出）
// 副本放在软链**之外**：若把副本放进那个 node_modules 里，就会与软链冲突
// （EEXIST），且更糟的是会写进引擎树。副本解析依赖时向上走到
// <work>/patch/node_modules，与线上解析链一致。
const work = join(tmpdir(), 'aureliacode-seed-check-' + process.pid)
try {
  const patchRoot = join(work, 'patch')
  const pkgDir = join(patchRoot, 'entry', '@deepseek-ai', 'dsh-llm-pi-ai')
  mkdirSync(pkgDir, { recursive: true })
  symlinkSync(engineNm, join(patchRoot, 'node_modules'))
  cpSync(join(piAi, 'lib'), join(pkgDir, 'lib'), { recursive: true })
  cpSync(join(piAi, 'package.json'), join(pkgDir, 'package.json'))

  const entry = join(pkgDir, 'lib', 'index.js')
  const original = readFileSync(entry, 'utf8')
  // 引擎只导出 7 个符号，resolveProfiles 是内部函数：追加一行导出即可调用真实实现。
  const withExport = /export\s*\{[^}]*\};?/.test(original)
    ? original.replace(/export\s*\{([^}]*)\};?/, (m, names) => `export {${names}, resolveProfiles };`)
    : original + '\nexport { resolveProfiles };\n'
  if (withExport === original) {
    console.error('✗ 无法在该包上追加 resolveProfiles 导出 —— 引擎打包形式可能已变化，请更新本门禁')
    process.exit(1)
  }
  writeFileSync(entry, withExport)

  const mod = await import(pathToFileURL(entry).href)
  if (typeof mod.resolveProfiles !== 'function') {
    console.error('✗ 取不到 resolveProfiles —— 引擎内部结构可能已变化，请更新本门禁')
    process.exit(1)
  }

  // YAML 解析器要从**引擎树**里解析：本脚本位于工作区，那里没有 node_modules，
  // 直接 import 'yaml' 会 ERR_MODULE_NOT_FOUND。用 createRequire 以引擎树为基准。
  const req = createRequire(join(engineNm, 'noop.js'))
  let YAML = null
  for (const name of ['yaml', 'js-yaml']) {
    try { YAML = req(name); break } catch { /* 试下一个 */ }
  }
  if (!YAML || typeof (YAML.parse || YAML.load) !== 'function') {
    console.error('✗ 无法在引擎树中解析 YAML 库（yaml / js-yaml）—— 无法验证，拒绝构建')
    process.exit(1)
  }
  const parseYaml = YAML.parse ? (t) => YAML.parse(t) : (t) => YAML.load(t)
  const cfg = parseYaml(readFileSync(SEED, 'utf8'))
  const providers = (cfg['llm-pi-ai'] || {}).providers

  console.log(`出厂设置: ${SEED}`)
  console.log(`providers: ${JSON.stringify(providers ?? {})}`)
  try {
    const m = mod.resolveProfiles(providers, 'strict')
    console.log(`✓ 引擎接受该出厂设置（strict 通过，路由数=${m.size}）`)
    process.exit(0)
  } catch (e) {
    console.error('✗ 引擎拒绝了该出厂设置 —— 拒绝构建')
    console.error(`  ${e.name}: ${e.message}`)
    console.error('')
    console.error('修复方向：不在引擎内置目录里的自定义供应商路由，必须至少声明一个模型条目。')
    console.error('注意 `models: []` 空列表会抛错，且该分支不受 strict/deferred 门控。')
    process.exit(1)
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
