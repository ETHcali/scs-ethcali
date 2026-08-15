# DonationVault + DonationReceipt1155 Contract Reference

**Complete API reference** for the ETH Cali donation system with frontend integration guide.

**Contracts**: `contracts/DonationVault.sol`, `contracts/DonationReceipt1155.sol`
**Version**: 1.0
**Last Updated**: August 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Donor Guarantees](#donor-guarantees)
3. [Launch Runbook](#launch-runbook)
4. [Supported Currencies](#supported-currencies)
5. [DonationVault — Data Structures](#donationvault--data-structures)
6. [DonationVault — Admin Functions](#donationvault--admin-functions)
7. [DonationVault — Donations](#donationvault--donations)
8. [DonationVault — View Functions](#donationvault--view-functions)
9. [DonationReceipt1155](#donationreceipt1155)
10. [Events](#events)
11. [Error Reference](#error-reference)
12. [Frontend Integration](#frontend-integration)

---

## Overview

A **multi-campaign donation vault**. One contract holds N relief campaigns, and each
campaign accepts donations in any number of currencies. A qualifying donation mints
an ERC-1155 receipt from an admin-configured collection.

Built for the **Cali earthquake relief appeal**.

### Key Features

| Feature | Description |
|---------|-------------|
| **Multiple campaigns** | One contract, unlimited appeals, independently configured |
| **Any currency per campaign** | Native ETH plus any set of ERC-20s — USDC, COPm, … |
| **Per-token tiers** | Thresholds are set per currency, because decimals and value differ |
| **NFT receipts** | Admin-configured ERC-1155 collection, soulbound by default |
| **On-chain attribution** | Per-donor, per-token totals for a public donor wall |
| **Beneficiary-locked** | Funds can only ever be withdrawn to the campaign beneficiary |
| **Router or holder** | `autoForward` routes each donation straight to the beneficiary Safe, so no admin ever takes custody |
| **Donation-safe receipts** | A failed receipt mint can never block a donation |
| **Optional messages** | A public message per donation, emitted in the event log |

---

## Donor Guarantees

These properties are enforced by the contract, not by policy. All are covered by tests.

**1. Funds can only reach the campaign beneficiary.**
`withdraw` and `withdrawAll` take **no destination parameter**. The only way to change
where money goes is `setBeneficiary`, which requires `DEFAULT_ADMIN_ROLE` (a higher bar
than the `ADMIN_ROLE` that runs day-to-day campaign operations) and emits
`BeneficiaryUpdated`. A campaign admin cannot redirect funds.

**2. A donation never fails because of NFT configuration.**
Receipt minting is wrapped in `try/catch`. A missing tier, a deactivated tier, a revoked
`MINTER_ROLE`, or a reverting receipt contract emits `ReceiptFailed` and the donation
still settles. Emergency relief funds are never blocked by collectible plumbing.

**3. Router mode removes custody entirely.**
With `autoForward = true` a donation is pushed to the beneficiary Safe in the *same
transaction*, so the vault never holds donor funds and no admin can touch them. If the
forward cannot land (an unreachable beneficiary), the funds stay held and remain
withdrawable to that same beneficiary — the donation still settles either way. Switching
custody mode requires `DEFAULT_ADMIN_ROLE`.

A fourth property worth knowing: **campaign balances are isolated.** `availableBalance`
is computed per campaign from `totalRaised - totalWithdrawn`, so campaign B can never
withdraw funds raised by campaign A even though one contract holds both.

---

## Launch Runbook

Order matters — the vault needs `MINTER_ROLE` before the first donation, or early
donors silently get `ReceiptFailed` instead of their NFT.

```
1. Deploy                     npm run deploy:celo   (or :base, :ethereum, …)
                              Deploys DonationReceipt1155 + DonationVault and grants
                              the vault MINTER_ROLE when the deployer is DONATION_ADMIN.

2. If the deployer was NOT DONATION_ADMIN, from the admin account:
                              DonationReceipt1155.addMinter(<vault address>)

3. Configure receipt tiers    DonationReceipt1155.setTier(1, "Supporter", "ipfs://…", true)
                              DonationReceipt1155.setTier(2, "Guardian",  "ipfs://…", true)

4. Create the campaign        DonationVault.createCampaign(
                                "Cali Earthquake Relief 2026",
                                "Emergency relief for affected families",
                                0xB6BDe4fB6dFBad5488Fa31Edf0F3730D9D86da64,  // ethcali.eth
                                <receipt collection address>,
                                true                                          // router mode
                              )

5. Accept currencies          setAcceptedToken(id, ETH_TOKEN, true)
                              setAcceptedToken(id, <USDC>,    true)
                              setAcceptedToken(id, <COPm>,    true)     // Celo only

6. Set tiers PER currency     setTiers(id, <USDC>, [{10e6, 1}, {100e6, 2}])
                              setTiers(id, <COPm>, [{40_000e18, 1}, {400_000e18, 2}])
                              setTiers(id, ETH_TOKEN, [{0.01e18, 1}, {0.1e18, 2}])

7. Verify before announcing   canDonate(id, token, amount) → (true, "")
                              resolveTier(id, token, amount) → expected tier
```

**Step 6 is the one that is easy to get wrong.** See below.

---

## Supported Currencies

All addresses below were verified on-chain, not copied from documentation.

| Currency | Network | Address | Decimals |
|----------|---------|---------|----------|
| ETH | all | `0xEeee…EEeE` (sentinel) | 18 |
| — beneficiary — | all | `0xB6BDe4fB6dFBad5488Fa31Edf0F3730D9D86da64` (`ethcali.eth`) | Safe 3-of-5 |
| USDC | Celo | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | **6** |
| COPm | Celo | `0x8a567e2ae79ca692bd748ab832081c45de4041ea` | **18** |

**COPm** is the Mento Colombian Peso (`symbol() == "COPm"`, formerly branded cCOP), on
Celo mainnet (chainId 42220).

### Why tier thresholds are per token

A single global threshold cannot express "a meaningful donation" across these currencies,
because both the **decimals** and the **value** differ:

```
10 USDC       = 10_000000                          (10 * 10^6)
~40,000 COPm  = 40000_000000000000000000           (40000 * 10^18)
```

Passing a USDC-scaled threshold to a COPm campaign would make **every** donation clear
the top tier by a factor of ~10^12. `setTiers` is therefore called once per currency, and
`resolveTier(campaignId, token, amount)` should be checked against real amounts before
launch.

---

## DonationVault — Data Structures

### Campaign

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | e.g. `"Cali Earthquake Relief 2026"` |
| `description` | `string` | Where the funds go |
| `beneficiary` | `address` | The **only** address funds can be withdrawn to |
| `receiptCollection` | `address` | `DonationReceipt1155`, or `address(0)` for none |
| `donorCount` | `uint256` | Distinct donor addresses |
| `donationCount` | `uint256` | Total donations received |
| `active` | `bool` | Whether the campaign accepts donations |
| `autoForward` | `bool` | `true` = router (forward on receipt), `false` = holder |
| `createdAt` | `uint256` | Creation timestamp |

### Tier

| Field | Type | Description |
|-------|------|-------------|
| `minAmount` | `uint256` | Minimum donation **in that token's base units** |
| `receiptTokenId` | `uint256` | tokenId minted from the receipt collection |

Tiers are stored **ascending by `minAmount`**; `setTiers` rejects any other order.
`resolveTier` walks down and returns the highest qualifying tier.

---

## DonationVault — Admin Functions

`ADMIN_ROLE` unless marked otherwise.

```solidity
function createCampaign(string name, string description, address beneficiary, address receiptCollection, bool autoForward)
    external returns (uint256 campaignId)

function updateCampaign(uint256 campaignId, string name, string description, bool active) external

function setBeneficiary(uint256 campaignId, address beneficiary) external  // DEFAULT_ADMIN_ROLE
function setAutoForward(uint256 campaignId, bool autoForward) external     // DEFAULT_ADMIN_ROLE

function setReceiptCollection(uint256 campaignId, address collection) external

function setAcceptedToken(uint256 campaignId, address token, bool accepted) external

function setTiers(uint256 campaignId, address token, Tier[] tiers) external

function withdraw(uint256 campaignId, address token, uint256 amount) external
function withdrawAll(uint256 campaignId, address token) external

function addAdmin(address admin) external      // DEFAULT_ADMIN_ROLE
function removeAdmin(address admin) external   // DEFAULT_ADMIN_ROLE
function pause() external
function unpause() external
```

Notes:

- **`setAcceptedToken(…, false)`** stops new donations in that currency but does **not**
  touch funds already raised in it — those stay withdrawable.
- **`setTiers` with an empty array** disables receipts for that currency.
- **`withdraw` / `withdrawAll`** always send to `campaigns[campaignId].beneficiary`.

---

## DonationVault — Donations

```solidity
function donate(uint256 campaignId, address token, uint256 amount, string message) external payable
```

| Currency | How to call |
|----------|-------------|
| ETH | `token = ETH_TOKEN`, and `msg.value` **must equal** `amount` |
| ERC-20 | `approve(vault, amount)` first, send **no** ETH |

`message` is emitted in the `Donated` event and never stored — pass `""` when unused.

**Fee-on-transfer tokens** are credited by measured balance delta: if 100 is sent and 99
arrives, 99 is what gets recorded and what the beneficiary can withdraw. Donations credit
what actually arrived rather than reverting.

---

## DonationVault — View Functions

| Function | Returns |
|----------|---------|
| `getCampaign(id)` | Full `Campaign` struct |
| `getAllCampaigns()` | Every campaign |
| `getActiveCampaigns()` | `(uint256[] ids, Campaign[] campaigns)` |
| `getAcceptedTokens(id)` | Every accepted token address |
| `isTokenAccepted(id, token)` | `bool` |
| `getTiers(id, token)` | `Tier[]` for that currency |
| `resolveTier(id, token, amount)` | `(bool found, uint256 receiptTokenId)` |
| `getDonation(id, donor, token)` | That donor's cumulative total in that token |
| `getDonors(id)` | Every donor address |
| `getDonorsPaginated(id, offset, limit)` | `(address[] page, uint256 total)` |
| `getDonorsWithAmounts(id, token, offset, limit)` | `(address[], uint256[], uint256 total)` |
| `getCampaignTotals(id)` | `(address[] tokens, uint256[] raised, uint256[] available)` |
| `totalRaised(id, token)` | Cumulative raised — never decreases |
| `totalWithdrawn(id, token)` | Cumulative sent to the beneficiary |
| `availableBalance(id, token)` | `totalRaised - totalWithdrawn` |
| `canDonate(id, token, amount)` | `(bool allowed, string reason)` |
| `isAdmin(a)` / `isSuperAdmin(a)` | `bool` |

`canDonate` mirrors every check in `donate`. Drive the donate button from it and show the
returned reason. Possible reasons: `Campaign does not exist`, `Donations are paused`,
`Campaign not active`, `Token not accepted`, `Amount must be greater than zero`.

`getDonorsWithAmounts` returns pages **unsorted** — sorting on-chain would cost more than
it is worth. Fetch and sort client-side for a leaderboard.

`totalRaised` is a permanent record and is **not** reduced by withdrawals, so a campaign
progress bar keeps reading correctly after funds are disbursed.

---

## DonationReceipt1155

An admin-configurable ERC-1155 where **each tokenId is a tier**.

```solidity
constructor(string name, string symbol, string baseURI, address initialAdmin)

function setTier(uint256 tokenId, string tierName, string metadataURI, bool active) external  // ADMIN_ROLE
function removeTier(uint256 tokenId) external                                                 // ADMIN_ROLE
function setBaseURI(string newURI) external                                                   // ADMIN_ROLE
function setTransfersEnabled(bool enabled) external                                           // DEFAULT_ADMIN_ROLE
function addMinter(address minter) external                                                   // DEFAULT_ADMIN_ROLE
function removeMinter(address minter) external                                                // DEFAULT_ADMIN_ROLE
function mint(address to, uint256 tokenId, uint256 amount) external                            // MINTER_ROLE

function getTier(uint256 tokenId) external view returns (Tier memory)
function listTierIds() external view returns (uint256[] memory)
function tierCount() external view returns (uint256)
function isTierActive(uint256 tokenId) external view returns (bool)
function uri(uint256 tokenId) public view returns (string memory)
```

**Soulbound by default.** `transfersEnabled` starts `false`, so receipts cannot be
transferred — a donation receipt attests that a *specific address* gave, so it should not
be resellable. Mints and burns always work. A super admin can open transfers per
collection if a campaign wants tradeable art.

**Tiers with supply are permanent.** `removeTier` reverts with `TierHasSupply` once a tier
has been minted, so holders' metadata keeps resolving. Deactivate with
`setTier(…, active: false)` instead.

**`mint` reverts on an inactive tier**, which is what makes the vault's `try/catch`
necessary — and what makes a misconfiguration visible via `ReceiptFailed` rather than
minting receipts nobody can render.

---

## Events

### DonationVault

| Event | Emitted by |
|-------|-----------|
| `CampaignCreated(campaignId, name, beneficiary, receiptCollection)` | `createCampaign` |
| `CampaignUpdated(campaignId, name, description, active)` | `updateCampaign` |
| `BeneficiaryUpdated(campaignId, oldBeneficiary, newBeneficiary)` | `setBeneficiary` |
| `ReceiptCollectionUpdated(campaignId, oldCollection, newCollection)` | `setReceiptCollection` |
| `TokenAccepted(campaignId, token, accepted)` | `setAcceptedToken` |
| `TiersUpdated(campaignId, token, tierCount)` | `setTiers` |
| `Donated(campaignId, donor, token, amount, message)` | `donate` |
| `Forwarded(campaignId, token, beneficiary, amount)` | `donate`, router mode success |
| `ForwardFailed(campaignId, token, amount)` | `donate`, router mode failure — funds stay held |
| `AutoForwardUpdated(campaignId, autoForward)` | `setAutoForward` |
| `ReceiptIssued(campaignId, donor, receiptTokenId)` | `donate`, on successful mint |
| `ReceiptFailed(campaignId, donor, receiptTokenId)` | `donate`, on failed mint |
| `Withdrawn(campaignId, token, beneficiary, amount)` | `withdraw`, `withdrawAll` |

`Donated` is the event to index for a donor wall — it carries donor, token, amount and
message in one record. **Monitor `ReceiptFailed`**: any occurrence means tier config is
wrong and donors are not receiving their NFTs.

### DonationReceipt1155

`TierSet`, `TierRemoved`, `ReceiptMinted`, `TransfersEnabledSet`.

---

## Error Reference

### DonationVault

| Error | Cause |
|-------|-------|
| `CampaignDoesNotExist(id)` | `campaignId >= campaignCount` |
| `EmptyName()` | Campaign name is `""` |
| `InvalidBeneficiary()` | Beneficiary / admin is `address(0)` |
| `InvalidToken()` | Token is `address(0)` |
| `CampaignNotActive(id)` | Campaign is closed |
| `TokenNotAccepted(id, token)` | Currency not enabled for this campaign |
| `ZeroAmount()` | Amount is zero, or nothing arrived, or nothing to withdraw |
| `EthNotAccepted()` | ETH sent alongside an ERC-20 donation |
| `IncorrectEthAmount()` | `msg.value != amount` for an ETH donation |
| `TiersNotAscending()` | `setTiers` input not strictly ascending |
| `InsufficientBalance(available, requested)` | Withdrawing more than the campaign holds |
| `EthTransferFailed()` | Beneficiary rejected the ETH payout |
| `DirectEthNotAccepted()` | Bare ETH transfer — a donation must name a campaign |

### DonationReceipt1155

| Error | Cause |
|-------|-------|
| `Soulbound()` | Transfer attempted while `transfersEnabled == false` |
| `TierNotActive(tokenId)` | Minting an unconfigured or deactivated tier |
| `EmptyURI()` | `setTier` with an empty metadata URI |
| `InvalidRecipient()` | Zero address as mint recipient / minter / admin |
| `TierHasSupply(tokenId)` | `removeTier` on a tier that has been minted |

Plus OpenZeppelin's `EnforcedPause()` and `AccessControlUnauthorizedAccount(...)`.

---

## Frontend Integration

ABIs and per-network addresses are generated by `npm run setup:frontend` into
`frontend/abis/DonationVault.json`, `frontend/abis/DonationReceipt1155.json`, and
`frontend/<network>/addresses.json`.

Wallet-side module: `components/donations/`, `hooks/donations/`, `pages/donations.tsx`
(+ `pages/donations/admin.tsx`) in the `wallet_ethcali` repo.

**Rules for the donate UI:**

1. Drive the button from `canDonate` and surface the returned `reason`. Never let a donor
   submit a transaction that will revert.
2. For ERC-20 donations run `approve` → `donate`, checking existing allowance first so a
   returning donor is not asked to approve twice.
3. **Format amounts with the token's own decimals** — USDC is 6, COPm is 18. Hardcoding 18
   would show a COPm donor a figure 10^12 too large.
4. Preview the reward with `resolveTier(id, token, amount)` as the donor types, so they can
   see the tier they are about to earn.
5. Build the progress bar from `totalRaised`, not `availableBalance` — the latter drops
   when funds are disbursed to the beneficiary.
