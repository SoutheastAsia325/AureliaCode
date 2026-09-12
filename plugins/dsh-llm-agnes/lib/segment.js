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
/** 围栏开闭标记——剥离目标。 */
const FENCE_RE = /^```[a-zA-Z0-9_+-]*\s*$/;
const TAG_OPEN = ['<tool_call>', '<tool_calls>', '<function_call>'];
const TAG_CLOSE = ['</tool_call>', '</tool_calls>', '</function_call>'];
/**
 * 「确证的调用信封」键名：出现即认定其值是工具调用，无需再看形状。
 *
 * 注意 function_call 与 function 的区别：前者是 OpenAI 的调用信封（确证），
 * 后者只是一个字段名（普通 JSON 里随处可见），故后者必须配合 name 一起判。
 */
const ENVELOPE_KEYS = ['tool_calls', 'toolCalls', 'tool_call', 'function_call', 'functionCall'];
/**
 * 工具调用在两个协议家族里的必填字段名。
 *
 * 这是本模块**最重要的判据**。早期版本用「有 name 就算」，结果把
 * {"name":"line","arguments":"x"} 这类普通 JSON 误判成工具调用。收紧为
 * 「必须同时具备 id 与 arguments」——OpenAI 契约（id/type/function.name/
 * function.arguments）与 DeepSeek 家族（name/arguments）都满足，而普通
 * 数据对象几乎不可能同时长这样。
 */
const CALL_KEYS = ['arguments', 'input', 'parameters', 'args'];
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
export function hasCallContext(text, pos) {
    const from = Math.max(0, pos - 24);
    const before = text.slice(from, pos);
    const after = text.slice(pos, Math.min(text.length, pos + 4096));
    if (/<tool_calls?>\s*$/.test(before))
        return true;
    if (before.includes('```') && !before.slice(before.lastIndexOf('```')).includes('\n```')) {
        // 候选紧跟在围栏之后或位于未闭合的围栏内
        return true;
    }
    // 候选自身被标签包裹（闭合标签在其后不远处）
    const closeIdx = after.indexOf('</tool_call');
    if (closeIdx >= 0 && closeIdx < 512) {
        // 确认闭合标签之前没有别的东西先结束（粗略但足够）
        return true;
    }
    return false;
}
/**
 * 从任意 JSON 值里抽出工具调用列表。容忍三种信封与裸形态。
 *
 * @param value - JSON.parse 之后的值。
 * @param opts - 可选：`relaxedBare` 允许无 id 的裸 `{name, arguments}` 形态。
 * @returns 抽出的调用；空数组表示「这个 JSON 不是工具调用」。
 */
export function callsFromJsonRelaxed(value, relaxedBare) {
    return callsFromJsonInner(value, relaxedBare);
}
export function callsFromJson(value) {
    return callsFromJsonInner(value, false);
}
/**
 * 内部实现：{@link callsFromJson} 与 {@link callsFromJsonRelaxed} 共用。
 *
 * @param value - 待解析值。
 * @param relaxedBare - 是否接受「无 id 的裸 {name, arguments}」形态。
 * @returns 抽出的调用。
 */
function callsFromJsonInner(value, relaxedBare) {
    const out = [];
    /** 在对象上找参数槽；找不到返回 undefined。 */
    const argsSlotOf = (obj) => {
        for (const key of CALL_KEYS) {
            if (key in obj)
                return { key, value: obj[key] };
        }
        return undefined;
    };
    /**
     * 判定一个 {name, <args>} 形状的对象是否为工具调用。
     *
     * canonical = 自身同时具备 id 与参数槽（工具调用的标准形状）。
     * relaxed   = 外层已确证是调用信封（正在遍历信封内部的数组元素）。
     */
    const accept = (obj, relaxed) => {
        if (typeof obj['name'] !== 'string' || obj['name'].length === 0)
            return false;
        if (argsSlotOf(obj) === undefined)
            return false;
        if (relaxed || relaxedBare)
            return true;
        return typeof obj['id'] === 'string' && obj['id'].length > 0;
    };
    const emit = (obj, name, slot) => {
        out.push({
            ...(typeof obj['id'] === 'string' ? { id: obj['id'] } : {}),
            name,
            arguments: normalizeArgs(slot.value),
        });
    };
    const visit = (node, relaxed) => {
        if (node === null || typeof node !== 'object')
            return;
        if (Array.isArray(node)) {
            for (const item of node)
                visit(item, relaxed);
            return;
        }
        const obj = node;
        // ① 确证信封：键名即证据，其值按 relaxed 继续深入
        for (const key of ENVELOPE_KEYS) {
            if (key in obj)
                visit(obj[key], true);
        }
        // ② 函数信封：{function:{name, arguments}}（外层有 id/type 佐证或处于 relaxed）
        const fnNode = obj['function'];
        if (fnNode !== null && typeof fnNode === 'object' && !Array.isArray(fnNode)) {
            const fnObj = fnNode;
            const slot = argsSlotOf(fnObj);
            if (slot !== undefined && typeof fnObj['name'] === 'string' && fnObj['name'].length > 0) {
                const corroborated = relaxed ||
                    typeof obj['id'] === 'string' ||
                    obj['type'] === 'function' ||
                    'index' in obj;
                if (corroborated)
                    emit(obj, fnObj['name'], slot);
            }
        }
        // ③ 裸形态：{id, name, arguments}
        const slot = argsSlotOf(obj);
        if (slot !== undefined && accept(obj, relaxed))
            emit(obj, obj['name'], slot);
    };
    visit(value, false);
    // 去重：信封遍历可能重复命中同一调用。
    const seen = new Set();
    return out.filter((c) => {
        const k = c.name + '\u0000' + c.arguments;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}
/**
 * 把模型给出的参数规范成 JSON 字符串。
 *
 * OpenAI 契约里 arguments 是字符串；但不少网关直接给对象，或给一个被双重
 * 编码的字符串。三种都收敛成「可被 JSON.parse 的字符串」。
 *
 * @param raw - 任意形态的参数值。
 * @returns 标准 JSON 字符串。
 */
export function normalizeArgs(raw) {
    if (raw === undefined || raw === null)
        return '{}';
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed === '')
            return '{}';
        // 已是合法 JSON 字符串 → 原样保留，避免二次编码
        try {
            JSON.parse(trimmed);
            return trimmed;
        }
        catch {
            return JSON.stringify({ value: raw });
        }
    }
    try {
        return JSON.stringify(raw);
    }
    catch {
        return '{}';
    }
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
export function scanJsonObjects(text, from = 0) {
    const candidates = [];
    let i = from;
    while (i < text.length) {
        if (text[i] !== '{') {
            i += 1;
            continue;
        }
        const start = i;
        let depth = 0;
        let inString = false;
        let escaped = false;
        let closed = false;
        for (let j = i; j < text.length; j += 1) {
            const ch = text[j];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (ch === '\\')
                    escaped = true;
                else if (ch === '"')
                    inString = false;
                continue;
            }
            if (ch === '"')
                inString = true;
            else if (ch === '{')
                depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    const raw = text.slice(start, j + 1);
                    try {
                        candidates.push({ start, end: j + 1, value: JSON.parse(raw) });
                        i = j + 1;
                        closed = true;
                    }
                    catch {
                        // 花括号配对成功但 JSON 非法：当成普通文本，继续推进
                    }
                    break;
                }
            }
        }
        if (!closed) {
            // 从 start 起有未闭合的花括号——可能是流式半截 JSON，等更多数据
            return { candidates, pendingStart: start };
        }
    }
    return { candidates, pendingStart: -1 };
}
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
export function candidateAt(text, start) {
    if (text[start] !== '{')
        return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = start; j < text.length; j += 1) {
        const ch = text[j];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"')
            inString = true;
        else if (ch === '{')
            depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                const raw = text.slice(start, j + 1);
                try {
                    return { start, end: j + 1, value: JSON.parse(raw) };
                }
                catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}
/**
 * 剥掉片段两侧的围栏与标签噪声。
 *
 * @param text - 原始片段（工具调用 JSON 之外的残余文本）。
 * @returns 清理后的文本；仅剩噪声时为空串。
 */
export function stripNoise(text) {
    let out = text;
    out = out
        .split('\n')
        .filter((line) => !FENCE_RE.test(line.trim()))
        .join('\n');
    for (let k = 0; k < TAG_OPEN.length; k += 1) {
        out = out.split(TAG_OPEN[k]).join('');
        out = out.split(TAG_CLOSE[k]).join('');
    }
    out = out
        .split('\n')
        .filter((line) => line.trim().toLowerCase() !== 'json')
        .join('\n');
    return out;
}
/**
 * 把一个**已完结**的文本块切成规范片段序列。
 *
 * @param text - 完整文本（流已结束或块已闭合）。
 * @returns 片段序列；纯文本时返回单个 text 片段。
 */
export function segmentComplete(text) {
    const { candidates } = scanJsonObjects(text);
    if (candidates.length === 0) {
        const cleaned = stripNoise(text);
        return cleaned.length > 0 ? [{ kind: 'text', text: cleaned }] : [];
    }
    /**
     * 逐候选判定，并累计两个**独立旁证**：
     *   - `sawAdjacent`：两个被接受的候选在文本中紧邻（中间只有空白/围栏/标签）
     *     ——真实数据几乎不会长成这样，而「一次调多个工具」恰恰如此；
     *   - `hasCallContext`：候选处在工具调用标签/围栏的语境里。
     *
     * 判据分两遍：第一遍用严格规则（必须带 id）；若有候选被严格规则拒绝、
     * 却出现了旁证，则第二遍对该候选启用宽松规则（允许无 id 的裸形态）。
     * 这样「模型不给 id」与「普通 JSON 误报」两个方向同时被照顾。
     */
    const accepted = [];
    let prevAcceptedEnd = -1;
    let sawAdjacent = false;
    let sawContext = false;
    for (const cand of candidates) {
        const strict = callsFromJson(cand.value);
        const context = hasCallContext(text, cand.start);
        if (context)
            sawContext = true;
        if (strict.length > 0) {
            if (prevAcceptedEnd >= 0) {
                const gap = text.slice(prevAcceptedEnd, cand.start);
                if (stripNoise(gap).trim().length === 0)
                    sawAdjacent = true;
            }
            accepted.push({ cand, calls: strict });
            prevAcceptedEnd = cand.end;
            continue;
        }
        // 严格规则拒绝：先记账，稍后视旁证决定是否宽松接受。
        // 同时用**宽松**规则探测相邻性——两个都像工具调用的对象紧挨在一起
        //（中间只有空白/围栏/标签）本身就是极强的旁证：真实数据几乎不会这样，
        // 而「一次要调多个工具」恰恰如此。
        const probe = callsFromJsonRelaxed(cand.value, true);
        if (probe.length > 0 && prevAcceptedEnd >= 0) {
            const gap = text.slice(prevAcceptedEnd, cand.start);
            if (stripNoise(gap).trim().length === 0)
                sawAdjacent = true;
        }
        accepted.push({ cand, calls: [] });
        if (probe.length > 0)
            prevAcceptedEnd = cand.end;
    }
    const relaxedAllowed = sawAdjacent || sawContext;
    if (relaxedAllowed) {
        for (const entry of accepted) {
            if (entry.calls.length > 0)
                continue;
            const relaxed = callsFromJsonRelaxed(entry.cand.value, true);
            if (relaxed.length > 0)
                entry.calls = relaxed;
        }
    }
    const segments = [];
    let cursor = 0;
    for (const entry of accepted) {
        const calls = entry.calls;
        if (calls.length === 0)
            continue; // 不是工具调用 → 留在文本里
        const between = stripNoise(text.slice(cursor, entry.cand.start));
        if (between.trim().length > 0)
            segments.push({ kind: 'text', text: between });
        segments.push({ kind: 'tool-calls', calls });
        cursor = entry.cand.end;
    }
    if (segments.length === 0) {
        const cleaned = stripNoise(text);
        return cleaned.length > 0 ? [{ kind: 'text', text: cleaned }] : [];
    }
    const tail = stripNoise(text.slice(cursor));
    if (tail.trim().length > 0)
        segments.push({ kind: 'text', text: tail });
    return segments;
}
/**
 * 流式分段器：累积 delta，判定「是否可以安全地在当前位置切分」。
 *
 * 用法：对每个 text-delta 调 push，把 takeSettled 返回的稳定前缀立即下发
 * （保打字机效果）；流结束时调 finish 取残余并按片段类型分别 emit。
 *
 * 折中逻辑：只在「已完整闭合且确认是工具调用的 JSON」处才认定需要改写；
 * 未闭合候选一律继续缓冲；无花括号的纯文本整体视为稳定，可即刻下发。
 */
export class StreamSegmenter {
    buffer = '';
    settled = 0;
    /** 追加一个 delta。 */
    push(delta) {
        this.buffer += delta;
        this.recomputeSettled();
    }
    /** 当前缓冲区内容（调试/测试用）。 */
    get pending() {
        return this.buffer;
    }
    /** 可安全提前下发的稳定前缀。 */
    takeSettled() {
        const head = this.buffer.slice(0, this.settled);
        if (head.length === 0)
            return '';
        this.buffer = this.buffer.slice(this.settled);
        this.settled = 0;
        this.recomputeSettled();
        return head;
    }
    /**
     * 收尾：把残余缓冲区整体切分。
     *
     * @returns 最终片段序列。
     */
    finish() {
        const segments = segmentComplete(this.buffer);
        this.buffer = '';
        this.settled = 0;
        return segments;
    }
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
    recomputeSettled() {
        const buf = this.buffer;
        let i = 0;
        let depth = 0;
        let inString = false;
        let escaped = false;
        let objStart = -1;
        while (i < buf.length) {
            const ch = buf[i];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (ch === '\\')
                    escaped = true;
                else if (ch === '"')
                    inString = false;
                i += 1;
                continue;
            }
            if (ch === '"') {
                inString = true;
                i += 1;
                continue;
            }
            if (ch === '{') {
                if (depth === 0)
                    objStart = i;
                depth += 1;
                i += 1;
                continue;
            }
            if (ch === '}') {
                depth -= 1;
                i += 1;
                if (depth <= 0) {
                    const start = objStart >= 0 ? objStart : 0;
                    const raw = buf.slice(start, i);
                    let value;
                    let parsed = false;
                    try {
                        value = JSON.parse(raw);
                        parsed = true;
                    }
                    catch {
                        parsed = false;
                    }
                    if (parsed && callsFromJson(value).length > 0) {
                        this.settled = start;
                        return;
                    }
                    // 完整但非调用（或非法 JSON）：放行到其后
                    depth = 0;
                    objStart = -1;
                    continue;
                }
                continue;
            }
            i += 1;
        }
        // 扫完：若还有未闭合的顶层对象，只放行它之前的文本
        this.settled = depth > 0 && objStart >= 0 ? objStart : buf.length;
    }
}
/**
 * 判断一段文本里是否含**疑似**工具调用（快速路径用）。
 *
 * @param text - 待检文本。
 * @returns 是否值得进一步解析。
 */
export function looksLikeToolCall(text) {
    if (!text.includes('{'))
        return false;
    const { candidates } = scanJsonObjects(text);
    return candidates.some((c) => callsFromJson(c.value).length > 0);
}
