#!/usr/bin/env node
// Outside-view watchdog probe: asks the same question a consumer would —
// "is there a fresh, valid header event for each network stream right now?"
//
// Checks per stream (d = network code, per NIP-333):
//   - found on relays, and how many agree
//   - freshness: event age within the per-network threshold
//   - validity: 12 headers decode, link prevBlockHash -> hash, and meet
//     their own PoW target — the publisher is untrusted, same as any client
//
// Prints one line per stream plus a JSON summary. Exit 0 healthy,
// 1 unhealthy, 2 probe failure (e.g. no relay reachable).
//
//   node watchdog/probe.js [--relays wss://a,wss://b] [--author <hex>] [--json]

import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';

export const PUBLISHER = 'cccccccc829b802b7bf52d43edf7cfe62ac89f332a318b6826ac8bd6e73660da';
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];
// freshness thresholds are generous multiples of expected block cadence:
// loose enough that a slow chain is not an incident, tight enough that a
// wedged publisher is caught the same day
export const STREAMS = [
  { d: 'btc', maxAgeMin: 180 },
  { d: 'tbtc4', maxAgeMin: 360 },
];

const dep = (p) => readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8').then(JSON.parse);

const compactTarget = (bits) => {
  const exp = BigInt(bits >>> 24);
  const mant = BigInt(bits & 0x007fffff);
  return exp <= 3n ? mant >> (8n * (3n - exp)) : mant << (8n * (exp - 3n));
};

// fetch the newest matching event from one relay; null on miss/timeout
function fetchEvent(url, { author, d, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let ws;
    const done = (v) => { clearTimeout(timer); try { ws?.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    try { ws = new WebSocket(url); } catch { return done(null); }
    ws.binaryType = 'arraybuffer'; // some relays/mocks frame binary
    let newest = null;
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'probe',
      { kinds: [33333], authors: [author], '#d': [d], limit: 1 }]));
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      if (m[0] === 'EVENT') {
        const e = m[2];
        // never trust the relay's filtering — re-check author and d ourselves
        const dTag = e.tags?.find((t) => t[0] === 'd')?.[1];
        if (e.kind === 33333 && e.pubkey === author && dTag === d
            && (!newest || e.created_at > newest.created_at)) newest = e;
      } else if (m[0] === 'EOSE') done(newest);
    };
    ws.onerror = () => done(newest);
    ws.onclose = () => done(newest);
  });
}

// decode + verify 12 headers: shape, linkage, PoW. Returns { tip, issues }.
export function verifyContent(codec, event) {
  const issues = [];
  const content = event.content ?? '';
  if (!/^[0-9a-f]+$/.test(content) || content.length !== 12 * 160) {
    return { issues: [`content is not 12 headers (${content.length} hex chars)`] };
  }
  let prevHash = null;
  for (let i = 0; i < 12; i++) {
    const header = codec.decode('BlockHeader', content.slice(i * 160, (i + 1) * 160));
    const hash = codec.blockHash(header);
    if (prevHash && header.prevBlockHash !== prevHash) issues.push(`header ${i} does not link to header ${i - 1}`);
    if (BigInt('0x' + hash) > compactTarget(header.bits)) issues.push(`header ${i} fails its PoW target`);
    prevHash = hash;
  }
  const tip = parseInt(event.tags.find((t) => t[0] === 'tip')?.[1] ?? '', 10);
  if (!Number.isFinite(tip)) issues.push('missing/invalid tip tag');
  return { tip, tipHash: prevHash, issues };
}

export async function probe({ relays = DEFAULT_RELAYS, author = PUBLISHER, streams = STREAMS, now = Date.now() } = {}) {
  const codec = new Codec(await dep('schema/core.jsonld'), await dep('schema/proof.jsonld'));
  const report = { healthy: true, probedAt: new Date(now).toISOString(), relays: relays.length, streams: {} };

  for (const { d, maxAgeMin } of streams) {
    const results = await Promise.all(relays.map((r) => fetchEvent(r, { author, d })));
    const events = results.filter(Boolean);
    const s = { found: events.length > 0, relaysAnswering: events.length, issues: [] };

    if (!s.found) {
      s.issues.push(`no event on any of ${relays.length} relays`);
    } else {
      const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      const ids = new Set(events.map((e) => e.id));
      if (ids.size > 1) s.note = `relays differ (${ids.size} ids) — usually propagation lag`;
      s.ageMinutes = Math.round((now / 1000 - newest.created_at) / 60);
      if (s.ageMinutes > maxAgeMin) s.issues.push(`stale: ${s.ageMinutes} min old (limit ${maxAgeMin})`);
      const v = verifyContent(codec, newest);
      s.tip = v.tip;
      s.issues.push(...v.issues);
      s.valid = v.issues.length === 0;
    }
    s.healthy = s.issues.length === 0;
    if (!s.healthy) report.healthy = false;
    report.streams[d] = s;
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const report = await probe({
    relays: opt('relays')?.split(',').map((s) => s.trim()) ?? DEFAULT_RELAYS,
    author: opt('author') ?? PUBLISHER,
  });
  for (const [d, s] of Object.entries(report.streams)) {
    console.log(s.healthy
      ? `✓ ${d}  tip ${s.tip?.toLocaleString()}  age ${s.ageMinutes}m  ${s.relaysAnswering}/${report.relays} relays${s.note ? `  (${s.note})` : ''}`
      : `✗ ${d}  ${s.issues.join('; ')}`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  const streams = Object.values(report.streams);
  if (streams.length > 1 && streams.every((s) => !s.healthy)) {
    console.log('! all streams unhealthy — suspect the publisher side (machine, pm2, relays), not the chains');
  }
  // 2 = blind (no relay answered for any stream), 1 = saw something unhealthy, 0 = healthy
  process.exit(streams.every((s) => s.relaysAnswering === 0) ? 2 : report.healthy ? 0 : 1);
}
