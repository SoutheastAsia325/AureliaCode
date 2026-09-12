/**
 * dsh-llm-agnes — Agnes 适配层（AureliaCode 专用）。
 *
 * 解决「Agnes 在原始 DSH 环境里工具调用格式不稳、执行卡顿」的三件事，全部
 * 挂在引擎既有的公开接缝上，**不改引擎树**：
 *
 * | 需求 | 落地 | 接缝 |
 * |---|---|---|
 * | ① 强制格式清洗 | {@link cleanseStream} | `llm/stream` waterfall |
 * | ② 前缀缓存对齐 | {@link createDriftDetector} | 同一 waterfall 的请求侧 |
 * | ③ 强制工具调用约束 | {@link applyConstraint} | 同一 waterfall 的请求侧 |
 *
 * 为什么用 waterfall 而不是自建 provider 适配器：`llm/stream` 是引擎**原生**
 * 的模型调用拦截点（引擎内已有 8 个消费者），请求在此处尚未派发、chunk 流
 * 在此处尚未装配，因此在这里改写既不触犯「loop 请求深冻结」的约束，也天然
 * 覆盖用户手动配置的任意 Agnes 路由。
 *
 * @module dsh-llm-agnes
 */

import * as schemasteryNs from '@deepseek-ai/schemastery';

/**
 * 取 schemastery 的构造器。
 *
 * 为什么不用 default import：该包的导出形态在不同次版本间变过（default 与
 * 具名并存），default import 在纯 ESM 下拿到的可能是模块命名空间对象而非
 * 构造器。这里做一次归一，两者都认。取不到时回退到一个「声明默认值」的
 * 恒等实现——目标是**插件绝不因配置解析器不可用而装载失败**。
 */
interface SchemaLike {
  default: (v: unknown) => unknown;
}
type SchemaNode = Record<string, SchemaLike>;
interface SchemaCtor {
  object: (shape: SchemaNode) => unknown;
  boolean: () => { default: (v: unknown) => SchemaLike };
}

const z: SchemaCtor = (() => {
  const ns = schemasteryNs as unknown as { default?: unknown; object?: unknown };
  const candidate = (ns.default ?? ns) as { object?: unknown };
  if (typeof candidate?.object === 'function') return candidate as SchemaCtor;
  return {
    object: (shape: SchemaNode) => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const node = shape[key];
        out[key] = typeof node?.default === 'function' ? node.default(undefined) : undefined;
      }
      return out;
    },
    boolean: () => ({
      default: (v: unknown): SchemaLike => ({ default: () => v }),
    }),
  };
})();
import { cleanseStream, createStats, type CleanseStats } from './cleanse.js';
import { applyConstraint, constraintPreview, hasTools } from './constraint.js';
import { createDriftDetector } from './cache.js';
import { segmentComplete } from './segment.js';

export const name = 'dsh-llm-agnes';

/** 本插件只读设置与日志接缝；不需要 tools/llm 也能工作（降级即静默旁路）。 */
export const inject = ['settings', 'logger'];

/** 设置页命名空间：用户可开关三项能力。 */
const AgnesConfig = z.object({
  /** ① 流式格式清洗：把写进正文的 tool_calls 还原为规范块。 */
  formatCleanse: z.boolean().default(true),
  /** ③ 强制工具调用约束：向系统槽追加格式硬约束。 */
  injectConstraint: z.boolean().default(true),
  /** ② 前缀漂移监测：记录稳定前缀指纹的意外变化（不阻断请求）。 */
  driftMonitor: z.boolean().default(true),
  /** 调试日志：命中改写时输出形态分类，便于定位 Agnes 的具体畸形输出。 */
  debug: z.boolean().default(false),
});

/** 请求对象的最小视图（`llm/stream` 的 options）。 */
interface StreamOptions {
  provider?: string;
  model?: string;
  sessionId?: unknown;
  options?: unknown;
  system?: string;
  messages?: ReadonlyArray<{ role?: string; content?: unknown }>;
  tools?: unknown;
  [key: string]: unknown;
}

/** 插件对外暴露的诊断快照。 */
export interface AgnesDiagnostics {
  /** 累计清洗统计。 */
  stats: CleanseStats;
  /** 当前会话级漂移监测是否启用。 */
  driftMonitor: boolean;
  /** 约束正文（供设置页预览）。 */
  constraint: string;
}

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文。
 */
export function apply(ctx: {
  settings: { register: (ns: string, schema: unknown) => { (): unknown } & Record<string, unknown> };
  logger?: (...args: unknown[]) => unknown;
  get?: (key: string) => unknown;
  waterfall?: (event: string, ...args: unknown[]) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
}): void {
  const scope = ctx.settings.register('llm-agnes', AgnesConfig);
  const stats = createStats();
  const detector = createDriftDetector({ maxSessions: 64 });

  /** 诊断快照：放进 ctx 供其他插件/控制台读取。 */
  const diagnostics: AgnesDiagnostics = {
    stats,
    driftMonitor: true,
    constraint: constraintPreview(),
  };
  try {
    (ctx as unknown as { llmAgnesDiagnostics?: AgnesDiagnostics }).llmAgnesDiagnostics = diagnostics;
  } catch {
    // 只读上下文：忽略
  }

  /**
   * 中间件主体：请求侧对齐 + 响应侧清洗。
   *
   * @param options - 引擎装配好的请求。
   * @param next - 下游（真正的适配器）入口。
   * @returns 清洗后的 chunk 流。
   */
  const middleware = (
    options: StreamOptions,
    next: () => AsyncIterable<unknown>,
  ): AsyncIterable<unknown> => {
    // config 在每次调用时读取，使设置页改动即时生效（无需重启）
    const cfg = {
      formatCleanse: true,
      injectConstraint: true,
      driftMonitor: true,
      debug: false,
    };
    try {
      const raw = (scope as unknown as { (): Record<string, unknown> })();
      if (raw !== null && typeof raw === 'object') {
        for (const key of Object.keys(cfg) as Array<keyof typeof cfg>) {
          const v = raw[key];
          if (typeof v === 'boolean') cfg[key] = v;
        }
      }
    } catch {
      // 设置未就绪：用默认值继续（自动化优先：绝不因配置读取失败而中断模型调用）
    }
    diagnostics.driftMonitor = cfg.driftMonitor;

    if (options !== null && typeof options === 'object') {
      // ── 需求③：强制工具调用约束（只在有工具时注入）──
      if (cfg.injectConstraint && hasTools(options.tools)) {
        try {
          applyConstraint(options as { system?: string; messages?: ReadonlyArray<{ role?: string; content?: unknown }> });
        } catch (err) {
          if (cfg.debug) ctx.logger?.('[llm-agnes] 约束注入失败:', err);
        }
      }
      // ── 需求②：前缀漂移监测（不阻断）──
      if (cfg.driftMonitor) {
        try {
          const sessionKey =
            typeof options.sessionId === 'string' && options.sessionId.length > 0
              ? options.sessionId
              : (options.provider ?? 'unknown') + '|' + (options.model ?? 'unknown');
          const report = detector.observe(sessionKey, options);
          if (report.drifted) {
            ctx.logger?.(
              '[llm-agnes] 前缀漂移（将降低缓存命中率）: ' + (report.detail ?? '未提供细节'),
            );
          }
        } catch (err) {
          if (cfg.debug) ctx.logger?.('[llm-agnes] 漂移检测失败:', err);
        }
      }
    }

    const source = next();

    // ── 需求①：流式格式清洗 ──
    if (!cfg.formatCleanse) return source;
    return cleanseStream(source, stats);
  };

  // 挂载：优先 waterfall（引擎原生的模型调用拦截点）
  if (typeof ctx.waterfall === 'function') {
    ctx.waterfall('llm/stream', middleware as unknown as (...args: unknown[]) => unknown);
  } else if (typeof ctx.on === 'function') {
    // 降级：无 waterfall 时用 on 包装（老版本引擎）
    ctx.on('llm/stream', ((...args: unknown[]) => {
      const options = args[0] as StreamOptions;
      const next = args[1] as (() => AsyncIterable<unknown>) | undefined;
      if (typeof next !== 'function') return undefined;
      return middleware(options, next);
    }) as (...args: unknown[]) => unknown);
  }

  ctx.logger?.('[llm-agnes] Agnes 适配层已装载（清洗/约束/缓存对齐）');

  // 供测试与外部校准：暴露纯函数
  Object.assign(diagnostics as unknown as Record<string, unknown>, {
    segment: segmentComplete,
  });
}

export { cleanseStream } from './cleanse.js';
export { applyConstraint, constraintPreview, TOOL_CONSTRAINT, hasTools } from './constraint.js';
export { createDriftDetector, fingerprint, stableStringify, canonicalize } from './cache.js';
export {
  callsFromJson,
  normalizeArgs,
  scanJsonObjects,
  segmentComplete,
  stripNoise,
  StreamSegmenter,
  looksLikeToolCall,
} from './segment.js';
