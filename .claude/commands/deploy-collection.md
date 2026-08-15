# Deploy Collection via SwagFactory

Deploy a new Swag1155 product collection via the SwagFactory. Each product is an EIP-1167 clone — the factory handles deploying, initializing, configuring all sizes, granting admin, and registering the collection.

## Usage

```bash
ITEM_NAME="ETH Cali Hoodie" \
ITEM_SKU="ETH-CALI-HOODIE-2025" \
ITEM_ADMIN=0xYourAdminAddress \
ITEM_SIZES_JSON='[
  {
    "metadataURI": "ipfs://Qm.../s.json",
    "maxSupply": 50,
    "active": true,
    "payments": [
      { "token": "0xUSDC...", "price": 25000000 },
      { "token": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "price": "10000000000000000" }
    ]
  }
]' \
npx hardhat run scripts/deploy-collection.ts --network base
```

## What It Does

Run the deploy-collection script for the user. Steps:

1. Read `ITEM_NAME`, `ITEM_SKU`, `ITEM_ADMIN`, `ITEM_SIZES_JSON` from environment (or ask the user for them if missing)
2. Load the latest deployment file for the target network from `deployments/{network}-latest.json`
3. Call `SwagFactory.deployCollection()` with the provided sizes and payment options
4. Wait for the transaction to confirm
5. Print the new collection address and configured tokenIds
6. Append the new collection to the deployment file

## Payment Token Addresses

Common addresses by network:

| Token | Base | Optimism | Unichain |
|-------|------|----------|----------|
| USDC  | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 | 0x078D782b760474a361dDA0AF3839290b0EF57AD6 |
| USDT  | 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2 | 0x94b008aA00579c1307B0EF2c499aD98a8ce58e58 | — |
| ETH   | 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE | same | same |

## Instructions

Help the user run the deploy-collection script. If they haven't provided the required env vars, ask for:
- Product name (ITEM_NAME)
- SKU (ITEM_SKU)
- Item admin address (ITEM_ADMIN)
- Sizes JSON with payment options (ITEM_SIZES_JSON)
- Target network

Then construct and run the command using Bash.
