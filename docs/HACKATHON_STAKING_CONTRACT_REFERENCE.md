# HackathonStaking Contract Reference

**Complete API reference** for the HackathonStaking commitment-bond contract with frontend integration guide.

**Contract**: `contracts/HackathonStaking.sol`
**Version**: 1.0 (Phase 1 — bond only, no yield)
**Last Updated**: August 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Lifecycle](#lifecycle)
3. [Data Structures](#data-structures)
4. [Admin Functions](#admin-functions)
5. [User Functions](#user-functions)
6. [View Functions](#view-functions)
7. [Events](#events)
8. [Error Messages](#error-messages)
9. [Phase 2 — Yield Seam](#phase-2--yield-seam)
10. [Frontend Integration](#frontend-integration)

---

## Overview

HackathonStaking is a **multi-hackathon commitment-bond system**. Participants post a
fixed bond to register for a hackathon and reclaim it in full once an admin confirms
their submission. Bonds belonging to no-shows are swept to a prize pool after the
submission deadline.

A bond is **not an investment**. A participant who submits always receives exactly the
principal they staked — never less.

### Key Features

| Feature | Description |
|---------|-------------|
| **Multiple Hackathons** | One contract, unlimited events, each independently configured |
| **Fixed Bond** | Every participant in a hackathon stakes the same amount |
| **ETH or ERC-20** | Native ETH via the `0xEeee…EEeE` sentinel, or any standard ERC-20 |
| **Anti-Sybil** | Optional ZKPassport NFT gating per hackathon |
| **Token/NFT Gating** | Restrict registration to holders of a specific token |
| **Whitelist** | Optional whitelist per hackathon |
| **Admin-Confirmed Submissions** | Unstaking unlocks only after a jury marks the submission |
| **Paginated Forfeits** | No-show bonds sweep to a prize pool without gas limits |
| **Good Actor Tracking** | `submissionCount` counts hackathons a builder has delivered |
| **Yield-Ready** | Phase 2 seam lets a strategy be attached with no redeploy |

### Relationship to FaucetManager

`FaucetManager` has a `Returnable` vault type where the **contract pays the user first**
and the user returns funds voluntarily. HackathonStaking is the inverse — the **user pays
in first** and reclaims on delivery. The gating, role, and event conventions are shared,
but the two are independent contracts.

---

## Lifecycle

```
 admin                        participant                    admin
   │                               │                            │
   ├─ createHackathon()            │                            │
   │                               │                            │
   │      ── registrationDeadline ─┼─────────────────────        │
   │                               ├─ stake()                   │
   │                               │   bond held by contract    │
   │                               │                            │
   │      ── submissionDeadline ───┼─────────────────────        │
   │                               │                  markSubmitted()
   │                               ├─ unstake()  ←──────┘        │
   │                               │   full principal returned   │
   │                                                             │
   └─ sweepForfeited()  ── no-show bonds → prize pool ───────────┘
```

**Ordering invariant**: `registrationDeadline <= submissionDeadline`, enforced at
creation and on every `updateDeadlines` call.

---

## Data Structures

### Hackathon

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | e.g. `"ETHGlobal Cali 2026"` |
| `description` | `string` | Purpose / rules summary |
| `stakeAsset` | `address` | `ETH_TOKEN` sentinel or an ERC-20 address. **Immutable** |
| `stakeAmount` | `uint256` | Exact bond per participant, in asset base units. **Immutable** |
| `registrationDeadline` | `uint256` | Last timestamp at which `stake()` is allowed |
| `submissionDeadline` | `uint256` | After this, unswept bonds may be forfeited |
| `totalStaked` | `uint256` | Principal currently held (excludes refunded/forfeited) |
| `stakerCount` | `uint256` | Distinct addresses that have ever staked |
| `totalRefunded` | `uint256` | Cumulative principal returned to participants |
| `totalForfeited` | `uint256` | Cumulative principal swept to a prize pool |
| `active` | `bool` | Whether new stakes are accepted |
| `whitelistEnabled` | `bool` | Whether a whitelist gates registration |
| `zkPassportRequired` | `bool` | Whether a ZKPassport NFT is required |
| `allowedToken` | `address` | Token/NFT required to stake (`address(0)` = none) |
| `yieldStrategy` | `address` | Phase 2. `address(0)` in phase 1 |
| `createdAt` | `uint256` | Creation timestamp |

`stakeAsset` and `stakeAmount` cannot be changed after creation — participants have
already bonded against them.

### HackathonInit

Input struct for `createHackathon`, holding `name`, `description`, `stakeAsset`,
`stakeAmount`, `registrationDeadline`, `submissionDeadline`, `whitelistEnabled`,
`zkPassportRequired`, `allowedToken`. Used to avoid stack-too-deep.

### Stake

| Field | Type | Description |
|-------|------|-------------|
| `principal` | `uint256` | Bond amount. `0` means never staked |
| `stakedAt` | `uint256` | Stake timestamp |
| `submitted` | `bool` | Admin confirmed a submission |
| `submittedAt` | `uint256` | Confirmation timestamp |
| `unstaked` | `bool` | Principal returned |
| `unstakedAt` | `uint256` | Unstake timestamp |
| `forfeited` | `bool` | Principal swept to the prize pool |
| `forfeitedAt` | `uint256` | Forfeit timestamp |

`principal` is **retained after unstaking** so the record stays queryable as history.
Use `unstaked` / `forfeited` — not `principal == 0` — to test whether a bond is live.

---

## Admin Functions

All require `ADMIN_ROLE` unless noted.

### createHackathon

```solidity
function createHackathon(HackathonInit calldata init) external returns (uint256 hackathonId)
```

Reverts on an empty name, a zero stake amount, a registration deadline in the past, or a
submission deadline before the registration deadline.

### updateHackathon

```solidity
function updateHackathon(uint256 hackathonId, string calldata name, string calldata description, bool active) external
```

Renames a hackathon or opens/closes registration. Setting `active = false` blocks new
stakes but never blocks existing participants from unstaking.

### updateDeadlines

```solidity
function updateDeadlines(uint256 hackathonId, uint256 registrationDeadline, uint256 submissionDeadline) external
```

For a jury running late. The ordering invariant is re-checked.

### updateHackathonGating

```solidity
function updateHackathonGating(uint256 hackathonId, bool zkPassportRequired, address allowedToken) external
```

### Whitelist management

```solidity
function setWhitelistEnabled(uint256 hackathonId, bool enabled) external
function addToWhitelist(uint256 hackathonId, address user) external
function addBatchToWhitelist(uint256 hackathonId, address[] calldata users) external
function removeFromWhitelist(uint256 hackathonId, address user) external
function removeBatchFromWhitelist(uint256 hackathonId, address[] calldata users) external
```

### markSubmitted

```solidity
function markSubmitted(uint256 hackathonId, address[] calldata participants) external
```

Unlocks `unstake()` for each address and increments its `submissionCount`.

**Silently skips** addresses that never staked, are already marked, already unstaked, or
were forfeited — so a jury can paste a full submission list without one bad row
reverting the batch. Marking twice does not double-count.

### unmarkSubmitted

```solidity
function unmarkSubmitted(uint256 hackathonId, address participant) external
```

Correction path for a disqualification. Only possible while the bond is still held —
once unstaked, the principal is gone and the mark is history.

### sweepForfeited

```solidity
function sweepForfeited(uint256 hackathonId, address to, uint256 maxCount)
    external returns (uint256 swept)
```

Forfeits the bonds of everyone who never submitted and sends the total to `to`.

- Callable only **after** `submissionDeadline`.
- Scans at most `maxCount` stakers per call, advancing `forfeitCursor[hackathonId]`.
  Poll `pendingForfeitCount()` and call repeatedly until it returns `0`.
- Participants who submitted are untouched and can still unstake afterwards.

### setYieldStrategy

```solidity
function setYieldStrategy(uint256 hackathonId, address strategy) external  // DEFAULT_ADMIN_ROLE
```

Phase 2. See [Phase 2 — Yield Seam](#phase-2--yield-seam). Reverts while
`totalStaked > 0`.

### Misc

```solidity
function setNFTContract(address newContract) external  // DEFAULT_ADMIN_ROLE
function addAdmin(address admin) external              // DEFAULT_ADMIN_ROLE
function removeAdmin(address admin) external           // DEFAULT_ADMIN_ROLE
function pause() external
function unpause() external
```

---

## User Functions

### stake

```solidity
function stake(uint256 hackathonId) external payable
```

Posts the bond. **ETH hackathons**: send exactly `stakeAmount` as `msg.value`.
**ERC-20 hackathons**: `approve(staking, stakeAmount)` first and send no ETH.

Checks, in order: hackathon exists → active → registration open → not already staked →
ZKPassport (if required) → whitelist (if enabled) → token holding (if configured).

Fee-on-transfer and rebasing ERC-20s are rejected rather than silently
under-collateralising a bond.

### unstake

```solidity
function unstake(uint256 hackathonId) external
```

Returns the full principal. Requires `submitted == true`, and that the bond is neither
already unstaked nor forfeited.

---

## View Functions

| Function | Returns |
|----------|---------|
| `getHackathon(id)` | Full `Hackathon` struct |
| `getAllHackathons()` | Every hackathon |
| `getActiveHackathons()` | `(uint256[] ids, Hackathon[] hackathons)` for active only |
| `getStake(id, user)` | Full `Stake` struct |
| `getStakers(id)` | Every address that has staked |
| `getStakersPaginated(id, offset, limit)` | `(address[] page, uint256 total)` |
| `getUserStakes(user)` | `(uint256[] ids, Stake[] stakes)` across all hackathons |
| `isWhitelisted(id, user)` | `bool` |
| `canUserStake(id, user)` | `(bool canStake, string reason)` |
| `canUserUnstake(id, user)` | `(bool canUnstake, string reason)` |
| `pendingForfeitCount(id)` | Stakers still unscanned by `sweepForfeited` |
| `getSubmissionCount(user)` | Hackathons this address has delivered on |
| `isAdmin(account)` / `isSuperAdmin(account)` | `bool` |

`canUserStake` and `canUserUnstake` mirror every `require` in their write counterparts,
so the UI can disable a button **with a reason** instead of surfacing a failed
transaction. Use them for every button state.

**`canUserStake` reasons**: `Hackathon does not exist`, `Staking is paused`,
`Hackathon not active`, `Registration closed`, `Already staked`,
`Must own ZKPassport NFT`, `Not whitelisted`, `Must hold required token`.

**`canUserUnstake` reasons**: `Hackathon does not exist`, `Staking is paused`,
`Nothing staked`, `Already unstaked`, `Stake forfeited`, `Submission not confirmed`.

---

## Events

| Event | Emitted by |
|-------|-----------|
| `HackathonCreated(id, name, stakeAsset, stakeAmount, registrationDeadline, submissionDeadline)` | `createHackathon` |
| `HackathonUpdated(id, name, description, active)` | `updateHackathon` |
| `DeadlinesUpdated(id, registrationDeadline, submissionDeadline)` | `updateDeadlines` |
| `HackathonGatingUpdated(id, zkPassportRequired, allowedToken)` | `updateHackathonGating` |
| `WhitelistUpdated(id, enabled)` | `setWhitelistEnabled` |
| `AddressWhitelisted(id, user)` | `addToWhitelist`, `addBatchToWhitelist` |
| `AddressRemovedFromWhitelist(id, user)` | `removeFromWhitelist`, `removeBatchFromWhitelist` |
| `Staked(id, user, amount)` | `stake` |
| `SubmissionMarked(id, user)` | `markSubmitted` |
| `SubmissionUnmarked(id, user)` | `unmarkSubmitted` |
| `Unstaked(id, user, amount)` | `unstake` |
| `Forfeited(id, user, amount, to)` | `sweepForfeited`, per participant |
| `ForfeitSweep(id, count, total, to)` | `sweepForfeited`, once per call |
| `YieldStrategyUpdated(id, oldStrategy, newStrategy)` | `setYieldStrategy` |
| `NFTContractUpdated(oldContract, newContract)` | `setNFTContract` |

---

## Error Messages

All prefixed `HackathonStaking: `.

| Message | Cause |
|---------|-------|
| `hackathon does not exist` | `hackathonId >= hackathonCount` |
| `empty name` | Name is `""` |
| `invalid stake asset` | `stakeAsset` is `address(0)` |
| `stake amount must be > 0` | Zero bond |
| `registration deadline in the past` | Deadline `<= block.timestamp` at creation |
| `submission before registration deadline` | Ordering invariant violated |
| `hackathon not active` | `active == false` |
| `registration closed` | Past `registrationDeadline` |
| `already staked` | One bond per address per hackathon |
| `must own ZKPassport NFT` | Gating failed |
| `not whitelisted` | Gating failed |
| `must hold required token` | Gating failed |
| `incorrect ETH amount` | `msg.value != stakeAmount` |
| `ETH not accepted for this hackathon` | ETH sent to an ERC-20 hackathon |
| `unsupported transfer-fee token` | Received amount ≠ `stakeAmount` |
| `nothing staked` | No bond for this address |
| `already unstaked` | Bond already reclaimed |
| `stake forfeited` | Bond was swept to the prize pool |
| `submission not confirmed` | Admin has not marked the submission |
| `not marked as submitted` | `unmarkSubmitted` on an unmarked address |
| `submission period not over` | `sweepForfeited` before the deadline |
| `invalid recipient` | Sweep `to` is `address(0)` |
| `maxCount must be > 0` | Sweep pagination size is zero |
| `principal still staked` | `setYieldStrategy` while `totalStaked > 0` |
| `strategy asset mismatch` | Strategy `asset()` ≠ hackathon `stakeAsset` |
| `strategy returned short` | Strategy delivered less than the principal requested |
| `direct ETH not accepted` | Plain ETH transfer from a non-strategy address |
| `ETH transfer failed` | Recipient rejected the ETH payout |

`EnforcedPause()` (OpenZeppelin) is raised when staking/unstaking while paused.
`AccessControlUnauthorizedAccount(...)` is raised for role failures.

---

## Phase 2 — Yield Seam

Phase 1 ships with **no yield**. Principal rests in the contract and every hackathon has
`yieldStrategy == address(0)`, which makes the internal `_afterStake` and
`_pullFromStrategy` hooks no-ops.

`contracts/interfaces/IYieldStrategy.sol` defines the contract a future venue must
satisfy. Attaching one later requires **no redeploy and no stake migration**, because:

- Principal is tracked in `Hackathon.totalStaked` / `Stake.principal`, independently of
  the contract's token balance.
- `setYieldStrategy` is gated on `totalStaked == 0`, so principal can never be split
  between "resting here" and "inside a strategy".
- `asset()` is checked against `stakeAsset` at attach time.
- `_pullFromStrategy` reverts if the strategy returns less than the requested principal,
  so a participant's bond is never exposed to strategy losses.
- `receive()` only accepts ETH from a currently attached strategy, so the contract's
  balance never drifts from tracked principal.

Still to build in phase 2: a concrete `IYieldStrategy` implementation per network, plus
the yield **distribution** policy (who receives the accrued surplus).

---

## Frontend Integration

ABI and per-network addresses are generated by `npm run setup:frontend` into
`frontend/abis/HackathonStaking.json` and `frontend/<network>/addresses.json`.

Wallet-side module lives at `components/staking/`, `hooks/staking/`, and
`pages/staking.tsx` (+ `pages/staking/admin.tsx`) in the `wallet_ethcali` repo.

**Two rules for the UI:**

1. Drive every button's enabled state from `canUserStake` / `canUserUnstake` and show
   the returned `reason` — never let a user submit a transaction that will revert.
2. For ERC-20 hackathons, always run the `approve` → `stake` two-step, checking existing
   allowance first so a returning user is not asked to approve twice.
