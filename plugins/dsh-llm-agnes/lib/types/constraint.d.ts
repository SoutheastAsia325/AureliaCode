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
export declare const TOOL_CONSTRAINT: string;
/** 最小化的请求视图——只依赖本模块真正读取的字段。 */
export interface ConstraintRequest {
    system?: string;
    messages?: ReadonlyArray<{
        role?: string;
        content?: unknown;
    }>;
}
/**
 * 判断本轮是否携带工具定义。
 *
 * 没有工具可用时不该注入约束——那会让模型以为有工具可调，反而诱发幻觉调用。
 *
 * @param tools - 请求里的工具定义数组。
 * @returns 是否存在至少一个工具。
 */
export declare function hasTools(tools: unknown): boolean;
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
export declare function applyConstraint(request: ConstraintRequest, constraint?: string): boolean;
/**
 * 组装要发给 Agnes 的提示词尾部约束（供设置页预览/诊断使用）。
 *
 * @returns 约束正文。
 */
export declare function constraintPreview(): string;
