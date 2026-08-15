# Swag1155 Contract Reference

**Complete API reference** for frontend integration with the Swag1155 ERC-1155 smart contract and SwagFactory.

**Contracts**: `contracts/Swag1155.sol` · `contracts/SwagFactory.sol`
**Version**: 2.5 (Factory-first deployment model)
**Last Updated**: March 2026

---

## Table of Contents

1. [Overview](#overview)
2. [SwagFactory Integration](#swagfactory-integration)
3. [UI Components Map](#ui-components-map)
4. [Data Structures](#data-structures)
5. [Discount System](#discount-system)
6. [State Variables](#state-variables)
7. [Admin Functions](#admin-functions)
8. [User Functions](#user-functions)
9. [View Functions](#view-functions)
10. [Events](#events)
11. [Error Messages](#error-messages)
12. [Frontend Integration Examples](#frontend-integration-examples)

---

## Overview

### Architecture

Products are deployed and managed through a two-contract system:

| Contract | Role | Address source |
|----------|------|----------------|
| `SwagFactory` | Registry + deployer. Creates one `Swag1155` per product. | `frontend/addresses.json` → `SwagFactory` |
| `Swag1155` | One contract per physical product (e.g. "ETH Cali Hoodie"). TokenIds = sizes. | Returned by `factory.getCollections()` |

**The factory is the single source of truth for product addresses.** Never hardcode a `Swag1155` address — always discover it via the factory.

### Swag1155 features (per product contract)

- **Multi-token payments** — admin configures accepted tokens (USDC, USDT, DAI, WETH, native ETH) and sets an independent price per token per size
- **Native ETH** — sentinel `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` used as ETH payment token; excess msg.value is refunded
- **Role-based access** (DEFAULT_ADMIN_ROLE, ADMIN_ROLE)
- **Per-token metadata** (IPFS URIs per size)
- **Physical redemption tracking** (3-state flow)
- **Royalty distribution** (automatic payment splits to artists, works for every payment token)
- **Dynamic discount system** (POAP address whitelist and token holder discounts, token-agnostic)
- **Serial numbers** (unique per-unit identifier assigned at mint time)

**Note:** When users purchase swag, they choose which payment token to use. Payments are automatically split between royalty recipients and the treasury. For ERC-20 tokens the buyer must approve the contract first; for ETH the buyer sends `msg.value`. Discounts stack additively up to 100% off and apply regardless of which token is used.

### Role Hierarchy

| Role | Can Do | Granted By |
|------|--------|------------|
| `DEFAULT_ADMIN_ROLE` | Add/remove admins, set treasury, set USDC | Contract deployer / factory itemAdmin |
| `ADMIN_ROLE` | Create products, set variants, mark fulfillment | DEFAULT_ADMIN_ROLE |

---

## SwagFactory Integration

### Mental Model

```
SwagFactory (one per network)
  └── ETH Cali Hoodie  → Swag1155 @ 0xAAA...
        tokenId 1 = Size S  (price, supply, URI)
        tokenId 2 = Size M
        tokenId 3 = Size L
        tokenId 4 = Size XL
  └── ETH Cali Tee     → Swag1155 @ 0xBBB...
        tokenId 1 = Size S
        tokenId 2 = Size M
        ...
```

- **One `SwagFactory`** per network — address in `frontend/addresses.json`.
- **One `Swag1155`** per physical product — discovered via the factory.
- **TokenIds within a `Swag1155`** represent sizes/variants (1-indexed, in the order passed to `deployCollection`).

### Creating a Product (Admin)

Products are created exclusively via `SwagFactory.deployCollection()`. This atomically:
1. Deploys a new `Swag1155`
2. Configures all sizes as tokenIds
3. Grants `itemAdmin` full control (DEFAULT_ADMIN_ROLE + ADMIN_ROLE)
4. Renounces factory's own roles on the new contract
5. Registers the collection in the factory registry

**Script (recommended):**
```bash
ITEM_NAME="ETH Cali Hoodie" \
ITEM_SKU="ETH-CALI-HOODIE-2025" \
ITEM_ADMIN=0xYourAdminAddress \
ITEM_SIZES_JSON='[
  {
    "metadataURI": "ipfs://QmS.../s.json",
    "maxSupply": 50,
    "active": true,
    "payments": [
      { "token": "0xUSDC...", "price": 25000000 },
      { "token": "0xUSDT...", "price": 25000000 },
      { "token": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "price": "10000000000000000" }
    ]
  },
  {
    "metadataURI": "ipfs://QmM.../m.json",
    "maxSupply": 100,
    "active": true,
    "payments": [
      { "token": "0xUSDC...", "price": 25000000 },
      { "token": "0xUSDT...", "price": 25000000 },
      { "token": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "price": "10000000000000000" }
    ]
  }
]' \
npx hardhat run scripts/deploy-collection.ts --network base
```

**Direct contract call:**
```solidity
function deployCollection(
    string        calldata name,      // "ETH Cali Hoodie"
    string        calldata sku,       // "ETH-CALI-HOODIE-2025"
    address                treasury,  // Where sales go
    address                itemAdmin, // Who owns the new Swag1155
    VariantInit[] calldata sizes      // One entry per size; tokenId = index + 1
) external onlyRole(ADMIN_ROLE) returns (address swagAddr)
```

**`VariantInit` and `PaymentOption` structs:**
```solidity
struct PaymentOption {
    address token; // ERC-20 address, or ETH_TOKEN (0xEeee...EEeE) for native ETH
    uint256 price; // Price in that token's base units (25 USDC = 25_000_000)
}

struct VariantInit {
    string          metadataURI; // "ipfs://Qm.../s.json"
    uint256         maxSupply;   // Max inventory for this size
    bool            active;      // Open for purchase at launch?
    PaymentOption[] payments;    // One entry per accepted token + price
}
```

**Frontend (admin form):**
```typescript
import SwagFactoryABI from './abis/SwagFactory.json';

const ETH_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const tx = await writeContract({
  address: SWAG_FACTORY_ADDRESS,
  abi: SwagFactoryABI,
  functionName: 'deployCollection',
  args: [
    'ETH Cali Hoodie',
    'ETH-CALI-HOODIE-2025',
    TREASURY_ADDRESS,
    ITEM_ADMIN_ADDRESS,
    [
      {
        metadataURI: 'ipfs://QmS.../s.json',
        maxSupply: 50n,
        active: true,
        payments: [
          { token: USDC_ADDRESS, price: 25000000n },      // 25 USDC
          { token: USDT_ADDRESS, price: 25000000n },      // 25 USDT
          { token: ETH_TOKEN,    price: 10000000000000000n }, // 0.01 ETH
        ],
      },
      {
        metadataURI: 'ipfs://QmM.../m.json',
        maxSupply: 100n,
        active: true,
        payments: [
          { token: USDC_ADDRESS, price: 25000000n },
          { token: ETH_TOKEN,    price: 10000000000000000n },
        ],
      },
    ],
  ],
});
// After tx confirms, call getCollections() to get the new contract address
```

**Emits:**
```solidity
event CollectionDeployed(
    address indexed collection,  // new Swag1155 clone address
    string  name,
    string  sku,
    address treasury,
    uint256 variantCount,
    address indexed creator
);
```

### Discovering Products (Frontend)

The factory is the source of truth. Call it on page load to build the product list.

```typescript
import SwagFactoryABI from './abis/SwagFactory.json';
import Swag1155ABI from './abis/Swag1155.json';

// 1. Get all active product addresses
const activeCollections = await readContract({
  address: SWAG_FACTORY_ADDRESS,
  abi: SwagFactoryABI,
  functionName: 'getActiveCollections',
});
// → ['0xAAA...', '0xBBB...', ...]

// 2. For each collection, load metadata and sizes
for (const collectionAddr of activeCollections) {
  // Factory metadata (name, SKU, etc.)
  const meta = await readContract({
    address: SWAG_FACTORY_ADDRESS,
    abi: SwagFactoryABI,
    functionName: 'getCollectionMeta',
    args: [collectionAddr],
  });
  // meta = { name: 'ETH Cali Hoodie', sku: '...', variantCount: 3n, active: true, ... }

  // Token IDs (sizes) within this product's Swag1155
  const tokenIds = await readContract({
    address: collectionAddr,
    abi: Swag1155ABI,
    functionName: 'listTokenIds',
  });
  // tokenIds = [1n, 2n, 3n]  (S, M, L in order of deployment)

  // Variant details per size
  for (const tokenId of tokenIds) {
    const variant = await readContract({
      address: collectionAddr,
      abi: Swag1155ABI,
      functionName: 'getVariant',
      args: [tokenId],
    });
    const metadataUri = await readContract({
      address: collectionAddr,
      abi: Swag1155ABI,
      functionName: 'uri',
      args: [tokenId],
    });
    // Build product card: name from meta, price/supply from variant, image from IPFS
  }
}
```

### Factory View Functions

```solidity
// All deployed collections (including inactive)
function getCollections() external view returns (address[] memory)

// Only factory-active collections
function getActiveCollections() external view returns (address[] memory)

// Registry metadata for one collection
function getCollectionMeta(address collection) external view returns (CollectionMeta memory)

// Total number of deployed collections
function getCollectionCount() external view returns (uint256)

// Check if an address is a factory-registered collection
function isCollection(address) external view returns (bool)
```

**`CollectionMeta` struct:**
```typescript
interface CollectionMeta {
  name: string;        // "ETH Cali Hoodie"
  sku: string;         // "ETH-CALI-HOODIE-2025"
  treasury: string;    // Sale proceeds recipient
  creator: string;     // Who called deployCollection
  deployedAt: bigint;  // block.timestamp
  variantCount: bigint; // Number of sizes (tokenIds)
  active: boolean;     // Factory-level visibility toggle
}
```

> Payment tokens are stored per-tokenId on each `Swag1155` clone. Call `getPaymentOptions(tokenId)` on the product contract to enumerate accepted tokens and prices.

### Toggling Product Visibility (Admin)

```solidity
function setCollectionActive(address collection, bool active) external onlyRole(ADMIN_ROLE)
```

This is a **factory-level visibility toggle only** — it does not affect the underlying `Swag1155` sale state. Use it to show/hide products in the storefront without modifying the deployed contract.

```typescript
// Hide a product from the storefront
await writeContract({
  address: SWAG_FACTORY_ADDRESS,
  abi: SwagFactoryABI,
  functionName: 'setCollectionActive',
  args: [collectionAddress, false],
});
```

**Emits:** `CollectionStatusChanged(address indexed collection, bool active)`

### Post-Deployment Product Configuration

After `deployCollection`, the `itemAdmin` configures the resulting `Swag1155` directly:

```typescript
const collectionAddr = '0xAAA...'; // returned by factory

// Add royalty for artist
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addRoyalty', args: [1n, artistAddress, 500n] }); // 5%

// Add POAP discount for size M (tokenId 2)
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addPoapDiscount', args: [2n, 123456n, 1000n] }); // 10% off

// Whitelist attendees for POAP discount
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addPoapWhitelist', args: [2n, 123456n, ['0xUser1...', '0xUser2...']] });
```

### Factory Admin Management

```solidity
// Grant factory ADMIN_ROLE (can call deployCollection, setCollectionActive)
function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE)

// Revoke factory ADMIN_ROLE
function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE)
```

Note: factory admins only control the factory. Each deployed `Swag1155` has its own independent `itemAdmin`.

---

## UI Components Map

### Admin Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│                     ADMIN - SWAG MANAGEMENT                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ [+ Create Product]  ←── setVariantWithURI()             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PRODUCT: ETH Cali Tee - Black                           │    │
│  │ Price: $25 | Stock: 45/100 | Active: Yes                │    │
│  │                                                          │    │
│  │ [Edit Price]   [Edit Stock]   [Toggle Active]           │    │
│  │      ↓              ↓              ↓                    │    │
│  │ setVariant()   setVariant()   setVariant()              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PENDING REDEMPTIONS                                      │    │
│  │ ┌─────────────────────────────────────────────────────┐ │    │
│  │ │ Token #1001 | Owner: 0x123... | Requested: Jan 15   │ │    │
│  │ │ Shipping: John Doe, 123 Main St...                  │ │    │
│  │ │ [Mark Shipped]  ←── markFulfilled()                 │ │    │
│  │ └─────────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### User Store

```
┌─────────────────────────────────────────────────────────────────┐
│                        SWAG STORE                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ [Product Image] │  │ [Product Image] │  │ [Product Image] │  │
│  │ ETH Cali Tee    │  │ ETH Cali Hoodie │  │ ETH Cali Cap    │  │
│  │ $25.00          │  │ $50.00          │  │ $20.00          │  │
│  │ 55 left         │  │ SOLD OUT        │  │ 12 left         │  │
│  │                 │  │                 │  │                 │  │
│  │ Size: [S][M][L] │  │                 │  │ Size: [One]     │  │
│  │ Qty:  [1]       │  │                 │  │ Qty:  [1]       │  │
│  │                 │  │                 │  │                 │  │
│  │ [Buy Now]       │  │ [Notify Me]     │  │ [Buy Now]       │  │
│  │     ↓           │  │                 │  │     ↓           │  │
│  │ approve() +     │  │                 │  │ approve() +     │  │
│  │ buy()           │  │                 │  │ buy()           │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### User - My NFTs & Redemption

```
┌─────────────────────────────────────────────────────────────────┐
│                         MY SWAG NFTs                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ ETH Cali Tee - Black - Size M                           │    │
│  │ Token ID: #1001                                          │    │
│  │ Status: Not Redeemed                                     │    │
│  │                                                          │    │
│  │ [Redeem Physical Item]  ←── redeem()                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ ETH Cali Cap - One Size                                  │    │
│  │ Token ID: #2005                                          │    │
│  │ Status: Awaiting Shipment                                │    │
│  │                                                          │    │
│  │ [Pending...]  (disabled)                                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ ETH Cali Hoodie - Black - Size L                        │    │
│  │ Token ID: #3003                                          │    │
│  │ Status: Shipped                                          │    │
│  │                                                          │    │
│  │ [Shipped!]  (badge)                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Button-to-Function Mapping

| UI Button | Contract Function | Who Can Use | Parameters |
|-----------|-------------------|-------------|------------|
| **[Create Product]** | `setVariantWithURI()` | Admin | tokenId, price, maxSupply, active, uri |
| **[Edit Price]** | `setVariant()` | Admin | tokenId, newPrice, maxSupply, active |
| **[Edit Stock]** | `setVariant()` | Admin | tokenId, price, newMaxSupply, active |
| **[Toggle Active]** | `setVariant()` | Admin | tokenId, price, maxSupply, !active |
| **[Mark Shipped]** | `markFulfilled()` | Admin | tokenId, ownerAddress |
| **[Buy Now]** | `approve()` + `buy()` | User | tokenId, quantity |
| **[Redeem Physical]** | `redeem()` | User | tokenId |
| **[Add Royalty]** | `addRoyalty()` | Admin | tokenId, recipient, percentage |
| **[Clear Royalties]** | `clearRoyalties()` | Admin | tokenId |
| **[Add POAP Discount]** | `addPoapDiscount()` | Admin | tokenId, eventId, discountBps |
| **[Remove POAP Discount]** | `removePoapDiscount()` | Admin | tokenId, index |
| **[Add POAP Whitelist]** | `addPoapWhitelist()` | Admin | tokenId, eventId, addresses[] |
| **[Remove POAP Whitelist]** | `removePoapWhitelist()` | Admin | tokenId, eventId, addresses[] |
| **[Add Holder Discount]** | `addHolderDiscount()` | Admin | tokenId, token, discountType, value |
| **[Remove Holder Discount]** | `removeHolderDiscount()` | Admin | tokenId, index |

---

## Data Structures

### Variant

Stores inventory and active status per tokenId. Prices live in the payment options mapping, not here.

```solidity
struct Variant {
    uint256 maxSupply; // Maximum available stock
    uint256 minted;    // Already sold/minted count
    bool    active;    // Whether variant is available for purchase
}
```

**Frontend usage:**
```typescript
interface Variant {
  maxSupply: bigint; // e.g., 100n
  minted: bigint;    // e.g., 45n
  active: boolean;   // e.g., true
}

// Calculate available stock
const available = Number(variant.maxSupply - variant.minted);

// Get price for a specific payment token
const [tokens, prices] = await readContract({
  address: collectionAddr,
  abi: Swag1155ABI,
  functionName: 'getPaymentOptions',
  args: [tokenId],
});
// tokens = ['0xUSDC...', '0xEeee...EEeE']
// prices = [25000000n, 10000000000000000n]
```

---

### RedemptionStatus

Tracks physical item claim status.

```solidity
enum RedemptionStatus {
    NotRedeemed,        // 0 - User hasn't claimed yet
    PendingFulfillment, // 1 - User claimed, waiting for shipment
    Fulfilled           // 2 - Admin verified shipment complete
}
```

**Frontend usage:**
```typescript
enum RedemptionStatus {
  NotRedeemed = 0,
  PendingFulfillment = 1,
  Fulfilled = 2,
}

const statusLabels: Record<RedemptionStatus, string> = {
  [RedemptionStatus.NotRedeemed]: 'Not Redeemed',
  [RedemptionStatus.PendingFulfillment]: 'Awaiting Shipment',
  [RedemptionStatus.Fulfilled]: 'Shipped',
};
```

---

### RoyaltyInfo

Stores royalty recipient and percentage for payment distribution.

```solidity
struct RoyaltyInfo {
    address recipient;   // Royalty recipient (e.g., artist)
    uint256 percentage;  // Basis points (500 = 5%, 1000 = 10%)
}
```

**Frontend usage:**
```typescript
interface RoyaltyInfo {
  recipient: string;    // e.g., "0xArtist..."
  percentage: bigint;   // e.g., 500n = 5%
}

// Convert basis points to percentage
const percentageDisplay = Number(royalty.percentage) / 100; // 5.00%

// Calculate royalty amount from price
const royaltyAmount = (price * royalty.percentage) / 10000n;
```

---

## Discount System

Swag1155 supports a flexible discount system that allows admins to configure per-product discounts based on POAP ownership or token holdings. Discounts are automatically applied during purchase and can stack additively.

### Deployment Model (Clones)

`Swag1155` uses the **EIP-1167 minimal clone** pattern. A single reference implementation is deployed once; `SwagFactory` creates cheap proxy clones for each product and calls `initialize()` on each clone.

You never call these directly — `SwagFactory.deployCollection()` handles everything atomically.

```solidity
// Reference implementation constructor — locks itself against initialization
constructor() ERC1155("") { /* _initialized = true */ }

// Called by SwagFactory on each clone immediately after Clones.clone()
function initialize(
    string memory baseURI,
    address _treasury,
    address initialAdmin
) external
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|--------|
| `baseURI` | `string` | Base URI for token metadata | `"ipfs://"` |
| `_treasury` | `address` | Treasury wallet address | `0xTreasury...` |
| `initialAdmin` | `address` | Admin with DEFAULT_ADMIN_ROLE + ADMIN_ROLE | `0xFactory...` |

> **SwagFactory constructor:** `constructor(address admin, address implementation)` — takes both the factory admin and the address of the deployed Swag1155 reference implementation. `deploy-all.ts` handles this deployment order automatically.

---

### POAP Discounts

Admins can configure POAP-based discounts per product. Eligibility is determined by an admin-managed whitelist (`poapWhitelist`) — the admin adds qualified wallet addresses after a POAP event rather than querying the POAP contract on-chain. POAP discount tiers define the `eventId` and `discountBps`; the `addPoapWhitelist` functions control which addresses qualify.

#### addPoapDiscount

Add a POAP-based discount for a specific product.

```solidity
function addPoapDiscount(
    uint256 tokenId,
    uint256 eventId,
    uint256 discountBps
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Product token ID | `1001` |
| `eventId` | `uint256` | POAP event ID | `123456` |
| `discountBps` | `uint256` | Discount in basis points | `500` (= 5% off) |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `discountBps` must be > 0

**Emits:** `PoapDiscountAdded(uint256 indexed tokenId, uint256 eventId, uint256 discountBps)`

**Frontend:**
```typescript
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addPoapDiscount',
  args: [
    1001n,      // tokenId
    123456n,    // eventId (POAP event)
    500n,       // discountBps (5% off)
  ],
});
```

---

#### removePoapDiscount

Remove a POAP discount by array index.

```solidity
function removePoapDiscount(
    uint256 tokenId,
    uint256 index
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Product token ID | `1001` |
| `index` | `uint256` | Array index of discount to remove | `0` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- Index must be valid

**Emits:** `PoapDiscountRemoved(uint256 indexed tokenId, uint256 eventId)`

**Frontend:**
```typescript
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'removePoapDiscount',
  args: [1001n, 0n], // Remove first POAP discount
});
```

---

#### getPoapDiscounts

View all POAP discounts configured for a product.

```solidity
function getPoapDiscounts(uint256 tokenId) external view returns (PoapDiscount[] memory)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Product token ID | `1001` |

**Returns:** `PoapDiscount[]` - Array of POAP discounts

**PoapDiscount struct:**
```solidity
struct PoapDiscount {
    uint256 eventId;     // POAP event ID
    uint256 discountBps; // Discount percentage in basis points
    bool active;         // Whether discount is active
}
```

**Frontend:**
```typescript
const { data: poapDiscounts } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getPoapDiscounts',
  args: [1001n],
});

// poapDiscounts = [
//   { eventId: 123456n, discountBps: 500n, active: true },   // 5% off
//   { eventId: 789012n, discountBps: 1000n, active: true },  // 10% off
// ]
```

---

### POAP Whitelist

POAP discount eligibility is controlled by an admin-managed whitelist. After a POAP event, the admin exports attendee wallets and adds them via `addPoapWhitelist`. The discount percentage is defined separately in the `poapDiscounts` tier for the same `eventId`.

#### addPoapWhitelist

Add wallet addresses to the POAP whitelist for a specific product and event.

```solidity
function addPoapWhitelist(
    uint256 tokenId,
    uint256 eventId,
    address[] calldata addresses
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|--------|
| `tokenId` | `uint256` | Product token ID | `1` |
| `eventId` | `uint256` | POAP event ID (must match a `poapDiscounts` entry) | `123456` |
| `addresses` | `address[]` | Wallet addresses to whitelist (up to ~200 per tx) | `['0xUser1...', '0xUser2...']` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `addresses` cannot be empty

**Emits:** `PoapWhitelistUpdated(uint256 indexed tokenId, uint256 indexed eventId, address[] addresses, bool added)` (`added = true`)

**Frontend:**
```typescript
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addPoapWhitelist',
  args: [
    1n,                                    // tokenId
    123456n,                               // POAP eventId
    ['0xUser1...', '0xUser2...'],          // addresses (batch ~200 per tx)
  ],
});
```

---

#### removePoapWhitelist

Remove wallet addresses from the POAP whitelist.

```solidity
function removePoapWhitelist(
    uint256 tokenId,
    uint256 eventId,
    address[] calldata addresses
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|--------|
| `tokenId` | `uint256` | Product token ID | `1` |
| `eventId` | `uint256` | POAP event ID | `123456` |
| `addresses` | `address[]` | Wallet addresses to remove | `['0xUser1...']` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `addresses` cannot be empty

**Emits:** `PoapWhitelistUpdated(...)` (`added = false`)

---

#### isPoapWhitelisted

Check whether a wallet is whitelisted for a POAP discount on a specific product and event.

```solidity
function isPoapWhitelisted(
    uint256 tokenId,
    uint256 eventId,
    address buyer
) external view returns (bool)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|--------|
| `tokenId` | `uint256` | Product token ID | `1` |
| `eventId` | `uint256` | POAP event ID | `123456` |
| `buyer` | `address` | Address to check | `0xUser...` |

**Returns:** `bool` — `true` if whitelisted

**Frontend:**
```typescript
const { data: isWhitelisted } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'isPoapWhitelisted',
  args: [1n, 123456n, userAddress],
});
// Show "You qualify for a POAP discount!" if true
```

---

### Holder Discounts

Admins can configure discounts for users who hold specific ERC-20, ERC-721, or ERC-1155 tokens.

#### addHolderDiscount

Add a token holder discount for a specific product.

```solidity
function addHolderDiscount(
    uint256 tokenId,
    address token,
    DiscountType discountType,
    uint256 value
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Product token ID | `1001` |
| `token` | `address` | Token contract address | `0xToken...` |
| `discountType` | `DiscountType` | Percentage (0) or Fixed (1) | `0` (Percentage) |
| `value` | `uint256` | Discount value — bps for Percentage; payment token base units for Fixed | `500` (5% off) or `5000000` ($5 in USDC) |

**DiscountType enum:**
```solidity
enum DiscountType {
    Percentage, // 0 - Discount in basis points (500 = 5%)
    Fixed       // 1 - Fixed amount in the payment token's base units
                //     e.g. 5_000_000 for $5 USDC, or 5_000_000_000_000_000 for 0.005 ETH
}
```

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `token` cannot be zero address
- `value` must be > 0

**Emits:** `HolderDiscountAdded(uint256 indexed tokenId, address indexed token, DiscountType discountType, uint256 value)`

**Frontend:**
```typescript
// Add 10% percentage discount for NFT holders
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addHolderDiscount',
  args: [
    1001n,                    // tokenId
    '0xNFTAddress...',        // token
    0,                        // discountType (Percentage)
    1000n,                    // value (10% off)
  ],
});

// Add $5 fixed discount for ERC20 holders
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addHolderDiscount',
  args: [
    1001n,                    // tokenId
    '0xERC20Address...',      // token
    1,                        // discountType (Fixed)
    5000000n,                 // value ($5 off)
  ],
});
```

---

#### removeHolderDiscount

Remove a holder discount by array index.

```solidity
function removeHolderDiscount(
    uint256 tokenId,
    uint256 index
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Product token ID | `1001` |
| `index` | `uint256` | Array index of discount to remove | `0` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- Index must be valid

**Emits:** `HolderDiscountRemoved(uint256 indexed tokenId, address indexed token)`

**Frontend:**
```typescript
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'removeHolderDiscount',
  args: [1001n, 0n], // Remove first holder discount
});
```

---

#### getHolderDiscounts

View all holder discounts configured for a product.

```solidity
function getHolderDiscounts(uint256 tokenId) external view returns (HolderDiscount[] memory)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Product token ID | `1001` |

**Returns:** `HolderDiscount[]` - Array of holder discounts

**HolderDiscount struct:**
```solidity
struct HolderDiscount {
    address token;           // Token contract address
    DiscountType discountType; // Percentage (0) or Fixed (1)
    uint256 value;           // Discount value
    bool active;             // Whether discount is active
}
```

**Frontend:**
```typescript
const { data: holderDiscounts } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getHolderDiscounts',
  args: [1001n],
});

// holderDiscounts = [
//   { token: '0xNFT...', discountType: 0, value: 1000n, active: true },   // 10% off
//   { token: '0xERC20...', discountType: 1, value: 5000000n, active: true }, // $5 off
// ]
```

---

### Price Calculation with Discounts

The discount system automatically calculates the final price based on all qualifying discounts.

#### getDiscountedPrice

Calculate the final price after applying all qualifying discounts for a buyer, denominated in the chosen payment token.

```solidity
function getDiscountedPrice(
    uint256 tokenId,
    address buyer,
    address paymentToken
) public view returns (uint256 finalPrice)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Variant token ID | `1` |
| `buyer` | `address` | Buyer address to check discounts | `0xBuyer...` |
| `paymentToken` | `address` | Token to pay with (or ETH_TOKEN) | `0xUSDC...` |

**Returns:** `uint256` - Final price in `paymentToken`'s base units. Returns `0` if the token is not accepted for this variant.

**Discount Stacking Rules:**
- All qualifying discounts are **additive** (they add together)
- POAP discounts: Buyer receives discount if their address is in `poapWhitelist[tokenId][eventId]` (admin-managed)
- Holder discounts: Buyer receives discount if they hold the specified ERC-20 or ERC-721 token (checked on-chain)
- Percentage discounts: Applied as basis points (500 bps = 5%) — work identically for any payment token
- Fixed discounts: Subtracted in payment token base units — set them appropriately per token's decimals
- If total discounts >= 100%, final price is 0 (free)
- Discounts cannot result in negative prices (capped at 0)

**Example Calculation:**
```
Payment token: USDC (6 decimals)
Base Price: $25 (25_000_000 in USDC base units)

Qualifying Discounts:
- POAP event 123456: 5% off (500 bps)
- NFT holder: 10% off (1000 bps)
- ERC20 holder: $5 fixed (5_000_000 USDC base units)

Total:
- Percentage discounts: 5% + 10% = 15% (1500 bps)
- Fixed discounts: $5
- Price after percentage: $25 × 0.85 = $21.25
- Price after fixed: $21.25 − $5 = $16.25

Final Price: $16.25 (16_250_000 in USDC base units)
```

**Frontend:**
```typescript
const ETH_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// For USDC payment
const { data: finalPriceUSDC } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getDiscountedPrice',
  args: [1n, buyerAddress, USDC_ADDRESS],
});
const priceUSD = Number(finalPriceUSDC) / 1e6; // 16.25

// For ETH payment
const { data: finalPriceETH } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getDiscountedPrice',
  args: [1n, buyerAddress, ETH_TOKEN],
});
const priceETH = Number(finalPriceETH) / 1e18; // e.g., 0.0085
```

---

### Automatic Discount Application

The `buy()` and `buyBatch()` functions automatically use `getDiscountedPrice()` to calculate the final price. No additional frontend changes are needed.

**Important:**
- If the total discounted price is 0 (100% discount), **no token transfer occurs**
- The buyer still receives the NFT tokens
- The `DiscountApplied` event is emitted with price details

**Frontend Integration (USDC example):**
```typescript
const handlePurchase = async (paymentToken: string) => {
  const finalPrice = await readContract({
    address: swag1155,
    abi: Swag1155ABI,
    functionName: 'getDiscountedPrice',
    args: [tokenId, buyerAddress, paymentToken],
  });

  const totalPrice = finalPrice * quantity;
  const isETH = paymentToken === ETH_TOKEN;

  if (!isETH && totalPrice > 0n) {
    // Approve ERC-20 spend
    await writeContract({ address: paymentToken, abi: ERC20ABI,
      functionName: 'approve', args: [swag1155, totalPrice] });
  }

  await writeContract({
    address: swag1155,
    abi: Swag1155ABI,
    functionName: 'buy',
    args: [tokenId, quantity, paymentToken],
    value: isETH ? totalPrice : 0n, // send ETH if native payment
  });
};
```

---

## State Variables

### Public Variables

| Variable | Type | Description | Frontend Read |
|----------|------|-------------|---------------|
| `treasury` | `address` | Address receiving payments | `useReadContract({ functionName: 'treasury' })` |
| `variants` | `mapping(uint256 => Variant)` | Inventory data by tokenId | `useReadContract({ functionName: 'variants', args: [tokenId] })` |
| `variantTokenPrice` | `mapping(uint256 => mapping(address => uint256))` | Price per tokenId per payment token | `useReadContract({ functionName: 'variantTokenPrice', args: [tokenId, tokenAddr] })` |
| `redemptions` | `mapping(uint256 => mapping(address => RedemptionStatus))` | Redemption status by tokenId and owner | `useReadContract({ functionName: 'redemptions', args: [tokenId, owner] })` |
| `royaltyRecipients` | `mapping(uint256 => RoyaltyInfo[])` | Array of royalty recipients per tokenId | `useReadContract({ functionName: 'royaltyRecipients', args: [tokenId, index] })` |
| `totalRoyaltyBps` | `mapping(uint256 => uint256)` | Total royalty basis points per tokenId | `useReadContract({ functionName: 'totalRoyaltyBps', args: [tokenId] })` |
| `poapWhitelist` | `mapping(uint256 => mapping(uint256 => mapping(address => bool)))` | POAP discount eligibility — `[tokenId][eventId][address]` | `useReadContract({ functionName: 'poapWhitelist', args: [tokenId, eventId, address] })` |
| `nextSerial` | `mapping(uint256 => uint256)` | Highest serial number assigned per tokenId | `useReadContract({ functionName: 'nextSerial', args: [tokenId] })` |
| `serialOwner` | `mapping(uint256 => mapping(uint256 => address))` | Buyer address per serial — `[tokenId][serial]` | `useReadContract({ functionName: 'serialOwner', args: [tokenId, serial] })` |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `ETH_TOKEN` | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | Sentinel address representing native ETH as payment |
| `ROYALTY_DENOMINATOR` | `10000` | Basis points denominator (100% = 10000 bps) |

### Role Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_ADMIN_ROLE` | `0x00` | Super admin role (can manage admins) |
| `ADMIN_ROLE` | `keccak256("ADMIN_ROLE")` | Product admin role |

---

## Admin Functions

### addAdmin

Grants ADMIN_ROLE to a new address.

```solidity
function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `admin` | `address` | Address to grant admin role |

**Requirements:**
- Caller must have `DEFAULT_ADMIN_ROLE`
- `admin` cannot be zero address

**Emits:** `AdminAdded(address indexed admin)`

**Frontend:**
```typescript
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addAdmin',
  args: ['0x1234...'],
});
```

---

### removeAdmin

Revokes ADMIN_ROLE from an address.

```solidity
function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `admin` | `address` | Address to revoke admin role |

**Requirements:**
- Caller must have `DEFAULT_ADMIN_ROLE`

**Emits:** `AdminRemoved(address indexed admin)`

---

### setTreasury

Updates the treasury address receiving payments.

```solidity
function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `newTreasury` | `address` | New treasury wallet address |

**Requirements:**
- Caller must have `DEFAULT_ADMIN_ROLE`
- `newTreasury` cannot be zero address

**Emits:** `TreasuryUpdated(address indexed newTreasury)`

---

### setPaymentOption

Set or update the price for a specific payment token on a variant. Can be called multiple times to add USDC, USDT, ETH, etc.

```solidity
function setPaymentOption(
    uint256 tokenId,
    address token,
    uint256 price
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Variant token ID | `1` |
| `token` | `address` | ERC-20 address or `ETH_TOKEN` (0xEeee...EEeE) | `0xUSDC...` |
| `price` | `uint256` | Price in that token's base units | `25000000` (25 USDC) |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `token` cannot be zero address
- `price` must be > 0

**Emits:** `PaymentOptionSet(uint256 indexed tokenId, address indexed token, uint256 price)`

**Frontend:**
```typescript
const ETH_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Add USDC at $25
await writeContract({ address: swag1155, abi: Swag1155ABI,
  functionName: 'setPaymentOption', args: [1n, USDC_ADDRESS, 25000000n] });

// Add native ETH at 0.01 ETH
await writeContract({ address: swag1155, abi: Swag1155ABI,
  functionName: 'setPaymentOption', args: [1n, ETH_TOKEN, 10000000000000000n] });
```

---

### removePaymentOption

Remove a payment token from a variant so it can no longer be used to purchase.

```solidity
function removePaymentOption(uint256 tokenId, address token) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Variant token ID | `1` |
| `token` | `address` | Token to remove | `0xDAI...` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `token` must already be a payment option for this variant

**Emits:** `PaymentOptionRemoved(uint256 indexed tokenId, address indexed token)`

---

### setVariant

Creates or updates a product variant's supply and active status. Use `setPaymentOption` separately to configure accepted tokens and prices.

```solidity
function setVariant(
    uint256 tokenId,
    uint256 maxSupply,
    bool active
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Unique identifier for this variant | `1` |
| `maxSupply` | `uint256` | Maximum available stock | `50` |
| `active` | `bool` | Whether available for purchase | `true` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `maxSupply` must be >= current `minted` count

**Emits:** `VariantUpdated(uint256 indexed tokenId, uint256 maxSupply, bool active)`

**Frontend:**
```typescript
// Toggle active state
await writeContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'setVariant', args: [1n, 50n, false], // pause sales
});

// Increase supply
await writeContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'setVariant', args: [1n, 100n, true], // restock
});
```

---

### setVariantWithURI

Creates or updates a variant with a per-token metadata URI. Prices are set separately via `setPaymentOption`.

```solidity
function setVariantWithURI(
    uint256 tokenId,
    uint256 maxSupply,
    bool    active,
    string memory tokenURI
) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Unique identifier for this variant | `1` |
| `maxSupply` | `uint256` | Maximum available stock | `50` |
| `active` | `bool` | Whether available for purchase | `true` |
| `tokenURI` | `string` | IPFS URI for token metadata | `ipfs://QmXyz.../metadata.json` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `maxSupply` must be >= current `minted` count
- `tokenURI` cannot be empty

**Emits:**
- `VariantUpdated(uint256 indexed tokenId, uint256 maxSupply, bool active)`
- `VariantURISet(uint256 indexed tokenId, string uri)`

**Frontend:**
```typescript
await writeContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'setVariantWithURI',
  args: [1n, 50n, true, 'ipfs://QmXyz123.../metadata.json'],
});
```

---

### setBaseURI

Updates the base URI for token metadata (fallback when per-token URI not set).

```solidity
function setBaseURI(string memory newURI) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `newURI` | `string` | New base URI | `ipfs://QmBaseUri/` |

**Requirements:**
- Caller must have `ADMIN_ROLE`

---

### addRoyalty

Adds a royalty recipient for a specific token. Multiple recipients can be added per token.

```solidity
function addRoyalty(uint256 tokenId, address recipient, uint256 percentage) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Token to receive royalties | `1001` |
| `recipient` | `address` | Royalty recipient address (e.g., artist) | `0xArtist...` |
| `percentage` | `uint256` | Percentage in basis points (bps) | `500` (= 5%) |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- `recipient` cannot be zero address
- `percentage` must be > 0
- Combined royalties for token cannot exceed 10000 bps (100%)

**Emits:** `RoyaltyAdded(uint256 indexed tokenId, address indexed recipient, uint256 percentage)`

**Frontend:**
```typescript
// Add 5% royalty for artist
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addRoyalty',
  args: [
    1001n,                  // tokenId
    '0xArtistAddress...',   // recipient
    500n,                   // percentage (5%)
  ],
});

// Add multiple royalties (10% to artist, 5% to designer)
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addRoyalty',
  args: [1001n, '0xArtist...', 1000n], // 10%
});

await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'addRoyalty',
  args: [1001n, '0xDesigner...', 500n], // 5%
});
```

---

### clearRoyalties

Removes all royalty recipients for a specific token.

```solidity
function clearRoyalties(uint256 tokenId) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Token to clear royalties from | `1001` |

**Requirements:**
- Caller must have `ADMIN_ROLE`

**Emits:** `RoyaltiesCleared(uint256 indexed tokenId)`

**Frontend:**
```typescript
// Remove all royalties for a token
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'clearRoyalties',
  args: [1001n],
});
```

---

### getRoyalties

View function to retrieve all royalty recipients for a token.

```solidity
function getRoyalties(uint256 tokenId) external view returns (RoyaltyInfo[] memory)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Token to query | `1001` |

**Returns:** `RoyaltyInfo[]` - Array of royalty recipients and percentages

**Frontend:**
```typescript
const { data: royalties } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getRoyalties',
  args: [1001n],
});

// royalties = [
//   { recipient: '0xArtist...', percentage: 1000n },    // 10%
//   { recipient: '0xDesigner...', percentage: 500n },   // 5%
// ]

// Calculate total royalty percentage
const totalRoyaltyPercent = royalties.reduce(
  (sum, r) => sum + Number(r.percentage) / 100,
  0
); // 15.00%

// Calculate treasury portion
const treasuryPercent = 100 - totalRoyaltyPercent; // 85.00%
```

---

### markFulfilled

Marks a redemption as fulfilled after admin verifies shipment.

```solidity
function markFulfilled(uint256 tokenId, address owner) external onlyRole(ADMIN_ROLE)
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Token being redeemed | `1001` |
| `owner` | `address` | Address that requested redemption | `0xUser...` |

**Requirements:**
- Caller must have `ADMIN_ROLE`
- Redemption status must be `PendingFulfillment`

**Emits:** `RedemptionFulfilled(address indexed owner, uint256 indexed tokenId, address indexed admin)`

**Frontend:**
```typescript
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'markFulfilled',
  args: [
    1001n,                                    // tokenId
    '0xUserAddress...',                       // owner
  ],
});
```

---

## User Functions

### buy

Purchase a single variant. Buyer chooses the payment token. Discounts are applied automatically. Payment is split between royalty recipients and treasury.

```solidity
function buy(
    uint256 tokenId,
    uint256 quantity,
    address paymentToken
) external payable nonReentrant
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Variant to purchase | `1` |
| `quantity` | `uint256` | Number of units to buy | `2` |
| `paymentToken` | `address` | Token to pay with (ERC-20 address or `ETH_TOKEN`) | `0xUSDC...` |

**Requirements:**
- `quantity` must be > 0
- Variant must be `active`
- Sufficient supply: `minted + quantity <= maxSupply`
- Token must be a configured payment option for this variant
- **ERC-20:** `msg.value == 0`, buyer must have approved `discountedPrice × quantity`
- **ETH:** `msg.value >= discountedPrice × quantity`; excess is refunded

**Emits:**
- `Purchased(address indexed buyer, uint256 indexed tokenId, uint256 quantity, address indexed paymentToken, uint256 unitPrice, uint256 totalPrice)`
- `DiscountApplied(address indexed buyer, uint256 indexed tokenId, address paymentToken, uint256 originalPrice, uint256 finalPrice)` (if discounts applied)
- `SerialMinted(address indexed buyer, uint256 indexed tokenId, uint256 indexed serial)` (once per unit)

**Frontend — ERC-20:**
```typescript
const discountedPrice = await readContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'getDiscountedPrice', args: [tokenId, buyerAddress, USDC_ADDRESS],
});
const total = discountedPrice * quantity;

if (total > 0n) {
  await writeContract({ address: USDC_ADDRESS, abi: ERC20ABI,
    functionName: 'approve', args: [swag1155, total] });
}

await writeContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'buy', args: [tokenId, quantity, USDC_ADDRESS],
});
```

**Frontend — Native ETH:**
```typescript
const ETH_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const discountedPrice = await readContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'getDiscountedPrice', args: [tokenId, buyerAddress, ETH_TOKEN],
});
const total = discountedPrice * quantity;

await writeContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'buy', args: [tokenId, quantity, ETH_TOKEN],
  value: total, // send ETH; excess is refunded by the contract
});
```

---

### buyBatch

Purchase multiple variants in a single transaction using one payment token. All items must share the same payment token.

```solidity
function buyBatch(
    uint256[] calldata tokenIds,
    uint256[] calldata quantities,
    address paymentToken
) external payable nonReentrant
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenIds` | `uint256[]` | Array of variant IDs | `[1, 2, 3]` |
| `quantities` | `uint256[]` | Array of quantities per variant | `[1, 2, 1]` |
| `paymentToken` | `address` | Token to pay with (same for all items) | `0xUSDC...` |

**Requirements:**
- Arrays must have same length and not be empty
- Each quantity > 0, each variant must be `active` with sufficient supply
- Token must be accepted for every variant in the batch
- **ERC-20:** `msg.value == 0`, buyer must have approved the grand total
- **ETH:** `msg.value >= grandTotal`; excess is refunded

**Emits:**
- `PurchasedBatch(address indexed buyer, uint256[] tokenIds, uint256[] quantities, address indexed paymentToken, uint256 totalPrice)`

**Frontend:**
```typescript
const tokenIds  = [1n, 2n, 3n];
const quantities = [1n, 2n, 1n];
let grandTotal = 0n;

for (let i = 0; i < tokenIds.length; i++) {
  const price = await readContract({
    address: swag1155, abi: Swag1155ABI,
    functionName: 'getDiscountedPrice',
    args: [tokenIds[i], buyerAddress, USDC_ADDRESS],
  });
  grandTotal += price * quantities[i];
}

if (grandTotal > 0n) {
  await writeContract({ address: USDC_ADDRESS, abi: ERC20ABI,
    functionName: 'approve', args: [swag1155, grandTotal] });
}

await writeContract({
  address: swag1155, abi: Swag1155ABI,
  functionName: 'buyBatch', args: [tokenIds, quantities, USDC_ADDRESS],
});
```

---

### redeem

Request redemption of physical item for owned NFT.

```solidity
function redeem(uint256 tokenId) external
```

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `tokenId` | `uint256` | Token to redeem | `1001` |

**Requirements:**
- Caller must own at least 1 of the tokenId (`balanceOf(msg.sender, tokenId) > 0`)
- Redemption status must be `NotRedeemed`

**Emits:** `RedemptionRequested(address indexed owner, uint256 indexed tokenId)`

**State Change:** `redemptions[tokenId][msg.sender] = PendingFulfillment`

**Frontend:**
```typescript
await writeContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'redeem',
  args: [1001n],
});

// After success, prompt user for shipping address (off-chain)
```

---

## View Functions

### getPaymentOptions

Get all accepted payment tokens and their prices for a variant.

```solidity
function getPaymentOptions(uint256 tokenId)
    external view
    returns (address[] memory tokens, uint256[] memory prices)
```

**Returns:**
- `tokens` — array of accepted token addresses (`ETH_TOKEN` for native ETH)
- `prices` — corresponding prices in each token's base units

**Frontend:**
```typescript
const ETH_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const [tokens, prices] = await readContract({
  address: collectionAddr, abi: Swag1155ABI,
  functionName: 'getPaymentOptions', args: [1n],
});

// Build a payment selector for the UI
const paymentOptions = tokens.map((token, i) => ({
  token,
  price: prices[i],
  isETH: token.toLowerCase() === ETH_TOKEN.toLowerCase(),
  label: token.toLowerCase() === ETH_TOKEN.toLowerCase()
    ? `${Number(prices[i]) / 1e18} ETH`
    : `${Number(prices[i]) / 1e6} USDC`,
}));
```

---

### getTokenPrice

Get the price for one specific payment token on a variant. Returns `0` if the token is not accepted.

```solidity
function getTokenPrice(uint256 tokenId, address token) external view returns (uint256)
```

---

### isAdmin

Check if an address has ADMIN_ROLE.

```solidity
function isAdmin(address account) external view returns (bool)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `account` | `address` | Address to check |

**Returns:** `bool` - true if address has ADMIN_ROLE

**Frontend:**
```typescript
const { data: isAdmin } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'isAdmin',
  args: [address],
});
```

---

### isSuperAdmin

Check if an address has DEFAULT_ADMIN_ROLE.

```solidity
function isSuperAdmin(address account) external view returns (bool)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `account` | `address` | Address to check |

**Returns:** `bool` - true if address has DEFAULT_ADMIN_ROLE

---

### getVariant

Get full variant information.

```solidity
function getVariant(uint256 tokenId) external view returns (Variant memory)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tokenId` | `uint256` | Variant ID to query |

**Returns:** `Variant` struct with price, maxSupply, minted, active

**Frontend:**
```typescript
const { data: variant } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getVariant',
  args: [1001n],
});

// variant = { price: 25000000n, maxSupply: 50n, minted: 10n, active: true }
```

---

### remaining

Get available stock for a variant.

```solidity
function remaining(uint256 tokenId) public view returns (uint256)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tokenId` | `uint256` | Variant ID to query |

**Returns:** `uint256` - Available units (maxSupply - minted)

**Frontend:**
```typescript
const { data: available } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'remaining',
  args: [1001n],
});
// available = 40n
```

---

### listTokenIds

Get all known token IDs.

```solidity
function listTokenIds() external view returns (uint256[] memory)
```

**Returns:** `uint256[]` - Array of all token IDs that have been created

**Frontend:**
```typescript
const { data: tokenIds } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'listTokenIds',
});
// tokenIds = [1001n, 1002n, 1003n, 1004n, ...]
```

---

### uri

Get metadata URI for a token.

```solidity
function uri(uint256 tokenId) public view override returns (string memory)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tokenId` | `uint256` | Token ID to query |

**Returns:** `string` - IPFS URI (per-token if set, otherwise baseURI)

**Frontend:**
```typescript
const { data: metadataUri } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'uri',
  args: [1001n],
});
// metadataUri = "ipfs://QmXyz.../metadata.json"

// Fetch metadata
const gatewayUrl = metadataUri.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/');
const metadata = await fetch(gatewayUrl).then(r => r.json());
```

---

### getRedemptionStatus

Get redemption status for a specific owner and token.

```solidity
function getRedemptionStatus(uint256 tokenId, address owner) external view returns (RedemptionStatus)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tokenId` | `uint256` | Token ID to query |
| `owner` | `address` | Owner address to query |

**Returns:** `RedemptionStatus` (0, 1, or 2)

**Frontend:**
```typescript
const { data: status } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getRedemptionStatus',
  args: [1001n, userAddress],
});
// status = 0 (NotRedeemed), 1 (PendingFulfillment), or 2 (Fulfilled)
```

---

### balanceOf (inherited from ERC1155)

Get token balance for an address.

```solidity
function balanceOf(address account, uint256 id) public view returns (uint256)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `account` | `address` | Owner address |
| `id` | `uint256` | Token ID |

**Returns:** `uint256` - Number of tokens owned

**Frontend:**
```typescript
const { data: balance } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'balanceOf',
  args: [userAddress, 1001n],
});
// balance = 2n (user owns 2 of this token)
```

---

### getSerialOwner

Look up the buyer address that owns a specific serial number.

```solidity
function getSerialOwner(uint256 tokenId, uint256 serial) external view returns (address)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tokenId` | `uint256` | The variant/size token ID |
| `serial` | `uint256` | The serial number (1-indexed, assigned at mint time) |

**Returns:** `address` — buyer address that owns this unit; `address(0)` if not yet minted

**Frontend:**
```typescript
// Look up who owns serial #42 of size M (tokenId 2)
const { data: owner } = useReadContract({
  address: swag1155,
  abi: Swag1155ABI,
  functionName: 'getSerialOwner',
  args: [2n, 42n],
});
// owner = "0xAbc..." or "0x000..." if not minted
```

**Fulfillment use case:**
```typescript
// Admin: list all buyers for a tokenId by iterating serials 1..nextSerial
const totalMinted = await readContract({ functionName: 'nextSerial', args: [tokenId] });
const buyers = [];
for (let serial = 1n; serial <= totalMinted; serial++) {
  const owner = await readContract({ functionName: 'getSerialOwner', args: [tokenId, serial] });
  buyers.push({ serial, owner });
}
```

---

## Events

### Purchase Events

| Event | Parameters | When Emitted |
|-------|------------|--------------|
| `Purchased` | `buyer`, `tokenId`, `quantity`, `unitPrice`, `totalPrice` | Single purchase via `buy()` |
| `PurchasedBatch` | `buyer`, `tokenIds[]`, `quantities[]`, `totalPrice` | Batch purchase via `buyBatch()` |

### Admin Events

| Event | Parameters | When Emitted |
|-------|------------|--------------|
| `VariantUpdated` | `tokenId`, `price`, `maxSupply`, `active` | `setVariant()` or `setVariantWithURI()` |
| `VariantURISet` | `tokenId`, `uri` | `setVariantWithURI()` |
| `TreasuryUpdated` | `newTreasury` | `setTreasury()` |
| `USDCUpdated` | `newUSDC` | `setUSDC()` |
| `AdminAdded` | `admin` | `addAdmin()` |
| `AdminRemoved` | `admin` | `removeAdmin()` |

### Redemption Events

| Event | Parameters | When Emitted |
|-------|------------|--------------|
| `RedemptionRequested` | `owner`, `tokenId` | User calls `redeem()` |
| `RedemptionFulfilled` | `owner`, `tokenId`, `admin` | Admin calls `markFulfilled()` |

### Royalty Events

| Event | Parameters | When Emitted |
|-------|------------|--------------|
| `RoyaltyAdded` | `tokenId`, `recipient`, `percentage` | Admin calls `addRoyalty()` |
| `RoyaltiesCleared` | `tokenId` | Admin calls `clearRoyalties()` |

### Discount Events

| Event | Parameters | When Emitted |
|-------|------------|--------------|
| `PoapDiscountAdded` | `tokenId`, `eventId`, `discountBps` | Admin calls `addPoapDiscount()` |
| `PoapDiscountRemoved` | `tokenId`, `eventId` | Admin calls `removePoapDiscount()` |
| `HolderDiscountAdded` | `tokenId`, `token`, `discountType`, `value` | Admin calls `addHolderDiscount()` |
| `HolderDiscountRemoved` | `tokenId`, `token` | Admin calls `removeHolderDiscount()` |
| `DiscountApplied` | `buyer`, `tokenId`, `originalPrice`, `finalPrice` | User purchases with discount via `buy()` or `buyBatch()` |
| `PoapWhitelistUpdated` | `tokenId`, `eventId`, `addresses[]`, `added` | Admin calls `addPoapWhitelist()` or `removePoapWhitelist()` |

### Serial Number Events

| Event | Parameters | When Emitted |
|-------|------------|--------------|
| `SerialMinted` | `buyer` *(indexed)*, `tokenId` *(indexed)*, `serial` *(indexed)* | One per unit on every `buy()` or `buyBatch()` call |

**Fulfillment workflow — listen for SerialMinted:**
```typescript
// Off-chain: build serial → buyer map from events
const logs = await publicClient.getLogs({
  address: swag1155,
  event: parseAbiItem('event SerialMinted(address indexed buyer, uint256 indexed tokenId, uint256 indexed serial)'),
  fromBlock: deployBlock,
});
// logs[i].args = { buyer: '0x...', tokenId: 2n, serial: 7n }
```

**Frontend Event Listening:**
```typescript
import { useWatchContractEvent } from 'wagmi';

// Listen for purchases
useWatchContractEvent({
  address: swag1155,
  abi: Swag1155ABI,
  eventName: 'Purchased',
  onLogs(logs) {
    logs.forEach((log) => {
      const { buyer, tokenId, quantity, totalPrice } = log.args;
      console.log(`${buyer} bought ${quantity} of token ${tokenId} for ${totalPrice}`);
    });
  },
});

// Listen for redemption requests (useful for backend)
useWatchContractEvent({
  address: swag1155,
  abi: Swag1155ABI,
  eventName: 'RedemptionRequested',
  onLogs(logs) {
    logs.forEach((log) => {
      const { owner, tokenId } = log.args;
      // Trigger shipping address collection
    });
  },
});

// Listen for discount events
useWatchContractEvent({
  address: swag1155,
  abi: Swag1155ABI,
  eventName: 'DiscountApplied',
  onLogs(logs) {
    logs.forEach((log) => {
      const { buyer, tokenId, originalPrice, finalPrice } = log.args;
      const savings = Number(originalPrice - finalPrice) / 1e6;
      console.log(`${buyer} saved $${savings} on token ${tokenId}`);
    });
  },
});
```

---

## Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `"invalid USDC"` | Zero address passed for USDC | Provide valid USDC contract address |
| `"invalid treasury"` | Zero address passed for treasury | Provide valid treasury address |
| `"invalid address"` | Zero address passed for admin | Provide valid admin address |
| `"maxSupply < minted"` | Trying to set maxSupply below already minted | Set maxSupply >= current minted count |
| `"invalid URI"` | Empty string passed for tokenURI | Provide valid IPFS URI |
| `"invalid quantity"` | Quantity is 0 | Provide quantity > 0 |
| `"variant inactive"` | Trying to buy inactive variant | Admin must activate variant first |
| `"exceeds supply"` | Not enough stock | Reduce quantity or wait for restock |
| `"length mismatch"` | tokenIds and quantities arrays differ in length | Ensure arrays have same length |
| `"empty batch"` | Empty arrays passed to buyBatch | Provide at least one item |
| `"not owner"` | Trying to redeem without owning NFT | User must own the token |
| `"already redeemed"` | Trying to redeem twice | NFT already redeemed |
| `"not pending"` | Admin trying to fulfill non-pending redemption | Status must be PendingFulfillment |
| `"invalid recipient"` | Zero address passed for royalty recipient | Provide valid recipient address |
| `"percentage must be > 0"` | Zero percentage passed for royalty | Provide percentage > 0 |
| `"total royalty exceeds 100%"` | Combined royalties exceed 10000 bps | Reduce royalty percentages (total must be ≤ 10000) |

---

## Frontend Integration Examples

### Complete Purchase Flow

```typescript
import { useWriteContract, useReadContract, useAccount } from 'wagmi';

function PurchaseButton({ tokenId, quantity }: { tokenId: bigint; quantity: number }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

  // Get variant info
  const { data: variant } = useReadContract({
    address: SWAG1155_ADDRESS,
    abi: Swag1155ABI,
    functionName: 'getVariant',
    args: [tokenId],
  });

  // Get discounted price
  const { data: discountedPrice } = useReadContract({
    address: SWAG1155_ADDRESS,
    abi: Swag1155ABI,
    functionName: 'getDiscountedPrice',
    args: [tokenId, address],
  });

  const handlePurchase = async () => {
    if (!variant || !discountedPrice) return;

    const totalPrice = discountedPrice * BigInt(quantity);

    // 1. Approve USDC (only if price > 0)
    if (totalPrice > 0n) {
      await writeContractAsync({
        address: USDC_ADDRESS,
        abi: ERC20ABI,
        functionName: 'approve',
        args: [SWAG1155_ADDRESS, totalPrice],
      });
    }

    // 2. Buy (discounts applied automatically)
    await writeContractAsync({
      address: SWAG1155_ADDRESS,
      abi: Swag1155ABI,
      functionName: 'buy',
      args: [tokenId, BigInt(quantity)],
    });

    alert('Purchase successful!');
  };

  // Calculate savings
  const originalPrice = variant ? Number(variant.price * BigInt(quantity)) / 1e6 : 0;
  const finalPrice = discountedPrice ? Number(discountedPrice * BigInt(quantity)) / 1e6 : 0;
  const savings = originalPrice - finalPrice;
  const hasSavings = savings > 0;

  return (
    <div>
      <button onClick={handlePurchase} disabled={!variant?.active}>
        {finalPrice === 0 ? 'Claim Free!' : `Buy ${quantity} for $${finalPrice.toFixed(2)}`}
      </button>
      {hasSavings && (
        <div style={{ color: 'green', fontSize: '0.9em' }}>
          Save ${savings.toFixed(2)} ({((savings / originalPrice) * 100).toFixed(0)}% off)
        </div>
      )}
    </div>
  );
}
```

### Complete Redemption Flow

```typescript
function RedemptionFlow({ tokenId }: { tokenId: bigint }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

  // Check ownership
  const { data: balance } = useReadContract({
    address: SWAG1155_ADDRESS,
    abi: Swag1155ABI,
    functionName: 'balanceOf',
    args: [address, tokenId],
  });

  // Check redemption status
  const { data: status } = useReadContract({
    address: SWAG1155_ADDRESS,
    abi: Swag1155ABI,
    functionName: 'getRedemptionStatus',
    args: [tokenId, address],
  });

  const canRedeem = balance && balance > 0n && status === 0;

  const handleRedeem = async () => {
    // 1. Call redeem on contract
    await writeContractAsync({
      address: SWAG1155_ADDRESS,
      abi: Swag1155ABI,
      functionName: 'redeem',
      args: [tokenId],
    });

    // 2. Collect shipping (off-chain)
    const shipping = await collectShippingAddress();

    // 3. Send to backend
    await fetch('/api/shipping', {
      method: 'POST',
      body: JSON.stringify({ tokenId: tokenId.toString(), wallet: address, shipping }),
    });
  };

  if (status === 2) return <span>Shipped</span>;
  if (status === 1) return <span>Awaiting Shipment</span>;
  if (!canRedeem) return <span>Cannot Redeem</span>;

  return <button onClick={handleRedeem}>Redeem Physical Item</button>;
}
```

### Admin Fulfillment

```typescript
function AdminFulfillment({ tokenId, owner }: { tokenId: bigint; owner: string }) {
  const { writeContractAsync } = useWriteContract();

  const handleFulfill = async () => {
    await writeContractAsync({
      address: SWAG1155_ADDRESS,
      abi: Swag1155ABI,
      functionName: 'markFulfilled',
      args: [tokenId, owner],
    });

    // Update backend
    await fetch('/api/admin/fulfillment', {
      method: 'POST',
      body: JSON.stringify({ tokenId: tokenId.toString(), owner }),
    });
  };

  return <button onClick={handleFulfill}>Mark as Shipped</button>;
}
```

---

## Quick Reference Card

### Factory-First Flow
```
1. Deploy infrastructure (one time per network):
   npx hardhat run scripts/deploy-all.ts --network base
   → ZKPassportNFT, FaucetManager, SwagFactory

2. Create a product (one time per item):
   ITEM_NAME="ETH Cali Hoodie" ITEM_SKU="..." ITEM_SIZES_JSON='[...]' \
   npx hardhat run scripts/deploy-collection.ts --network base
   → New Swag1155 deployed & registered in factory

3. Configure the product (on the Swag1155 address returned by factory):
   → addRoyalty(), addPoapDiscount(), addPoapWhitelist(), addHolderDiscount()

4. Frontend discovers products:
   → factory.getActiveCollections()  → list of Swag1155 addresses
   → factory.getCollectionMeta(addr) → name, SKU, variantCount
   → swag1155.listTokenIds()         → [1n, 2n, 3n] (sizes)
   → swag1155.getVariant(tokenId)    → price, supply, active
```

### TokenId Convention
```
TokenIds within a Swag1155 are 1-indexed, matching the sizes[] order from deployCollection():
  tokenId 1 = first size  (e.g. S)
  tokenId 2 = second size (e.g. M)
  tokenId 3 = third size  (e.g. L)
  tokenId 4 = fourth size (e.g. XL)
```

### Price Conversion
```typescript
// USDC has 6 decimals
const toBaseUnits = (usd: number) => BigInt(Math.round(usd * 1e6));
const toDisplay = (baseUnits: bigint) => Number(baseUnits) / 1e6;

// Examples:
toBaseUnits(25.50)   // → 25500000n
toDisplay(25500000n) // → 25.5
```

### Redemption States
```
0 = NotRedeemed        → User can call redeem()
1 = PendingFulfillment → Waiting for admin to verify shipment
2 = Fulfilled          → Shipment complete
```
