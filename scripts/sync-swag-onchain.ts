import { network } from "hardhat";
import { formatEther, formatUnits, parseUnits } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Bring a live collection back in line with swag-catalogue.json: prices and
 * metadata URIs. seed-swag.ts creates collections; this updates the ones
 * that exist when the catalogue changes afterwards (a re-price, a re-pin).
 *
 *   npm run seed:swag:dry -- --network base        # unrelated: seeding
 *   DRY_RUN=1 npx hardhat run scripts/sync-swag-onchain.ts --network base
 *   npx hardhat run scripts/sync-swag-onchain.ts --network base
 *
 * Per token, in catalogue order (tokenId = index + 1):
 *   - price:  setPaymentOption(tokenId, USDC, parseUnits(price, 6)) when it
 *             differs from getTokenPrice. Caps and active flags are NOT
 *             touched — those are stock decisions made in the admin UI.
 *   - uri:    setVariantWithURI(tokenId, onchainCap, voucherCap, active, uri)
 *             with the CURRENT caps read from chain, when uri(tokenId) differs.
 *             Refuses ipfs://PENDING like the seeder does.
 *
 * The signer must hold ADMIN_ROLE on the collection (the itemAdmin).
 */

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  10: "optimism",
  42220: "celo",
  31337: "hardhat",
};

const USDC_BY_NETWORK: Record<string, string | undefined> = {
  base: process.env.USDC_ADDRESS_BASE,
  ethereum: process.env.USDC_ADDRESS_ETH,
  unichain: process.env.USDC_ADDRESS_UNI,
  optimism: process.env.USDC_ADDRESS_OP,
  celo: process.env.USDC_ADDRESS_CELO,
};

interface Variant {
  label: string;
  designSku: string;
  metadataURI: string;
  prices: Record<string, string>;
}

/**
 * Read until the value matches or we give up. Public RPCs load-balance across
 * replicas; a read right after a mined write can land on one behind the tip
 * and report the old value. This bit the deploy scripts and it bit this one on
 * its first Base run. Retry before calling it a mismatch.
 */
async function readBack<T>(read: () => Promise<T>, want: T, what: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await read()) === want) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${what}: read-back still differs after 30s`);
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [signer] = await viem.getWalletClients();
  const signerAddress = signer.account.address as `0x${string}`;

  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;
  const usdc = USDC_BY_NETWORK[networkName];
  if (!usdc) throw new Error(`No USDC address configured for ${networkName}`);

  const cataloguePath = path.resolve(process.env.SWAG_CATALOGUE || path.join(__dirname, "../swag-catalogue.json"));
  const catalogue = JSON.parse(fs.readFileSync(cataloguePath, "utf8")) as {
    products: { sku: string; variants: Variant[] }[];
  };
  const deploymentPath = path.join(__dirname, `../deployments/${networkName}-latest.json`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as {
    swagCollections?: Record<string, `0x${string}`>;
  };

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`         SWAG ON-CHAIN SYNC — ${networkName}${dryRun ? " (DRY RUN)" : ""}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  signer  : ${signerAddress}`);
  console.log(`  USDC    : ${usdc}`);

  const startBalance = await publicClient.getBalance({ address: signerAddress });
  let priceTx = 0;
  let uriTx = 0;

  for (const product of catalogue.products) {
    const collection = deployment.swagCollections?.[product.sku];
    if (!collection) {
      console.log(`\n⏭  ${product.sku}: not deployed on ${networkName}, skipping`);
      continue;
    }
    const swag = await viem.getContractAt("Swag1155", collection);
    const adminRole = (await swag.read.ADMIN_ROLE()) as `0x${string}`;
    if (!(await swag.read.hasRole([adminRole, signerAddress]))) {
      throw new Error(`${signerAddress} does not hold ADMIN_ROLE on ${collection}`);
    }
    console.log(`\n📦 ${product.sku} @ ${collection}`);

    for (let i = 0; i < product.variants.length; i++) {
      const v = product.variants[i];
      const tokenId = BigInt(i + 1);
      const wantPrice = parseUnits(v.prices.USDC, 6);
      const havePrice = (await swag.read.getTokenPrice([tokenId, usdc as `0x${string}`])) as bigint;
      const haveUri = (await swag.read.uri([tokenId])) as string;
      const line = `   #${String(i + 1).padStart(2)} ${v.label.padEnd(36)}`;

      if (havePrice !== wantPrice) {
        console.log(`${line} price ${formatUnits(havePrice, 6)} → ${v.prices.USDC} USDC`);
        if (!dryRun) {
          const hash = await swag.write.setPaymentOption([tokenId, usdc as `0x${string}`, wantPrice]);
          const rcpt = await publicClient.waitForTransactionReceipt({ hash });
          if (rcpt.status !== "success") throw new Error(`setPaymentOption(${tokenId}) reverted (${hash})`);
          await readBack(
            async () => (await swag.read.getTokenPrice([tokenId, usdc as `0x${string}`])) as bigint,
            wantPrice,
            `price #${tokenId}`
          );
          priceTx++;
        }
      }

      if (haveUri !== v.metadataURI) {
        if (!/^ipfs:\/\/[a-z0-9]{46,}$/i.test(v.metadataURI)) {
          throw new Error(`#${tokenId} ${v.designSku}: metadataURI is a placeholder (${v.metadataURI}); pin first`);
        }
        console.log(`${line} uri   ${haveUri.slice(0, 24)}… → ${v.metadataURI.slice(0, 24)}…`);
        if (!dryRun) {
          const cur = (await swag.read.getVariant([tokenId])) as {
            onchainCap: bigint;
            voucherCap: bigint;
            active: boolean;
          };
          const hash = await swag.write.setVariantWithURI([
            tokenId,
            cur.onchainCap,
            cur.voucherCap,
            cur.active,
            v.metadataURI,
          ]);
          const rcpt = await publicClient.waitForTransactionReceipt({ hash });
          if (rcpt.status !== "success") throw new Error(`setVariantWithURI(${tokenId}) reverted (${hash})`);
          await readBack(async () => (await swag.read.uri([tokenId])) as string, v.metadataURI, `uri #${tokenId}`);
          uriTx++;
        }
      }

      if (havePrice === wantPrice && haveUri === v.metadataURI) {
        console.log(`${line} ✓ in sync`);
      }
    }
  }

  const spent = startBalance - (await publicClient.getBalance({ address: signerAddress }));
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  price updates: ${priceTx}   uri updates: ${uriTx}${dryRun ? "   (dry run — nothing sent)" : `   gas: ${formatEther(spent)}`}`);
  console.log("═══════════════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
