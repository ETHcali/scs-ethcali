# ETHcali Smart Contracts

Identity, faucet, merchandise, hackathon staking, and donation contracts for the ETHcali
ecosystem on Base, Ethereum, Unichain, Optimism, and Celo.

## Contracts

| Contract | Description |
|----------|-------------|
| **ZKPassportNFT** | Soulbound ERC721 — verified identity via ZKPassport |
| **FaucetManager** | Multi-vault ETH faucet with ZKPassport & ERC-20/ERC-721 token gating |
| **Swag1155** | ERC-1155 merchandise store — USDC payments, royalties, POAP/holder discounts, serial numbers |
| **SwagFactory** | Deploys one `Swag1155` per product; maintains a registry of all collections |
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

# ZKPassport SDK (must match the query built in the frontend)
ZKPASSPORT_DOMAIN=ethcali.org
ZKPASSPORT_SCOPE=ethcali-verification

# RPC
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
BASE_RPC_URL=https://base-mainnet.infura.io/v3/YOUR_KEY
UNICHAIN_RPC_URL=https://unichain-mainnet.infura.io/v3/YOUR_KEY
OPTIMISM_RPC_URL=https://optimism-mainnet.infura.io/v3/YOUR_KEY

# Verification
ETHERSCAN_API_KEY=...
BASESCAN_API_KEY=...
UNICHAIN_API_KEY=...
OPTIMISM_API_KEY=...

# USDC (network-specific)
USDC_ADDRESS_ETH=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
USDC_ADDRESS_BASE=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_ADDRESS_UNI=0x078D782b760474a361dDA0AF3839290b0EF57AD6
USDC_ADDRESS_OP=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85
```

## Commands

```bash
npm run compile          # Compile contracts
npm test                 # Run all 141 tests

npm run deploy:base      # Deploy all contracts to Base
npm run deploy:ethereum  # Deploy all contracts to Ethereum
npm run deploy:unichain  # Deploy all contracts to Unichain
npm run deploy:optimism  # Deploy all contracts to Optimism

npm run verify:base      # Verify on Basescan
npm run verify:ethereum  # Verify on Etherscan
npm run verify:unichain  # Verify on Uniscan
npm run verify:optimism  # Verify on Optimism Etherscan

npm run setup:frontend   # Generate ABIs & addresses for frontend

# Deploy a single product collection via SwagFactory (run after deploy:*)
npx hardhat run scripts/deploy-collection.ts --network base
```

## Swag1155 Features

Each `Swag1155` is a standalone merchandise contract for one product line:

- **Variants / sizes** — each `tokenId` is a size; priced, supply-capped, and URI'd independently
- **USDC payments** — all purchases in USDC (6 decimals); price set per variant
- **Royalties** — per-`tokenId` royalty splits to multiple recipients (basis points, auto-distributed on purchase)
- **POAP discounts** — admin maintains a wallet whitelist per `(tokenId, eventId)`; whitelisted buyers get a % off
- **Holder discounts** — ERC-20 or ERC-721 holders get a percentage or fixed-amount discount
- **Discount stacking** — POAP + holder discounts add together; 100 % off = free mint (no USDC transfer)
- **Serial numbers** — every mint assigns a sequential serial starting at 1 per `tokenId`; query with `getSerialOwner(tokenId, serial)`
- **Redemption flow** — buyer calls `redeem(tokenId)`; admin calls `markFulfilled(tokenId, buyer)` after shipping

## SwagFactory

`SwagFactory` is a plain `AccessControl` contract (no proxy) that atomically deploys and configures a `Swag1155` per product:

1. Deploys `Swag1155` with itself as temporary admin
2. Configures all size variants (`tokenId = size index + 1`) with price, supply, and IPFS URI
3. Hands `DEFAULT_ADMIN_ROLE` + `ADMIN_ROLE` to the `itemAdmin` you specify
4. Renounces its own roles — `itemAdmin` is sole controller
5. Registers the collection in its on-chain registry

```typescript
// Admin: deploy a new product
await swagFactory.write.deployCollection([
  "ETH Cali Hoodie",
  "ETH-CALI-HOODIE-2025",
  USDC_ADDRESS,
  TREASURY_ADDRESS,
  ITEM_ADMIN_ADDRESS,
  [
    { metadataURI: "ipfs://QmS/s.json", price: 25_000_000n, maxSupply: 50n, active: true },
    { metadataURI: "ipfs://QmM/m.json", price: 25_000_000n, maxSupply: 100n, active: true },
    { metadataURI: "ipfs://QmL/l.json", price: 30_000_000n, maxSupply: 75n,  active: true },
  ],
]);

// Frontend: enumerate live products
const collections = await swagFactory.read.getActiveCollections();
```

Registry can be reconstructed at any time from `CollectionDeployed` events.

## Documentation

Per-contract API references and admin guide live in [`docs/`](docs/):

- [ZKPassportNFT Reference](docs/ZKPASSPORT_CONTRACT_REFERENCE.md)
- [FaucetManager Reference](docs/FAUCET_CONTRACT_REFERENCE.md)
- [Swag1155 Reference](docs/SWAG1155_CONTRACT_REFERENCE.md)
- [Security & Admin Guide](docs/SECURITY_ADMIN_GUIDE.md)

Full frontend integration guide: [docs/FRONTEND_CHANGES.md](docs/FRONTEND_CHANGES.md)

## Networks

| Network | Chain ID | USDC |
|---------|----------|------|
| Ethereum Mainnet | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base Mainnet | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Unichain Mainnet | 130 | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` |
| Optimism Mainnet | 10 | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |

## License

MIT
