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
import { createHash } from 'node:crypto';
/**
 * 递归规范化任意值为「键序稳定」的形态。
 *
 * @param value - 任意 JSON 值。
 * @returns 键按字典序排列的等价结构。
 */
export function canonicalize(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(canonicalize);
    const obj = value;
    const out = {};
    for (const key of Object.keys(obj).sort())
        out[key] = canonicalize(obj[key]);
    return out;
}
/**
 * 确定性 JSON 序列化：键序稳定、无多余空白。
 *
 * @param value - 任意 JSON 值。
 * @returns 稳定字符串。
 */
export function stableStringify(value) {
    return JSON.stringify(canonicalize(value));
}
/**
 * 取请求里的「稳定前缀」文本。
 *
 * 稳定部分 = system 槽 + 工具定义。会话消息不进前缀计算，因为它们本来就会
 * 随对话增长（比对它们只会产生无意义噪声）。
 *
 * @param request - 请求视图。
 * @returns 稳定前缀文本。
 */
export function stablePrefixText(request) {
    const parts = [];
    if (typeof request.system === 'string' && request.system.length > 0) {
        parts.push(request.system);
    }
    else if (Array.isArray(request.messages)) {
        for (const m of request.messages) {
            if (m !== null && typeof m === 'object' && m.role === 'system' && typeof m.content === 'string') {
                parts.push(m.content);
            }
        }
    }
    if (Array.isArray(request.tools) && request.tools.length > 0) {
        const names = request.tools
            .map((t) => (t !== null && typeof t === 'object' ? String(t.name ?? '') : ''))
            .sort();
        parts.push(stableStringify(request.tools.map((t) => canonicalize(t)).sort((a, b) => {
            const an = String(a?.name ?? '');
            const bn = String(b?.name ?? '');
            return an < bn ? -1 : an > bn ? 1 : 0;
        })));
        parts.push(names.join('\u0000'));
    }
    return parts.join('\n\u0001\n');
}
/**
 * 计算稳定前缀指纹。
 *
 * @param request - 请求视图。
 * @returns 指纹快照。
 */
export function fingerprint(request) {
    const text = stablePrefixText(request);
    const toolNames = Array.isArray(request.tools)
        ? request.tools
            .map((t) => (t !== null && typeof t === 'object' ? String(t.name ?? '') : ''))
            .filter((n) => n.length > 0)
            .sort()
        : [];
    return {
        hash: createHash('sha256').update(text, 'utf8').digest('hex'),
        toolNames,
        bytes: Buffer.byteLength(text, 'utf8'),
    };
}
/**
 * 会话级前缀漂移检测器。
 *
 * 只在**同一会话**内比对：跨会话前缀本就不同，比对无意义。
 *
 * @param options - 可选项。
 * @returns 检测器实例。
 */
export function createDriftDetector(options) {
    const maxSessions = options?.maxSessions ?? 64;
    const seen = new Map();
    return {
        observe(sessionKey, request) {
            const fp = fingerprint(request);
            const prev = seen.get(sessionKey);
            if (prev === undefined) {
                seen.set(sessionKey, fp);
                // 简单的 LRU：超限时丢最早的一条
                if (seen.size > maxSessions) {
                    const oldest = seen.keys().next();
                    if (!oldest.done)
                        seen.delete(oldest.value);
                }
                return { drifted: false, first: true };
            }
            if (prev.hash === fp.hash)
                return { drifted: false, first: false };
            const added = fp.toolNames.filter((n) => !prev.toolNames.includes(n));
            const removed = prev.toolNames.filter((n) => !fp.toolNames.includes(n));
            const bits = [];
            if (added.length > 0)
                bits.push('工具新增: ' + added.join(', '));
            if (removed.length > 0)
                bits.push('工具移除: ' + removed.join(', '));
            bits.push('前缀字节 ' + prev.bytes + ' → ' + fp.bytes);
            seen.set(sessionKey, fp);
            return { drifted: true, first: false, detail: bits.join('；') };
        },
        size: () => seen.size,
    };
}
