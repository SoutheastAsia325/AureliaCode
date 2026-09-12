/**
 * `constraint` — 需求③：强制工具调用约束。
 *
 * 把「需要调用工具时 content 必须为空、tool_calls 必须完整、严禁在文本里描述
 * 调用过程」这段约束，追加到实际发往 Agnes 的提示词末尾。
 *
 * 两个关键设计：
 *
 * ① **追加位置是「系统槽」而不是最后一条消息。** loop 构建的请求由会话日志
 *    派生，最后一条消息是用户内容；往那里写会污染用户输入、并在下一轮被当作
 *    历史留存。系统槽才是承载指令语义的位置。
 *
 * ② **只在本轮尚未注入时注入（WeakSet 记账）。** `llm/stream` 是 waterfall，
 *    同一次调用可能被多个监听者包裹；若无记账，约束会被追加多次，既浪费
 *    token 又让前缀字节不稳定——直接损害需求②的缓存命中率。
 *
 * 前缀稳定性说明：注入的是**定值**（同一份文本），因此第 N 轮与第 N+1 轮的
 * 系统槽前缀字节完全一致，不引入缓存漂移。
 *
 * @module dsh-llm-agnes/constraint
 */
/** 约束正文。改动它会改变系统提示词前缀，从而重置一次缓存——故保持稳定。 */
export const TOOL_CONSTRAINT = [
    '',
    '## 工具调用硬性格式约束（最高优先级）',
    '',
    '当你需要调用工具时，必须严格遵守以下规则：',
    '',
    '1. `content` 必须为空字符串（或 null）。严禁在文本中描述调用过程、宣告你「将要调用」或解释参数。',
    '2. 工具调用必须写进结构化的 `tool_calls` 数组，而不是正文文本。',
    '3. `tool_calls` 数组的每一项必须完整包含四个字段：',
    '   - `id`：本次调用的唯一标识字符串',
    '   - `type`：固定为 `"function"`',
    '   - `function.name`：工具名',
    '   - `function.arguments`：参数的标准 JSON 字符串（注意是字符串，不是对象）',
    '4. 禁止使用 Markdown 代码块包裹工具调用。',
    '5. 一次需要多个工具时，全部放进同一个 `tool_calls` 数组。',
    '',
    '只有在你不需要调用任何工具、纯粹回复用户时，才把内容写进 `content`。',
].join('\n');
/** 已注入过的请求，避免重复追加。 */
const injected = new WeakSet();
/**
 * 判断本轮是否携带工具定义。
 *
 * 没有工具可用时不该注入约束——那会让模型以为有工具可调，反而诱发幻觉调用。
 *
 * @param tools - 请求里的工具定义数组。
 * @returns 是否存在至少一个工具。
 */
export function hasTools(tools) {
    return Array.isArray(tools) && tools.length > 0;
}
/**
 * 把约束追加到系统槽。
 *
 * 优先追加到 `system` 字段（一次性调用路径）；否则在 `messages` 里找第一条
 * `role === 'system'` 的消息追加（loop 构建路径）。两条路径都不存在时**就地
 * 插入**一条 system 消息，保证约束一定送达。
 *
 * @param request - 请求对象（会被原地修改）。
 * @param constraint - 约束文本，默认 {@link TOOL_CONSTRAINT}。
 * @returns 是否发生了注入。
 */
export function applyConstraint(request, constraint = TOOL_CONSTRAINT) {
    if (request === null || typeof request !== 'object')
        return false;
    if (injected.has(request))
        return false;
    if (typeof request.system === 'string') {
        request.system = request.system.length > 0 ? request.system + '\n' + constraint : constraint;
        injected.add(request);
        return true;
    }
    const messages = request.messages;
    if (Array.isArray(messages)) {
        const lead = messages.find((m) => m !== null && typeof m === 'object' && m.role === 'system');
        if (lead !== undefined && typeof lead.content === 'string') {
            lead.content = lead.content.length > 0 ? lead.content + '\n' + constraint : constraint;
            injected.add(request);
            return true;
        }
    }
    // 两条常规路径都不存在：显式插入系统消息（位置在最前，符合协议惯例）
    if (Array.isArray(messages)) {
        messages.unshift({ role: 'system', content: constraint });
        injected.add(request);
        return true;
    }
    return false;
}
/**
 * 组装要发给 Agnes 的提示词尾部约束（供设置页预览/诊断使用）。
 *
 * @returns 约束正文。
 */
export function constraintPreview() {
    return TOOL_CONSTRAINT;
}
