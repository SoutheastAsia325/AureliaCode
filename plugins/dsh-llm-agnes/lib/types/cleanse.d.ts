/**
 * `cleanse` — 需求①：强制格式清洗（流式中间件）。
 *
 * 挂在 `llm/stream` waterfall 上，包住下游适配器返回的 chunk 流，把
 * 「tool_calls 被写进正文」的非规范输出重写成规范的 `tool-call` 块。
 *
 * ## 设计（第二版，明确取代早期实现）
 *
 * 早期实现试图「流式透传文本 + 遇调用再改写」，结果反复出错：一旦前面已经
 * 把某段文本当正文下发，后面才发现它其实是工具调用，就再也追不回来。文本
 * 与调用的判定本质上需要**看到完整对象**才能下结论，所以正确做法是：
 *
 *   **按 index 缓冲文本 delta，在块闭合（或流结束）时做一次确定性的定型。**
 *
 * 纯文本（不含花括号）依旧随到随发——那是绝大多数情况，打字机效果不受影响；
 * 只有出现 `{` 的那个块才会被缓冲到闭合为止。这是「正确性优先、且尽可能少
 * 牺牲流式感」的折中。
 *
 * ## 为什么自己发号 index
 *
 * `BlockAssembler` 按 index 顺序装配，一个 index 一经 `block-end` 关闭，其后
 * 的 delta 就被忽略。所以「一个 text 块被拆成文本 + 调用」时，新块必须拿全
 * 新的 index，且立即闭合。
 *
 * ## 不变量（有测试守住）
 *
 * 1. 无花括号的纯文本流：输出与未挂载本中间件时**逐字节一致**。
 * 2. 任何情况下都不得丢正文：判不出调用的内容一律回落为文本。
 * 3. 同一个 index 不得既发文本又发调用。
 *
 * @module dsh-llm-agnes/cleanse
 */
/** 与引擎 dsh-llm 的 StreamChunk 对齐的最小结构（只声明本模块读写的字段）。 */
interface Chunk {
    type: string;
    index: number;
    blockType?: string;
    text?: string;
    id?: string;
    name?: string;
    argumentsDelta?: string;
    block?: {
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        arguments?: string;
    };
    [key: string]: unknown;
}
/** 清洗统计——用于诊断与自检（自动化优先：可观测才好排查）。 */
export interface CleanseStats {
    /** 处理过的流数量。 */
    streams: number;
    /** 被改写为工具调用的次数。 */
    rewritten: number;
    /** 命中的畸形形态计数（按形态分类）。 */
    detected: Record<string, number>;
}
/** 创建一份统计表。 */
export declare function createStats(): CleanseStats;
/**
 * 从异步 chunk 流中清洗格式。
 *
 * @param source - 下游适配器产出的 chunk 流。
 * @param stats - 可选统计表（会被原地累加）。
 * @returns 清洗后的 chunk 流。
 */
export declare function cleanseStream(source: AsyncIterable<unknown>, stats?: CleanseStats): AsyncIterable<Chunk>;
export {};
