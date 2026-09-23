# ETHcali Smart Contracts

Identity, faucet, merchandise, hackathon staking, and donation contracts for the ETHcali
ecosystem on Base, Ethereum, Unichain, Optimism, and Celo.

## Contracts

| Contract | Description |
|----------|-------------|
| **ZKPassportNFT** | Soulbound ERC721 — verified identity via ZKPassport |
| **FaucetManager** | Multi-vault ETH faucet with ZKPassport & ERC-20/ERC-721 token gating |
| **Swag1155** | ERC-1155 merch proof-of-purchase, one inventory sold through two channels — `buy()` on-chain in any configured token, or `claim()` with an EIP-712 voucher signed after a paid Shopify order. Clone-only. |
| **SwagFactory** | Clones and configures one `Swag1155` per product; maintains the registry of all collections |
| **HackathonStaking** | Commitment bonds for hackathons — stake to register, reclaim on submission, no-show bonds sweep to a prize pool |
| **DonationVault** | Multi-campaign donation vault — any currency per campaign, on-chain donor attribution, beneficiary-locked withdrawals |
| **DonationReceipt1155** | Admin-configurable, soulbound-by-default ERC-1155 receipts issued to donors by tier |

## Setup

```bash
npm install
cp .env.example .env   # Fill in your keys
```

### `.env` variables

```bash
PRIVATE_KEY=0x...

# Admins (set at deployment)
SWAG_ADMIN=0x...
FAUCET_ADMIN=0x...
ZK_PASSPORT_ADMIN=0x...
SWAG_TREASURY_ADDRESS=0x...
SWAG_SIGNER=0x...            # backend key that signs Shopify claim vouchers (passed to deployCollection by seed:swag)

# ZKPassport SDK (must match the query built in the frontend)
ZKPASSPORT_DOMAIN=ethcali.org
ZKPASSPORT_SCOPE=ethcali-verification

# RPC
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
BASE_RPC_URL=https://base-mainnet.infura.io/v3/YOUR_KEY
UNICHAIN_RPC_URL=https://unichain-mainnet.infura.io/v3/YOUR_KEY
OPTIMISM_RPC_URL=https://optimism-mainnet.infura.io/v3/YOUR_KEY
CELO_RPC_URL=https://forno.celo.org

# Verification
ETHERSCAN_API_KEY=...
BASESCAN_API_KEY=...
UNICHAIN_API_KEY=...
OPTIMISM_API_KEY=...
CELOSCAN_API_KEY=...

# USDC (network-specific)
USDC_ADDRESS_ETH=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
USDC_ADDRESS_BASE=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_ADDRESS_UNI=0x078D782b760474a361dDA0AF3839290b0EF57AD6
USDC_ADDRESS_OP=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85
USDC_ADDRESS_CELO=0xcebA9300f2b948710d2653dD7B07f33A8B32118C
```

## Commands

```bash
npm run compile          # Compile contracts
npm run test:all         # Hardhat flows + Foundry invariants — the real gate
npm test                 # Hardhat suite only
npm run test:forge       # Foundry invariants only (test:forge:deep before a mainnet deploy)

npm run deploy:base      # Deploy all contracts to Base
npm run deploy:ethereum  # Deploy all contracts to Ethereum
npm run deploy:unichain  # Deploy all contracts to Unichain
npm run deploy:optimism  # Deploy all contracts to Optimism
npm run deploy:celo      # Deploy all contracts to Celo

npm run verify:base      # Verify on Basescan (also :ethereum, :unichain, :optimism, :celo)

npm run setup:frontend   # Generate ABIs & addresses for frontend

# Deploy the products in swag-catalogue.json via SwagFactory (run after deploy:*).
# Idempotent — skips SKUs already in the registry. SWAG_SIGNER becomes each collection's voucher signer.
SWAG_SIGNER=0x... npm run seed:swag -- --network base
npm run seed:swag:dry -- --network base   # validate the catalogue, send nothing
```

## Swag1155

One inventory, two sales channels. Shopify owns commerce — catalogue, fiat pricing,
discount codes, customer accounts, fulfilment. The contract proves that a specific wallet
owns a specific item, which is the one thing Shopify cannot do.

Each product is a `Swag1155` **clone** deployed by `SwagFactory`; a directly deployed
`Swag1155` locks itself in its constructor and can never be initialised. Each size is a
`tokenId`, 1-indexed in catalogue order.

Per variant, supply is split at configuration time into two counters that never touch:

| Bucket | Sold via | Paid |
|--------|----------|------|
| `onchainCap` | `buy(tokenId, quantity, paymentToken)` | in any token the admin configured with `setPaymentOption` — an ERC-20 or native (`0xEeee…EEeE`). Price is per token, in that token's own base units (USDC 6 decimals, COPm 18). |
| `voucherCap` | `claim(voucher, signature)` | already, on Shopify. The backend signs an EIP-712 `Claim(tokenId, to, quantity, orderRef, deadline)` voucher with a `SIGNER_ROLE` key; the buyer (or anyone) submits it. |

Set the Shopify product's inventory to exactly `voucherCap` and neither channel can eat
the other's stock.

- Proceeds go straight to `treasury` — the contract never holds funds and rejects bare ETH.
- `orderRef` (hash of the Shopify order id) is burned on claim, so a replayed webhook
  cannot mint twice. A voucher is bound to one collection's EIP-712 domain. A refunded
  order is closed with `cancelOrder(orderRef)` (`ADMIN_ROLE`), which burns the same key;
  cancelling an order that already minted reverts, so a late refund is loud.
- Every unit gets a sequential serial per `tokenId`, **starting at 0**, across both
  channels. Storage keeps only the counter, `nextSerial(tokenId)`; who got which serial
  is one `SerialsAssigned(tokenId, to, firstSerial, quantity)` event per mint.
- A variant must have stock in at least one channel (`EmptyVariant`) and every price
  must be non-zero (`ZeroPrice`) — free merch is a signed voucher, not a zero price.
- `canBuy(tokenId, quantity, paymentToken)` and `canClaim(voucher, signature)` mirror
  every check in the writes and return `(allowed, reason)` so the UI can disable a
  button with a reason.
- Caps can be raised at any time, never cut below what that channel already minted.
- Roles on each collection: `DEFAULT_ADMIN_ROLE` (treasury, admins, signers) and
  `ADMIN_ROLE` (variants, prices, pause, cancel) go to the `itemAdmin`. `SIGNER_ROLE`
  goes to the `signer` passed to `deployCollection` (`seed-swag.ts` passes
  `SWAG_SIGNER`); with the zero address no signer is granted and every `claim()`
  reverts with `InvalidSignature` until the `itemAdmin` calls `addSigner`.

Full API: [docs/SWAG1155_CONTRACT_REFERENCE.md](docs/SWAG1155_CONTRACT_REFERENCE.md).
Foundry invariants: `test/forge/Swag1155.invariants.t.sol`.

### SwagFactory

`SwagFactory` is a plain `AccessControl` contract (no proxy). `deployCollection(name,
sku, treasury, itemAdmin, sizes[], signer)` clones the implementation, calls
`setVariantWithURI` and `setPaymentOption` for every size, hands `DEFAULT_ADMIN_ROLE` +
`ADMIN_ROLE` to `itemAdmin`, grants `SIGNER_ROLE` to `signer` (skipped when zero),
renounces its own roles, and registers the collection.

```typescript
await swagFactory.write.deployCollection([
  "ETH Cali Hoodie",
  "ETH-CALI-HOODIE-2026",
  TREASURY_ADDRESS,
  ITEM_ADMIN_ADDRESS,
  [
    {
      metadataURI: "ipfs://Qm…/hoodie-m.json",
      onchainCap: 10n,   // sellable via buy()
      voucherCap: 30n,   // reserved for Shopify — set Shopify inventory to this
      active: true,
      payments: [
        { token: USDC_ADDRESS, price: 45_000_000n },                                    // 45 USDC
        { token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", price: 18_000_000_000_000_000n }, // 0.018 ETH
      ],
    },
  ],
  BACKEND_SIGNER_ADDRESS, // SIGNER_ROLE from block one; zero address to grant none
]);

// Storefront: discover products from the factory — never hardcode a Swag1155 address
const collections = await swagFactory.read.getActiveCollections();
```

In practice use `npm run seed:swag`: it reads `swag-catalogue.json`, parses
human-readable prices with each token's own decimals, skips SKUs already deployed, and
passes `SWAG_SIGNER` as the signer (repairing older collections via `addSigner`).

Registry can be reconstructed at any time from `CollectionDeployed` events.

## Documentation

Per-contract API references and admin guide live in [`docs/`](docs/):

- [ZKPassportNFT Reference](docs/ZKPASSPORT_CONTRACT_REFERENCE.md)
- [FaucetManager Reference](docs/FAUCET_CONTRACT_REFERENCE.md)
- [Swag1155 Reference](docs/SWAG1155_CONTRACT_REFERENCE.md)
- [Security & Admin Guide](docs/SECURITY_ADMIN_GUIDE.md)

Frontend integration guide: [FRONTEND_CHANGES.md](FRONTEND_CHANGES.md)

## Networks

| Network | Chain ID | USDC |
|---------|----------|------|
| Ethereum Mainnet | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base Mainnet | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Unichain Mainnet | 130 | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` |
| Optimism Mainnet | 10 | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| Celo Mainnet | 42220 | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` |

## License

MIT
