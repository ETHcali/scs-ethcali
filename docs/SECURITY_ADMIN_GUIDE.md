# Security & Admin Management Guide

**Complete guide** for managing admin roles, treasury addresses, and security configuration across all ETHCALI contracts.

**Last Updated**: January 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Role Hierarchy](#role-hierarchy)
3. [Initial Deployment (.env)](#initial-deployment-env)
4. [Post-Deployment Admin Functions](#post-deployment-admin-functions)
5. [Security Best Practices](#security-best-practices)
6. [Emergency Procedures](#emergency-procedures)

---

## Overview

### Access Control Model

| Contract | Model | Super Admin | Regular Admin |
|----------|-------|-------------|---------------|
| **ZKPassportNFT** | Ownable | Owner (single) | N/A |
| **FaucetManager** | AccessControl | DEFAULT_ADMIN_ROLE | ADMIN_ROLE |
| **Swag1155** | AccessControl | DEFAULT_ADMIN_ROLE | ADMIN_ROLE |

### Key Differences

```
OWNABLE (ZKPassportNFT):
├── Single owner
├── Can transfer ownership
└── All admin functions require owner

ACCESS CONTROL (FaucetManager, Swag1155):
├── Multiple admins possible
├── Two-tier hierarchy (Super Admin + Admin)
├── Super Admin can add/remove other admins
└── Admin can perform daily operations
```

---

## Role Hierarchy

### ZKPassportNFT

```
┌─────────────────────────────────────────────────────────────┐
│                    ZKPassportNFT                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  OWNER (single address)                                      │
│  ├── setMetadata()       - Configure NFT image/description  │
│  ├── setImageURI()       - Set IPFS image                   │
│  ├── setDescription()    - Set description                  │
│  ├── setExternalURL()    - Set website link                 │
│  ├── setUseIPFSImage()   - Toggle IPFS vs SVG               │
│  ├── approveVerification() - Pre-approve mints              │
│  └── transferOwnership() - Change owner                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### FaucetManager

```
┌─────────────────────────────────────────────────────────────┐
│                    FaucetManager                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  DEFAULT_ADMIN_ROLE (Super Admin)                           │
│  ├── addAdmin()          - Grant ADMIN_ROLE                 │
│  ├── removeAdmin()       - Revoke ADMIN_ROLE                │
│  ├── setNFTContract()    - Change ZKPassport address        │
│  ├── grantRole()         - Grant any role                   │
│  └── revokeRole()        - Revoke any role                  │
│                                                              │
│  ADMIN_ROLE (Operations)                                     │
│  ├── createVault()       - Create new faucet                │
│  ├── updateVault()       - Edit vault settings              │
│  ├── updateVaultGating() - Update vault ZKPassport/token gating │
│  ├── deposit()           - Add ETH to vault                 │
│  ├── withdraw()          - Remove ETH from vault            │
│  ├── addToWhitelist()    - Add address to vault whitelist   │
│  ├── removeFromWhitelist() - Remove address from whitelist  │
│  ├── addBatchToWhitelist() - Batch add to whitelist         │
│  ├── removeBatchFromWhitelist() - Batch remove from whitelist │
│  ├── pause()             - Emergency pause                  │
│  └── unpause()           - Resume operations                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Swag1155

```
┌─────────────────────────────────────────────────────────────┐
│                      Swag1155                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  DEFAULT_ADMIN_ROLE (Super Admin)                           │
│  ├── addAdmin()          - Grant ADMIN_ROLE                 │
│  ├── removeAdmin()       - Revoke ADMIN_ROLE                │
│  ├── addSigner()         - Grant SIGNER_ROLE (voucher key)  │
│  ├── removeSigner()      - Revoke SIGNER_ROLE               │
│  ├── setTreasury()       - Change treasury wallet           │
│  ├── grantRole()         - Grant any role                   │
│  └── revokeRole()        - Revoke any role                  │
│                                                              │
│  ADMIN_ROLE (Operations)                                     │
│  ├── setVariant()        - Create/edit a tokenId's caps     │
│  ├── setVariantWithURI() - Same, with a per-token URI       │
│  ├── setBaseURI()        - Set default metadata URI         │
│  ├── setPaymentOption()  - Set unit price in one token      │
│  ├── removePaymentOption() - Stop accepting a token         │
│  ├── cancelOrder()       - Burn a refunded order's voucher  │
│  └── pause() / unpause() - Halt buy() and claim()           │
│                                                              │
│  SIGNER_ROLE (backend key, no on-chain calls)               │
│  └── signs EIP-712 `Claim` vouchers redeemed by claim()     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

Each collection is a clone deployed by `SwagFactory.deployCollection(name, sku, treasury,
itemAdmin, sizes, signer)`. The factory grants `itemAdmin` both admin roles and `signer`
`SIGNER_ROLE`, then renounces its own roles. `SwagFactory` itself has `DEFAULT_ADMIN_ROLE`
(`addAdmin`/`removeAdmin`) and `ADMIN_ROLE` (`deployCollection`, `setCollectionActive`).

Live on Base (verified 2026-09-23): the collection `0xA5C0…9479` has `itemAdmin`
`0x3B89…415B` holding **both** `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`, signer `0x3977…62e6`,
treasury = the ethcali.eth Safe. Moving `DEFAULT_ADMIN_ROLE` to the Safe is still open.

---

## Initial Deployment (.env)

### Required Environment Variables

```bash
# ============================================================
# ADMIN & TREASURY CONFIGURATION
# ============================================================

# Contract Admins
SWAG_ADMIN=0x...          # SwagFactory admin; itemAdmin of seeded collections (ITEM_ADMIN overrides)
FAUCET_ADMIN=0x...        # Admin for FaucetManager (can manage vaults, admins)
ZK_PASSPORT_ADMIN=0x...   # Owner for ZKPassportNFT (can manage metadata)

# Treasury
SWAG_TREASURY_ADDRESS=0x...  # Receives every on-chain sale, in full (ITEM_TREASURY overrides)
SWAG_SIGNER=0x...            # Backend key granted SIGNER_ROLE on each seeded collection

# Optional: NFT metadata (can be set post-deployment)
NFT_IMAGE_URI=ipfs://...
NFT_DESCRIPTION=Your description
NFT_EXTERNAL_URL=https://yoursite.com
```

### Deployment Command

```bash
# Deploy to Base mainnet
npx hardhat run scripts/deploy-all.ts --network base

# Deploy to Ethereum mainnet
npx hardhat run scripts/deploy-all.ts --network ethereum

# Deploy to Optimism mainnet
npx hardhat run scripts/deploy-all.ts --network optimism

# Deploy to Unichain mainnet
npx hardhat run scripts/deploy-all.ts --network unichain

# Deploy to testnet first
npx hardhat run scripts/deploy-all.ts --network sepolia
```

### Supported Networks

- **Base** (Chain ID: 8453)
- **Ethereum** (Chain ID: 1)
- **Optimism** (Chain ID: 10)
- **Unichain** (Chain ID: 130)
- **Sepolia** (Chain ID: 11155111) - Testnet

### What Happens During Deployment

1. **ZKPassportNFT**: Deploys, then transfers ownership to `ZK_PASSPORT_ADMIN`
2. **FaucetManager**: Deploys, grants admin roles to `FAUCET_ADMIN`
3. **Swag1155 / SwagFactory**: `deploy-all.ts` (or `deploy:swag:base`) deploys the locked `Swag1155`
   implementation and a `SwagFactory` with `SWAG_ADMIN` as factory admin. Collections are deployed
   afterwards by `seed:swag`, which passes `SWAG_TREASURY_ADDRESS`, `SWAG_ADMIN` and `SWAG_SIGNER`
   to `deployCollection`. Do not run `deploy-all.ts` on a chain that already has contracts.

---

## Post-Deployment Admin Functions

### ZKPassportNFT - Change Owner

```typescript
// Transfer ownership to new address
await zkPassportNFT.write.transferOwnership([
  '0xNewOwnerAddress...'
]);
```

**Warning**: This is irreversible. The old owner loses all access.

---

### FaucetManager - Manage Admins

```typescript
// Add a new admin
await faucetManager.write.addAdmin(['0xNewAdmin...']);

// Remove an admin
await faucetManager.write.removeAdmin(['0xOldAdmin...']);

// Check if address is admin
const isAdmin = await faucetManager.read.isAdmin(['0xAddress...']);

// Check if address is super admin
const isSuperAdmin = await faucetManager.read.isSuperAdmin(['0xAddress...']);
```

### FaucetManager - Change ZKPassport Contract

```typescript
// Update ZKPassport NFT contract (super admin only)
await faucetManager.write.setNFTContract(['0xNewZKPassport...']);
```

---

### Swag1155 - Manage Admins

```typescript
// Add a new admin
await swag1155.write.addAdmin(['0xNewAdmin...']);

// Remove an admin
await swag1155.write.removeAdmin(['0xOldAdmin...']);

// Check roles
const isAdmin = await swag1155.read.isAdmin(['0xAddress...']);
const isSuperAdmin = await swag1155.read.isSuperAdmin(['0xAddress...']);
```

### Swag1155 - Change Treasury

```typescript
// Change treasury address (super admin only)
await swag1155.write.setTreasury(['0xNewTreasury...']);

// Get current treasury
const treasury = await swag1155.read.treasury();
```

### Swag1155 - Manage Signers

```typescript
// Grant the backend voucher key (super admin only)
await swag1155.write.addSigner(['0xBackendSigner...']);

// Rotate: grant the new key first, swap SWAG_VOUCHER_SIGNER_KEY on Vercel, then revoke the old one
await swag1155.write.removeSigner(['0xOldSigner...']);

// Check
const SIGNER_ROLE = await swag1155.read.SIGNER_ROLE();
const ok = await swag1155.read.hasRole([SIGNER_ROLE, '0xBackendSigner...']);
```

### Swag1155 - Pause

```typescript
// ADMIN_ROLE. Blocks buy() and claim(); transfers still work.
await swag1155.write.pause();
await swag1155.write.unpause();
```

### Swag1155 - Cancel a refunded order

```typescript
// ADMIN_ROLE. Burns the orderRef so its voucher can never mint. Reverts
// VoucherAlreadyClaimed if the customer already claimed — that refund needs a human.
await swag1155.write.cancelOrder([orderRef]);
```

---

## Security Best Practices

### 1. Use Multisig for Super Admin

```
Recommended: Gnosis Safe multisig

Setup:
- 3-of-5 signers minimum
- Include team members from different locations
- Hardware wallet required for each signer
```

### 2. Role Separation

```
Recommended Role Distribution:

SUPER_ADMIN (Multisig):
├── Can add/remove admins and voucher signers
├── Can change the treasury
└── Rarely used, high security

ADMIN (Individual wallets):
├── Daily operations
├── Create vaults; set caps, prices, pause
└── Cancel refunded orders' vouchers
```

### 3. Monitor Admin Actions

All admin actions emit events:

```solidity
// FaucetManager events
event VaultCreated(uint256 indexed vaultId, ...);
event VaultUpdated(uint256 indexed vaultId, ...);

// Swag1155 events
event VariantSet(uint256 indexed tokenId, uint128 onchainCap, uint128 voucherCap, bool active);
event PaymentOptionSet(uint256 indexed tokenId, address indexed token, uint256 price);
event PaymentOptionRemoved(uint256 indexed tokenId, address indexed token);
event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
event OrderCancelled(bytes32 indexed orderRef);
// role changes are OpenZeppelin RoleGranted / RoleRevoked
```

Set up event monitoring with:
- The Graph indexer
- Tenderly alerts
- Custom webhook listener

### 4. Treasury Security

```
DO:
✅ Use a dedicated treasury wallet (not personal)
✅ Consider a multisig for treasury
✅ Regularly withdraw to cold storage
✅ Monitor incoming transactions

DON'T:
❌ Use treasury wallet for other purposes
❌ Share treasury private key
❌ Keep large amounts in hot wallet
```

### 5. Voucher Signer Security

`SIGNER_ROLE` is a hot key by design: it lives on the wallet app's server as
`SWAG_VOUCHER_SIGNER_KEY` and signs a `Claim` voucher for every paid card or event order.

```
WHAT A LEAKED SIGNER CAN DO:
- mint up to voucherCap of every active tokenId, to any address, until revoked
- NOT touch the on-chain allocation, prices, caps, treasury or roles

CONTAINMENT:
✅ voucherCap is the ceiling — keep it at the physical stock, never "plenty"
✅ removeSigner() from the DEFAULT_ADMIN closes it in one transaction
✅ cancelOrder(orderRef) voids any specific voucher already issued
✅ pause() stops claim() entirely while you rotate

ROTATION:
1. addSigner(new)   2. swap SWAG_VOUCHER_SIGNER_KEY on Vercel   3. removeSigner(old)
```

---

## Emergency Procedures

### 1. Pause Contracts

```typescript
// FaucetManager - pause all claims
await faucetManager.write.pause();

// To resume
await faucetManager.write.unpause();
```

**Note**: Swag1155 doesn't have pause. To stop sales, deactivate all variants:

```typescript
// Deactivate a product
await swag1155.write.setVariant([
  tokenId,
  currentPrice,
  currentMaxSupply,
  false  // active = false
]);
```

### 2. Compromised Admin Key

```
IMMEDIATE ACTIONS:

1. Remove compromised admin (from another admin):
   await contract.write.removeAdmin(['0xCompromised...']);

2. If super admin compromised:
   - Cannot directly recover
   - Deploy new contract
   - Migrate data/users

PREVENTION:
- Use hardware wallets
- Enable 2FA on all accounts
- Regular security audits
```

### 3. Wrong Treasury Address

```typescript
// Fix immediately (super admin only)
await swag1155.write.setTreasury(['0xCorrectTreasury...']);

// Funds already sent to wrong address cannot be recovered on-chain
// Contact the wrong recipient off-chain
```

### 4. Upgrade Path

Contracts are NOT upgradeable. To upgrade:

1. Deploy new contract
2. Transfer admin roles
3. Update frontend to use new address
4. Migrate user data if needed
5. Consider keeping old contract read-only for historical data

---

## Quick Reference

### Check Current Configuration

```typescript
// ZKPassportNFT
const owner = await zkPassportNFT.read.owner();
const imageURI = await zkPassportNFT.read.nftImageURI();
const description = await zkPassportNFT.read.nftDescription();

// FaucetManager
const nftContract = await faucetManager.read.nftContract();
const isAdmin = await faucetManager.read.isAdmin([address]);

// Swag1155
const treasury = await swag1155.read.treasury();
const usdc = await swag1155.read.usdc();
const isAdmin = await swag1155.read.isAdmin([address]);
```

### Role Constants

```typescript
// AccessControl role identifiers
const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';
const ADMIN_ROLE = keccak256(toBytes('ADMIN_ROLE'));
const SIGNER_ROLE = keccak256(toBytes('SIGNER_ROLE')); // Swag1155 only
```

### Common Operations Checklist

| Operation | Contract | Function | Role Required |
|-----------|----------|----------|---------------|
| Add admin | FaucetManager | `addAdmin()` | DEFAULT_ADMIN_ROLE |
| Add admin | Swag1155 | `addAdmin()` | DEFAULT_ADMIN_ROLE |
| Change treasury | Swag1155 | `setTreasury()` | DEFAULT_ADMIN_ROLE |
| Change owner | ZKPassportNFT | `transferOwnership()` | Owner |
| Create vault | FaucetManager | `createVault()` | ADMIN_ROLE |
| Update vault gating | FaucetManager | `updateVaultGating()` | ADMIN_ROLE |
| Configure a tokenId's caps / URI | Swag1155 | `setVariant()` / `setVariantWithURI()` | ADMIN_ROLE |
| Set / remove a price | Swag1155 | `setPaymentOption()` / `removePaymentOption()` | ADMIN_ROLE |
| Cancel a refunded order's voucher | Swag1155 | `cancelOrder()` | ADMIN_ROLE |
| Add / remove voucher signer | Swag1155 | `addSigner()` / `removeSigner()` | DEFAULT_ADMIN_ROLE |
| Deploy a collection | SwagFactory | `deployCollection()` | ADMIN_ROLE (factory) |
| Pause | FaucetManager | `pause()` | ADMIN_ROLE |
