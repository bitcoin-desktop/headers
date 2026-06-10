# Bitcoin Headers Distribution — Specification

**Status: DRAFT for review — spec first, code second.** Nothing in this repo is implemented
until this document is agreed.

This specifies how Bitcoin block headers are distributed across three complementary channels.
Headers are self-certifying (proof-of-work plus linkage), so **no channel, host, or publisher
is ever trusted** — consumers verify everything on receipt. Redundancy is therefore purely
additive: any party can run any channel, and disagreement is detectable rather than dangerous.

| channel | medium | mutability | cadence |
|---|---|---|---|
| 1. Live events | Nostr | replaceable | per block |
| 2. Epoch files | any static host | immutable | sealed every 2,016 blocks |
| 3. Current file | release asset / static host | replaced | periodic |

Common definitions:

- **header**: the 80-byte consensus serialization (version, prev hash, merkle root, time,
  bits, nonce); hex encoding is lowercase.
- **network**: one of `mainnet`, `testnet`, `testnet4`, `signet`, `regtest` — matching the
  NetworkParams names in [bitcoin-desktop/schema](https://bitcoin-desktop.github.io/schema/).
- **height/epoch**: epoch `n` covers heights `n·2016 … n·2016+2015`. An epoch is **sealed**
  once its last block has ≥ some confirmation depth (see Open Question 3).

---

## 1. Live events (Nostr)

A parameterized-replaceable event carrying the most recent headers.

```json
{
  "kind": 31021,
  "content": "<concatenated 80-byte headers, hex, oldest first>",
  "tags": [
    ["d", "<network>"],
    ["n", "<network>"],
    ["tip", "<height of newest header>"],
    ["tiphash", "<block hash of newest header, display order>"],
    ["start", "<height of oldest header>"],
    ["count", "<number of headers>"]
  ]
}
```

- `d` is the network name, so one publisher key maintains exactly one live event **per
  network**, and relays replace rather than accumulate.
- `content` carries 12 headers (~2 hours of mainnet blocks): enough to bridge short gaps and
  to confirm recent history; clients further behind use channels 2–3 or P2P.
- The event's `created_at` **is the liveness heartbeat**: a consumer (or watchdog) judges the
  feed healthy iff the newest event is younger than a few block intervals.

**Trust model (normative):** publishers are identified but **not trusted**. Clients MUST
verify every header (PoW against bits, linkage, and — where they maintain a chain — the full
header rules) and SHOULD follow multiple publisher keys, preferring the heaviest verified
chain. A publisher key is a brand and a filter, never a security boundary.

**Publisher conduct (normative):** a publisher MUST validate headers against its own
maintained chain before signing; MUST exit (crash-only) rather than run silently wedged, so
supervisors can act; SHOULD publish to ≥3 relays.

## 2. Epoch files (immutable bulk)

```
{base}/{network}/epoch/{n}.bin      exactly 2016 × 80 = 161,280 bytes
{base}/{network}/manifest.json
```

`manifest.json`:

```json
{
  "network": "mainnet",
  "epochLength": 2016,
  "sealed": 459,
  "sha256": { "0": "<hex>", "1": "<hex>", "…": "…" },
  "generator": "<tool name+version>",
  "updated": "<ISO time>"
}
```

- Epoch files are **byte-deterministic**: any party regenerating from the same chain produces
  identical files; mirrors are audited by comparing `sha256` entries.
- A generator MUST validate the full chain from genesis (schema rulesets) before writing.
- Mirrors are dumb hosts (gh-pages, R2, pods, IPFS, mesh peers); consumers carry a mirror
  list and fail over freely.
- The legacy bitcoin.cc JSON epoch format remains readable by consumers but is not produced
  by new generators.

## 3. Current file (the unsealed remainder)

```
{network}.current.bin    headers from the last sealed epoch boundary to the tip
```

Replaced in place (e.g. as a GitHub release asset — proven pattern, no git history growth).
Consumers treat it as a convenience snapshot of the hot end; channels 1 and P2P remain the
fresher sources. Accompanied by `{network}.current.json` carrying tip height/hash, sha256,
and timestamp.

---

## Open questions for review

1. **Kind number.** This draft says `31021` (matches the published NIP-XX draft). The
   currently-live publisher emits `33333` with `n: btc` — an undocumented divergence. Decide:
   keep 31021 (and migrate the live feed), adopt 33333 (and rewrite the NIP), or pick fresh.
2. **`d` tag.** Old draft used `d: latest` (one event per pubkey *total*); this draft uses
   `d: <network>` (one per network). Confirm.
3. **Seal depth.** How many confirmations before an epoch file is written — 6? 100? (Deeper =
   reorg-proof files; shallower = fresher bulk.)
4. **Header count in live events.** 12 (status quo) — enough? More costs little.
5. **Signing dependency.** The publisher needs BIP-340 *signing* (never in the schema repo):
   take `@noble/secp256k1` as the one audited dependency, or write the ~80-line signer in
   house style?

---

*Independent community project; not affiliated with Bitcoin Core.*
