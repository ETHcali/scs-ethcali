import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Script to extract ABIs and addresses for frontend integration
 * Reads from deployments/{network}-latest.json files
 * Usage: npx hardhat run scripts/setup-frontend.ts
 */

interface DeploymentResult {
  zkPassportNFT: string;
  faucetManager: string;
  swag1155Implementation?: string;
  swagFactory?: string;
  hackathonStaking?: string;
  donationVault?: string;
  donationReceipt?: string;
  network: string;
  timestamp: string;
  config: {
    network: string;
    superAdmin: string;
    zkpassportOwner: string;
    faucetAdmin: string;
    swagTreasury: string;
    usdcAddress: string;
  };
}

interface ContractInfo {
  address: string;
  abi: any[];
}

interface NetworkConfig {
  network: string;
  chainId: number;
  contracts: {
    ZKPassportNFT: ContractInfo;
    FaucetManager: ContractInfo;
    SwagFactory?: ContractInfo;
    HackathonStaking?: ContractInfo;
    DonationVault?: ContractInfo;
    DonationReceipt1155?: ContractInfo;
  };
}

interface MultiNetworkConfig {
  networks: Record<string, NetworkConfig>;
  defaultNetwork?: string;
}

const NETWORK_CHAIN_IDS: Record<string, number> = {
  base: 8453,
  ethereum: 1,
  unichain: 130,
  optimism: 10,
  celo: 42220,
};

const NETWORK_NAMES: Record<string, string> = {
  base: "Base Mainnet",
  ethereum: "Ethereum Mainnet",
  unichain: "Unichain Mainnet",
  optimism: "Optimism Mainnet",
  celo: "Celo Mainnet",
};

const SUPPORTED_NETWORKS = ["base", "ethereum", "unichain", "optimism", "celo"];

async function main() {
  console.log("🚀 Setting up frontend files from deployments...\n");

  // Read ABIs from artifacts (same for all networks)
  const artifactsDir = join(__dirname, "../artifacts/contracts");

  const readABI = (contractName: string): any[] => {
    const artifactPath = join(artifactsDir, `${contractName}.sol`, `${contractName}.json`);
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
      return artifact.abi;
    } catch (error) {
      console.error(`Error reading ABI for ${contractName}:`, error);
      return [];
    }
  };

  const nftABI = readABI("ZKPassportNFT");
  const faucetABI = readABI("FaucetManager");
  const swagABI = readABI("Swag1155");   // still needed for factory-deployed collections
  const factoryABI = readABI("SwagFactory");
  const stakingABI = readABI("HackathonStaking");
  const donationVaultABI = readABI("DonationVault");
  const donationReceiptABI = readABI("DonationReceipt1155");

  if (!nftABI.length || !faucetABI.length) {
    console.error("❌ Missing ABIs. Run 'npm run compile' first.");
    process.exit(1);
  }
  if (!factoryABI.length) {
    console.warn("⚠️  SwagFactory ABI not found — compile may be needed");
  }

  // Find all deployment files
  const deploymentsDir = join(__dirname, "../deployments");

  if (!existsSync(deploymentsDir)) {
    console.error("❌ Deployments directory not found. Deploy contracts first.");
    process.exit(1);
  }

  const multiNetworkConfig: MultiNetworkConfig = {
    networks: {},
  };

  const outputDir = join(__dirname, "../frontend");
  mkdirSync(outputDir, { recursive: true });

  // Process each supported network
  for (const networkName of SUPPORTED_NETWORKS) {
    const deploymentPath = join(deploymentsDir, `${networkName}-latest.json`);

    if (!existsSync(deploymentPath)) {
      console.log(`⚠️  No deployment found for ${networkName} - skipping`);
      continue;
    }

    const networkDisplayName = NETWORK_NAMES[networkName] || networkName;
    const chainId = NETWORK_CHAIN_IDS[networkName];

    console.log(`📦 Processing ${networkDisplayName} (Chain ID: ${chainId})...`);

    let deployment: DeploymentResult;
    try {
      deployment = JSON.parse(readFileSync(deploymentPath, "utf-8"));
    } catch (error) {
      console.log(`   ⚠️  Error reading deployment file - skipping\n`);
      continue;
    }

    // Create network config
    const networkConfig: NetworkConfig = {
      network: networkName,
      chainId,
      contracts: {
        ZKPassportNFT: {
          address: deployment.zkPassportNFT,
          abi: nftABI,
        },
        FaucetManager: {
          address: deployment.faucetManager,
          abi: faucetABI,
        },
        ...(deployment.swagFactory && factoryABI.length
          ? { SwagFactory: { address: deployment.swagFactory, abi: factoryABI } }
          : {}),
        ...(deployment.hackathonStaking && stakingABI.length
          ? { HackathonStaking: { address: deployment.hackathonStaking, abi: stakingABI } }
          : {}),
        ...(deployment.donationVault && donationVaultABI.length
          ? { DonationVault: { address: deployment.donationVault, abi: donationVaultABI } }
          : {}),
        ...(deployment.donationReceipt && donationReceiptABI.length
          ? { DonationReceipt1155: { address: deployment.donationReceipt, abi: donationReceiptABI } }
          : {}),
      },
    };

    multiNetworkConfig.networks[networkName] = networkConfig;

    // Set first network as default
    if (!multiNetworkConfig.defaultNetwork) {
      multiNetworkConfig.defaultNetwork = networkName;
    }

    // Create network-specific directory
    const networkDir = join(outputDir, networkName);
    mkdirSync(networkDir, { recursive: true });

    // Write network-specific files
    writeFileSync(
      join(networkDir, "contracts.json"),
      JSON.stringify(networkConfig, null, 2)
    );

    const addressesFile = {
      network: networkName,
      chainId,
      addresses: {
        ZKPassportNFT: deployment.zkPassportNFT,
        FaucetManager: deployment.faucetManager,
        ...(deployment.swagFactory ? { SwagFactory: deployment.swagFactory } : {}),
        ...(deployment.hackathonStaking ? { HackathonStaking: deployment.hackathonStaking } : {}),
        ...(deployment.donationVault ? { DonationVault: deployment.donationVault } : {}),
        ...(deployment.donationReceipt ? { DonationReceipt1155: deployment.donationReceipt } : {}),
      },
    };

    writeFileSync(
      join(networkDir, "addresses.json"),
      JSON.stringify(addressesFile, null, 2)
    );

    // Create TypeScript types for this network
    const typesContent = `// Auto-generated contract addresses and types for ${networkDisplayName}
// Generated: ${new Date().toISOString()}
export const CONTRACTS = ${JSON.stringify(networkConfig, null, 2)} as const;

export const ADDRESSES = {
${[
  ["ZKPassportNFT", deployment.zkPassportNFT],
  ["FaucetManager", deployment.faucetManager],
  ["SwagFactory", deployment.swagFactory],
  ["HackathonStaking", deployment.hackathonStaking],
  ["DonationVault", deployment.donationVault],
  ["DonationReceipt1155", deployment.donationReceipt],
]
  .filter(([, addr]) => Boolean(addr))
  .map(([name, addr]) => `  ${name}: "${addr}",`)
  .join("\n")}
} as const;

export const CHAIN_ID = ${chainId} as const;
export const NETWORK = "${networkName}" as const;
`;
    writeFileSync(join(networkDir, "contracts.ts"), typesContent);

    console.log(`   ✅ Created files in frontend/${networkName}/`);
    if (deployment.zkPassportNFT) console.log(`      - ZKPassportNFT: ${deployment.zkPassportNFT}`);
    if (deployment.faucetManager) console.log(`      - FaucetManager: ${deployment.faucetManager}`);
    if (deployment.donationVault) console.log(`      - DonationVault: ${deployment.donationVault}`);
    if (deployment.donationReceipt) console.log(`      - DonationReceipt1155: ${deployment.donationReceipt}`);
    if (deployment.swagFactory) {
      console.log(`      - SwagFactory:   ${deployment.swagFactory}`);
    }
    console.log("");
  }

  if (Object.keys(multiNetworkConfig.networks).length === 0) {
    console.error("❌ No deployments found. Deploy contracts first with 'npm run deploy:{network}'");
    process.exit(1);
  }

  // Write multi-network config
  writeFileSync(
    join(outputDir, "contracts.json"),
    JSON.stringify(multiNetworkConfig, null, 2)
  );
  console.log(`✅ Created frontend/contracts.json (multi-network config)`);

  // Write all addresses in one file
  const allAddresses: Record<string, any> = {};
  for (const [networkName, config] of Object.entries(multiNetworkConfig.networks)) {
    allAddresses[networkName] = {
      chainId: config.chainId,
      addresses: {
        ZKPassportNFT: config.contracts.ZKPassportNFT.address,
        FaucetManager: config.contracts.FaucetManager.address,
        ...(config.contracts.SwagFactory ? { SwagFactory: config.contracts.SwagFactory.address } : {}),
        ...(config.contracts.HackathonStaking ? { HackathonStaking: config.contracts.HackathonStaking.address } : {}),
        ...(config.contracts.DonationVault ? { DonationVault: config.contracts.DonationVault.address } : {}),
        ...(config.contracts.DonationReceipt1155 ? { DonationReceipt1155: config.contracts.DonationReceipt1155.address } : {}),
      },
    };
  }
  writeFileSync(
    join(outputDir, "addresses.json"),
    JSON.stringify(allAddresses, null, 2)
  );
  console.log(`✅ Created frontend/addresses.json (all networks)`);

  // Write shared ABIs
  const abisDir = join(outputDir, "abis");
  mkdirSync(abisDir, { recursive: true });

  writeFileSync(
    join(abisDir, "ZKPassportNFT.json"),
    JSON.stringify(nftABI, null, 2)
  );
  writeFileSync(
    join(abisDir, "FaucetManager.json"),
    JSON.stringify(faucetABI, null, 2)
  );
  writeFileSync(
    join(abisDir, "Swag1155.json"),
    JSON.stringify(swagABI, null, 2)
  );
  if (factoryABI.length) {
    writeFileSync(
      join(abisDir, "SwagFactory.json"),
      JSON.stringify(factoryABI, null, 2)
    );
  }
  if (stakingABI.length) {
    writeFileSync(
      join(abisDir, "HackathonStaking.json"),
      JSON.stringify(stakingABI, null, 2)
    );
  }
  if (donationVaultABI.length) {
    writeFileSync(
      join(abisDir, "DonationVault.json"),
      JSON.stringify(donationVaultABI, null, 2)
    );
  }
  if (donationReceiptABI.length) {
    writeFileSync(
      join(abisDir, "DonationReceipt1155.json"),
      JSON.stringify(donationReceiptABI, null, 2)
    );
  }
  console.log(`✅ Created frontend/abis/ (shared ABIs${factoryABI.length ? " including SwagFactory" : ""})`);

  // Create TypeScript types for multi-network
  const multiTypesContent = `// Auto-generated multi-network contract addresses and types
// Generated: ${new Date().toISOString()}
export const CONTRACTS = ${JSON.stringify(multiNetworkConfig, null, 2)} as const;

export const ADDRESSES = ${JSON.stringify(allAddresses, null, 2)} as const;

// Helper to get addresses for a specific network
export function getAddresses(network: keyof typeof ADDRESSES) {
  return ADDRESSES[network];
}

// Helper to get contract config for a specific network
export function getContracts(network: keyof typeof CONTRACTS.networks) {
  return CONTRACTS.networks[network];
}

// Default network
export const DEFAULT_NETWORK = "${multiNetworkConfig.defaultNetwork}" as const;
`;
  writeFileSync(join(outputDir, "contracts.ts"), multiTypesContent);
  console.log(`✅ Created frontend/contracts.ts (multi-network types)`);

  // Create README
  const frontendReadme = `# Frontend Contract Integration

This directory contains contract ABIs and addresses for frontend integration across multiple networks.

## Structure

\`\`\`
frontend/
├── contracts.json          # Multi-network config (all networks)
├── addresses.json          # All network addresses
├── contracts.ts           # TypeScript exports (multi-network)
├── abis/                  # Shared ABIs (same for all networks)
│   ├── ZKPassportNFT.json
│   ├── FaucetManager.json
│   ├── SwagFactory.json   # Factory registry — use getActiveCollections() to discover products
│   └── Swag1155.json      # Product contract ABI — used with addresses returned by SwagFactory
${Object.keys(multiNetworkConfig.networks)
  .map(
    (n) => `├── ${n}/                  # ${NETWORK_NAMES[n] || n} specific files
│   ├── contracts.json
│   ├── addresses.json
│   └── contracts.ts`
  )
  .join("\n")}
\`\`\`

## Usage Examples

### Multi-Network (Recommended)

\`\`\`typescript
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
\`\`\`

### Single Network

\`\`\`typescript
// Import from network-specific directory
import { ADDRESSES } from './base/contracts';
import ZKPassportNFT_ABI from './abis/ZKPassportNFT.json';

const contract = new ethers.Contract(ADDRESSES.ZKPassportNFT, ZKPassportNFT_ABI, signer);
\`\`\`

### React with Wagmi (Multi-Chain)

\`\`\`typescript
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
\`\`\`

## Deployed Networks

${Object.entries(multiNetworkConfig.networks)
  .map(
    ([name, config]) =>
      `- **${NETWORK_NAMES[name] || name}** (Chain ID: ${config.chainId})
  - ZKPassportNFT: \`${config.contracts.ZKPassportNFT.address}\`
  - FaucetManager: \`${config.contracts.FaucetManager.address}\`${config.contracts.SwagFactory ? `\n  - SwagFactory: \`${config.contracts.SwagFactory.address}\`` : ""}`
  )
  .join("\n\n")}

## Default Network

Default network: **${NETWORK_NAMES[multiNetworkConfig.defaultNetwork || "base"]}**
`;
  writeFileSync(join(outputDir, "README.md"), frontendReadme);
  console.log(`✅ Created frontend/README.md`);

  console.log("\n✨ Frontend setup complete for all networks!");
  console.log(`\n📁 Output directory: ${outputDir}`);
  console.log(`\n📊 Summary:`);
  console.log(`   - Networks processed: ${Object.keys(multiNetworkConfig.networks).length}`);
  console.log(`   - Networks: ${Object.keys(multiNetworkConfig.networks).join(", ")}`);
  console.log(`   - Default network: ${multiNetworkConfig.defaultNetwork}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
