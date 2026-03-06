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
│   └── Swag1155.json
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
```

## Usage Examples

### Multi-Network (Recommended)

```typescript
import { getAddresses, getContracts, DEFAULT_NETWORK } from './contracts';
import ZKPassportNFT_ABI from './abis/ZKPassportNFT.json';
import FaucetManager_ABI from './abis/FaucetManager.json';

// Get addresses for a specific network
const baseAddresses = getAddresses('base');
const ethereumAddresses = getAddresses('ethereum');
const unichainAddresses = getAddresses('unichain');

// Use with ethers.js
const nftContract = new ethers.Contract(
  baseAddresses.addresses.ZKPassportNFT,
  ZKPassportNFT_ABI,
  signer
);

const faucetContract = new ethers.Contract(
  baseAddresses.addresses.FaucetManager,
  FaucetManager_ABI,
  signer
);
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
  - ZKPassportNFT: `0xe9d1d4fb7615f9bd879d70c70daa07a2a05fc834`
  - FaucetManager: `0xe9b78619c4ef60d8aec9fe6572991c03432de130`
  - Swag1155: `0xe132daa0e39299260c35399e57e20ac837729b9f`

- **Ethereum Mainnet** (Chain ID: 1)
  - ZKPassportNFT: `0x607003f188c49ed6e0553805734b9990393402df`
  - FaucetManager: `0x2940e286b41d279b61e484b98a08498e355e4778`
  - Swag1155: `0xd9663db045850171850fd1298a2176b329a67928`

- **Unichain Mainnet** (Chain ID: 130)
  - ZKPassportNFT: `0x8057dfc3d5aa4e6d66a2fc2c66f9282846a36a62`
  - FaucetManager: `0xa2db0955b8e452a489b977e308b38691eb093f0c`
  - Swag1155: `0x4437ac2399e7346d1cb47e7d0be19a67eec11a21`

- **Optimism Mainnet** (Chain ID: 10)
  - ZKPassportNFT: `0x01401f4802bcd0e1ee4fa7e42a1b7f48ab82d121`
  - FaucetManager: `0x016d7d55708f7b7b39693e2b46d69f290537420b`
  - Swag1155: `0x7a61c947a59a6b9364928af60341b50c1fb83439`

## Default Network

Default network: **Base Mainnet**
