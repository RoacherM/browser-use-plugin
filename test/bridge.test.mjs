import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridge } from '../src/bridge.js';

test('rejects immediately when no window has polled', async () => {
  const bridge = createBridge();
  await assert.rejects(bridge.request({ action: 'snapshot', args: {} }), /桌面/);
});

test('a parked poll receives the command and the answer resolves the request', async () => {
  const bridge = createBridge();
  const poll = bridge.poll();
  const pending = bridge.request({ action: 'navigate', args: { url: 'https://example.com' } });
  const command = await poll;
  assert.equal(command.action, 'navigate');
  assert.equal(bridge.answer(command.id, { ok: true, value: { text: 'done' } }), true);
  assert.deepEqual(await pending, { text: 'done' });
  assert.equal(bridge.answer(command.id, { ok: true, value: {} }), false, 'answers are single-use');
});

test('commands queue while no poll is parked and a failure reaches the tool', async () => {
  const bridge = createBridge();
  await bridge.poll(AbortSignal.timeout(1));          // marks a window as connected, then releases
  const pending = bridge.request({ action: 'click', args: { ref: 3 } });
  const command = await bridge.poll();
  bridge.answer(command.id, { ok: false, error: 'stale ref' });
  await assert.rejects(pending, /stale ref/);
});

test('times out and drops the queued command', async () => {
  const bridge = createBridge();
  await bridge.poll(AbortSignal.timeout(1));
  await assert.rejects(bridge.request({ action: 'wait', args: {} }, { timeoutMs: 20 }), /没有响应/);
  const next = await bridge.poll(AbortSignal.timeout(20));
  assert.equal(next, undefined, 'the timed-out command is not handed out later');
});

test('an idle poll ends empty after the hold time', async () => {
  const bridge = createBridge({ holdMs: 10 });
  assert.equal(await bridge.poll(), undefined);
});

test('dispose fails in-flight requests', async () => {
  const bridge = createBridge();
  const poll = bridge.poll();
  const pending = bridge.request({ action: 'snapshot', args: {} });
  await poll;
  bridge.dispose();
  await assert.rejects(pending, /卸载/);
});
