# Bitcoin Headers Distribution — Specification

**Status: AGREED v1** — spec first, code second; all review questions resolved below.

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
  once its last block has ≥ 12 confirmations (matching the NIP's 12-header window; a
  generator MAY deepen this per network).

---

## 1. Live events (Nostr) — NIP-33333

The live channel is specified by **[NIP-33333](https://nip-333.github.io/)** (Bitcoin Block
Headers over Nostr) and this spec defers to it entirely. Summary of the normative points:

- kind `33333`, parameterized replaceable; `d` = the network code, equal to `n` — one
  replaceable stream per network per key (relays replace on `(pubkey, kind, d)`)
- `n`: `btc` | `tbtc3` | `tbtc4` (mapping to schema network names `mainnet` / `testnet` /
  `testnet4`)
- content: exactly 12 concatenated headers, lowercase hex, ascending, tip last
- `tip` recommended; `u` tags point at bulk data sources (channels 2–3 below) with optional
  `epoch`/`archive` hints; `p` tags name other publishers; `alt` per NIP-31

The event's `created_at` **is the liveness heartbeat**: the feed is healthy iff the newest
event is younger than a few block intervals.

**Trust model (normative here and in the NIP's spirit):** publishers are identified but
**not trusted**. Clients MUST verify every header (PoW, linkage, and — where they maintain a
chain — the full header rules) and SHOULD follow multiple publisher keys (`p` tags help
discovery), preferring the heaviest verified chain. A publisher key is a brand and a filter,
never a security boundary.

**Publisher conduct (normative, this spec):** a publisher MUST validate headers against its
own maintained chain before signing; MUST exit (crash-only) rather than run silently wedged,
so supervisors can act; SHOULD publish to ≥3 relays; SHOULD carry `u` tags referencing
channels 2–3.

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

## Resolved in review

- **Kind / event format**: defer to published **NIP-33333** (kind 33333, `d` = network code,
  `n: btc|tbtc3|tbtc4`, 12 headers). The older NIP-XX (31021) draft is superseded; bitcoincc
  copies get backfilled to point at NIP-33333. (Earlier drafts used `d: latest` for all
  networks — superseded because the `n` tag is not part of the replaceable-event key, so one
  publisher key could carry only a single network stream. Clients MAY dual-read
  `["<net>", "latest"]` during migration, keeping the newest verified event.)
- **Network naming**: NIP codes on the wire (`btc`…), schema names (`mainnet`…) everywhere
  else; the mapping is normative above.
- **Seal depth**: 12 confirmations, matching the NIP's 12-header window — an epoch file is
  written only once every header in it is at least 12 deep. Generators MAY deepen per
  network.
- **Signing dependency**: `@noble/curves` BIP-340 signing is the one audited dependency —
  signing is the single operation where an implementation bug leaks the key. Events are
  cross-verified against the schema's own `verifySchnorr` in tests.

---

*Independent community project; not affiliated with Bitcoin Core.*
