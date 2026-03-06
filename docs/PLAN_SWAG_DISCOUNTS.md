# Plan: Swag1155 Discount System

Two independent discount types. **Additive stacking** — if a buyer qualifies for both, discounts add up. 100% off is valid (free swag). Admin configures per product.

---

## Discount Types

| Type | How it works | Admin sets |
|------|-------------|------------|
| **POAP Discount** | Per tokenId: POAP eventId + % off | `addPoapDiscount(tokenId, eventId, bps)` |
| **Holder Discount** | Per tokenId: contract address + % or fixed | `addHolderDiscount(tokenId, token, type, value)` |

---

## 1. POAP Contract — Same Address on All Chains

POAP is deployed at `0x22C1f6050E56d2876009903609a2cC3fEf83B415` on:
- Ethereum (1), Base (8453), Unichain (130), Gnosis (100), Arbitrum, Polygon, etc.

**No whitelist fallback needed.** Direct on-chain `balanceOf` works everywhere.

Default in constructor or hardcoded:
```solidity
address public constant POAP_CONTRACT = 0x22C1f6050E56d2876009903609a2cC3fEf83B415;
```

## 2. POAP Interface

```solidity
interface IPOAP {
    function balanceOf(address owner, uint256 eventId) external view returns (uint256);
}
```

Note: POAP uses a custom `balanceOf(address, uint256)` — not the standard ERC721 `balanceOf(address)`. The second param is the eventId.

## 3. New Structs & State

```solidity
enum DiscountType { Percentage, Fixed }

// POAP discount: tied to a specific product (tokenId)
struct PoapDiscount {
    uint256 eventId;
    uint256 discountBps;   // basis points (1000 = 10%)
    bool active;
}

// Holder discount: tied to a specific product (tokenId)
struct HolderDiscount {
    address token;          // ERC20/ERC721 contract address
    DiscountType discountType;
    uint256 value;          // bps for Percentage, USDC base units for Fixed
    bool active;
}

// State
mapping(uint256 => PoapDiscount[]) public poapDiscounts;    // tokenId => POAP discount tiers
mapping(uint256 => HolderDiscount[]) public holderDiscounts; // tokenId => holder discount tiers
```

## 4. Admin Functions — POAP Discounts

```solidity
// Add a POAP discount tier for a specific product
function addPoapDiscount(
    uint256 tokenId,
    uint256 eventId,
    uint256 discountBps
) external onlyRole(ADMIN_ROLE)
// require: discountBps > 0 && discountBps < ROYALTY_DENOMINATOR

// Remove a POAP discount tier by index
function removePoapDiscount(uint256 tokenId, uint256 index) external onlyRole(ADMIN_ROLE)

// View all POAP discounts for a product
function getPoapDiscounts(uint256 tokenId) external view returns (PoapDiscount[] memory)
```

## 5. Admin Functions — Holder Discounts (per product)

```solidity
// Add holder discount for a specific product
function addHolderDiscount(
    uint256 tokenId,
    address token,
    DiscountType discountType,
    uint256 value
) external onlyRole(ADMIN_ROLE)
// require: token != address(0), value > 0, Percentage < 10000

// Remove a holder discount tier by index
function removeHolderDiscount(uint256 tokenId, uint256 index) external onlyRole(ADMIN_ROLE)

// View all holder discounts for a product
function getHolderDiscounts(uint256 tokenId) external view returns (HolderDiscount[] memory)
```

Admin adds holder discounts when creating/editing a product — same UX as adding POAP discounts.

## 6. Price Calculation

```solidity
// Returns best discounted price for a buyer on a specific tokenId
function getDiscountedPrice(
    uint256 tokenId,
    address buyer
) public view returns (uint256 finalPrice, string memory source) {
    uint256 basePrice = variants[tokenId].price;
    uint256 totalDiscountBps = 0;  // accumulate all percentage discounts
    uint256 fixedDiscount = 0;     // accumulate all fixed discounts

    // Check POAP discounts (per-tokenId) — additive
    PoapDiscount[] storage poaps = poapDiscounts[tokenId];
    for (uint256 i = 0; i < poaps.length; i++) {
        if (!poaps[i].active) continue;
        try IPOAP(POAP_CONTRACT).balanceOf(buyer, poaps[i].eventId) returns (uint256 bal) {
            if (bal > 0) {
                totalDiscountBps += poaps[i].discountBps;
            }
        } catch {}
    }

    // Check holder discounts (per-tokenId) — additive
    HolderDiscount[] storage holders = holderDiscounts[tokenId];
    for (uint256 i = 0; i < holders.length; i++) {
        if (!holders[i].active) continue;
        uint256 balance;
        try IERC721(holders[i].token).balanceOf(buyer) returns (uint256 bal) {
            balance = bal;
        } catch {
            try IERC20(holders[i].token).balanceOf(buyer) returns (uint256 bal) {
                balance = bal;
            } catch { continue; }
        }
        if (balance > 0) {
            if (holders[i].discountType == DiscountType.Percentage) {
                totalDiscountBps += holders[i].value;
            } else {
                fixedDiscount += holders[i].value;
            }
        }
    }

    // Apply additive discount (cap at 100%)
    if (totalDiscountBps >= ROYALTY_DENOMINATOR) {
        return (0, "FREE");  // 100%+ off = free
    }
    uint256 percentOff = (basePrice * totalDiscountBps) / ROYALTY_DENOMINATOR;
    uint256 finalPrice = basePrice - percentOff;
    finalPrice = finalPrice > fixedDiscount ? finalPrice - fixedDiscount : 0;

    string memory source = "";
    if (totalDiscountBps > 0 || fixedDiscount > 0) source = "DISCOUNT";
    return (finalPrice, source);
}
```

## 7. Modified `buy()` and New `buyWithHolderDiscount()`

### `buy()` — checks POAP discounts automatically

```solidity
function buy(uint256 tokenId, uint256 quantity) external nonReentrant {
    require(quantity > 0, "invalid quantity");
    Variant storage v = variants[tokenId];
    require(v.active, "variant inactive");
    require(v.minted + quantity <= v.maxSupply, "exceeds supply");

    (uint256 unitPrice, ) = getDiscountedPrice(tokenId, msg.sender);
    uint256 total = unitPrice * quantity;
    if (total > 0) {
        _distributePayment(tokenId, total);
    }

    v.minted += quantity;
    _mint(msg.sender, tokenId, quantity, "");

    emit Purchased(msg.sender, tokenId, quantity, unitPrice, total);
}
```

Both POAP and holder discounts are checked automatically in `getDiscountedPrice()` — no separate buy function needed. Same pattern for `buyBatch()` — call `getDiscountedPrice` per tokenId.

## 8. Events

```solidity
event PoapDiscountAdded(uint256 indexed tokenId, uint256 eventId, uint256 discountBps);
event PoapDiscountRemoved(uint256 indexed tokenId, uint256 eventId);
event HolderDiscountAdded(uint256 indexed tokenId, address indexed token, DiscountType discountType, uint256 value);
event HolderDiscountRemoved(uint256 indexed tokenId, address indexed token);
event DiscountApplied(address indexed buyer, uint256 indexed tokenId, uint256 originalPrice, uint256 finalPrice, string source);
```

## 9. Test Plan (~12 tests)

Need a **mock POAP contract** in tests that implements `balanceOf(address, uint256)`.

1. Add POAP discount → buyer with POAP gets reduced price
2. Add POAP discount → buyer without POAP pays full price
3. Multiple POAP tiers on same product → best discount wins
4. Remove POAP discount → full price
5. Set holder discount (percentage) → holder gets discount via `buyWithHolderDiscount`
6. Set holder discount (fixed) → holder gets fixed amount off
7. Holder without token → full price
8. Remove holder discount → full price
9. POAP 10% + holder 20% → buyer pays 70% (additive stacking)
10. POAP 50% + holder 50% → free (100% off, no USDC transfer)
11. POAP 60% + holder 60% → still free (capped at 100%, no revert)
12. Only POAP set, no holder → just POAP discount applies
13. Only holder set, no POAP → just holder discount applies
14. buyBatch with discounts per tokenId
15. Admin-only access on all set/remove functions

## 10. Files to Modify

| File | Changes |
|------|---------|
| `contracts/Swag1155.sol` | Add IPOAP interface, structs, state, POAP_CONTRACT constant, admin funcs, getDiscountedPrice, modify buy()/buyBatch() |
| `test/Swag1155.test.ts` | Add MockPOAP contract, discount test section (~12 tests) |
| `frontend/abis/Swag1155.json` | Regenerate |
| `docs/SWAG1155_CONTRACT_REFERENCE.md` | Add discount section |
| `FRONTEND_CHANGES.md` | Add discount UI requirements |

## 11. Implementation Order

1. Add `IPOAP` interface + `POAP_CONTRACT` constant
2. Add `DiscountType` enum, `PoapDiscount`, `HolderDiscount` structs + state
3. Add POAP discount admin functions
4. Add holder discount admin functions
5. Add `getDiscountedPrice()` view (checks both POAP + holder per tokenId)
6. Modify `buy()` to use discounted price
7. Modify `buyBatch()` to use discounted price per tokenId
9. Add events
10. Write MockPOAP + tests
11. Regenerate ABIs
12. Update docs

## 12. Frontend Changes

### Admin UI:
- **POAP Discounts tab** (per product): eventId + discount % + add/remove
- **Holder Discounts** (per product, same view as POAP): token address + percentage/fixed + value + add/remove

### User Store:
- Call `getDiscountedPrice(tokenId, userAddress)` when wallet connected
- Show strikethrough original price + green discounted price + badge ("POAP discount!" / "Holder discount!")
- Just call `buy(tokenId, qty)` — contract checks everything automatically
- USDC approval uses discounted total, not base price
