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
import { segmentComplete, stripNoise } from './segment.js';
/** 创建一份统计表。 */
export function createStats() {
    return { streams: 0, rewritten: 0, detected: {} };
}
/**
 * 生成调用 id。
 *
 * 为什么可以随机：id 只进 `tool_calls[].id`，不进系统前缀，因此不影响前缀
 * 缓存命中率；而它必须在会话日志里唯一。
 *
 * @param n - 序号，保证同一流内不重复。
 * @returns 调用 id。
 */
function makeCallId(n) {
    return 'agnes-' + n.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
/** 形态分类（用于 stats.detected 与调试日志）。 */
function classify(text) {
    const hasFence = text.includes('```');
    const hasTag = /<\/?(tool_call|tool_calls|function_call)>/.test(text);
    if (hasFence && hasTag)
        return 'fence+tag';
    if (hasFence)
        return 'fence';
    if (hasTag)
        return 'tag';
    try {
        const segments = segmentComplete(text);
        const call = segments.find((s) => s.kind === 'tool-calls');
        if (call !== undefined)
            return 'embedded-json';
    }
    catch {
        // 分类失败不影响清洗
    }
    return 'unknown';
}
/**
 * 从异步 chunk 流中清洗格式。
 *
 * @param source - 下游适配器产出的 chunk 流。
 * @param stats - 可选统计表（会被原地累加）。
 * @returns 清洗后的 chunk 流。
 */
export async function* cleanseStream(source, stats) {
    /** 下一个可用的块 index（只增不减，绝不复用已发布的 index）。 */
    let nextIndex = 0;
    const bump = (i) => {
        if (i >= nextIndex)
            nextIndex = i + 1;
    };
    /** 每个 index 的已知块类型。 */
    const blockTypeOf = new Map();
    /**
     * 待定的文本块：已见 block-start，但首个 delta 还没到，尚不知是否含花括号。
     *
     * 为什么必须待定 —— 这一点由引擎实测确立，不是推测：文本块只要对 engine
     * 暴露过一次（block-start 或 text-delta），它就进入装配序；此后若该块被判
     * 定为「调用 + 文本」的混排而改用新 index，engine 侧必然留下一个空文本块。
     * 用真实 `BlockAssembler` 实测三种形态：
     *   · start 无 end      → `[{text:""}, {tool-call}]`   ← 脏
     *   · 空文本块闭合       → `[{text:""}, {tool-call}]`   ← 脏
     *   · 该 index 不出现    → `[{tool-call}]`              ← 干净
     * 故：含花括号的块一律**不发布其原 index**。
     */
    const undecided = new Set();
    /** 已确认含花括号、正在缓冲的文本块。 */
    const buffers = new Map();
    /** 已流式下发过 delta 的 index。 */
    const streamedDeltas = new Set();
    /** 本次流已生成的调用数。 */
    let callSeq = 0;
    if (stats)
        stats.streams += 1;
    /** 发出一个规范化的工具调用块（用新 index）。 */
    function* emitToolCall(call) {
        const idx = nextIndex;
        bump(idx);
        const id = call.id !== undefined && call.id.length > 0 ? call.id : makeCallId(callSeq++);
        yield { type: 'block-start', index: idx, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: idx, id, name: call.name, argumentsDelta: call.arguments };
        yield {
            type: 'block-end',
            index: idx,
            block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
        };
        if (stats)
            stats.rewritten += 1;
    }
    /** 发出一个文本块（显式 start/delta/end）；空文本不发块。 */
    function* emitText(text) {
        if (text.length === 0)
            return;
        const idx = nextIndex;
        bump(idx);
        yield { type: 'block-start', index: idx, blockType: 'text' };
        yield { type: 'text-delta', index: idx, text };
        yield { type: 'block-end', index: idx, block: { type: 'text', text } };
    }
    /** 按片段序列发出。 */
    function* emitSegments(segments) {
        for (const seg of segments) {
            if (seg.kind === 'text')
                yield* emitText(seg.text);
            else
                for (const call of seg.calls)
                    yield* emitToolCall(call);
        }
    }
    for await (const raw of source) {
        const chunk = raw;
        if (chunk === null || typeof chunk !== 'object' || typeof chunk.type !== 'string') {
            yield chunk;
            continue;
        }
        switch (chunk.type) {
            case 'block-start': {
                bump(chunk.index);
                if (typeof chunk.blockType === 'string')
                    blockTypeOf.set(chunk.index, chunk.blockType);
                if (chunk.blockType === 'text') {
                    // 文本块转待定：start 暂不发布（见 undecided 说明）
                    undecided.add(chunk.index);
                    break;
                }
                yield chunk;
                break;
            }
            case 'text-delta': {
                bump(chunk.index);
                const piece = typeof chunk.text === 'string' ? chunk.text : '';
                const buffered = buffers.get(chunk.index) ?? '';
                const hasBrace = buffered.length > 0 || piece.includes('{') || piece.includes('}');
                if (hasBrace) {
                    // 含花括号：转缓冲，等块闭合后一次性定型（可能含工具调用）
                    undecided.delete(chunk.index);
                    buffers.set(chunk.index, buffered + piece);
                    break;
                }
                // 纯净文本：确认无花括号 → 发布 start（若尚未发布）并流式透传
                if (undecided.delete(chunk.index)) {
                    yield { type: 'block-start', index: chunk.index, blockType: 'text' };
                }
                streamedDeltas.add(chunk.index);
                yield chunk;
                break;
            }
            case 'block-end': {
                bump(chunk.index);
                const startedType = blockTypeOf.get(chunk.index);
                blockTypeOf.delete(chunk.index);
                const buffered = buffers.get(chunk.index);
                buffers.delete(chunk.index);
                const wasStreamed = streamedDeltas.delete(chunk.index);
                const wasUndecided = undecided.delete(chunk.index);
                const ownType = typeof chunk.block?.type === 'string' ? chunk.block.type : undefined;
                const bt = ownType ?? startedType;
                const rawText = typeof chunk.block?.text === 'string' ? chunk.block.text : '';
                if (bt === 'text') {
                    const fullText = rawText.length > 0 ? rawText : (buffered ?? '');
                    if (buffered !== undefined || !wasStreamed) {
                        // 尚未流式下发过 → 一次性定型（含调用则改写）
                        const segments = segmentComplete(fullText);
                        const hasCall = segments.some((sn) => sn.kind === 'tool-calls');
                        if (hasCall) {
                            if (stats) {
                                const kind = classify(fullText);
                                stats.detected[kind] = (stats.detected[kind] ?? 0) + 1;
                            }
                            yield* emitSegments(segments);
                            break;
                        }
                        // 无调用：发布完整文本块（若 start 还被待定着，emitText 会带 start）
                        const text = segments.map((sn) => (sn.kind === 'text' ? sn.text : '')).join('');
                        if (wasUndecided) {
                            yield* emitText(text);
                        }
                        else {
                            if (text.length > 0)
                                yield { type: 'text-delta', index: chunk.index, text };
                            yield { ...chunk, block: { ...(chunk.block ?? {}), type: 'text', text } };
                        }
                        break;
                    }
                    // 已经流式透传过纯净文本：原样关闭
                    yield { ...chunk, block: { ...(chunk.block ?? {}), type: 'text', text: fullText } };
                    break;
                }
                // 非文本块：缓冲若有内容（异常情形）先补发，再原样透传
                if (buffered !== undefined && buffered.length > 0) {
                    yield { type: 'text-delta', index: chunk.index, text: stripNoise(buffered) };
                }
                yield chunk;
                break;
            }
            case 'finish': {
                // 流结束仍未闭合的缓冲：定型补发，绝不丢内容
                for (const [idx, text] of buffers) {
                    const segments = segmentComplete(text);
                    const hasCall = segments.some((sn) => sn.kind === 'tool-calls');
                    if (hasCall) {
                        if (stats) {
                            const kind = classify(text);
                            stats.detected[kind] = (stats.detected[kind] ?? 0) + 1;
                        }
                        yield* emitSegments(segments);
                    }
                    else {
                        const cleaned = segments.map((sn) => (sn.kind === 'text' ? sn.text : '')).join('');
                        if (cleaned.length > 0)
                            yield { type: 'text-delta', index: idx, text: cleaned };
                    }
                }
                buffers.clear();
                // 始终没有 delta 的待定文本块：不发布任何 chunk（该 index 干脆不出现）
                undecided.clear();
                yield chunk;
                break;
            }
            default:
                yield chunk;
                break;
        }
    }
}
