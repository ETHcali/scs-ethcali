import { network } from "hardhat";
import { formatEther, parseUnits } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Seed the swag catalogue: deploy one Swag1155 collection per product via
 * SwagFactory, from a JSON file rather than one-product-at-a-time env vars.
 *
 * IDEMPOTENT — reads the factory registry first and skips any SKU already
 * deployed, so a partial run can simply be re-run.
 *
 * Prices in the catalogue are HUMAN-READABLE and parsed with each token's own
 * decimals. Writing base units by hand is how a 10^12 pricing error happens:
 * 25 USDC is 25_000000 but 25 of an 18-decimal token is 25_000000000000000000.
 *
 * Usage:
 *   npx hardhat run scripts/seed-swag.ts --network base
 *   SWAG_CATALOGUE=./my-catalogue.json npx hardhat run scripts/seed-swag.ts --network celo
 *   DRY_RUN=1 npx hardhat run scripts/seed-swag.ts --network base
 */

const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  10: "optimism",
  42220: "celo",
  31337: "hardhat",
};

/** Token catalogue per chain. Decimals are explicit — never assumed. */
function tokensForChain(networkName: string): Record<string, { address: string; decimals: number }> {
  const usdc: Record<string, string | undefined> = {
    ethereum: process.env.USDC_ADDRESS_ETH,
    base: process.env.USDC_ADDRESS_BASE,
    unichain: process.env.USDC_ADDRESS_UNI,
    optimism: process.env.USDC_ADDRESS_OP,
    celo: process.env.USDC_ADDRESS_CELO,
  };

  const out: Record<string, { address: string; decimals: number }> = {
    ETH: { address: ETH_TOKEN, decimals: 18 },
  };

  if (usdc[networkName]) out.USDC = { address: usdc[networkName] as string, decimals: 6 };

  // COPm (Mento Colombian Peso) is Celo-only and 18 decimals, unlike USDC.
  if (networkName === "celo") {
    out.COPm = {
      address: process.env.COPM_ADDRESS_CELO || "0x8a567e2ae79ca692bd748ab832081c45de4041ea",
      decimals: 18,
    };
  }

  return out;
}

interface CatalogueVariant {
  label: string;
  metadataURI: string;
  maxSupply: number;
  active: boolean;
  prices: Record<string, string>;
}

interface CatalogueProduct {
  name: string;
  sku: string;
  description?: string;
  variants: CatalogueVariant[];
}

async function main() {
  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address as `0x${string}`;

  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;
  const dryRun = process.env.DRY_RUN === "1";

  // ── Load catalogue ────────────────────────────────────────────────────────
  const cataloguePath = path.resolve(
    __dirname,
    "..",
    process.env.SWAG_CATALOGUE || "swag-catalogue.json"
  );
  if (!fs.existsSync(cataloguePath)) {
    throw new Error(
      `No catalogue at ${cataloguePath}. Copy swag-catalogue.example.json to swag-catalogue.json and fill it in.`
    );
  }
  const catalogue = JSON.parse(fs.readFileSync(cataloguePath, "utf8")) as {
    products: CatalogueProduct[];
  };

  // ── Resolve the factory ───────────────────────────────────────────────────
  // A dry run validates the catalogue offline — price parsing and token
  // resolution are what matter, and neither needs a deployed factory.
  const deploymentPath = path.join(__dirname, `../deployments/${networkName}-latest.json`);
  const deployment = fs.existsSync(deploymentPath)
    ? JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
    : {};

  if (!dryRun) {
    if (!fs.existsSync(deploymentPath)) {
      throw new Error(`No deployment for ${networkName}. Deploy the contracts first.`);
    }
    if (!deployment.swagFactory) {
      throw new Error(`No SwagFactory deployed on ${networkName}.`);
    }
  }

  const factory = deployment.swagFactory
    ? await viem.getContractAt("SwagFactory", deployment.swagFactory)
    : null;
  const treasury = (process.env.ITEM_TREASURY || process.env.SWAG_TREASURY_ADDRESS) as `0x${string}`;
  const itemAdmin = (process.env.ITEM_ADMIN || process.env.SWAG_ADMIN) as `0x${string}`;

  if (!dryRun && (!treasury || !itemAdmin)) {
    throw new Error("Set SWAG_TREASURY_ADDRESS and SWAG_ADMIN (or ITEM_TREASURY / ITEM_ADMIN)");
  }

  const tokens = tokensForChain(networkName);
  const startBalance = await publicClient.getBalance({ address: deployerAddress });

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`                SEEDING SWAG — ${networkName}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  factory   : ${deployment.swagFactory || "(none — dry run)"}`);
  console.log(`  treasury  : ${treasury}`);
  console.log(`  itemAdmin : ${itemAdmin}`);
  console.log(`  currencies: ${Object.keys(tokens).join(", ")}`);
  console.log(`  catalogue : ${path.basename(cataloguePath)} (${catalogue.products.length} products)`);
  if (dryRun) console.log("  MODE      : DRY RUN — nothing will be sent");

  // ── Which SKUs already exist? ─────────────────────────────────────────────
  const existingSkus = new Set<string>();
  if (factory) {
    const existing = (await factory.read.getCollections()) as `0x${string}`[];
    for (const addr of existing) {
      const meta = (await factory.read.getCollectionMeta([addr])) as { sku: string };
      existingSkus.add(meta.sku);
    }
    console.log(`  already deployed: ${existingSkus.size} collection(s)\n`);
  } else {
    console.log("");
  }

  let deployed = 0;
  let skipped = 0;

  for (const product of catalogue.products) {
    if (existingSkus.has(product.sku)) {
      console.log(`⏭  ${product.name} (${product.sku}) — already deployed, skipping`);
      skipped++;
      continue;
    }

    // Build VariantInit[], converting human prices to base units.
    const sizes = product.variants.map((variant) => {
      const payments: Array<{ token: `0x${string}`; price: bigint }> = [];

      for (const [symbol, human] of Object.entries(variant.prices)) {
        const token = tokens[symbol];
        if (!token) {
          console.log(`   ⚠️  ${symbol} not available on ${networkName} — skipping that price`);
          continue;
        }
        payments.push({
          token: token.address as `0x${string}`,
          price: parseUnits(human, token.decimals),
        });
      }

      if (payments.length === 0) {
        throw new Error(
          `${product.sku} / ${variant.label}: no usable payment options on ${networkName}`
        );
      }

      return {
        metadataURI: variant.metadataURI,
        maxSupply: BigInt(variant.maxSupply),
        active: variant.active,
        payments,
      };
    });

    console.log(`\n📦 ${product.name} (${product.sku})`);
    for (let i = 0; i < product.variants.length; i++) {
      const v = product.variants[i];
      const priced = Object.entries(v.prices)
        .filter(([s]) => tokens[s])
        .map(([s, p]) => `${p} ${s}`)
        .join(", ");
      console.log(`   tokenId ${i + 1}  ${v.label.padEnd(10)} supply ${String(v.maxSupply).padEnd(5)} ${priced}`);
    }

    if (dryRun) {
      console.log("   (dry run — not deployed)");
      continue;
    }

    if (!factory) throw new Error("factory unavailable");
    process.stdout.write("   deploying … ");
    const hash = await factory.write.deployCollection([
      product.name,
      product.sku,
      treasury,
      itemAdmin,
      sizes,
    ]);
    // Wait for the receipt before the next product — consecutive writes without
    // waiting race on nonce.
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`deployCollection reverted (${hash})`);

    const all = (await factory.read.getCollections()) as `0x${string}`[];
    console.log(`ok → ${all[all.length - 1]}`);
    deployed++;
  }

  const spent = startBalance - (await publicClient.getBalance({ address: deployerAddress }));

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  deployed: ${deployed}   skipped: ${skipped}`);
  if (!dryRun) console.log(`  gas spent: ${formatEther(spent)}`);
  console.log("═══════════════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
