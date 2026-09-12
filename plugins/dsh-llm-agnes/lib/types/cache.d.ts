/**
 * `cache` — 需求②：前缀缓存对齐。
 *
 * 目标：让**逐字节可变的部分**不被混进稳定前缀。一旦 system 提示词里混入
 * 时间戳、随机 id、未排序的键序，前缀缓存命中率会崩塌，首字延迟随之上升。
 *
 * 那为什么不能简单地「每轮比对 system 哈希」？因为 loop 构建的请求其 system
 * 槽本身就会随工作区目录树、上下文用量等**合法地**演进——变了不等于出错。
 * 所以本模块不去禁止变化，而是做两件真正有用的事：
 *
 * 1. **规范序列化（canonical serialization）**：把工具定义按名排序、键序稳定
 *    地序列化。这是本适配层唯一能自主保证的「序」的来源。
 * 2. **漂移检测（drift detection）**：对稳定部分取指纹，只在**意外**漂移时
 *    报诊断——例如同一会话内工具集无理由地改变。检测结果进诊断日志，不阻断
 *    请求（自动化优先：宁可记录也不打断用户）。
 *
 * @module dsh-llm-agnes/cache
 */
/** 稳定前缀的指纹快照。 */
export interface PrefixFingerprint {
    /** 稳定部分的 sha256（十六进制）。 */
    hash: string;
    /** 工具名有序列表。 */
    toolNames: string[];
    /** 参与计算的总字节数（便于判断前缀规模）。 */
    bytes: number;
}
/** 最小化的请求视图。 */
export interface CacheRequest {
    system?: string;
    messages?: ReadonlyArray<{
        role?: string;
        content?: unknown;
    }>;
    tools?: unknown;
}
/**
 * 递归规范化任意值为「键序稳定」的形态。
 *
 * @param value - 任意 JSON 值。
 * @returns 键按字典序排列的等价结构。
 */
export declare function canonicalize(value: unknown): unknown;
/**
 * 确定性 JSON 序列化：键序稳定、无多余空白。
 *
 * @param value - 任意 JSON 值。
 * @returns 稳定字符串。
 */
export declare function stableStringify(value: unknown): string;
/**
 * 取请求里的「稳定前缀」文本。
 *
 * 稳定部分 = system 槽 + 工具定义。会话消息不进前缀计算，因为它们本来就会
 * 随对话增长（比对它们只会产生无意义噪声）。
 *
 * @param request - 请求视图。
 * @returns 稳定前缀文本。
 */
export declare function stablePrefixText(request: CacheRequest): string;
/**
 * 计算稳定前缀指纹。
 *
 * @param request - 请求视图。
 * @returns 指纹快照。
 */
export declare function fingerprint(request: CacheRequest): PrefixFingerprint;
/** 漂移判定结果。 */
export interface DriftReport {
    /** 是否检测到漂移。 */
    drifted: boolean;
    /** 稳定前缀是否为首次观测（首次不算漂移）。 */
    first: boolean;
    /** 人类可读的漂移说明。 */
    detail?: string;
}
/**
 * 会话级前缀漂移检测器。
 *
 * 只在**同一会话**内比对：跨会话前缀本就不同，比对无意义。
 *
 * @param options - 可选项。
 * @returns 检测器实例。
 */
export declare function createDriftDetector(options?: {
    maxSessions?: number;
}): {
    observe: (sessionKey: string, request: CacheRequest) => DriftReport;
    size: () => number;
};
