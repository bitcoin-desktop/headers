// Watchdog probe tests, CI-safe with zero network. Events use REAL
// testnet4 vector headers so the PoW check is exercised for real, signed
// with a throwaway key fed to the probe via the author option.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { attachWsServer } from '@bitcoin-desktop/schema/codec/ws.js';
import { publicKey, finalizeEvent } from '../publisher/nostr.js';
import { probe } from '../watchdog/probe.mjs';

const dep = (p) => readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8').then(JSON.parse);
const t4 = await dep('test/vectors/testnet4.json');

const PRIV = Buffer.from('2'.repeat(64), 'hex');
const AUTHOR = publicKey(PRIV);
const TIP = t4.run.startHeight + t4.run.headers.length - 1;

function makeEvent({ d = 'tbtc4', ageSec = 60, content } = {}) {
  return finalizeEvent({
    kind: 33333,
    pubkey: AUTHOR,
    created_at: Math.floor(Date.now() / 1000) - ageSec,
    tags: [['d', d], ['n', d], ['tip', String(TIP)]],
    content: content ?? t4.run.headers.slice(-12).join(''),
  }, PRIV);
}

// a mock relay that replays its canned events to any REQ, then EOSE
function startMockRelay(events) {
  const server = http.createServer();
  attachWsServer(server, (client) => {
    client.onMessage((bytes) => {
      const m = JSON.parse(new TextDecoder().decode(bytes));
      if (m[0] !== 'REQ') return;
      const send = (x) => client.send(new TextEncoder().encode(JSON.stringify(x)));
      for (const e of events) send(['EVENT', m[1], e]);
      send(['EOSE', m[1]]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `ws://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const STREAMS = [{ d: 'tbtc4', maxAgeMin: 360 }];

test('healthy: fresh valid event passes all checks', async () => {
  const relay = await startMockRelay([makeEvent()]);
  try {
    const r = await probe({ relays: [relay.url], author: AUTHOR, streams: STREAMS });
    assert.equal(r.healthy, true);
    assert.equal(r.streams.tbtc4.tip, TIP);
    assert.equal(r.streams.tbtc4.valid, true);
    assert.equal(r.streams.tbtc4.relaysAnswering, 1);
  } finally { relay.close(); }
});

test('stale: an old event is flagged, validity untouched', async () => {
  const relay = await startMockRelay([makeEvent({ ageSec: 9 * 3600 })]);
  try {
    const r = await probe({ relays: [relay.url], author: AUTHOR, streams: STREAMS });
    assert.equal(r.healthy, false);
    assert.match(r.streams.tbtc4.issues.join(';'), /stale/);
    assert.equal(r.streams.tbtc4.valid, true, 'old but still a valid chain segment');
  } finally { relay.close(); }
});

test('tampered: a corrupted header fails linkage/PoW', async () => {
  const headers = t4.run.headers.slice(-12);
  headers[5] = headers[5].slice(0, 8) + 'deadbeef' + headers[5].slice(16);
  const relay = await startMockRelay([makeEvent({ content: headers.join('') })]);
  try {
    const r = await probe({ relays: [relay.url], author: AUTHOR, streams: STREAMS });
    assert.equal(r.healthy, false);
    assert.equal(r.streams.tbtc4.valid, false);
    assert.match(r.streams.tbtc4.issues.join(';'), /link|PoW/);
  } finally { relay.close(); }
});

test('missing: stream absent from all relays', async () => {
  const relay = await startMockRelay([]);
  try {
    const r = await probe({ relays: [relay.url], author: AUTHOR, streams: STREAMS });
    assert.equal(r.healthy, false);
    assert.equal(r.streams.tbtc4.found, false);
  } finally { relay.close(); }
});

test('wrong author or d is ignored even if the relay serves it', async () => {
  const stranger = finalizeEvent({
    kind: 33333,
    pubkey: publicKey(Buffer.from('3'.repeat(64), 'hex')),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', 'tbtc4'], ['n', 'tbtc4'], ['tip', String(TIP)]],
    content: t4.run.headers.slice(-12).join(''),
  }, Buffer.from('3'.repeat(64), 'hex'));
  const relay = await startMockRelay([stranger]);
  try {
    const r = await probe({ relays: [relay.url], author: AUTHOR, streams: STREAMS });
    assert.equal(r.streams.tbtc4.found, false, 'client-side filtering rejects relay junk');
  } finally { relay.close(); }
});
