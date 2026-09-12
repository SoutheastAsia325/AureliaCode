/**
 * `segment` — 把「把 tool_calls 写进正文」的非规范流，还原成规范的
 * text / tool-call 块序列。
 *
 * 背景（为什么需要它）：DSH 的 `StreamChunk` 是判别联合，文本与工具调用是
 * 两类并列的块，且 `BlockAssembler` **按 index 顺序装配、块一经 `block-end`
 * 关闭便不再接受该 index 的 delta**。因此清洗不能事后改字段——必须由一个
 * 掌握整条流序的组件，在流中途就把「伪装的文本」重写成 tool-call 块，并
 * 自行发号 index。本模块就是那个组件。
 *
 * 覆盖的畸形形态（Agnes 类网关常见）：
 *   1. 正文里直接写 JSON：        {"name":"bash","arguments":{...}}
 *   2. OpenAI 信封：              {"tool_calls":[{"id":..,"type":"function",..}]}
 *   3. 函数信封：                 {"function":{"name":..,"arguments":"{..}"}}
 *   4. Markdown 围栏包裹：        围栏 json ... 围栏 / 多重围栏嵌套
 *   5. tool_call 类标签包裹：      <tool_call>...</tool_call>
 *   6. 混合：说明文字 + 上述任一 + 更多说明文字（说明文字保留为 text）
 *
 * 设计约束：
 *   - 流式安全：不得对未完结的 JSON 下结论。缓冲区里若出现「疑似开头但
 *     尚未闭合」的候选，一律继续等待，绝不提前 emit。
 *   - 绝不丢正文：任何无法解析为工具调用的片段，原样回落到 text。
 *   - 纯函数：不碰网络、不碰时钟，便于单元测试穷举。
 *
 * @module dsh-llm-agnes/segment
 */
/** 一个提取出的工具调用；arguments 始终是 JSON 字符串（DSH 契约）。 */
export interface ExtractedToolCall {
    /** 模型给出的 id；缺失时由调用方生成（此处留空）。 */
    id?: string;
    name: string;
    /** 标准 JSON 字符串。 */
    arguments: string;
}
/** 一段输出：要么是可视文本，要么是一组工具调用。 */
export type Segment = {
    kind: 'text';
    text: string;
} | {
    kind: 'tool-calls';
    calls: ExtractedToolCall[];
};
/**
 * 从任意 JSON 值里抽出工具调用列表。容忍三种信封与裸形态。
 *
 * @param value - JSON.parse 之后的值。
 * @returns 抽出的调用；空数组表示「这个 JSON 不是工具调用」。
 */
/**
 * 旁证：该位置附近是否有「工具调用语境」标记（标签或围栏）。
 *
 * 为什么需要旁证而不是直接放宽判据：模型把调用写进正文时**绝大多数不给
 * `id`**（实测形态 `{"name":"bash","arguments":{...}}`），所以「必须带 id」
 * 太严；但把判据放宽成「有 name + arguments 就算」，又会把
 * `{"name":"line","arguments":"x"}` 这类普通数据误判成调用。两者都不对，
 * 正解是**引入独立证据**：周围有明确调用标记时才算数。
 *
 * @param text - 完整文本。
 * @param pos - 候选对象在文本中的起点。
 * @returns 是否有语境标记。
 */
export declare function hasCallContext(text: string, pos: number): boolean;
/**
 * 从任意 JSON 值里抽出工具调用列表。容忍三种信封与裸形态。
 *
 * @param value - JSON.parse 之后的值。
 * @param opts - 可选：`relaxedBare` 允许无 id 的裸 `{name, arguments}` 形态。
 * @returns 抽出的调用；空数组表示「这个 JSON 不是工具调用」。
 */
export declare function callsFromJsonRelaxed(value: unknown, relaxedBare: boolean): ExtractedToolCall[];
export declare function callsFromJson(value: unknown): ExtractedToolCall[];
/**
 * 把模型给出的参数规范成 JSON 字符串。
 *
 * OpenAI 契约里 arguments 是字符串；但不少网关直接给对象，或给一个被双重
 * 编码的字符串。三种都收敛成「可被 JSON.parse 的字符串」。
 *
 * @param raw - 任意形态的参数值。
 * @returns 标准 JSON 字符串。
 */
export declare function normalizeArgs(raw: unknown): string;
/** 候选片段：一个可能的 JSON 对象及其在文本中的区间。 */
interface Candidate {
    start: number;
    end: number;
    value: unknown;
}
/**
 * 扫描文本，找出所有**已完整闭合**的顶层 JSON 对象。
 *
 * 用括号配对而非正则：正则无法正确处理嵌套与字符串内的花括号（工具参数里
 * 恰恰常有花括号）。同时正确处理字符串字面量与转义。
 *
 * @param text - 待扫描文本。
 * @param from - 起始下标。
 * @returns 完整候选，按出现顺序；以及最后一个未闭合候选的起点（若有）。
 */
export declare function scanJsonObjects(text: string, from?: number): {
    candidates: Candidate[];
    pendingStart: number;
};
/**
 * 在固定偏移处尝试读出一个完整的顶层 JSON 对象。
 *
 * 与 {@link scanJsonObjects} 的区别：后者负责「找」，本函数负责「判」——
 * 分段器必须逐个检查缓冲区里的每一个 `{`，而不能跳过任何一个，否则会把
 * 工具调用当成普通文本提前下发。
 *
 * @param text - 待检文本。
 * @param start - 已知是 `{` 的偏移。
 * @returns 完整候选；未闭合或 JSON 非法时返回 undefined。
 */
export declare function candidateAt(text: string, start: number): {
    start: number;
    end: number;
    value: unknown;
} | undefined;
/**
 * 剥掉片段两侧的围栏与标签噪声。
 *
 * @param text - 原始片段（工具调用 JSON 之外的残余文本）。
 * @returns 清理后的文本；仅剩噪声时为空串。
 */
export declare function stripNoise(text: string): string;
/**
 * 把一个**已完结**的文本块切成规范片段序列。
 *
 * @param text - 完整文本（流已结束或块已闭合）。
 * @returns 片段序列；纯文本时返回单个 text 片段。
 */
export declare function segmentComplete(text: string): Segment[];
/**
 * 流式分段器：累积 delta，判定「是否可以安全地在当前位置切分」。
 *
 * 用法：对每个 text-delta 调 push，把 takeSettled 返回的稳定前缀立即下发
 * （保打字机效果）；流结束时调 finish 取残余并按片段类型分别 emit。
 *
 * 折中逻辑：只在「已完整闭合且确认是工具调用的 JSON」处才认定需要改写；
 * 未闭合候选一律继续缓冲；无花括号的纯文本整体视为稳定，可即刻下发。
 */
export declare class StreamSegmenter {
    private buffer;
    private settled;
    /** 追加一个 delta。 */
    push(delta: string): void;
    /** 当前缓冲区内容（调试/测试用）。 */
    get pending(): string;
    /** 可安全提前下发的稳定前缀。 */
    takeSettled(): string;
    /**
     * 收尾：把残余缓冲区整体切分。
     *
     * @returns 最终片段序列。
     */
    finish(): Segment[];
    /**
     * 重算稳定前缀 —— 只认「深度 0 处闭合的最外层对象」。
     *
     * 算法：从缓冲区起点推进，维护花括号深度与字符串状态。
     *   - 记录 depth 从 0 变 1 的位置（一个顶层对象的起点）；
     *   - 每次 depth 回到 0，就把 [起点, 当前位置] 取出尝试 JSON.parse：
     *       · 解析成功且是工具调用 → 稳定前缀截止到起点，交给中间件改写；
     *       · 解析成功但不是调用 → 放行到当前位置之后，继续推进；
     *       · 解析失败 → 也放行（它是普通文本里的花括号，不是调用）；
     *   - 扫到末尾仍有未闭合的顶层对象 → 稳定前缀截止到该起点。
     *
     * 为什么必须只认最外层：曾经用「任意配对成功的花括号」判定，结果工具调用
     * 参数里的嵌套对象 `{"cmd":"ls"}` 先闭合、被当成非调用而放行，外层真正的
     * 调用对象反而因「起点已在稳定区」被整段当文本透传——调用直接丢失。
     *
     * 代价与收益：含花括号的普通文本会多等一个闭合括号才下发；不含花括号的
     * 纯文本依旧即时下发，打字机效果不受影响。这是正确的取舍——宁可晚一点，
     * 不可漏判。
     */
    private recomputeSettled;
}
/**
 * 判断一段文本里是否含**疑似**工具调用（快速路径用）。
 *
 * @param text - 待检文本。
 * @returns 是否值得进一步解析。
 */
export declare function looksLikeToolCall(text: string): boolean;
export {};
