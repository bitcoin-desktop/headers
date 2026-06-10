// Nostr event construction, signing, and relay publishing for the
// NIP-33333 publisher. Signing uses the audited noble secp256k1
// implementation (BIP-340), per SPEC.md — the one operation where an
// implementation bug leaks the key gets the boring choice.

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

const sha256 = (data) => createHash('sha256').update(data).digest();
const hex = (b) => Buffer.from(b).toString('hex');

// nsec1… (bech32) or 64-char hex -> 32-byte key.
export function parsePrivateKey(input) {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  if (s.startsWith('nsec1')) {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const data = [...s.slice(5, -6)].map((c) => CHARSET.indexOf(c));
    if (data.includes(-1)) throw new Error('bad nsec');
    let acc = 0, bits = 0;
    const out = [];
    for (const v of data) {
      acc = (acc << 5) | v; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    if (out.length !== 32) throw new Error('bad nsec length');
    return Buffer.from(out);
  }
  throw new Error('key must be nsec1… or 64-char hex');
}

export const publicKey = (priv) => hex(schnorr.getPublicKey(priv));

// NIP-01 event id + BIP-340 signature.
export function finalizeEvent(event, priv) {
  const serial = JSON.stringify([
    0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
  ]);
  event.id = hex(sha256(Buffer.from(serial, 'utf8')));
  event.sig = hex(schnorr.sign(event.id, priv));
  return event;
}

// NIP-33333 header event for a network.
export function buildHeadersEvent({ network, headersHex, tip, uTags = [] }, priv) {
  const start = tip - headersHex.length + 1;
  return finalizeEvent({
    kind: 33333,
    pubkey: publicKey(priv),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'latest'],
      ['n', network],
      ['tip', String(tip)],
      ['alt', `Bitcoin headers ${start}-${tip}`],
      ...uTags.map((u) => ['u', ...[].concat(u)]),
    ],
    content: headersHex.join(''),
  }, priv);
}

// A reconnecting relay connection that tracks OK acknowledgements.
export class Relay {
  constructor(url, { log = () => {} } = {}) {
    this.url = url;
    this.log = log;
    this.acks = new Map(); // event id -> resolve
    this.closed = false;
    this.backoff = 1000;
  }

  async connect() {
    if (this.closed) return;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer'; // some relays/mocks frame binary
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
      this.ws.onopen = () => { clearTimeout(t); resolve(); };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error('connect failed')); };
    });
    this.backoff = 1000;
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      if (m[0] === 'OK') this.acks.get(m[1])?.(m[2]);
    };
    this.ws.onclose = () => this.#reconnect();
  }

  async #reconnect() {
    if (this.closed) return;
    this.log(`relay ${this.url}: reconnecting in ${this.backoff}ms`);
    await new Promise((r) => setTimeout(r, this.backoff));
    this.backoff = Math.min(this.backoff * 2, 60000);
    try { await this.connect(); } catch { this.#reconnect(); }
  }

  // true iff the relay acks within the timeout.
  publish(event, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== 1) return resolve(false);
      const timer = setTimeout(() => { this.acks.delete(event.id); resolve(false); }, timeoutMs);
      this.acks.set(event.id, (ok) => {
        clearTimeout(timer);
        this.acks.delete(event.id);
        resolve(!!ok);
      });
      this.ws.send(JSON.stringify(['EVENT', event]));
    });
  }

  close() { this.closed = true; this.ws?.close(); }
}

export class RelayPool {
  constructor(urls, { log = () => {} } = {}) {
    this.relays = urls.map((u) => new Relay(u, { log }));
    this.log = log;
  }
  async connect() {
    const results = await Promise.allSettled(this.relays.map((r) => r.connect()));
    const up = results.filter((r) => r.status === 'fulfilled').length;
    this.log(`relays connected: ${up}/${this.relays.length}`);
    return up;
  }
  // returns the number of relays that acked.
  async publish(event) {
    const oks = await Promise.all(this.relays.map((r) => r.publish(event)));
    return oks.filter(Boolean).length;
  }
  close() { this.relays.forEach((r) => r.close()); }
}
