const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PiWebBridge } = require('../bridge.cjs');

function fixture() {
  const bridge = new PiWebBridge();
  const state = { session: {}, seq: 3, subscribers: new Set(), events: [1, 2, 3].map(seq => ({ seq, id: `${bridge.bootId}:${seq}`, event: { type: 'assistant-delta', text: String(seq) } })) };
  bridge.attach = async () => state;
  bridge.rebuildHistoryIfTruncated = () => {};
  const res = new EventEmitter();
  res.frames = [];
  res.writeHead = () => {};
  res.flushHeaders = () => { res.flushed = true; };
  res.write = wire => res.frames.push(JSON.parse(wire.slice(6)));
  return { bridge, state, res };
}

test('SSE bridges the history gap without replaying old frames, then delivers live updates', async () => {
  const { bridge, state, res } = fixture();
  await bridge.subscribe('test', res, { since: 2, boot: bridge.bootId });
  assert.deepEqual(res.frames.map(f => f.seq), [3]);
  bridge.push(state, { type: 'assistant-delta', text: 'live' });
  assert.deepEqual(res.frames.map(f => f.seq), [3, 4]);
  res.emit('close');
  assert.equal(state.subscribers.size, 0);
});

test('SSE retains full replay for old clients and changed server boot', async () => {
  for (const options of [{}, { since: 99, boot: 'old-server' }]) {
    const { bridge, res } = fixture();
    await bridge.subscribe('test', res, options);
    assert.deepEqual(res.frames.map(f => f.seq), [1, 2, 3]);
  }
});

test('caught-up SSE connects immediately; cancelled clients do not subscribe', async () => {
  const { bridge, state, res } = fixture();
  await bridge.subscribe('test', res, { since: 3, boot: bridge.bootId });
  assert.equal(res.flushed, true);
  assert.equal(res.frames.length, 0);
  res.emit('close');
  res.destroyed = true;
  await bridge.subscribe('test', res);
  assert.equal(state.subscribers.size, 0);
});
