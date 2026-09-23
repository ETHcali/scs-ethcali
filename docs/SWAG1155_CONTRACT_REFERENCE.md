# Swag1155 Contract Reference

API reference for `Swag1155` and `SwagFactory`.

**Contracts**: `contracts/Swag1155.sol` · `contracts/SwagFactory.sol`
**Version**: 3.1 (two-channel inventory: on-chain `buy()` + Shopify `claim()` vouchers; order cancellation; serials as events)
**Last updated**: September 2026

---

## 1. Model

Shopify owns commerce: catalogue, fiat pricing, discount codes, customer accounts, orders,
fulfilment, shipping. None of that is on-chain. What Shopify cannot do is prove that a
specific wallet owns a specific item — that is this contract.

```
SwagFactory (one per network, address in frontend/addresses.json)
  └── ETH Cali Hoodie  → Swag1155 clone @ 0xAAA…
        tokenId 1 = S   onchainCap 6  / voucherCap 19   USDC 45, ETH 0.018
        tokenId 2 = M   onchainCap 10 / voucherCap 30
        …
  └── ETH Cali Tee     → Swag1155 clone @ 0xBBB…
```

- **One `Swag1155` per product**, deployed as an EIP-1167 clone by `SwagFactory.deployCollection`.
  The implementation's constructor sets `_initialized = true`, so a directly deployed
  `Swag1155` can never be configured. **Always get instances from the factory.**
- **Each size is a `tokenId`**, 1-indexed in the order passed to `deployCollection`.
- **Supply is split per variant into two counters that never touch:**

| Bucket | Channel | Entry point |
|--------|---------|-------------|
| `onchainCap` / `onchainMinted` | Storefront, paid in crypto | `buy(tokenId, quantity, paymentToken)` |
| `voucherCap` / `voucherMinted` | Shopify, already paid in fiat | `claim(voucher, signature)` |

If both channels drew from one cap, a Shopify checkout and an on-chain `buy()` landing in
the same moment could each see "1 left" and both commit. Set the Shopify product's
inventory to exactly `voucherCap` and neither channel can eat the other's stock.

- **Proceeds go straight to `treasury`.** The contract never holds revenue and `receive()`
  reverts on bare ETH.
- **Serials**: every unit gets a sequential serial per `tokenId`, **starting at 0**, across
  both channels. Storage keeps only the counter (`nextSerial`); each mint emits one
  `SerialsAssigned(tokenId, to, firstSerial, quantity)` and an indexer expands the range.

### Roles (per collection)

| Role | Can | Held by |
|------|-----|---------|
| `DEFAULT_ADMIN_ROLE` | `setTreasury`, `addAdmin`/`removeAdmin`, `addSigner`/`removeSigner` | the `itemAdmin` given to `deployCollection` |
| `ADMIN_ROLE` | `setVariant`, `setVariantWithURI`, `setBaseURI`, `setPaymentOption`, `removePaymentOption`, `cancelOrder`, `pause`, `unpause` | the `itemAdmin` |
| `SIGNER_ROLE` | sign claim vouchers (no on-chain calls) | the backend key — the `signer` argument to `deployCollection` (`seed-swag.ts` passes `SWAG_SIGNER`). With the zero address none is granted and every `claim()` reverts `InvalidSignature` until the `itemAdmin` calls `addSigner`. |

The factory grants the signer while it still holds `DEFAULT_ADMIN_ROLE`, then renounces
both of its own roles at the end of `deployCollection`.

---

## 2. SwagFactory

```solidity
struct PaymentOption { address token; uint256 price; }   // price in the token's own base units

struct VariantInit {
    string          metadataURI;   // full URI for this size's metadata
    uint128         onchainCap;    // units sellable via buy()
    uint128         voucherCap;    // units reserved for Shopify vouchers
    bool            active;
    PaymentOption[] payments;      // at least one per size
}

function deployCollection(
    string        calldata name,
    string        calldata sku,
    address                treasury,
    address                itemAdmin,
    VariantInit[] calldata sizes,
    address                signer        // SIGNER_ROLE holder; zero address grants none
) external onlyRole(ADMIN_ROLE) returns (address collection);
```

`deployCollection` clones the implementation, calls `initialize(sizes[0].metadataURI, treasury, factory)`,
then per size `setVariantWithURI` + one `setPaymentOption` per payment, grants `itemAdmin`
`DEFAULT_ADMIN_ROLE` + `ADMIN_ROLE` and `signer` `SIGNER_ROLE` (if non-zero), renounces
its own roles, and emits
`CollectionDeployed(collection, name, sku, treasury, variantCount, creator, signer)`.

Reverts: `EmptyName`, `EmptySku`, `InvalidTreasury`, `InvalidItemAdmin`, `NoSizes`,
`NoPaymentOptions` (a size with an empty `payments` array), and, bubbled up from the
collection, `Swag1155.EmptyVariant` (a size with both caps zero) and `Swag1155.ZeroPrice`
(a payment option priced at 0).

| Function | Notes |
|----------|-------|
| `getCollections()` | every collection, in deploy order |
| `getActiveCollections()` | those with the factory-level `active` flag — what the storefront lists |
| `getCollectionMeta(address)` | `{ name, sku, treasury, creator, deployedAt, variantCount, active }` |
| `isCollection(address)`, `getCollectionCount()` | |
| `setCollectionActive(address, bool)` | `ADMIN_ROLE`. Factory-level visibility only; does not touch the collection |
| `addAdmin` / `removeAdmin` | `DEFAULT_ADMIN_ROLE`. Factory-level admins who may deploy |
| `implementation()` | the cloned `Swag1155` |

The factory is not upgradeable and holds no funds; the registry can be rebuilt from
`CollectionDeployed` events.

In practice run `npm run seed:swag -- --network <net>` rather than calling this by hand: it
reads `swag-catalogue.json`, parses human-readable prices with each token's decimals,
skips SKUs already in the registry and passes `SWAG_SIGNER` as the signer (older
collections without one are repaired via `addSigner`).

---

## 3. Swag1155 — data

```solidity
struct Variant {
    uint128 onchainCap;
    uint128 onchainMinted;
    uint128 voucherCap;
    uint128 voucherMinted;
    bool    active;
}

struct ClaimVoucher {
    uint256 tokenId;
    address to;         // recipient — the mint goes here whoever submits the tx
    uint256 quantity;
    bytes32 orderRef;   // hash of the Shopify order id; burned on use
    uint256 deadline;   // unix seconds; claim reverts once block.timestamp > deadline
}

address constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;   // native token sentinel
```

A variant "exists" when `onchainCap != 0 || voucherCap != 0`. `setVariant` enforces this
(`EmptyVariant`), so `listTokenIds()` never lists a variant the rest of the contract
would report as `VariantNotFound`, and never lists the same id twice.

---

## 4. Swag1155 — admin

| Function | Role | Notes |
|----------|------|-------|
| `setVariant(tokenId, onchainCap, voucherCap, active)` | ADMIN | Create or reconfigure. Reverts `EmptyVariant` if both caps are 0 (deactivate instead), `CapBelowMinted` if either cap is below that channel's minted count — caps only move up once selling. Registers the id in `listTokenIds()` once, however often it is reconfigured. |
| `setVariantWithURI(tokenId, onchainCap, voucherCap, active, metadataURI)` | ADMIN | Same plus a per-token URI. `EmptyURI` if blank. |
| `setBaseURI(uri)` | ADMIN | Fallback for tokens with no per-token URI. |
| `setPaymentOption(tokenId, token, price)` | ADMIN | Accept `token` for this size at `price` **in that token's base units** (45 USDC = `45_000_000`; 0.018 ETH = `18_000_000_000_000_000`). Use `ETH_TOKEN` for native. Overwrites an existing price. Reverts `ZeroPrice` on 0 — free distribution is a signed `claim()` voucher, never a zero price. |
| `removePaymentOption(tokenId, token)` | ADMIN | |
| `cancelOrder(orderRef)` | ADMIN | Close a refunded / fraudulent Shopify order: marks `orderClaimed[orderRef] = true` and emits `OrderCancelled`. Reverts `VoucherAlreadyClaimed` if the ref is already spent by a claim **or** an earlier cancel — a cancel after the customer minted must be loud. |
| `pause()` / `unpause()` | ADMIN | Blocks `buy` and `claim`. Transfers still work. |
| `setTreasury(address)` | DEFAULT_ADMIN | Where every sale is sent. If a contract, it must accept plain ETH or native-token buys revert `EthTransferFailed`. |
| `addAdmin` / `removeAdmin` | DEFAULT_ADMIN | Grants/revokes `ADMIN_ROLE`. |
| `addSigner` / `removeSigner` | DEFAULT_ADMIN | Grants/revokes `SIGNER_ROLE`. Rotate the backend key here. |

---

## 5. Swag1155 — buying and claiming

### `buy(uint256 tokenId, uint256 quantity, address paymentToken) payable`

Checks, in order: not paused → variant exists (`VariantNotFound`) → `active`
(`VariantNotActive`) → `quantity > 0` (`ZeroQuantity`) → `quantity <= onchainCap - onchainMinted`
(`SoldOut(tokenId, remaining)`) → `paymentToken` accepted (`PaymentTokenNotAccepted`).

Then `total = price * quantity`:

- `paymentToken == ETH_TOKEN`: `msg.value` must equal `total` exactly (`IncorrectEthAmount(expected, sent)`, no refund path); forwarded to `treasury` (`EthTransferFailed`).
- ERC-20: `msg.value` must be 0 (`EthNotAccepted`); `safeTransferFrom(buyer, treasury, total)` — the buyer must have approved at least `total`.

Mints `quantity` of `tokenId` to `msg.sender`, assigns serials, emits
`Purchased(tokenId, buyer, quantity, paymentToken, paid)`.

### `claim(ClaimVoucher calldata voucher, bytes calldata signature)`

Checks, in order: not paused → `deadline` (`VoucherExpired`) → `orderRef` unused
(`VoucherAlreadyClaimed`) → `quantity > 0` → `to != 0` (`InvalidRecipient`) → variant exists and
active → `quantity <= voucherCap - voucherMinted` (`SoldOut`) → signature recovers to a
`SIGNER_ROLE` holder (`InvalidSignature`).

Marks `orderClaimed[orderRef] = true`, mints to `voucher.to`, assigns serials (one
`SerialsAssigned` event), emits `Claimed(tokenId, to, quantity, orderRef)`. Anyone may
submit; `msg.sender` is irrelevant, so the backend can relay gas-free claims if it wants to.

`claim()` and `cancelOrder()` share the same idempotency key: whichever lands first wins
and the other reverts `VoucherAlreadyClaimed`.

### Signing a voucher (backend)

EIP-712 domain `{ name: "ETHCaliSwag", version: "1", chainId, verifyingContract: <collection> }`,
type `Claim(uint256 tokenId,address to,uint256 quantity,bytes32 orderRef,uint256 deadline)`.
A signature is valid only on the collection it was signed for.

```typescript
import { keccak256, toBytes } from "viem";

const voucher = {
  tokenId:  1n,
  to:       customerWallet,
  quantity: BigInt(lineItem.quantity),
  orderRef: keccak256(toBytes(`shopify:${order.id}`)),   // idempotent per order → replayed webhook = same voucher
  deadline: BigInt(Math.floor(Date.now() / 1000) + 90 * 24 * 3600),
};

const signature = await signerAccount.signTypedData({
  domain: { name: "ETHCaliSwag", version: "1", chainId, verifyingContract: collection },
  types: { Claim: [
    { name: "tokenId",  type: "uint256" },
    { name: "to",       type: "address" },
    { name: "quantity", type: "uint256" },
    { name: "orderRef", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ]},
  primaryType: "Claim",
  message: voucher,
});
```

`hashVoucher(voucher)` returns the exact digest the contract will verify — useful to
cross-check a backend implementation. One Shopify line item with several sizes needs one
voucher per `tokenId`, each with its own `orderRef` (e.g. `shopify:<order>:<lineItem>`).

---

## 6. Swag1155 — views

| Function | Returns |
|----------|---------|
| `getVariant(tokenId)` / `variants(tokenId)` | `Variant` |
| `listTokenIds()` | every configured `tokenId` |
| `remainingOnchain(tokenId)` | `onchainCap - onchainMinted` — what the storefront can still sell |
| `remainingVoucher(tokenId)` | `voucherCap - voucherMinted` — Shopify's remaining stock |
| `totalMinted(tokenId)` | `onchainMinted + voucherMinted` |
| `getPaymentTokens(tokenId)` | accepted token addresses |
| `getTokenPrice(tokenId, token)` | unit price in that token's base units; reverts `PaymentTokenNotAccepted` if not configured |
| `variantTokenPrice(tokenId, token)` | same, raw mapping (0 if not configured) |
| `canBuy(tokenId, quantity, paymentToken)` | `(bool allowed, string reason)` — mirrors every `buy` check except the buyer's balance/allowance and `msg.value`; also returns `"Quantity too large"` where `buy` would panic on `price * quantity` overflow |
| `canClaim(voucher, signature)` | `(bool allowed, string reason)` — mirrors every `claim` check |
| `hashVoucher(voucher)` | the EIP-712 digest |
| `orderClaimed(orderRef)` | whether a Shopify order has already minted **or been cancelled** |
| `nextSerial(tokenId)` | serials issued so far (`== totalMinted`). Who holds which serial is not in storage — index `SerialsAssigned`. |
| `uri(tokenId)` | per-token URI, else base URI |
| `treasury()`, `isAdmin(a)`, `isSuperAdmin(a)`, `hasRole(role, a)`, `paused()` | |

`canBuy` / `canClaim` reasons: `"Variant does not exist"`, `"Sales are paused"` /
`"Claims are paused"`, `"Variant not active"`, `"Quantity must be greater than zero"`,
`"Sold out on-chain"` / `"No voucher allocation left"`, `"Payment token not accepted"`,
`"Quantity too large"`, `"Voucher expired"`, `"Order already claimed or cancelled"`,
`"Invalid recipient"`, `"Malformed signature"`, `"Voucher not signed by an authorised signer"`.

---

## 7. Events

```solidity
event VariantSet(uint256 indexed tokenId, uint128 onchainCap, uint128 voucherCap, bool active);
event PaymentOptionSet(uint256 indexed tokenId, address indexed token, uint256 price);
event PaymentOptionRemoved(uint256 indexed tokenId, address indexed token);
event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
event Purchased(uint256 indexed tokenId, address indexed buyer, uint256 quantity, address indexed paymentToken, uint256 paid);
event Claimed(uint256 indexed tokenId, address indexed to, uint256 quantity, bytes32 indexed orderRef);
event OrderCancelled(bytes32 indexed orderRef);
event SerialsAssigned(uint256 indexed tokenId, address indexed to, uint256 firstSerial, uint256 quantity); // one per mint, range [firstSerial, firstSerial + quantity)
// plus ERC-1155 TransferSingle/TransferBatch, Pausable Paused/Unpaused, AccessControl RoleGranted/RoleRevoked
```

`SwagFactory`: `CollectionDeployed(address indexed collection, string name, string sku, address treasury, uint256 variantCount, address indexed creator, address signer)`,
`CollectionStatusChanged(address indexed collection, bool active)`.

## 8. Errors

| Error | Meaning |
|-------|---------|
| `AlreadyInitialized` | `initialize` called twice, or on the implementation |
| `InvalidTreasury`, `InvalidRecipient`, `EmptyURI` | zero address / blank URI in an admin call |
| `VariantNotFound(tokenId)`, `VariantNotActive(tokenId)` | |
| `ZeroQuantity` | |
| `EmptyVariant` | `setVariant` with both caps 0 — a variant with no stock in either channel |
| `ZeroPrice` | `setPaymentOption` with `price == 0` |
| `CapBelowMinted` | admin tried to cut a cap below that channel's minted count |
| `SoldOut(tokenId, remaining)` | the requested channel has fewer than `quantity` left |
| `PaymentTokenNotAccepted(tokenId, token)` | |
| `IncorrectEthAmount(expected, sent)` | native buy with `msg.value != price * quantity` |
| `EthNotAccepted` | `msg.value != 0` on an ERC-20 buy |
| `EthTransferFailed` | treasury refused the ETH |
| `VoucherExpired(deadline)`, `InvalidSignature` | |
| `VoucherAlreadyClaimed(orderRef)` | `orderRef` already spent — by a claim or a `cancelOrder`. Also what `cancelOrder` itself reverts with when the order already minted. |
| `DirectEthNotAccepted` | bare ETH sent to the contract |
| `EnforcedPause` (OpenZeppelin) | `buy` / `claim` while paused |
| `AccessControlUnauthorizedAccount(account, role)` (OpenZeppelin) | wrong role |

---

## 9. Operations checklist

1. `npm run deploy:<net>` — deploys the `Swag1155` implementation and `SwagFactory`, writes
   `swag1155Implementation` + `swagFactory` to `deployments/<net>-latest.json`.
2. Fill `swag-catalogue.json` (copy `swag-catalogue.example.json`). Human-readable prices;
   `voucherCap` per size = the Shopify inventory you will set.
3. `SWAG_SIGNER=<backend address> npm run seed:swag -- --network <net>` — deploys one
   collection per SKU with `SWAG_SIGNER` as its voucher signer. Without `SWAG_SIGNER` it
   warns loudly and **no voucher can be claimed** until the `itemAdmin` calls `addSigner`.
4. Set each Shopify product's inventory to its `voucherCap`.
5. `npm run verify:<net>`, `npm run setup:frontend`, copy ABIs to `wallet_ethcali/frontend/abis/`.

Tests: `test/Swag1155.test.ts`, `test/SwagFactory.test.ts` (Hardhat flows) and
`test/forge/Swag1155.invariants.t.sol` (Foundry: caps never exceeded, supply == channel
counters, `nextSerial` == mints, treasury == payments, contract holds nothing, an `orderRef`
mints once and never after a cancel, the tokenId registry has no duplicates and no empty
variants, `canBuy`/`canClaim` agree with `buy`/`claim`).
