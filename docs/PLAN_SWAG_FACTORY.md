# Plan: SwagFactory — One Contract Per Item

## Overview

Instead of one `Swag1155` contract with many token IDs (one per item),
deploy a **separate `Swag1155` contract per item** via a `SwagFactory`.
Each deployed contract represents exactly one physical item (e.g., "ETHCali
2026 Hoodie"). Token IDs within that contract represent individual mints
(editions/serial numbers). The factory tracks all deployed item contracts
and the frontend enumerates them from the factory address.

The `Swag1155` contract itself is **UNCHANGED** in logic — only its usage
pattern changes: one variant/product registered per contract instead of many.

---

## Decisions

| Question | Answer |
|---|---|
| Payment token per collection? | Each collection sets its own ERC20 payment token freely at deploy time (USDC, DAI, etc.) |
| Treasury per collection? | Each collection sets its own treasury at deploy time |
| Upgradeable? | Yes — **UUPS proxy** (OpenZeppelin) |
| Naming convention? | `name` = display name (e.g., "ETHCali 2026 Hoodie"), `sku` = internal SKU (e.g., `"ethcali-hoodie-black"`) |
| SKU uniqueness enforcement? | Not on-chain — enforced off-chain in deploy script / admin UI |
| Legacy contract migration? | No dual-source — frontend updated to new factory-deployed addresses |
| Size/variant setup? | `deployCollection` accepts a `VariantInit[]` array — sets up all sizes (S, M, L, XL…) in one tx as tokenId 1, 2, 3… |
| Inventory tracking? | Per-size, per-contract — each `Swag1155` tracks `minted` and `maxSupply` per tokenId via the existing `Variant` struct |

---

## Size Management

**One contract per item type. One tokenId per size.**

```
SwagFactory
  └── Swag1155 @ 0xABC  ("ETHCali 2026 Hoodie", sku: "ethcali-hoodie-black")
        ├── tokenId 1  →  Size S  — price: 25 USDC, supply: 20, minted: 0
        ├── tokenId 2  →  Size M  — price: 25 USDC, supply: 40, minted: 0
        ├── tokenId 3  →  Size L  — price: 25 USDC, supply: 30, minted: 0
        └── tokenId 4  →  Size XL — price: 25 USDC, supply: 10, minted: 0

  └── Swag1155 @ 0xDEF  ("ETHCali 2026 T-Shirt", sku: "ethcali-tshirt-white")
        ├── tokenId 1  →  Size S  — price: 15 USDC, supply: 30, minted: 0
        ├── tokenId 2  →  Size M  — price: 15 USDC, supply: 50, minted: 0
        └── tokenId 3  →  Size L  — price: 15 USDC, supply: 20, minted: 0
```

- `deployCollection` accepts a `VariantInit[]` array — all sizes configured in one transaction
- Each `VariantInit` has: `sizeName` (label), `metadataURI` (IPFS per-size), `price`, `maxSupply`, `active`
- tokenIds are assigned sequentially: first variant → tokenId 1, second → tokenId 2, etc.
- Each size gets its own `metadataURI` (can differ if size affects the visual, e.g. size label in image)
- Inventory reads are per-tokenId: `swag.remaining(tokenId)` and `swag.getVariant(tokenId)`
- Admin can add more sizes post-deploy via direct `swag.setVariantWithURI(...)` calls on the contract
- Admin can deactivate a sold-out size via `swag.setVariant(tokenId, price, supply, false)`
- All sizes share the same discount config (POAP, holder) — discounts are per-tokenId, so they can also be differentiated if needed
- **Serial numbers**: each unit minted gets a unique, sequential serial number per tokenId (see below)

### Factory Control Flow During Deploy

Because `Swag1155` requires `ADMIN_ROLE` to call `setVariantWithURI`, the factory temporarily acts as admin during deployment:

```
1. Factory deploys Swag1155(metadataURI, paymentToken, treasury, address(this))
   → factory is initialAdmin, gets DEFAULT_ADMIN_ROLE + ADMIN_ROLE on the new contract

2. Factory loops VariantInit[] and calls:
   swag.setVariantWithURI(tokenId, price, maxSupply, active, sizeName_URI)
   for each size

3. Factory grants itemAdmin:
   swag.addAdmin(itemAdmin)          → grants ADMIN_ROLE to itemAdmin
   swag.grantRole(DEFAULT_ADMIN_ROLE, itemAdmin) → grants DEFAULT_ADMIN_ROLE

4. Factory removes itself:
   swag.renounceRole(ADMIN_ROLE, address(this))
   swag.renounceRole(DEFAULT_ADMIN_ROLE, address(this))
   → factory has zero privileges on the deployed contract after this

5. Factory registers the contract in collections[] and emits CollectionDeployed
```

---

## Why

| Current (one contract, many tokenIds) | Factory (one contract per item) |
|---|---|
| All items share one treasury config | Each item can have its own treasury |
| All items share one payment token | Each item can accept a different ERC20 |
| All items share one admin set | Per-item admin delegation possible |
| Discount configs mix across items | Discount config fully isolated per item |
| One compromise = all items at risk | Blast radius limited to one item |
| Frontend must filter tokenIds | Frontend just reads one contract per item |
| Hard to deprecate/retire one item | Deploy new contract, stop using old one |

---

## Serial Numbers (already implemented in Swag1155)

Each unit minted gets a unique, sequential serial number **per tokenId** (i.e., per size).
Serials are 1-indexed and assigned atomically at purchase time.

```
Hoodie contract @ 0xABC
  tokenId 1 (Size S):  serial #1 → 0xUserA,  serial #2 → 0xUserB
  tokenId 2 (Size M):  serial #1 → 0xUserC,  serial #2 → 0xUserA,  serial #3 → 0xUserD
  tokenId 3 (Size L):  serial #1 → 0xUserE
```

- `nextSerial[tokenId]` — current highest serial assigned (public mapping)
- `serialOwner[tokenId][serial]` — address that owns this unit (public mapping)
- `getSerialOwner(tokenId, serial)` — view helper; returns `address(0)` if not yet minted
- `SerialMinted(buyer, tokenId, serial)` — event emitted per unit at purchase time

**Fulfillment workflow**: admin queries `SerialMinted` events or calls `getSerialOwner`
to map each physical unit (serial) to the buyer's wallet for shipping.

---

## Contracts

### `SwagFactory.sol` (new)

Inherits: `Initializable`, `UUPSUpgradeable`, `AccessControlUpgradeable`

**State**
```solidity
address[] public collections;                        // all deployed item contracts
mapping(address => bool) public isCollection;        // quick membership check
mapping(address => CollectionMeta) public meta;      // name, sku, payment, creator

struct CollectionMeta {
    string name;            // display name, e.g. "ETHCali 2026 Hoodie"
    string sku;             // internal SKU, e.g. "ethcali-hoodie-black"
    address paymentToken;   // ERC20 token used for payments (USDC, DAI, etc.)
    address treasury;       // treasury address for this collection
    address creator;        // address that deployed it
    uint256 deployedAt;     // block.timestamp
    uint256 variantCount;   // how many sizes were registered at deploy time
    bool active;
}

// Passed as array to deployCollection — one entry per size
struct VariantInit {
    string sizeName;        // label stored off-chain in metadata, e.g. "S", "M", "L"
    string metadataURI;     // IPFS URI for this size (can differ or share base)
    uint256 price;          // price in payment token decimals
    uint256 maxSupply;      // inventory for this size
    bool active;            // whether it's on sale at deploy time
}
```

**Functions**
```
initialize(address admin)                           — called once via proxy

deployCollection(
    string name,                    // display name
    string sku,                     // internal SKU
    address paymentToken,           // ERC20 payment token (any token, not just USDC)
    address treasury,               // treasury for this item
    address itemAdmin,              // admin for the deployed Swag1155
    VariantInit[] calldata sizes    // one entry per size: S, M, L, XL…
) → address                                         ADMIN_ROLE only
    // Internally:
    // 1. Deploys new Swag1155(sizes[0].metadataURI, paymentToken, treasury, address(this))
    // 2. Loops sizes[]: calls setVariantWithURI(i+1, price, maxSupply, active, metadataURI)
    // 3. Grants itemAdmin DEFAULT_ADMIN_ROLE + ADMIN_ROLE on the new contract
    // 4. Factory renounces its own roles on the new contract
    // 5. Registers in collections[] + meta
    // 6. Emits CollectionDeployed

setCollectionActive(address, bool)                  ADMIN_ROLE only
getCollections() → address[]                        view
getActiveCollections() → address[]                  view
getCollectionMeta(address) → CollectionMeta         view
getCollectionCount() → uint256                      view
_authorizeUpgrade(address) override                 DEFAULT_ADMIN_ROLE only
```

**Events**
```
CollectionDeployed(
    address indexed collection,
    string name,
    string sku,
    address paymentToken,
    address treasury,
    uint256 variantCount,   // number of sizes registered
    address creator
)
CollectionStatusChanged(address indexed collection, bool active)
```

**Access**: `SwagFactory` has its own `AccessControl` with `ADMIN_ROLE`.

---

### `Swag1155.sol` (unchanged logic)

- No modifications needed beyond Track A (POAP whitelist changes already done)
- Constructor stays at 4 params: `(baseURI, paymentToken, treasury, initialAdmin)`
  (the `usdc` param already accepts any ERC20 address — just used as the payment token)
- When deployed via factory, tokenIds 1…N map to sizes S, M, L, XL… (N = `sizes` array length)
- The factory temporarily acts as `initialAdmin` to set up variants, then transfers
  control to `itemAdmin` and removes itself (see **Factory Control Flow** section above)
- All admin functions remain available post-deploy on the item address directly:
  `setVariant`, `setVariantWithURI`, `addRoyalty`, `addPoapDiscount`,
  `addPoapWhitelist`, `addHolderDiscount`, `addAdmin`, `removeAdmin`, etc.

---

## Deployment

### UUPS Proxy Setup

The `hardhat-upgrades` plugin handles the two-contract deployment automatically:
1. Deploy `SwagFactory` implementation (the logic)
2. Deploy `ERC1967Proxy` pointing to the implementation, calling `initialize(admin)`
3. Users interact with the proxy address — the logic can be upgraded later

```
npm install @openzeppelin/hardhat-upgrades
```

### Deploy Steps

1. Deploy `SwagFactory` implementation + UUPS proxy
2. Call `factory.deployCollection(name, sku, paymentToken, treasury, admin, [sizes...])` per item
   — `sizes` array: one `VariantInit` per size (S, M, L, XL), set up as tokenId 1, 2, 3, 4
3. Each call deploys a fresh `Swag1155`, configures all sizes atomically, transfers control to `itemAdmin`, and registers in the factory
4. Frontend reads `factory.getActiveCollections()` → loops each address with `Swag1155` ABI

---

## Implementation Steps

1. **Create `contracts/SwagFactory.sol`** — UUPS upgradeable, stores `collections[]`,
   `isCollection`, `CollectionMeta`, `VariantInit` struct. `deployCollection()` deploys
   `new Swag1155(...)` with factory as initial admin, loops `sizes[]` calling
   `setVariantWithURI` for each, transfers roles to `itemAdmin`, renounces factory
   roles, registers contract, emits `CollectionDeployed`.

2. **Write `test/SwagFactory.test.ts`** — deploy factory via proxy, call
   `deployCollection(...)` with 3 sizes (S/M/L), assert returned address is a valid
   `Swag1155` with tokenIds 1/2/3 configured (price, supply, URI, active), verify
   factory has no admin role on the deployed contract, test `setCollectionActive`,
   test admin-only gates, test upgrade authorization.

3. **Update `scripts/deploy-all.ts`** and **`ignition/modules/DeployAll.ts`** —
   deploy factory via `hardhat-upgrades` plugin, save proxy address to
   `deployments/` and `frontend/addresses.json`.

4. **Add `scripts/deploy-collection.ts`** — standalone CLI script that calls
   `factory.deployCollection(...)` for easy item creation from the CLI.

5. **Update frontend** — add `frontend/abis/SwagFactory.json`, register factory
   proxy address in `frontend/contracts.ts` per chain, enumerate collections via
   `getActiveCollections()` using the existing `Swag1155` ABI per address.
   Frontend just gets updated to the new factory-deployed addresses — no
   dual-source logic, no legacy flag.

---

## Admin Workflow

```
1. Admin deploys factory (once per chain)

2. For each new item:
   a. factory.deployCollection(
        "ETHCali 2026 Hoodie",    // name (display)
        "ethcali-hoodie-black",   // sku (internal)
        0xUSDC,                   // payment token (any ERC20)
        0xTreasury,               // treasury
        0xAdmin,                  // item admin
        [
          { sizeName: "S",  metadataURI: "ipfs://Qm.../S.json",  price: 25_000000, maxSupply: 20, active: true },
          { sizeName: "M",  metadataURI: "ipfs://Qm.../M.json",  price: 25_000000, maxSupply: 40, active: true },
          { sizeName: "L",  metadataURI: "ipfs://Qm.../L.json",  price: 25_000000, maxSupply: 30, active: true },
          { sizeName: "XL", metadataURI: "ipfs://Qm.../XL.json", price: 25_000000, maxSupply: 10, active: true },
        ]
      )
   b. Returns new Swag1155 address:
      - tokenId 1 = Size S  (20 supply)
      - tokenId 2 = Size M  (40 supply)
      - tokenId 3 = Size L  (30 supply)
      - tokenId 4 = Size XL (10 supply)
      - itemAdmin has full control, factory has no remaining role

   c. (Optional) Post-deploy admin calls directly on the returned address:
      - swag.addRoyalty(1, artistAddr, 500)              // 5% royalty on size S
      - swag.addPoapDiscount(1, eventId, 1000)           // 10% POAP discount
      - swag.addPoapWhitelist(1, eventId, [addrs])       // whitelist addresses
      - swag.addHolderDiscount(1, nftAddr, 0, 2000)      // 20% NFT holder discount
      - swag.setVariant(5, price, supply, true)          // add size XXL later
      - swag.setVariant(2, price, 0, false)              // deactivate sold-out M

3. Frontend auto-discovers new items via factory.getActiveCollections()
   - Reads all tokenIds per contract via swag.listTokenIds()
   - Reads per-size inventory via swag.remaining(tokenId)
   - Reads per-size price via swag.getVariant(tokenId).price
   d. Optionally add discounts: swag.addPoapDiscount(...), swag.addPoapWhitelist(...), swag.addHolderDiscount(...)
3. Frontend auto-discovers new items via factory.getActiveCollections()
```
