# headers

Bitcoin header distribution infrastructure: live Nostr events, immutable epoch files, and a
current-tip snapshot — all verify-on-receipt, so no host or publisher needs trusting.

**Spec: AGREED v1** — see [SPEC.md](SPEC.md). First implementation: the clean-room
**publisher** (live events channel).

## Publisher

```bash
npm install
NOSTR_PRIVKEY=nsec1... npm run publisher -- --network mainnet     # or testnet4
```

Per the spec: it maintains its own validated chain (schema engines over real P2P) and only
ever signs headers that passed every rule; it is crash-only (a 2–3h block silence makes it
exit so the supervisor restarts it; five unacked publishes likewise); keys come from the
environment or `--key-file`, never argv. Signing is the audited noble BIP-340 — and the test
suite cross-checks it against the schema's own verifier.

Successor to the [bitcoincc](https://github.com/bitcoincc) header work (bitcoin.cc), which it
will backfill once proven. Built on
[bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema) for all validation.

> Independent community project; not affiliated with Bitcoin Core.
