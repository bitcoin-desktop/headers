#!/usr/bin/env node
// The clean-room NIP-33333 publisher, per SPEC.md (AGREED v1).
//
// Contract highlights:
//   - validates every header against its OWN maintained chain (schema
//     engines, real P2P) before signing — can go quiet, never publishes
//     garbage under the key
//   - crash-only: stall watchdog exits if the chain goes silent beyond
//     reason; sockets reconnect with backoff; failures are loud; the
//     supervisor (pm2/systemd) does the resurrecting
//   - key from environment or file, NEVER argv
//
//   NOSTR_PRIVKEY=nsec1… node publisher/publisher.mjs --network mainnet
//   node publisher/publisher.mjs --network testnet4 --key-file ~/.keys/headers
//
// Options: --network mainnet|testnet4   (wire tag btc|tbtc4)
//          --relays wss://a,wss://b     (default: damus, nos.lol, nostr.band)
//          --peer host[:port]           (default: DNS seed)
//          --u url[,hint]               (repeatable; NIP-33333 data-source tags)
//          --stall-minutes N            (default 120 mainnet / 180 testnet4)

import { readFile } from 'node:fs/promises';
import dns from 'node:dns/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { LightNode, MemoryStorage } from '@bitcoin-desktop/schema/codec/node.js';
import { PeerConnection } from '@bitcoin-desktop/schema/bridge/bridge.mjs';
import { parsePrivateKey, publicKey, buildHeadersEvent, RelayPool } from './nostr.js';

const HEADERS_COUNT = 12;
const NETWORKS = {
  mainnet: { id: 'btc:mainnet', wire: 'btc', seed: 'seed.bitcoin.sipa.be', port: 8333, stall: 120 },
  testnet4: { id: 'btc:testnet4', wire: 'tbtc4', seed: 'seed.testnet4.bitcoin.sprovoost.nl', port: 48333, stall: 180 },
};
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const fail = (msg, code = 1) => { console.error(`[${new Date().toISOString()}] FATAL: ${msg}`); process.exit(code); };

// ---- config (key never via argv) ----
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const net = NETWORKS[opt('network') ?? 'mainnet'];
if (!net) fail(`unknown network (use: ${Object.keys(NETWORKS).join('|')})`);

let keyInput = process.env.NOSTR_PRIVKEY ?? null;
if (!keyInput && opt('key-file')) keyInput = (await readFile(opt('key-file'), 'utf8')).trim();
if (!keyInput) fail('no key: set NOSTR_PRIVKEY or --key-file (never pass keys as arguments)');
const priv = parsePrivateKey(keyInput);
log(`publisher pubkey: ${publicKey(priv)}`);

const relays = opt('relays')?.split(',').map((s) => s.trim()) ?? DEFAULT_RELAYS;
const uTags = opts('u').map((u) => u.split(','));
const stallMs = (parseInt(opt('stall-minutes') ?? String(net.stall), 10)) * 60000;

// ---- engines from the schema (loaded from the dependency, not the network) ----
const dep = (p) => readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8').then(JSON.parse);
const p2pSchema = await dep('schema/p2p.jsonld');
const chainSchema = await dep('schema/chain.jsonld');
const validateSchema = await dep('schema/validate.jsonld');
const codec = new Codec(await dep('schema/core.jsonld'), await dep('schema/proof.jsonld'), p2pSchema);
const p2p = P2pEngine.fromSchemas(codec, p2pSchema, chainSchema, net.id);
const headerEngine = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, net.id);

const node = LightNode.fromSchemas(codec, chainSchema, validateSchema, net.id, {
  storage: new MemoryStorage(),
});
await node.init();
log(`chain anchored at checkpoint ${node.meta.tipHeight.toLocaleString()} (${net.id})`);

// ---- peer connection (real P2P) ----
let host = opt('peer'), port = net.port;
if (host?.includes(':')) [host, port] = [host.split(':')[0], parseInt(host.split(':')[1], 10)];
if (!host) host = (await dns.resolve4(net.seed))[0];

const conn = new PeerConnection(p2p, { onStatus: (s) => log(`peer: ${s}`) });
await conn.connect(host, port);
log(`connected to ${host}:${port}`);

// the LightNode syncs through the live peer
const source = {
  base: `p2p://${host}`,
  headersAfter: async (tipHash) => {
    conn.send('getheaders', { version: 70016, blockLocator: [tipHash], hashStop: '0'.repeat(64) });
    const reply = await conn.waitFor(['headers']);
    if (!reply.decoded) return [];
    return reply.payload.entries.map((e) => codec.encodeHex('BlockHeader', e.header));
  },
};

// ---- publish path: only ever from our OWN validated store ----
const pool = new RelayPool(relays, { log });
if (await pool.connect() === 0) fail('no relays reachable');

let lastBlockAt = Date.now();
let lastPublishedTip = 0;
let consecutivePublishFailures = 0;

async function publishTip() {
  const tip = node.meta.tipHeight;
  if (tip === lastPublishedTip) return;
  const headersHex = [];
  for (let h = tip - HEADERS_COUNT + 1; h <= tip; h++) {
    const header = await node.headerAt(h);
    if (!header) { log(`tip window incomplete at ${h}; skipping publish`); return; }
    headersHex.push(codec.encodeHex('BlockHeader', header));
  }
  const event = buildHeadersEvent({ network: net.wire, headersHex, tip, uTags }, priv);
  const acks = await pool.publish(event);
  if (acks > 0) {
    lastPublishedTip = tip;
    consecutivePublishFailures = 0;
    log(`published tip ${tip.toLocaleString()} (${event.id.slice(0, 12)}…) — ${acks}/${relays.length} relays acked`);
  } else {
    consecutivePublishFailures++;
    log(`publish NOT acked by any relay (${consecutivePublishFailures} consecutive)`);
    if (consecutivePublishFailures >= 5) fail('5 consecutive unacked publishes', 3);
  }
}

async function syncAndPublish(reason) {
  try {
    const before = node.meta.tipHeight;
    await node.syncP2p(source, { maxBatches: 8 });
    if (node.meta.tipHeight > before) {
      lastBlockAt = Date.now();
      log(`${reason}: validated to ${node.meta.tipHeight.toLocaleString()} (+${node.meta.tipHeight - before})`);
    }
    await publishTip();
  } catch (e) {
    // a validation rejection means the PEER fed us garbage: loud + fatal,
    // the supervisor restarts us onto (likely) a different seed peer
    fail(`sync/publish: ${e.message}`, 4);
  }
}

// initial: catch up from checkpoint, publish once
await syncAndPublish('initial sync');

// react to peer block announcements
conn.onMessage = (msg) => {
  if (msg.command === 'inv' && msg.decoded
      && msg.payload.items.some((i) => i.type === 2 || i.type === 1073741826)) {
    syncAndPublish('new block announced');
  }
};

// belt-and-braces poll (inv can be missed) + stall watchdog (crash-only:
// alive-but-silent is the one failure no supervisor can see — so we die)
setInterval(() => syncAndPublish('poll'), 60000);
setInterval(() => {
  const quiet = Date.now() - lastBlockAt;
  if (quiet > stallMs) fail(`no new block for ${Math.round(quiet / 60000)} min — exiting for restart`, 2);
}, 60000);

process.on('SIGINT', () => { log('shutting down'); conn.socket.destroy(); pool.close(); process.exit(0); });
process.on('SIGTERM', () => { conn.socket.destroy(); pool.close(); process.exit(0); });
log(`watching for blocks (stall limit ${stallMs / 60000} min)`);
