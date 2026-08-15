# Frontend Contract Integration

This directory contains contract ABIs and addresses for frontend integration across multiple networks.

## Structure

```
frontend/
├── contracts.json          # Multi-network config (all networks)
├── addresses.json          # All network addresses
├── contracts.ts           # TypeScript exports (multi-network)
├── abis/                  # Shared ABIs (same for all networks)
│   ├── ZKPassportNFT.json
│   ├── FaucetManager.json
│   ├── SwagFactory.json   # Factory registry — use getActiveCollections() to discover products
│   └── Swag1155.json      # Product contract ABI — used with addresses returned by SwagFactory
├── base/                  # Base Mainnet specific files
│   ├── contracts.json
│   ├── addresses.json
│   └── contracts.ts
├── ethereum/                  # Ethereum Mainnet specific files
│   ├── contracts.json
│   ├── addresses.json
│   └── contracts.ts
├── unichain/                  # Unichain Mainnet specific files
│   ├── contracts.json
│   ├── addresses.json
│   └── contracts.ts
├── optimism/                  # Optimism Mainnet specific files
│   ├── contracts.json
│   ├── addresses.json
│   └── contracts.ts
├── celo/                  # Celo Mainnet specific files
│   ├── contracts.json
│   ├── addresses.json
│   └── contracts.ts
```

## Usage Examples

### Multi-Network (Recommended)

```typescript
import { getAddresses } from './contracts';
import SwagFactory_ABI from './abis/SwagFactory.json';
import Swag1155_ABI from './abis/Swag1155.json';
import FaucetManager_ABI from './abis/FaucetManager.json';

// Infrastructure addresses per network (ZKPassportNFT, FaucetManager, SwagFactory)
const baseAddresses = getAddresses('base');

// Discover swag products via factory — do NOT hardcode Swag1155 addresses
const factory = new ethers.Contract(
  baseAddresses.addresses.SwagFactory,
  SwagFactory_ABI,
  provider
);
const activeCollections = await factory.getActiveCollections();

// Interact with each product using Swag1155 ABI
for (const addr of activeCollections) {
  const meta    = await factory.getCollectionMeta(addr);
  const product = new ethers.Contract(addr, Swag1155_ABI, provider);
  const tokenIds = await product.listTokenIds();
  // Build product cards from meta.name, tokenIds, variant prices/supply
}
```

### Single Network

```typescript
// Import from network-specific directory
import { ADDRESSES } from './base/contracts';
import ZKPassportNFT_ABI from './abis/ZKPassportNFT.json';

const contract = new ethers.Contract(ADDRESSES.ZKPassportNFT, ZKPassportNFT_ABI, signer);
```

### React with Wagmi (Multi-Chain)

```typescript
import { useContractRead } from 'wagmi';
import { getAddresses } from './contracts';
import ZKPassportNFT_ABI from './abis/ZKPassportNFT.json';

function MyComponent({ chainId }: { chainId: number }) {
  const network = chainId === 8453 ? 'base' : chainId === 1 ? 'ethereum' : chainId === 130 ? 'unichain' : chainId === 10 ? 'optimism' : 'base';
  const addresses = getAddresses(network);

  const { data } = useContractRead({
    address: addresses.addresses.ZKPassportNFT,
    abi: ZKPassportNFT_ABI,
    functionName: 'totalSupply',
  });

  return <div>Total Supply: {data?.toString()}</div>;
}
```

## Deployed Networks

- **Base Mainnet** (Chain ID: 8453)
  - ZKPassportNFT: `0xa3f1150a8414b0383244e7c7936119e3e24d106d`
  - FaucetManager: `0x145d0d587bce7e390750cd67301e02478c51b48c`
  - SwagFactory: `0x89fb2a22bbb309703019b34439ae70b7e6d81e96`

- **Ethereum Mainnet** (Chain ID: 1)
  - ZKPassportNFT: `0x607003f188c49ed6e0553805734b9990393402df`
  - FaucetManager: `0x2940e286b41d279b61e484b98a08498e355e4778`

- **Unichain Mainnet** (Chain ID: 130)
  - ZKPassportNFT: `0xc2ddade57815220833c31ecab6f6e9de9c69df09`
  - FaucetManager: `0xdf1be43ae0636ba6f9bc26f75ab6ba8d66a3ddc8`
  - SwagFactory: `0x79abd2dabe18fa1086e210c41b622ed6011e0c85`

- **Optimism Mainnet** (Chain ID: 10)
  - ZKPassportNFT: `0x607003f188c49ed6e0553805734b9990393402df`
  - FaucetManager: `0x2940e286b41d279b61e484b98a08498e355e4778`
  - SwagFactory: `0x94b9f649f8825d5d797e37d04dfc66d612750b10`

- **Celo Mainnet** (Chain ID: 42220)
  - ZKPassportNFT: `undefined`
  - FaucetManager: `undefined`

## Default Network

Default network: **Base Mainnet**
