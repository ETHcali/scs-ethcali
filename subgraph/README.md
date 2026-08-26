# ETH Cali donations subgraph

Indexes `DonationVault` and `DonationReceipt1155` on **Celo, Optimism, Base and
Ethereum**.

Both contracts share one CREATE2 address on every chain, so a single manifest
covers all four — only the start block differs. Addresses and start blocks live
in `networks.json`; `graph build --network <name>` substitutes them into
`subgraph.yaml`, rewriting that file in place. That rewrite is normal CLI
behaviour, not a stray edit.

```
DonationVault        0x223f70933a14E847D83ff1e906C8CCf6962d36d3
DonationReceipt1155  0xA4E67a7bc9e17D6eBBCaa369727b9e8949D278e0
```

## Build

```bash
npm install
npm run codegen
npm run build:celo      # or :optimism :base :mainnet
```

## Deploy

Each chain is its **own subgraph** — The Graph has no multi-chain subgraph, so
four deployments, four slugs. Create them in
[Subgraph Studio](https://thegraph.com/studio/), then:

```bash
npx graph auth <deploy-key>
npm run deploy:celo     # prompts for a version label, e.g. v0.0.1
```

Studio gives a rate-limited development endpoint immediately. Publishing to the
decentralized network is a separate, on-chain step from the Studio UI: it mints
the subgraph into the registry on **Arbitrum One**, so it costs gas there, and
indexers only pick it up once it carries curation signal.

## Start blocks

Verified by binary search on `getCode` against archive nodes, then sanity
checked two ways: the receipt contract must be created no later than the vault
(it is deployed first in the same run), and timestamps must follow the launch
order celo → optimism → base → ethereum.

| Network | Receipt | Vault | Deployed |
|---|---|---|---|
| celo | 75391771 | 75391791 | 2026-08-21 06:08:49Z |
| optimism | 155847025 | 155847027 | 06:13:47Z |
| base | 50251815 | 50251816 | 06:16:17Z |
| mainnet | 25801674 | 25801675 | 06:20:23Z |

An earlier attempt used non-archive RPCs, which error on historical `getCode`.
Read as "no code", those errors converge on the node's retention edge and
produce blocks that are far too late — one set even claimed the receipt was
created *after* the vault it precedes. Too late is the dangerous direction: the
subgraph would start after real donations and never see them. If you re-derive
these, check the two invariants above.

## Schema notes

- **Amounts are never scaled.** They are `BigInt` in the token's own base units.
  USDC is 6 decimals and COPm is 18; dividing here would bake one token's
  decimals into every other. Format with `Token.decimals` at the render
  boundary.
- **`Token.decimals` is read from the chain**, not assumed. A token whose calls
  revert is stored as `UNKNOWN`/18 rather than dropped, so the donation is still
  indexed.
- **`network`** is stamped on `Campaign`, `Donation` and `Receipt` from
  `dataSource.network()`, because the contract addresses are identical across
  chains and are not enough to tell rows apart once a client merges them.
- **`donorCount` counts people, not donations** — it increments only when a
  donor has no existing `DonorTokenTotal` for that campaign and token.
- **`TxDonation`** is internal plumbing. `Forwarded`, `ReceiptIssued` and
  `ReceiptFailed` fire later in the same transaction as the `Donated` that
  caused them but carry no log index, so the donation handler records where it
  wrote and the others look it up. Keyed by transaction *and* campaign so a
  multicall donating to two campaigns still resolves.
- **`available` tracks raised minus paid out.** In auto-forward mode it stays
  at ~0 by design, because the vault never holds custody. Use `totalRaised` for
  "how much has this campaign raised" — `available` would render a healthy
  campaign as permanently empty.
- **`ForwardFailure` is its own entity**, not a flag. The donation still
  succeeded and the vault is now holding funds it did not expect to hold, which
  is a state someone has to act on.
