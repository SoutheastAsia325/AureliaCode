/**
 * dsh-llm-agnes / segment 单元测试。
 *
 * 运行：node --test test/segment.test.mjs
 * 依赖 lib/segment.js（先 npm run build）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  callsFromJson,
  normalizeArgs,
  scanJsonObjects,
  stripNoise,
  segmentComplete,
  StreamSegmenter,
  looksLikeToolCall,
} from '../lib/segment.js';

const json = (s) => JSON.parse(s);

test('callsFromJson：裸形态 {name, arguments:字符串}', () => {
  const calls = callsFromJson(json('{"id":"c1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.equal(calls[0].id, 'c1');
  assert.deepEqual(json(calls[0].arguments), { cmd: 'ls' });
});

test('callsFromJson：OpenAI 信封 {tool_calls:[{id,type,function:{name,arguments}}]}', () => {
  const raw = json(
    '{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}',
  );
  const calls = callsFromJson(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].id, 'call_a');
  assert.deepEqual(json(calls[0].arguments), { path: 'a.ts' });
});

test('callsFromJson：arguments 给成对象（非字符串）也能收敛为 JSON 字符串', () => {
  const calls = callsFromJson(json('{"id":"c2","name":"write","arguments":{"path":"b","text":"hi"}}'));
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].arguments, 'string');
  assert.deepEqual(json(calls[0].arguments), { path: 'b', text: 'hi' });
});

test('callsFromJson：多个调用（数组）', () => {
  const raw = json(
    '{"tool_calls":[{"id":"1","type":"function","function":{"name":"a","arguments":"{}"}},{"id":"2","type":"function","function":{"name":"b","arguments":"{}"}}]}',
  );
  const calls = callsFromJson(raw);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b']);
});

test('回归：普通 JSON 不得被误判为工具调用（name+arguments 无 id）', () => {
  // 这正是修掉的缺陷：{"name":"line","arguments":"x"} 是普通数据，不是调用
  assert.deepEqual(callsFromJson(json('{"name":"line","arguments":"x"}')), []);
  assert.deepEqual(callsFromJson(json('{"file":"a.ts","line":5,"name":"foo","arguments":"bar"}')), []);
  // 反向用例：带 id 才认
  assert.equal(callsFromJson(json('{"id":"c9","name":"line","arguments":"x"}')).length, 1);
});

test('回归：function 字段但无 type/id/index 佐证 → 不认', () => {
  assert.deepEqual(callsFromJson(json('{"function":{"name":"f","arguments":"{}"}}')), []);
  // 有佐证则认
  assert.equal(callsFromJson(json('{"id":"x","function":{"name":"f","arguments":"{}"}}')).length, 1);
  assert.equal(callsFromJson(json('{"type":"function","function":{"name":"f","arguments":"{}"}}')).length, 1);
});

test('normalizeArgs：null/undefined/空串 → {}', () => {
  assert.equal(normalizeArgs(null), '{}');
  assert.equal(normalizeArgs(undefined), '{}');
  assert.equal(normalizeArgs(''), '{}');
  assert.equal(normalizeArgs('   '), '{}');
});

test('scanJsonObjects：正确处理字符串内的花括号与转义', () => {
  const text = 'pre {"id":"c","name":"f","arguments":"{\\"a\\":\\"}\\"}"} post';
  const { candidates, pendingStart } = scanJsonObjects(text);
  assert.equal(candidates.length, 1);
  assert.equal(pendingStart, -1);
  assert.equal(candidates[0].value.name, 'f');
});

test('scanJsonObjects：未闭合对象报 pendingStart，且不产出候选', () => {
  const { candidates, pendingStart } = scanJsonObjects('tail {"id":"c","name":"ba');
  assert.equal(candidates.length, 0);
  assert.equal(pendingStart, 5);
});

test('stripNoise：剥围栏、标签、孤立 json 标记行', () => {
  const input = '```json\n<tool_call>\nhello\n```\n';
  assert.equal(stripNoise(input).trim(), 'hello');
  assert.equal(stripNoise('```\n```').trim(), '');
  assert.equal(stripNoise('json\nkeep').trim(), 'keep');
});

test('segmentComplete：纯文本原样返回单个 text 片段', () => {
  const segs = segmentComplete('这是一段普通回答。');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'text');
  assert.equal(segs[0].text, '这是一段普通回答。');
});

test('segmentComplete：直接 JSON → 纯 tool-calls，无 text 残留', () => {
  const segs = segmentComplete('{"id":"c1","name":"bash","arguments":"{\\"cmd\\":\\"pwd\\"}"}');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'tool-calls');
  assert.equal(segs[0].calls[0].name, 'bash');
});

test('segmentComplete：围栏包裹 → 围栏被剔除', () => {
  const segs = segmentComplete('```json\n{"id":"c1","name":"read","arguments":"{}"}\n```');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'tool-calls');
});

test('segmentComplete：说明文字 + 调用 + 说明文字 → 三段，文字保留', () => {
  const text = '我需要先看看目录。\n{"id":"c1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}\n好的，开始执行。';
  const segs = segmentComplete(text);
  assert.deepEqual(
    segs.map((s) => s.kind),
    ['text', 'tool-calls', 'text'],
  );
  assert.match(segs[0].text, /我需要先看看目录/);
  assert.match(segs[2].text, /好的，开始执行/);
});

test('segmentComplete：混合里含普通 JSON 时不得被吞掉', () => {
  const text = '配置是 {"name":"line","arguments":"x"} 这样。';
  const segs = segmentComplete(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'text');
  assert.match(segs[0].text, /line/);
});

test('StreamSegmenter：纯文本立即可下发（打字机不卡顿）', () => {
  const seg = new StreamSegmenter();
  seg.push('你好');
  assert.equal(seg.takeSettled(), '你好');
  seg.push('世界');
  assert.equal(seg.takeSettled(), '世界');
  assert.deepEqual(seg.finish(), []);
});

test('StreamSegmenter：半截 JSON 不下发，等闭合', () => {
  const seg = new StreamSegmenter();
  seg.push('准备调用 ');
  assert.equal(seg.takeSettled(), '准备调用 ');
  seg.push('{"id":"c1","name":"ba');
  // 半截：不得下发，否则后面的工具调用无法识别
  assert.equal(seg.takeSettled(), '');
  seg.push('sh","arguments":"{}"}');
  const segs = seg.finish();
  assert.deepEqual(
    segs.map((s) => s.kind),
    ['tool-calls'],
  );
  assert.equal(segs[0].calls[0].name, 'bash');
});

test('StreamSegmenter：逐字符喂入不丢不重（前导文本流式下发，finish 只余尾部）', () => {
  const text = '看目录\n{"id":"c1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}\n完成';
  const seg = new StreamSegmenter();
  let streamed = '';
  for (const ch of text) {
    seg.push(ch);
    streamed += seg.takeSettled();
  }
  const segs = seg.finish();
  // 前导文本已在流中下发，故 finish 只剩「工具调用 + 尾部文本」
  assert.deepEqual(
    segs.map((s) => s.kind),
    ['tool-calls', 'text'],
  );
  assert.equal(segs[0].calls[0].name, 'bash');
  assert.match(segs[1].text, /完成/);
  // 已下发的文本不得在 finish 里重复出现（不重）
  assert.match(streamed, /看目录/);
  assert.ok(!segs.some((s) => s.kind === 'text' && s.text.includes('看目录')));
});

test('StreamSegmenter：完整流式管线 —— 文本按序下发、调用被识别、无内容丢失', () => {
  const text = '先说一句\n{"id":"c1","name":"read","arguments":"{\\"path\\":\\"a\\"}"}\n收尾一句';
  const seg = new StreamSegmenter();
  let streamedText = '';
  for (const ch of text) {
    seg.push(ch);
    streamedText += seg.takeSettled();
  }
  const tail = seg.finish();

  // 组装：流式下发的文本 + finish 的片段 = 原文的规范还原
  const pieces = [
    ...(streamedText.length > 0 ? [{ kind: 'text', text: streamedText }] : []),
    ...tail,
  ];
  const kinds = pieces.map((p) => p.kind);
  assert.deepEqual(kinds, ['text', 'tool-calls', 'text']);
  const joined = pieces.filter((p) => p.kind === 'text').map((p) => p.text).join('');
  assert.match(joined, /先说一句/);
  assert.match(joined, /收尾一句/);
  // 工具调用 JSON 不得残留在任何文本片段里
  assert.ok(!joined.includes('tool_calls'));
  assert.ok(!joined.includes('"read"'));
  assert.equal(pieces[1].calls.length, 1);
  assert.equal(pieces[1].calls[0].name, 'read');
});

test('looksLikeToolCall：快速路径', () => {
  assert.equal(looksLikeToolCall('没有任何花括号'), false);
  assert.equal(looksLikeToolCall('有花括号 {"a":1} 但不是调用'), false);
  assert.equal(looksLikeToolCall('{"id":"c","name":"f","arguments":"{}"}'), true);
});
