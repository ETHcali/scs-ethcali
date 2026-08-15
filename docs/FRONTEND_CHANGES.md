# Frontend Integration Reference

Single source of truth for all contract features and the current implementation status.

**Current alignment (March 2026):**
- Contracts deployed on Base, Unichain, Optimism (SwagFactory + FaucetManager + ZKPassportNFT)
- `deploy-all.ts` deploys infrastructure only — no standalone Swag1155
- Products are created exclusively via `SwagFactory.deployCollection()`
- `frontend/addresses.json` contains `SwagFactory` address per network (no `Swag1155`)
- ABIs are up to date in `frontend/abis/`

---

## 1. FaucetManager — Vault Creation (BREAKING CHANGE)

### Updated: `createVault`
```solidity
function createVault(
    string memory name,
    string memory description,
    uint256 claimAmount,
    VaultType vaultType,        // 0 = NonReturnable, 1 = Returnable
    bool whitelistEnabled,
    bool zkPassportRequired,    // NEW
    address allowedToken        // NEW (0x0 to disable)
) external onlyRole(ADMIN_ROLE) returns (uint256 vaultId)
```

**Previous signature (5 params):**
```solidity
// OLD: createVault(name, description, claimAmount, vaultType, whitelistEnabled)
```

**Changes:**
- Added `zkPassportRequired` (bool) - require ZKPassport NFT ownership
- Added `allowedToken` (address) - require specific token/NFT balance (0x0 = disabled)

### New: `updateVaultGating`
```solidity
function updateVaultGating(
    uint256 vaultId,
    bool zkPassportRequired,
    address allowedToken
) external onlyRole(ADMIN_ROLE)
```
Admin can change gating rules on existing vaults without recreating them.

### Updated: `canUserClaim`
```solidity
function canUserClaim(uint256 vaultId, address user)
    external view
    returns (bool canClaim, string memory reason)
```

**New rejection reasons:**
- `"Must own ZKPassport NFT"`
- `"Must hold required token"`

**Existing reasons:**
- `"Vault does not exist"`
- `"Vault not active"`
- `"Insufficient vault balance"`
- `"Already claimed from this vault"`
- `"Not whitelisted"`

### Updated Vault Struct
```solidity
struct Vault {
    string name;
    string description;
    uint256 claimAmount;
    uint256 balance;
    uint256 totalClaimed;
    uint256 totalReturned;
    VaultType vaultType;
    bool active;
    bool whitelistEnabled;
    bool zkPassportRequired;    // NEW
    address allowedToken;       // NEW
    uint256 createdAt;
}
```

### Frontend Actions
**Admin UI:**
- Update vault creation form to include zkPassportRequired (checkbox) and allowedToken (address input)
- Add "Update Gating" button on existing vaults to call `updateVaultGating`

**User UI:**
- Call `canUserClaim(vaultId, userAddress)` before showing claim button
- Display specific error messages for ZKPassport/token requirements
- Show badge if vault requires ZKPassport or specific token

---

## 2. Swag1155 — Constructor

### Current signature (4 params — unchanged from original)
```solidity
constructor(
    string memory baseURI,
    address _usdc,
    address _treasury,
    address initialAdmin
)
```

The `_poap` constructor parameter and `POAP_CONTRACT` immutable were added then removed.
POAP discount eligibility is now managed entirely through an admin-controlled whitelist — see **Section 10**.

### Frontend Actions
- No deployment changes needed; constructor matches original 4-param signature
- POAP discounts are set by admin via `addPoapWhitelist` / `removePoapWhitelist` (off-chain list)

---

## 3. Swag1155 — Royalty Management

### Add Royalty
```solidity
function addRoyalty(
    uint256 tokenId,
    address recipient,
    uint256 percentage          // Basis points (500 = 5%, 1000 = 10%)
) external onlyRole(ADMIN_ROLE)
```
- Total royalties per token cannot exceed 10000 bps (100%)
- Multiple recipients allowed per token
- Royalties auto-distributed in `buy()` and `buyBatch()`

### Clear Royalties
```solidity
function clearRoyalties(uint256 tokenId) external onlyRole(ADMIN_ROLE)
```
Removes all royalty recipients for a token.

### Get Royalties
```solidity
function getRoyalties(uint256 tokenId)
    external view
    returns (RoyaltyInfo[] memory)

struct RoyaltyInfo {
    address recipient;
    uint256 percentage;         // Basis points
}
```

### Get Total Royalty
```solidity
function totalRoyaltyBps(uint256 tokenId) external view returns (uint256)
```
Returns sum of all royalty percentages for a token.

### Distribution Flow
1. User calls `buy(tokenId, quantity)` or `buyBatch(...)`
2. Contract calculates: `royaltyAmount = (total * percentage) / 10000` for each recipient
3. Royalties transferred from buyer to recipients via `transferFrom`
4. Remainder transferred to treasury

### Events
```solidity
event RoyaltyAdded(uint256 indexed tokenId, address indexed recipient, uint256 percentage);
event RoyaltiesCleared(uint256 indexed tokenId);
```

### Frontend Actions
**Admin UI (per product):**
- Add Royalty button: tokenId, recipient address, percentage input (convert % to bps: 5% = 500)
- Show list of current royalties with recipient addresses and percentages
- Clear All Royalties button
- Show total royalty percentage (warn if near 100%)

**User Store UI:**
- No changes needed (royalties deducted automatically)

---

## 4. Swag1155 — Discount System (NEW)

Two discount types, both per product (tokenId). Discounts stack additively. 100% off = free (no USDC transfer).

### POAP Discounts

#### Add POAP Discount
```solidity
function addPoapDiscount(
    uint256 tokenId,
    uint256 eventId,            // POAP event ID
    uint256 discountBps         // Basis points (1000 = 10%)
) external onlyRole(ADMIN_ROLE)
```

#### Remove POAP Discount
```solidity
function removePoapDiscount(
    uint256 tokenId,
    uint256 index               // Array index
) external onlyRole(ADMIN_ROLE)
```

#### Get POAP Discounts
```solidity
function getPoapDiscounts(uint256 tokenId)
    external view
    returns (PoapDiscount[] memory)

struct PoapDiscount {
    uint256 eventId;
    uint256 discountBps;
    bool active;
}
```

### Holder Discounts

#### Add Holder Discount
```solidity
function addHolderDiscount(
    uint256 tokenId,
    address token,              // ERC20/ERC721 contract address
    DiscountType discountType,  // 0 = Percentage, 1 = Fixed
    uint256 value               // bps for Percentage, USDC base units for Fixed
) external onlyRole(ADMIN_ROLE)

enum DiscountType { Percentage, Fixed }
```
- **Percentage:** value in bps (1000 = 10% off)
- **Fixed:** value in USDC base units (1000000 = $1.00 off for 6-decimal USDC)

#### Remove Holder Discount
```solidity
function removeHolderDiscount(
    uint256 tokenId,
    uint256 index               // Array index
) external onlyRole(ADMIN_ROLE)
```

#### Get Holder Discounts
```solidity
function getHolderDiscounts(uint256 tokenId)
    external view
    returns (HolderDiscount[] memory)

struct HolderDiscount {
    address token;
    DiscountType discountType;
    uint256 value;
    bool active;
}
```

### Price Calculation

#### Get Discounted Price
```solidity
function getDiscountedPrice(uint256 tokenId, address buyer)
    external view
    returns (uint256 finalPrice)
```

**Discount Logic:**
1. Start with base price from `variants[tokenId].price`
2. Check all active POAP discounts — add bps if address is in `poapWhitelist[tokenId][eventId][buyer]` (admin-managed, no on-chain POAP call)
3. Check all active holder discounts — add bps (percentage) or fixed amount (ERC-20/ERC-721 balance checked on-chain)
4. Apply percentage discounts: `finalPrice = basePrice - (basePrice * totalBps / 10000)`
5. Apply fixed discounts: `finalPrice = finalPrice - fixedTotal`
6. If discounts >= 100%, return 0 (free)

**Automatic Application:**
- `buy()` and `buyBatch()` automatically use discounted price
- If finalPrice is 0, no USDC transfer occurs (NFT minted for free)

### Events
```solidity
event PoapDiscountAdded(uint256 indexed tokenId, uint256 eventId, uint256 discountBps);
event PoapDiscountRemoved(uint256 indexed tokenId, uint256 eventId);
event HolderDiscountAdded(uint256 indexed tokenId, address indexed token, DiscountType discountType, uint256 value);
event HolderDiscountRemoved(uint256 indexed tokenId, address indexed token);
event DiscountApplied(address indexed buyer, uint256 indexed tokenId, uint256 originalPrice, uint256 finalPrice);
```

### Frontend Actions

**Admin UI (per product):**
- **POAP Discounts Section:**
  - Add button: eventId input, discount % input (convert to bps)
  - List current POAP discounts with eventId and percentage
  - Remove button per discount (by index)

- **Holder Discounts Section:**
  - Add button: token address, type dropdown (Percentage/Fixed), value input
  - If Percentage: convert % to bps (10% = 1000)
  - If Fixed: convert dollars to base units ($1 = 1000000 for 6-decimal USDC)
  - List current holder discounts with token address, type, value
  - Remove button per discount (by index)

**User Store UI:**
1. **Before wallet connection:**
   - Show base price only

2. **After wallet connection:**
   - Call `getDiscountedPrice(tokenId, userAddress)` for each product
   - If discounted price < base price:
     - Show strikethrough base price: `~~$10.00~~`
     - Show green discounted price: `$7.50`
     - Show discount badge: "25% OFF" or "You save $2.50"
   - If discounted price = 0:
     - Show "FREE" badge
     - Hide USDC approval flow

3. **USDC Approval:**
   - Use discounted total for `approve()` amount, not base price
   - Calculate: `totalPrice = sum(getDiscountedPrice(tokenId[i], userAddress) * quantity[i])`

4. **Cart/Checkout:**
   - Show line items with discounted prices
   - Show total savings

---

## 5. Environment Variables

| Old Var Name | New Var Name | Purpose |
|--------------|--------------|---------|
| ~~SUPER_ADMIN_ADDRESS~~ | (removed) | Use network-specific admins |
| ~~ZKPASSPORT_OWNER_ADDRESS~~ | `ZK_PASSPORT_ADMIN` | ZKPassportNFT owner |
| ~~FAUCET_ADMIN_ADDRESS~~ | `FAUCET_ADMIN` | FaucetManager admin |
| ~~ADMIN_ADDRESS~~ | `SWAG_ADMIN` | Swag1155 admin |
| ~~TREASURY_ADDRESS~~ | `SWAG_TREASURY_ADDRESS` | Swag1155 treasury |

**New .env structure:**
```bash
# Contract Admins
SWAG_ADMIN=0x...
FAUCET_ADMIN=0x...
ZK_PASSPORT_ADMIN=0x...

# Treasury
SWAG_TREASURY_ADDRESS=0x...

# USDC Addresses (network-specific)
USDC_ADDRESS_ETH=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
USDC_ADDRESS_BASE=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_ADDRESS_UNI=0x078D782b760474a361dDA0AF3839290b0EF57AD6
USDC_ADDRESS_OP=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85
```

---

## 6. Network Support

**Supported Networks:**
| Network | Chain ID | USDC Address |
|---------|----------|--------------|
| Ethereum | 1 | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 |
| Base | 8453 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| Unichain | 130 | 0x078D782b760474a361dDA0AF3839290b0EF57AD6 |
| Optimism | 10 | 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 |

**POAP Contract (same on all chains):**
```
0x22C1f6050E56d2876009903609a2cC3fEf83B415
```

### Frontend Actions
- Add network switcher supporting all 4 chains
- Load correct USDC address per network (see network table above)

---

## 7. ABIs — Current State

All ABIs are up to date in `frontend/abis/`. **Do not regenerate unless contracts change.**

### FaucetManager.json ✅
- `createVault` (7 params: +zkPassportRequired, +allowedToken)
- `updateVaultGating` function
- Updated `Vault` struct
- `VaultCreated` and `VaultGatingUpdated` events

### Swag1155.json ✅
- Constructor: 4 params (baseURI, _usdc, _treasury, initialAdmin)
- Royalty functions: `addRoyalty`, `clearRoyalties`, `getRoyalties`, `totalRoyaltyBps`
- POAP discount functions: `addPoapDiscount`, `removePoapDiscount`, `getPoapDiscounts`
- POAP whitelist functions: `addPoapWhitelist`, `removePoapWhitelist`, `isPoapWhitelisted`
- Holder discount functions: `addHolderDiscount`, `removeHolderDiscount`, `getHolderDiscounts`
- `getDiscountedPrice`, `listTokenIds`, `getSerialOwner`
- Serial number events: `SerialMinted`

> This ABI is used to interact with **factory-deployed collections** (not a standalone contract).
> Do not reference a single `Swag1155` address — use `SwagFactory.getActiveCollections()` to
> discover product contract addresses.

### SwagFactory.json ✅
- `deployCollection` — creates a new Swag1155 per product
- `getCollections`, `getActiveCollections`, `getCollectionMeta`, `getCollectionCount`
- `setCollectionActive`, `isCollection`
- `addAdmin`, `removeAdmin`
- `CollectionDeployed`, `CollectionStatusChanged` events

### ZKPassportNFT.json ✅
- No changes

---

## 8. New Events

### FaucetManager Events

```solidity
event VaultCreated(
    uint256 indexed vaultId,
    string name,
    VaultType vaultType,
    uint256 claimAmount,
    bool whitelistEnabled,
    bool zkPassportRequired,    // NEW
    address allowedToken        // NEW
);

event VaultGatingUpdated(      // NEW
    uint256 indexed vaultId,
    bool zkPassportRequired,
    address allowedToken
);
```

### Swag1155 Events

```solidity
// Royalties
event RoyaltyAdded(uint256 indexed tokenId, address indexed recipient, uint256 percentage);
event RoyaltiesCleared(uint256 indexed tokenId);

// POAP Discounts
event PoapDiscountAdded(uint256 indexed tokenId, uint256 eventId, uint256 discountBps);
event PoapDiscountRemoved(uint256 indexed tokenId, uint256 eventId);

// Holder Discounts
event HolderDiscountAdded(uint256 indexed tokenId, address indexed token, DiscountType discountType, uint256 value);
event HolderDiscountRemoved(uint256 indexed tokenId, address indexed token);

// Purchase
event DiscountApplied(address indexed buyer, uint256 indexed tokenId, uint256 originalPrice, uint256 finalPrice);
```

### Frontend Actions
- Listen to `VaultGatingUpdated` to refresh vault details
- Listen to `RoyaltyAdded`/`RoyaltiesCleared` to update product royalty display
- Listen to `PoapDiscountAdded`/`Removed` to refresh discount lists
- Listen to `HolderDiscountAdded`/`Removed` to refresh discount lists
- Listen to `DiscountApplied` to show success message with savings

---

## Quick Reference: Key Function Calls

### Admin: Deploy a New Product via Factory
```typescript
// swagFactoryAddress from frontend/addresses.json → SwagFactory
await writeContract({
  address: swagFactoryAddress,
  abi: SwagFactoryABI,
  functionName: 'deployCollection',
  args: [
    'ETH Cali Hoodie',
    'ETH-CALI-HOODIE-2025',
    usdcAddress,
    treasuryAddress,
    itemAdminAddress,
    [
      { metadataURI: 'ipfs://QmS.../s.json', price: 25000000n, maxSupply: 50n,  active: true },
      { metadataURI: 'ipfs://QmM.../m.json', price: 25000000n, maxSupply: 100n, active: true },
      { metadataURI: 'ipfs://QmL.../l.json', price: 25000000n, maxSupply: 75n,  active: true },
    ],
  ],
});
// After tx confirms, read getCollections() for the new Swag1155 address
```

### Frontend: Enumerate Products
```typescript
// All live products
const collections = await readContract({
  address: swagFactoryAddress, abi: SwagFactoryABI,
  functionName: 'getActiveCollections',
});
for (const addr of collections) {
  const meta     = await readContract({ address: swagFactoryAddress, abi: SwagFactoryABI,
                     functionName: 'getCollectionMeta', args: [addr] });
  const tokenIds = await readContract({ address: addr, abi: Swag1155ABI,
                     functionName: 'listTokenIds' });
  // Build product card from meta.name, meta.sku, tokenIds
}
```

### Admin: Create Vault with Gating
```typescript
await writeContract({
  address: faucetManagerAddress, abi: FaucetManagerABI,
  functionName: 'createVault',
  args: ["ETHGlobal 2026", "Hackathon faucet", parseEther("0.1"),
         0, false, true, "0x1234..."],
  //     vaultType  whitelist  zkPassport  allowedToken
});
```

### Admin: Update Existing Vault Gating
```typescript
await writeContract({
  address: faucetManagerAddress, abi: FaucetManagerABI,
  functionName: 'updateVaultGating',
  args: [vaultId, true, "0x5678..."],
});
```

### Admin: Configure Product (on a specific Swag1155 address)
```typescript
const collectionAddr = '0xAAA...'; // from factory

// 5% royalty for artist
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addRoyalty', args: [tokenId, '0xArtist...', 500n] });

// 10% POAP discount for eventId 12345 on tokenId 1
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addPoapDiscount', args: [1n, 12345n, 1000n] });

// Whitelist attendees for that discount
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addPoapWhitelist', args: [1n, 12345n, ['0xUser1...', '0xUser2...']] });

// 15% off for NFT holders
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addHolderDiscount', args: [1n, '0xNFTAddr...', 0, 1500n] });

// $2 fixed off for ERC20 holders
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'addHolderDiscount', args: [1n, '0xERC20Addr...', 1, 2000000n] });
```

### User: Check Claim Eligibility
```typescript
const [canClaim, reason] = await readContract({
  address: faucetManagerAddress, abi: FaucetManagerABI,
  functionName: 'canUserClaim', args: [vaultId, userAddress],
});
if (!canClaim) {
  // reason: "Must own ZKPassport NFT" | "Must hold required token" | ...
}
```

### User: Get Discounted Price and Buy
```typescript
// collectionAddr discovered from factory
const discountedPrice = await readContract({
  address: collectionAddr, abi: Swag1155ABI,
  functionName: 'getDiscountedPrice', args: [tokenId, buyerAddress],
});
const totalPrice = discountedPrice * quantity;

// Approve USDC (skip if free)
if (totalPrice > 0n) {
  await writeContract({ address: usdcAddress, abi: ERC20ABI,
    functionName: 'approve', args: [collectionAddr, totalPrice] });
}

// Buy (discount applied automatically on-chain)
await writeContract({ address: collectionAddr, abi: Swag1155ABI,
  functionName: 'buy', args: [tokenId, quantity] });
```

---

## Implementation Checklist

### Done — contracts, scripts, and addresses aligned ✅

- [x] FaucetManager ABI updated (`frontend/abis/FaucetManager.json`)
- [x] Swag1155 ABI updated (`frontend/abis/Swag1155.json`)
- [x] SwagFactory ABI added (`frontend/abis/SwagFactory.json`)
- [x] `.env` variable names updated (`SWAG_ADMIN`, `FAUCET_ADMIN`, `ZK_PASSPORT_ADMIN`, `SWAG_TREASURY_ADDRESS`)
- [x] `deploy-all.ts` deploys infrastructure only — no standalone Swag1155
- [x] `deploy-collection.ts` creates products via factory
- [x] `frontend/addresses.json` — `Swag1155` removed, `SwagFactory` is the entry point
- [x] `setup-frontend.ts` generates factory-only addresses
- [x] SwagFactory deployed on Base, Unichain, Optimism
- [x] POAP discount uses admin-managed whitelist (no on-chain POAP contract call)
- [x] Contract reference doc (`SWAG1155_CONTRACT_REFERENCE.md`) updated with full SwagFactory section

### Pending — frontend app implementation

**FaucetManager UI:**
- [ ] Update vault creation form: add `zkPassportRequired` (checkbox) + `allowedToken` (address input)
- [ ] Add "Update Gating" button on existing vaults → `updateVaultGating(vaultId, bool, address)`
- [ ] Display specific rejection reasons from `canUserClaim` ("Must own ZKPassport NFT", "Must hold required token")

**Swag Store UI:**
- [ ] Use `SwagFactory.getActiveCollections()` to enumerate products — **no hardcoded Swag1155 address**
- [ ] Load product name/SKU from `SwagFactory.getCollectionMeta(addr)`
- [ ] Load sizes from `Swag1155.listTokenIds()` per collection
- [ ] On wallet connect: call `getDiscountedPrice(tokenId, userAddress)` per product
- [ ] Show strikethrough base price + green discounted price when discount applies
- [ ] Show "FREE" badge and skip USDC approval when finalPrice = 0
- [ ] Use discounted total for `approve()` amount (not base price)
- [ ] Subscribe to `SerialMinted(buyer, tokenId, serial)` for live inventory and order receipts

**Swag Admin UI (per product — operates on a specific Swag1155 address):**
- [ ] `deployCollection` form: name, SKU, payment token, treasury, item admin, sizes table
- [ ] Collection list: read `getActiveCollections()` + `getCollectionMeta()`, with `setCollectionActive` toggle
- [ ] Royalty management: `addRoyalty`, `clearRoyalties`, `getRoyalties` per tokenId
- [ ] POAP discount: `addPoapDiscount`, `removePoapDiscount`, `getPoapDiscounts` per tokenId
- [ ] POAP whitelist: upload attendee list → `addPoapWhitelist(tokenId, eventId, addresses[])` (batch ~200/tx)
- [ ] Holder discount: `addHolderDiscount`, `removeHolderDiscount`, `getHolderDiscounts` per tokenId
- [ ] Redemption queue: list `PendingFulfillment` statuses → `markFulfilled(tokenId, owner)`

**General:**
- [ ] Network switcher supporting Base, Unichain, Optimism (Ethereum has no SwagFactory yet)
- [ ] Load correct USDC address per chain from network table in Section 6

---

## Notes

- All prices in USDC use 6 decimals (1 USDC = 1000000 base units)
- All percentages use basis points (10000 = 100%)
- Discounts stack additively (10% + 5% = 15% off, not 14.5%)
- If total discount >= 100%, price becomes 0 (free mint)
- POAP discounts now use an admin-managed whitelist (`poapWhitelist[tokenId][eventId][address]`) — no POAP_CONTRACT
- Royalties are capped at <100% to ensure treasury always gets something
- `getDiscountedPrice` is a view function - safe to call frequently
- Events are indexed for efficient filtering (use tokenId, buyer, recipient indexes)
- SwagFactory is deployed directly (no proxy) — address in `frontend/addresses.json` → `SwagFactory`
- Serial numbers start at 1 per tokenId and increment monotonically; use `getSerialOwner(tokenId, serial)` to verify ownership

---

## 9. SwagFactory — Deployment Pattern ✅

A plain `AccessControl` factory (no proxy) that deploys one `Swag1155` per product item.
Each item has its own contract address; sizes/variants are `tokenId`s (1-indexed) within it.
The registry is rebuildable from `CollectionDeployed` events if a new factory is ever needed.

ABI location: `frontend/abis/SwagFactory.json`
Address: see `frontend/addresses.json` → `SwagFactory`

**This is the only way to create swag products. Standalone `Swag1155` deployments are no longer used.**

### Deployment pattern

| Step | Who | What |
|------|-----|------|
| 1 | Deploy team | `scripts/deploy-all.ts` deploys **ZKPassportNFT + FaucetManager + SwagFactory** (no Swag1155) |
| 2 | Factory admin | `scripts/deploy-collection.ts` calls `deployCollection(...)` — deploys & configures one Swag1155 per product |
| 3 | Item admin | Interact with the returned Swag1155 directly to add royalties, discounts, whitelist, etc. |

### `deployCollection`

```solidity
function deployCollection(
    string   calldata name,          // "ETH Cali Hoodie"
    string   calldata sku,           // "ETH-CALI-HOODIE-2025"
    address           paymentToken,  // ERC-20 used for payment (e.g. USDC)
    address           treasury,      // Where sales go
    address           itemAdmin,     // Who owns the new Swag1155
    VariantInit[]     sizes          // One entry per size (tokenId = index + 1)
) external onlyRole(ADMIN_ROLE) returns (address swagAddr)
```

**`VariantInit` struct:**
```solidity
struct VariantInit {
    string  metadataURI; // "ipfs://Qm.../s.json"
    uint256 price;       // Payment token base units (USDC: 6 decimals → 25 USDC = 25_000_000)
    uint256 maxSupply;   // Max inventory for this size
    bool    active;      // Open for sale at launch?
}
```

**Events emitted:**
```solidity
event CollectionDeployed(
    address indexed collection,
    string  name,
    string  sku,
    address paymentToken,
    address treasury,
    uint256 variantCount,
    address indexed creator
);
```

**Frontend actions:**
- Admin form: name, SKU, payment token address, treasury address, item admin address, sizes table (URI / price / supply / active)
- After tx confirms, read `getCollections()` to get the new contract address
- Store new address → `swagAddr` for direct product interaction

### `CollectionMeta` struct (returned by `getCollectionMeta`)

```solidity
struct CollectionMeta {
    string  name;
    string  sku;
    address paymentToken;
    address treasury;
    address creator;
    uint256 deployedAt;    // block.timestamp
    uint256 variantCount;
    bool    active;        // factory-level toggle only
}
```

### View functions

```solidity
function getCollections()       external view returns (address[] memory)
function getActiveCollections() external view returns (address[] memory)
function getCollectionMeta(address collection) external view returns (CollectionMeta memory)
function getCollectionCount()   external view returns (uint256)
function isCollection(address)  external view returns (bool)
```

**Frontend pattern — enumerate live products:**
```typescript
const factory = getContract({ address: FACTORY_ADDR, abi: SwagFactory_ABI, publicClient });
const activeCollections = await factory.read.getActiveCollections();

// For each collection, load its Swag1155 and fetch variants
for (const addr of activeCollections) {
  const meta  = await factory.read.getCollectionMeta([addr]);
  const swag  = getContract({ address: addr, abi: Swag1155_ABI, publicClient });
  const tokenIds = await swag.read.getTokenIds();
  // ... build product cards
}
```

### `setCollectionActive`

```solidity
function setCollectionActive(address collection, bool active) external onlyRole(ADMIN_ROLE)
```

Factory-level visibility toggle.  Does **not** affect the underlying Swag1155 sale state.
Use this to hide/show products in the storefront without modifying the deployed contract.

### Admin management (factory-level)

```solidity
function addAdmin(address admin)    external onlyRole(DEFAULT_ADMIN_ROLE)
function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE)
```

---

## 10. Swag1155 — POAP Whitelist (BREAKING from old on-chain POAP check)

### Removed
- `address public immutable POAP_CONTRACT` — **gone**
- 5th constructor parameter (`_poap`) — **gone**
- On-chain `IPOAP.balanceOf` call — **replaced with mapping lookup**

### Added: `poapWhitelist` mapping

```solidity
mapping(uint256 tokenId => mapping(uint256 eventId => mapping(address => bool))) public poapWhitelist
```

### Admin functions

```solidity
function addPoapWhitelist(
    uint256   tokenId,
    uint256   eventId,
    address[] calldata addresses
) external onlyRole(ADMIN_ROLE)

function removePoapWhitelist(
    uint256   tokenId,
    uint256   eventId,
    address[] calldata addresses
) external onlyRole(ADMIN_ROLE)

function isPoapWhitelisted(
    uint256 tokenId,
    uint256 eventId,
    address buyer
) external view returns (bool)
```

**Event:**
```solidity
event PoapWhitelistUpdated(
    uint256 indexed tokenId,
    uint256 indexed eventId,
    address[] addresses,
    bool added
);
```

**Frontend admin workflow:**
1. After a POAP event, export attendee wallet list
2. Batch-call `addPoapWhitelist(tokenId, eventId, addresses[])` — gas-efficient for up to ~200 addresses per tx
3. Monitor `PoapWhitelistUpdated` events to show whitelist status in admin dashboard

---

## 11. Swag1155 — Serial Numbers (NEW)

Every mint assigns a sequential serial number per tokenId starting at 1.

### New state

```solidity
mapping(uint256 tokenId => uint256 counter)             public nextSerial
mapping(uint256 tokenId => mapping(uint256 serial => address)) public serialOwner
```

### New view

```solidity
function getSerialOwner(uint256 tokenId, uint256 serial)
    external view returns (address)  // address(0) if not minted
```

### New event

```solidity
event SerialMinted(
    address indexed buyer,
    uint256 indexed tokenId,
    uint256 indexed serial
);
```

**Frontend use cases:**
- **Receipt / proof of purchase**: display serial number in order confirmation ("You got serial #42 of the ETH Cali Hoodie M")
- **Inventory counter**: `nextSerial[tokenId] - 1` = total minted for that size
- **Ownership proof**: `getSerialOwner(tokenId, serial)` confirms who holds a specific unit
- **Listen for mints**: subscribe to `SerialMinted(buyer, tokenId, serial)` to update live inventory UI

**Buying multiple units:**
```typescript
// buy(tokenId, quantity) emits quantity × SerialMinted events
const receipt = await swag.write.buy([tokenId, 3n]);
// Serials assigned: nextSerial-2, nextSerial-1, nextSerial (three consecutive)
```

