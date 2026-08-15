import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * deploy-collection.ts
 *
 * Stand-alone script to deploy a single product collection via an already-deployed
 * SwagFactory.  Reads item configuration from environment variables and the
 * latest deployment file for the target network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-collection.ts --network base
 *
 * Required env vars:
 *   ITEM_NAME       Human-readable product name, e.g. "ETH Cali Hoodie"
 *   ITEM_SKU        Internal SKU, e.g. "ETH-CALI-HOODIE-2025"
 *   ITEM_ADMIN      Address that will own the deployed Swag1155
 *   ITEM_TREASURY   Address that receives sale proceeds (defaults to SWAG_TREASURY_ADDRESS)
 *   ITEM_SIZES_JSON JSON array of VariantInit objects, e.g.:
 *   '[
 *     {
 *       "metadataURI": "ipfs://Qm.../s.json",
 *       "maxSupply": 50,
 *       "active": true,
 *       "payments": [
 *         { "token": "0xUSDC...", "price": 25000000 },
 *         { "token": "0xUSDT...", "price": 25000000 },
 *         { "token": "0xDAI...",  "price": "25000000000000000000" },
 *         { "token": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "price": "10000000000000000" }
 *       ]
 *     }
 *   ]'
 *
 *   ETH_TOKEN sentinel: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
 */

interface PaymentOption {
  token: string;
  price: bigint | number | string;
}

interface VariantInit {
  metadataURI: string;
  maxSupply: bigint | number;
  active: boolean;
  payments: PaymentOption[];
}

interface DeploymentResult {
  swagFactory: string;
  network: string;
  config: {
    swagTreasury: string;
  };
}

async function main() {
  // ── Config from env ─────────────────────────────────────────────────────────
  const itemName  = process.env.ITEM_NAME;
  const itemSku   = process.env.ITEM_SKU;
  const itemAdmin = process.env.ITEM_ADMIN;
  const sizesJson = process.env.ITEM_SIZES_JSON;

  if (!itemName || !itemSku || !itemAdmin || !sizesJson) {
    throw new Error(
      "Missing required env vars: ITEM_NAME, ITEM_SKU, ITEM_ADMIN, ITEM_SIZES_JSON"
    );
  }

  let sizes: VariantInit[];
  try {
    sizes = JSON.parse(sizesJson);
    if (!Array.isArray(sizes) || sizes.length === 0) throw new Error("sizes must be a non-empty array");
  } catch (e) {
    throw new Error(`ITEM_SIZES_JSON is invalid JSON: ${(e as Error).message}`);
  }

  // ── Load existing deployment ────────────────────────────────────────────────
  const connection = await network.connect();
  const viem = connection.viem;

  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const chainIdToNetwork: Record<number, string> = {
    1:     "ethereum",
    8453:  "base",
    130:   "unichain",
    10:    "optimism",
    31337: "hardhat",
  };
  const networkName = chainIdToNetwork[chainId] || `chain-${chainId}`;

  const deploymentPath = path.join(__dirname, "../deployments", `${networkName}-latest.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `No deployment found at ${deploymentPath}. Run deploy-all.ts first.`
    );
  }

  const deployment: DeploymentResult = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  if (!deployment.swagFactory) {
    throw new Error(
      "swagFactory address not found in deployment file. Re-run deploy-all.ts to include SwagFactory."
    );
  }

  const itemTreasury = (
    process.env.ITEM_TREASURY || deployment.config.swagTreasury
  ) as `0x${string}`;

  if (!itemTreasury) throw new Error("Cannot determine treasury: set ITEM_TREASURY or SWAG_TREASURY_ADDRESS");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("              DEPLOY COLLECTION VIA SWAGFACTORY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`\n🌐 Network:    ${networkName}`);
  console.log(`🏭 Factory:    ${deployment.swagFactory}`);
  console.log(`📦 Item Name:  ${itemName}`);
  console.log(`🏷️  SKU:        ${itemSku}`);
  console.log(`👤 Item Admin: ${itemAdmin}`);
  console.log(`💰 Treasury:   ${itemTreasury}`);
  console.log(`📐 Sizes:      ${sizes.length}`);

  // ── Obtain factory contract handle ─────────────────────────────────────────
  const factory = await viem.getContractAt(
    "SwagFactory",
    deployment.swagFactory as `0x${string}`
  );

  // ── Convert sizes to contract-compatible format ─────────────────────────────
  const contractSizes = sizes.map((s) => ({
    metadataURI: s.metadataURI,
    maxSupply:   BigInt(s.maxSupply),
    active:      s.active,
    payments:    s.payments.map((p) => ({
      token: p.token as `0x${string}`,
      price: BigInt(p.price),
    })),
  }));

  // Log payment options per size
  for (let i = 0; i < sizes.length; i++) {
    console.log(`   Size ${i + 1} (${sizes[i].metadataURI.split('/').pop()}):`);
    for (const p of sizes[i].payments) {
      console.log(`     token=${p.token}  price=${p.price}`);
    }
  }

  // ── Call deployCollection ───────────────────────────────────────────────────
  console.log("\n🚀 Calling SwagFactory.deployCollection...");

  const tx = await factory.write.deployCollection([
    itemName,
    itemSku,
    itemTreasury,
    itemAdmin as `0x${string}`,
    contractSizes,
  ]);

  console.log(`   Transaction hash: ${tx}`);

  // ── Wait and get the new collection address ─────────────────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`   Confirmed in block ${receipt.blockNumber}`);

  const count = await factory.read.getCollectionCount();
  const allCollections = await factory.read.getCollections();
  const newAddr = allCollections[allCollections.length - 1];

  console.log(`\n✅ Collection deployed: ${newAddr}`);
  console.log(`   Total collections in factory: ${count}`);

  // ── Print size summary ──────────────────────────────────────────────────────
  const swag = await viem.getContractAt("Swag1155", newAddr);
  console.log(`\n📋 Configured tokenIds:`);
  for (let i = 0; i < sizes.length; i++) {
    const tokenId = BigInt(i + 1);
    const v = await swag.read.getVariant([tokenId]);
    const [tokens, prices] = await swag.read.getPaymentOptions([tokenId]);
    console.log(`   tokenId ${i + 1}: maxSupply=${v.maxSupply}, active=${v.active}`);
    console.log(`             URI: ${sizes[i].metadataURI}`);
    for (let j = 0; j < tokens.length; j++) {
      console.log(`             pay: ${tokens[j]} → ${prices[j]}`);
    }
  }

  // ── Append to deployment file ───────────────────────────────────────────────
  const updatedDeployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  if (!updatedDeployment.collections) updatedDeployment.collections = [];
  updatedDeployment.collections.push({
    address:   newAddr,
    name:      itemName,
    sku:       itemSku,
    admin:     itemAdmin,
    treasury:  itemTreasury,
    timestamp: new Date().toISOString(),
    sizes:     sizes.map((s, i) => ({
      tokenId:     i + 1,
      metadataURI: s.metadataURI,
      maxSupply:   s.maxSupply,
      active:      s.active,
      payments:    s.payments,
    })),
  });
  fs.writeFileSync(deploymentPath, JSON.stringify(updatedDeployment, null, 2));
  console.log(`\n📄 Appended collection to ${deploymentPath}`);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                    COLLECTION DEPLOYED");
  console.log("═══════════════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
