// Publisher tests, CI-safe with zero network. The cross-implementation
// check is the centerpiece: events signed with noble must verify under the
// schema's own BIP-340 verifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { LightNode, MemoryStorage } from '@bitcoin-desktop/schema/codec/node.js';
import { attachWsServer } from '@bitcoin-desktop/schema/codec/ws.js';
import { verifySchnorr } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { hexToBytes } from '@bitcoin-desktop/schema/codec/hash.js';
import { parsePrivateKey, publicKey, buildHeadersEvent, RelayPool } from '../publisher/nostr.js';

const dep = (p) => readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8').then(JSON.parse);
const codec = new Codec(await dep('schema/core.jsonld'), await dep('schema/proof.jsonld'));
const chainSchema = await dep('schema/chain.jsonld');
const validateSchema = await dep('schema/validate.jsonld');
const engine = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const t4 = await dep('test/vectors/testnet4.json');

const PRIV = Buffer.from('1'.repeat(64), 'hex');

test('keys: hex and nsec parse; argv-style junk refused', () => {
  assert.equal(parsePrivateKey('1'.repeat(64)).toString('hex'), '1'.repeat(64));
  assert.throws(() => parsePrivateKey('not-a-key'));
  assert.match(publicKey(PRIV), /^[0-9a-f]{64}$/);
});

test('events signed with noble verify under the schema BIP-340 verifier', () => {
  const headersHex = t4.run.headers.slice(-12);
  const event = buildHeadersEvent({ network: 'tbtc4', headersHex, tip: 138885 }, PRIV);

  assert.equal(event.kind, 33333);
  const tags = Object.fromEntries(event.tags.filter((t) => t.length >= 2));
  assert.equal(tags.d, 'tbtc4', 'd is the network code — one replaceable stream per network');
  assert.equal(tags.n, 'tbtc4');
  assert.equal(tags.tip, '138885');
  assert.equal(event.content, headersHex.join(''));
  assert.equal(event.content.length, 12 * 160);

  // cross-implementation: noble signs, OUR engine verifies
  assert.equal(verifySchnorr(
    hexToBytes(event.id), hexToBytes(event.sig), hexToBytes(event.pubkey)), true);
  // and a flipped sig byte fails
  const bad = event.sig.slice(0, 10) + (event.sig[10] === '0' ? '1' : '0') + event.sig.slice(11);
  assert.equal(verifySchnorr(hexToBytes(event.id), hexToBytes(bad), hexToBytes(event.pubkey)), false);
});

// ---- a mock relay implementing just enough NIP-01 ----
function startMockRelay({ ack = true } = {}) {
  const server = http.createServer();
  const received = [];
  attachWsServer(server, (client) => {
    client.onMessage((bytes) => {
      const m = JSON.parse(new TextDecoder().decode(bytes));
      if (m[0] === 'EVENT') {
        received.push(m[1]);
        client.send(new TextEncoder().encode(JSON.stringify(['OK', m[1].id, ack, ''])));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ port: server.address().port, received, close: () => server.close() })));
}

test('relay pool: publish counts acks; non-acking relays count zero', async () => {
  const good = await startMockRelay({ ack: true });
  const bad = await startMockRelay({ ack: false });
  const pool = new RelayPool(
    [`ws://127.0.0.1:${good.port}`, `ws://127.0.0.1:${bad.port}`], { log: () => {} });
  try {
    assert.equal(await pool.connect(), 2);
    const event = buildHeadersEvent(
      { network: 'tbtc4', headersHex: t4.run.headers.slice(-12), tip: 138885 }, PRIV);
    const acks = await pool.publish(event);
    assert.equal(acks, 1, 'only the acking relay counts');
    assert.equal(good.received.length, 1);
    assert.equal(good.received[0].id, event.id);
  } finally {
    pool.close(); good.close(); bad.close();
  }
});

test('the publish path only ever serves the node\'s own VALIDATED chain', async () => {
  // a node synced from the real testnet4 vector run
  const checkpoint = {
    height: t4.run.startHeight,
    rawHeader: t4.run.headers[0],
    hash: codec.blockHash(codec.decode('BlockHeader', t4.run.headers[0])),
  };
  const node = new LightNode({
    codec, headerEngine: engine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await node.init();
  const source = {
    base: 'vector://',
    headersAfter: async (tipHash) => {
      const all = t4.run.headers;
      const idx = all.findIndex((h) => codec.blockHash(codec.decode('BlockHeader', h)) === tipHash);
      return idx < 0 ? [] : all.slice(idx + 1);
    },
  };
  await node.syncP2p(source);
  assert.equal(node.meta.tipHeight, t4.run.startHeight + t4.run.headers.length - 1);

  // event built strictly from the validated store
  const tip = node.meta.tipHeight;
  const headersHex = [];
  for (let h = tip - 11; h <= tip; h++) headersHex.push(codec.encodeHex('BlockHeader', await node.headerAt(h)));
  const event = buildHeadersEvent({ network: 'tbtc4', headersHex, tip }, PRIV);
  assert.equal(event.content, t4.run.headers.slice(-12).join(''), 'content equals the validated chain tail');

  // and a tampering source is rejected BEFORE anything could be published
  const tampered = {
    base: 'evil://',
    headersAfter: async () => [t4.run.headers[5].slice(0, 8) + 'deadbeef' + t4.run.headers[5].slice(16)],
  };
  await assert.rejects(() => node.syncP2p(tampered), /rejected/);
});
