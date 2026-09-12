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
import { type CleanseStats } from './cleanse.js';
export declare const name = "dsh-llm-agnes";
/** 本插件只读设置与日志接缝；不需要 tools/llm 也能工作（降级即静默旁路）。 */
export declare const inject: string[];
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
export declare function apply(ctx: {
    settings: {
        register: (ns: string, schema: unknown) => {
            (): unknown;
        } & Record<string, unknown>;
    };
    logger?: (...args: unknown[]) => unknown;
    get?: (key: string) => unknown;
    waterfall?: (event: string, ...args: unknown[]) => unknown;
    on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
}): void;
export { cleanseStream } from './cleanse.js';
export { applyConstraint, constraintPreview, TOOL_CONSTRAINT, hasTools } from './constraint.js';
export { createDriftDetector, fingerprint, stableStringify, canonicalize } from './cache.js';
export { callsFromJson, normalizeArgs, scanJsonObjects, segmentComplete, stripNoise, StreamSegmenter, looksLikeToolCall, } from './segment.js';
