# AureliaCode

> **Agnes 深度定制的安卓端 AI 编码助手**（独立软件，包名 `com.southeast.aureliacode`）

AureliaCode 是一个**完整独立**的安卓应用：装完即用，内嵌运行时与编码 Agent 引擎，
不需要 Termux、不需要 ROOT、不需要电脑配合。它把模型能力接在 **Agnes** 上，并针对
Agnes 在通用 Harness 环境里「工具调用格式不稳、执行卡顿」的问题做了专门的适配层。

派生自开源项目 [`kelai141/dsh-mobile-apk`](https://github.com/kelai141/dsh-mobile-apk)（MIT），
在其基础上做去标识化与引擎适配改造。上游署名与许可证完整保留（见 [License](#license)）。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [Agnes 适配层（本项目核心）](#agnes-适配层本项目核心)
- [功能](#功能)
- [安装](#安装)
- [首次配置 Agnes](#首次配置-agnes)
- [从源码构建](#从源码构建)
- [架构](#架构)
- [权限](#权限)
- [许可证与署名](#许可证与署名)

---

## 它解决什么问题

Agnes 的原生输出与 Harness 期待的严格结构化工具调用之间存在三类偏差，直接表现为
「模型说要调用工具，但工具没被执行」或「回复卡住不动」：

| 偏差 | 现象 | AureliaCode 的应对 |
|---|---|---|
| 把 `tool_calls` 写进正文文本 | 工具调用完全不执行，正文里出现一串 JSON | **强制格式清洗**：流式识别并改写为规范调用块 |
| 提示词前缀不稳定 | 前缀缓存命中率低，首字延迟高 | **前缀缓存对齐**：稳定序列化 + 漂移监测 |
| 格式约束不明确 | 时好时坏，同一问题两次结果不同 | **强制工具调用约束**：系统槽注入硬性格式规则 |

## Agnes 适配层（本项目核心）

实现位于 `plugins/dsh-llm-agnes`。**三项能力全部挂在引擎既有的公开接缝
（`llm/stream` waterfall）上，不修改引擎源码、不注册 provider 插件**——因此你在
设置页手动配置的任意 Agnes 路由都会自动被覆盖，无需为换 endpoint 重新打包。

### ① 强制格式清洗

覆盖六类实际会遇到的畸形形态：

```
裸 JSON            {"name":"bash","arguments":{"cmd":"ls"}}
OpenAI 信封        {"tool_calls":[{"id":..,"type":"function","function":{..}}]}
function 信封      {"function":{"name":..,"arguments":"{..}"}}
Markdown 围栏      ```json ... ```
调用标签           <tool_call>...</tool_call>
混合              说明文字 + 调用 + 说明文字（文字完整保留）
```

实现要点：

- **用括号配对解析，不用正则**。工具参数里常有嵌套对象与字符串内的花括号，正则处理不了。
- **流式安全**。含花括号的文本块不会提前发布——必须等对象闭合才能判定它是正文还是调用，
  否则会漏判。不含花括号的普通回答依旧即时上屏，打字机效果不受影响。
- **绝不丢内容**。任何判不出调用的片段一律回落为正文。
- **判据三重收紧以免误报**（每条都有回归测试）：裸形态必须同时具备 `id` 与 `arguments`；
  `function` 信封必须有 `id`/`type`/`index` 佐证；无 `id` 的裸形态只在**旁证**成立时接受
  （处于调用标签/围栏语境，或两个候选彼此紧邻——真实数据几乎不会长成这样）。

判定用「块形态规则」是拿引擎真实的 `BlockAssembler` 实测确立的：含花括号的块其原
index 必须**完全不出现**，否则消息里会多出一个空文本块。

### ② 前缀缓存对齐

- 工具定义与系统槽做**规范化序列化**（键序稳定、无随机量），保证前缀逐字节一致。
- **会话级漂移检测**：前缀指纹变化时可指名是哪几个工具增删、字节数怎么变。
- 设计取舍：会话推进会让系统槽合法演进（工作区目录树、上下文用量），所以「变了」
  不等于「出错」——因此检测**只记诊断日志、绝不阻断请求**。

### ③ 强制工具调用约束

向**系统槽**（而非最后一条消息）注入硬性格式规则，要求调用时 `content` 为空、
`tool_calls` 必须含完整的 `id`/`type`/`function.name`/`function.arguments`。
只在请求确实携带工具时注入（避免诱导模型凭空调用），且幂等（不会重复追加）。
注入文本是定值，因此不损害前缀缓存。

---

## 功能

- **完整编码 Agent**：文件读写编辑、Shell 执行、文件与网页检索、Skills、计划模式、
  目标、子代理（subagent）、工作流编排。
- **内嵌运行时**：自带 bash / node 与工具链快照，首次启动自动解压，不依赖 Termux App。
- **流式渲染**：Markdown、代码高亮、打字机效果；**思考过程单独成块**，不与正文混排。
- **会话与工作区**：多会话历史、工作区文件树、`@` 引用文件、附件与图片输入。
- **手机端设备控制**（可选）：无障碍通道或 ADB 通道，让 AI 能读取界面语义并操作控件、
  截图。需显式授权，且会话须处于「完全访问」档位。
- **快照与回滚**：运行时快照事务化替换（暂存 → 原子交换 → 提交），中断可自动恢复；
  配置快照支持撤销/回退。
- **深色移动端 UI**：为竖屏窄幅优化，含悬浮球、抽屉式侧栏、安全区处理。

## 安装

从本仓库的 [Releases](https://github.com/) 下载对应架构的 APK：

| 设备 | 选择 |
|---|---|
| 绝大多数现代安卓手机（arm64） | `arm64` 产物 |
| 模拟器 / x86 平板（MuMu、WSA 等） | `x86_64` 产物 |

> **架构选错会崩溃**。debug 签名产物默认按 ABI 命名，真机请只用 `arm64`。
> 应用为 debug 签名，首次安装需允许「安装未知应用」。

最低要求：Android 8.0（API 26）。目标 API 34（为保留应用私有目录内的原生程序执行能力，
刻意不追到 35+）。

## 首次配置 Agnes

Agnes 的接入参数（endpoint / 模型 ID / Key）是**运行时信息**，不硬编码在代码里，
也不会由构建链写死——换 endpoint 不需要重新打包。出厂已预置好 `agnes` 供应商骨架，
你只需在应用内完成三步：

1. 打开**设置 → 模型**，找到 `Agnes` 供应商。
2. 把 `baseURL` 换成你的 Agnes endpoint，在 `models` 里填上模型 ID。
3. 填入 API Key。

出厂预置内容（`scripts/snapshot-config/seed-settings.yaml`，构建时逐字写入快照）：

```yaml
llm-pi-ai:
  providers:
    agnes:
      displayName: Agnes
      api: openai-completions          # Agnes 若为自有协议，改这里
      baseURL: https://REPLACE-WITH-YOUR-AGNES-ENDPOINT/v1
      apiKeyEnv: AGNES_API_KEY
      models: []                       # 自定义路由需在此声明模型
```

> `baseURL` 保持占位符时请求会失败并指向该占位符——这样一眼能看出「还没配置」，
> 而不是误以为网络故障。

## 从源码构建

### 云端构建（推荐，也是本项目唯一验证过的路径）

本仓库的 APK **必须走 GitHub Actions 构建**。仓库自带一键流水线：推送源码 →
触发 workflow → 轮询 → 下载 APK。

```bash
export GITHUB_TOKEN=<你的 token>          # 需要 repo + workflow 权限
bash scripts/aureliacode-cloud-build.sh <owner/repo> arm64
```

产物落在 `out/aureliacode/`。Token 只从环境变量读取，经临时 `GIT_ASKPASS` 注入，
不写入 `.git/config`、不进命令行参数、日志脱敏、退出即清理。

### 手动触发

在 GitHub 仓库页面进入 **Actions → build-apk → Run workflow**，选择 ABI 后运行。

### 本地构建（不推荐）

本地构建需要 JDK 17、Android SDK（compileSdk 36）、Node 24、Python 3，以及
**Git LFS**（`base/*.tar.xz` 是 LFS 对象）。构建链会从 npm 拉取引擎包并重建
Termux 运行时快照，因此需要稳定网络。

```bash
git lfs pull
node scripts/build-snapshot-013.mjs arm64      # 重建运行时快照
node scripts/build-apk.mjs --abi arm64         # 注入插件 → 门禁 → gradle
```

构建链带门禁（补丁挂载、机密扫描、第三方许可、ELF 检查等），门禁不过即拒绝打包。

### 测试 Agnes 适配层

```bash
cd plugins/dsh-llm-agnes
npm install && npm test
```

42 个单元测试覆盖分段解析、格式清洗、约束注入与缓存指纹，全部可离线运行。

## 架构

```
AureliaCode/
├── app/                          安卓壳（Kotlin）：WebView、前台服务、看门狗、
│                                 快照解压事务、SAF 桥、设备控制、悬浮球
├── plugins/
│   ├── dsh-llm-agnes/            ★ Agnes 适配层（本项目核心，TypeScript）
│   ├── dsh-android-bridge/       引擎 ↔ 安卓桥
│   ├── dsh-android-manage/       设备管理工具
│   ├── dsh-android-linux-env/    写面栅栏与共享目录
│   ├── dsh-android-file-open/    系统「打开方式」
│   └── dsh-model-capability/     自定义供应商能力发现
├── dsh-shell-termux/             引擎 bash / 工具链供给
├── dsh-client-ui-responsive/     移动端 UI 适配层
├── dsh-host-web-compat/          浏览器兼容与 polyfill
├── vendor/                       外部插件（快照撤销、插件市场、模型同步）
├── scripts/                      构建链与补丁（含云端流水线）
└── base/                         Git LFS：运行时底座归档
```

运行时形态：APK 内嵌 Termux 快照（`assets/snapshot.tar.xz`），首次启动解压到应用私有
目录，引擎监听 `127.0.0.1:3080`，WebView 加载引擎自带 Web UI。引擎包在构建期从 npm
按登记表逐包覆盖（`scripts/snapshot-config/engine-overlay.json`），带 sha512 校验。

## 权限

| 权限 | 用途 |
|---|---|
| `INTERNET` | 访问模型 API |
| `FOREGROUND_SERVICE` / `POST_NOTIFICATIONS` | 引擎常驻与状态通知 |
| `RECEIVE_BOOT_COMPLETED` / `WAKE_LOCK` | 开机恢复与保持后台工作 |
| `MANAGE_EXTERNAL_STORAGE` | 读写工作区（可拒绝，功能降级） |
| `REQUEST_INSTALL_PACKAGES` | APK 自更新（出厂未配置更新源时不触发） |
| `SYSTEM_ALERT_WINDOW` | 悬浮球 |
| `BIND_ACCESSIBILITY_SERVICE` | **可选**设备控制；仅在你于系统设置中开启后生效 |
| `QUERY_ALL_PACKAGES` | 「打开方式」候选枚举 |

设备控制为**双通道**（无障碍 / ADB），需显式授权且会话处于完全访问档位；两者都不可用时
一律失败关闭，不做静默降级。

## 许可证与署名

MIT。见 [LICENSE](LICENSE)。

本项目派生自 **[kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)**
（Copyright © 2026 kelai141），保留了其全部许可证与第三方声明。上游是一个成熟的
DeepSeek Harness 安卓壳，本项目的改动集中在：

1. **去标识化**：应用名 → AureliaCode，包名 → `com.southeast.aureliacode`，
   引擎路径常量与包名对齐，版本线独立为 `1.0.0`。
2. **Agnes 适配层**：新增 `plugins/dsh-llm-agnes`（格式清洗 / 缓存对齐 / 工具约束）。
3. **出厂配置**：预置 Agnes 供应商骨架；关闭指向上游仓库的 APK 自更新。

第三方组件与 GPL 合规三形态见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与
[LICENSES/](LICENSES/)。
