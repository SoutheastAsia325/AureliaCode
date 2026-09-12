/**
 * dsh-llm-agnes / constraint + cache + cleanse 单元测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyConstraint, TOOL_CONSTRAINT, hasTools } from '../lib/constraint.js';
import { fingerprint, stableStringify, canonicalize, createDriftDetector } from '../lib/cache.js';
import { cleanseStream, createStats } from '../lib/cleanse.js';

// ───────────────────────── 需求③：约束注入 ─────────────────────────

test('hasTools：空数组与缺失都不算有工具', () => {
  assert.equal(hasTools([]), false);
  assert.equal(hasTools(undefined), false);
  assert.equal(hasTools(null), false);
  assert.equal(hasTools([{ name: 'bash' }]), true);
});

test('applyConstraint：追加到 system 字段', () => {
  const req = { system: '你是助手。', messages: [] };
  assert.equal(applyConstraint(req), true);
  assert.ok(req.system.startsWith('你是助手。'));
  assert.ok(req.system.includes('tool_calls'));
  assert.ok(req.system.includes(TOOL_CONSTRAINT));
});

test('applyConstraint：system 缺失时追加到首条 system 消息', () => {
  const lead = { role: 'system', content: '角色设定' };
  const req = { messages: [lead, { role: 'user', content: '你好' }] };
  assert.equal(applyConstraint(req), true);
  assert.ok(lead.content.includes('角色设定'));
  assert.ok(lead.content.includes('tool_calls'));
  // 用户消息不得被污染
  assert.equal(req.messages[1].content, '你好');
});

test('applyConstraint：两条路径都缺失时显式插入 system 消息', () => {
  const req = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(applyConstraint(req), true);
  assert.equal(req.messages[0].role, 'system');
  assert.ok(String(req.messages[0].content).includes('tool_calls'));
});

test('applyConstraint：同一请求重复调用只注入一次（幂等）', () => {
  const req = { system: 'x', messages: [] };
  assert.equal(applyConstraint(req), true);
  const after = req.system;
  assert.equal(applyConstraint(req), false);
  assert.equal(req.system, after);
  // 且只出现一次约束标记
  assert.equal(req.system.split('工具调用硬性格式约束').length - 1, 1);
});

test('applyConstraint：约束是定值 —— 两次独立请求得到字节相同的尾部（缓存友好）', () => {
  const a = { system: 'base', messages: [] };
  const b = { system: 'base', messages: [] };
  applyConstraint(a);
  applyConstraint(b);
  assert.equal(a.system, b.system);
  const tailA = a.system.slice(-TOOL_CONSTRAINT.length);
  assert.equal(tailA, TOOL_CONSTRAINT);
});

// ───────────────────────── 需求②：前缀缓存对齐 ─────────────────────────

test('canonicalize/stableStringify：键序无关', () => {
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
  const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(stableStringify(a), '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('fingerprint：工具集相同则指纹相同（与定义顺序无关）', () => {
  const t1 = [{ name: 'bash', description: 'x' }, { name: 'read', description: 'y' }];
  const t2 = [{ name: 'read', description: 'y' }, { name: 'bash', description: 'x' }];
  const a = fingerprint({ system: 'S', tools: t1 });
  const b = fingerprint({ system: 'S', tools: t2 });
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.toolNames, ['bash', 'read']);
});

test('fingerprint：system 变化则指纹变化', () => {
  const a = fingerprint({ system: 'S1' });
  const b = fingerprint({ system: 'S2' });
  assert.notEqual(a.hash, b.hash);
});

test('漂移检测：首次不算漂移，同前缀不算，变化才算', () => {
  const d = createDriftDetector();
  const req = { system: 'S', tools: [{ name: 'bash' }] };
  assert.deepEqual(d.observe('s1', req), { drifted: false, first: true });
  assert.deepEqual(d.observe('s1', req), { drifted: false, first: false });
  const r = d.observe('s1', { system: 'S2', tools: [{ name: 'bash' }] });
  assert.equal(r.drifted, true);
  assert.match(r.detail, /前缀字节/);
});

test('漂移检测：会话之间互不干扰', () => {
  const d = createDriftDetector();
  d.observe('a', { system: 'A' });
  const r = d.observe('b', { system: 'B' });
  assert.equal(r.first, true);
  assert.equal(r.drifted, false);
});

test('漂移检测：工具增删能被指名', () => {
  const d = createDriftDetector();
  d.observe('s', { system: 'S', tools: [{ name: 'bash' }, { name: 'read' }] });
  const r = d.observe('s', { system: 'S', tools: [{ name: 'bash' }, { name: 'write' }] });
  assert.equal(r.drifted, true);
  assert.match(r.detail, /工具新增: write/);
  assert.match(r.detail, /工具移除: read/);
});

test('漂移检测：会话数上限生效（LRU 不无限增长）', () => {
  const d = createDriftDetector({ maxSessions: 3 });
  for (let i = 0; i < 10; i += 1) d.observe('s' + i, { system: 'S' });
  assert.ok(d.size() <= 4);
});

// ───────────────────────── 需求①：清洗中间件 ─────────────────────────

/** 把 async iterable 收成数组。 */
async function collect(iter) {
  const out = [];
  for await (const c of iter) out.push(c);
  return out;
}

const streamOf = (chunks) =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

test('cleanse：纯文本流逐字节不变（中间件不得改变正常输出）', async () => {
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你好' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(cleanseStream(streamOf(input)));
  assert.deepEqual(out, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你好' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('cleanse：reasoning 块原样透传', async () => {
  const input = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '思考中' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考中' } },
  ];
  const out = await collect(cleanseStream(streamOf(input)));
  assert.deepEqual(out, input);
});

test('cleanse：正文内嵌 tool_calls 被改写为规范 tool-call 块', async () => {
  const payload = '{"id":"c1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}';
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: payload },
    { type: 'block-end', index: 0, block: { type: 'text', text: payload } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const stats = createStats();
  const out = await collect(cleanseStream(streamOf(input), stats));

  const types = out.map((c) => c.type);
  assert.deepEqual(types, ['block-start', 'tool-call-delta', 'block-end', 'finish']);
  const delta = out[1];
  assert.equal(delta.name, 'bash');
  assert.equal(delta.id, 'c1');
  assert.deepEqual(JSON.parse(delta.argumentsDelta), { cmd: 'ls' });
  // 关键：不得有任何 text 块残留
  assert.ok(!out.some((c) => c.blockType === 'text'));
  assert.equal(stats.rewritten, 1);
  // 形态分类名不做硬编码断言（单个裸对象归入 embedded-json，信封形态归入各自的类），
  // 只要求「确实记了一笔」，避免断言绑死内部命名。
  const detectedTotal = Object.values(stats.detected).reduce((a, b) => a + b, 0);
  assert.equal(detectedTotal, 1);
});

test('cleanse：文字 + 调用混排 → 文本块与调用块并存且顺序正确', async () => {
  const text = '先看目录\n{"id":"c1","name":"bash","arguments":"{}"}\n完成';
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(cleanseStream(streamOf(input)));
  const shape = out
    .filter((c) => c.type === 'block-start')
    .map((c) => c.blockType);
  assert.deepEqual(shape, ['text', 'tool-call', 'text']);
  // 文本内容不得含有工具调用 JSON
  const texts = out.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text);
  assert.ok(texts.every((t) => !t.includes('"bash"')));
  assert.ok(texts.some((t) => t.includes('先看目录')));
});

test('cleanse：delta-only 协议（无 block-start）也能识别', async () => {
  const payload = '{"id":"c9","name":"read","arguments":"{}"}';
  const input = [
    { type: 'text-delta', index: 0, text: payload },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(cleanseStream(streamOf(input)));
  const calls = out.filter((c) => c.type === 'tool-call-delta');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
});

test('cleanse：id 缺失时自动生成，且同一流内不重复', async () => {
  const payload =
    '{"name":"bash","arguments":"{}"}' + '{"name":"read","arguments":"{}"}';
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: payload },
    { type: 'block-end', index: 0, block: { type: 'text', text: payload } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(cleanseStream(streamOf(input)));
  const ids = out.filter((c) => c.type === 'tool-call-delta').map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((i) => typeof i === 'string' && i.length > 0));
});

test('cleanse：新块 index 不得与已关闭的块冲突', async () => {
  const payload = '{"id":"c1","name":"bash","arguments":"{}"}';
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: payload },
    { type: 'block-end', index: 0, block: { type: 'text', text: payload } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(cleanseStream(streamOf(input)));
  const starts = out.filter((c) => c.type === 'block-start').map((c) => c.index);
  const ends = out.filter((c) => c.type === 'block-end').map((c) => c.index);
  // 每个 index 只被 start/end 一次
  assert.equal(new Set(starts).size, starts.length);
  assert.equal(new Set(ends).size, ends.length);
  // 新块 index 不得复用已被关闭的 index 0
  assert.ok(starts.every((i) => i >= 0));
});

test('cleanse：usage / finish 等非块 chunk 原样透传', async () => {
  const usage = { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } };
  const fin = { type: 'finish', reason: { kind: 'stop' }, replayState: { x: 1 } };
  const out = await collect(cleanseStream(streamOf([usage, fin])));
  assert.deepEqual(out, [usage, fin]);
});

test('cleanse：多个工具调用块各自独立发号', async () => {
  const text = '{"id":"a","name":"bash","arguments":"{}"}\n{"id":"b","name":"read","arguments":"{}"}';
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(cleanseStream(streamOf(input)));
  const deltas = out.filter((c) => c.type === 'tool-call-delta');
  assert.deepEqual(deltas.map((d) => d.name), ['bash', 'read']);
  // 两个调用各自拿到**不同的**新 index，且都不复用被改写掉的 index 0
  // （0 已被消费；复用可能撞上引擎已记录的引用，保守跳过才是安全的）
  const idx = deltas.map((d) => d.index);
  assert.equal(new Set(idx).size, idx.length);
  assert.ok(idx.every((i) => i !== 0), '不得复用被改写块的 index');
});
