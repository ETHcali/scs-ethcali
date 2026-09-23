import { network } from "hardhat";
import { decodeEventLog, formatEther, isAddress, parseUnits } from "viem";
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
 * SIGNER_ROLE — until a collection has a voucher signer, every Shopify claim()
 * on it reverts with InvalidSignature. Set SWAG_SIGNER and this script passes
 * it straight into deployCollection, which grants SIGNER_ROLE before the
 * factory renounces its roles, so a new collection is claimable from block
 * one. Collections deployed earlier without one are patched post hoc via
 * addSigner — which only works when the deployer holds their
 * DEFAULT_ADMIN_ROLE; the rest are listed loudly at the end.
 *
 * Usage:
 *   npx hardhat run scripts/seed-swag.ts --network base
 *   SWAG_CATALOGUE=./my-catalogue.json npx hardhat run scripts/seed-swag.ts --network celo
 *   DRY_RUN=1 npx hardhat run scripts/seed-swag.ts --network base
 */

const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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
  /** Units sellable on-chain via buy(). */
  onchainCap: number;
  /** Units reserved for Shopify vouchers. Set Shopify inventory to this. */
  voucherCap: number;
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

  // Refuse placeholders. The catalogue starts life with ipfs://PENDING (or the
  // older ipfs://REPLACE) until swag-pin.mjs writes real CIDs; deploying with
  // those would ship a collection whose every token renders broken, forever
  // visible in the CollectionDeployed log even after the URI is repointed.
  const pending = catalogue.products.flatMap((p) =>
    p.variants.filter((v) => !/^ipfs:\/\/[a-z0-9]{46,}$/i.test(v.metadataURI)).map((v) => `${p.sku}/${v.label}: ${v.metadataURI}`)
  );
  if (pending.length > 0) {
    throw new Error(
      `Refusing to seed: ${pending.length} variant(s) have no real metadata CID.\n  ` + pending.join("\n  ") +
      `\nRun wallet_ethcali/scripts/swag-pin.mjs first.`
    );
  }

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

  // The backend key that signs Shopify claim vouchers. Optional here, but
  // nothing can be claimed until it is granted — see the warning at the end.
  const signer = process.env.SWAG_SIGNER as `0x${string}` | undefined;
  if (signer && !isAddress(signer)) {
    throw new Error(`SWAG_SIGNER is not an address: ${signer}`);
  }

  // deployCollection is onlyRole(ADMIN_ROLE) on the factory. deploy-all.ts makes
  // SWAG_ADMIN the factory admin, which is not necessarily the key running this
  // script — fail here with the fix, not later with a raw revert.
  if (factory) {
    const adminRole = (await factory.read.ADMIN_ROLE()) as `0x${string}`;
    const deployerIsFactoryAdmin = (await factory.read.hasRole([adminRole, deployerAddress])) as boolean;
    if (!deployerIsFactoryAdmin) {
      const msg =
        `Deployer ${deployerAddress} does not hold ADMIN_ROLE on SwagFactory ${deployment.swagFactory}, ` +
        `so deployCollection would revert. Either run this with the factory admin's key ` +
        `(${deployment.config?.swagAdmin ?? "SWAG_ADMIN"}) or have that admin call ` +
        `addAdmin(${deployerAddress}) on the factory first.`;
      if (!dryRun) throw new Error(msg);
      console.log(`\n⚠️  ${msg}\n`);
    }
  }

  const tokens = tokensForChain(networkName);
  const startBalance = await publicClient.getBalance({ address: deployerAddress });

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`                SEEDING SWAG — ${networkName}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  factory   : ${deployment.swagFactory || "(none — dry run)"}`);
  console.log(`  treasury  : ${treasury}`);
  console.log(`  itemAdmin : ${itemAdmin}`);
  console.log(`  signer    : ${signer || "(SWAG_SIGNER unset — claims will not work, see below)"}`);
  console.log(`  currencies: ${Object.keys(tokens).join(", ")}`);
  console.log(`  catalogue : ${path.basename(cataloguePath)} (${catalogue.products.length} products)`);
  if (dryRun) console.log("  MODE      : DRY RUN — nothing will be sent");

  // ── Which SKUs already exist? ─────────────────────────────────────────────
  const existingBySku = new Map<string, `0x${string}`>();
  if (factory) {
    const existing = (await factory.read.getCollections()) as `0x${string}`[];
    for (const addr of existing) {
      const meta = (await factory.read.getCollectionMeta([addr])) as { sku: string };
      existingBySku.set(meta.sku, addr);
    }
    console.log(`  already deployed: ${existingBySku.size} collection(s)\n`);
  } else {
    console.log("");
  }

  // ── SIGNER_ROLE bookkeeping ───────────────────────────────────────────────
  let signerGrants = 0;
  const signerMissing: string[] = [];

  /**
   * Make sure `signer` can sign vouchers for `collection`. For a collection
   * this run just deployed it is a read-back check — the factory granted the
   * role. For an older collection it is the repair path: only the collection's
   * DEFAULT_ADMIN_ROLE (the itemAdmin) can grant it, so when the deployer is
   * not that account this records what the itemAdmin must do.
   */
  /** Persist each collection under deployments/<net>-latest.json → swagCollections[sku]. */
  function recordCollection(sku: string, collection: `0x${string}`) {
    if (dryRun || !fs.existsSync(deploymentPath)) return;
    const d = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    d.swagCollections = { ...(d.swagCollections ?? {}), [sku]: collection };
    fs.writeFileSync(deploymentPath, JSON.stringify(d, null, 2));
  }

  async function ensureSigner(collection: `0x${string}`, label: string) {
    if (!signer) {
      signerMissing.push(`${label}  ${collection}`);
      return;
    }

    // Public RPCs load-balance across replicas; a read right after a write can
    // land on one that has not seen the new clone yet. The first Base seed died
    // here with "contractAddress: undefined" after the collection was already
    // live. Wait until code is visible before reading anything from it.
    for (let i = 0; i < 20; i++) {
      const code = await publicClient.getBytecode({ address: collection });
      if (code && code !== "0x") break;
      if (i === 19) throw new Error(`${collection} has no code after 30s`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const swag = await viem.getContractAt("Swag1155", collection);
    const role = (await swag.read.SIGNER_ROLE()) as `0x${string}`;

    if (await swag.read.hasRole([role, signer])) {
      console.log(`   signer    ✓ ${signer} already holds SIGNER_ROLE`);
      return;
    }

    const deployerIsSuperAdmin = (await swag.read.isSuperAdmin([deployerAddress])) as boolean;
    if (!deployerIsSuperAdmin) {
      signerMissing.push(
        `${label}  ${collection}  — deployer ${deployerAddress} lacks DEFAULT_ADMIN_ROLE; ` +
          `the itemAdmin must call addSigner(${signer})`
      );
      return;
    }

    if (dryRun) {
      console.log(`   signer    (dry run — would call addSigner(${signer}))`);
      return;
    }

    process.stdout.write(`   signer    addSigner(${signer}) … `);
    const hash = await swag.write.addSigner([signer]);
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`addSigner reverted (${hash})`);

    // Read it back. A mined tx is not proof the role landed.
    if (!(await swag.read.hasRole([role, signer]))) {
      throw new Error(`addSigner mined but ${signer} still lacks SIGNER_ROLE on ${collection}`);
    }
    console.log("ok");
    signerGrants++;
  }

  let deployed = 0;
  let skipped = 0;

  // SWAG_REDEPLOY_SKUS=SKU1,SKU2 deploys a fresh clone for a SKU that already
  // exists, superseding the old one (recorded under supersededSwagCollections
  // so nothing forgets it). Used once on Base to move custody off the Safe
  // before anything had been minted. Pause the old clone yourself.
  const redeploy = new Set(
    (process.env.SWAG_REDEPLOY_SKUS || "").split(",").map((x) => x.trim()).filter(Boolean)
  );
  // SWAG_OPERATORS=0x…,0x… gets ADMIN_ROLE on every collection this run
  // deploys, granted by the deployer while it holds DEFAULT_ADMIN_ROLE.
  const operators = (process.env.SWAG_OPERATORS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean) as `0x${string}`[];
  for (const op of operators) if (!isAddress(op)) throw new Error(`SWAG_OPERATORS entry is not an address: ${op}`);

  for (const product of catalogue.products) {
    const existing = existingBySku.get(product.sku);
    if (existing && redeploy.has(product.sku)) {
      console.log(`♻️  ${product.name} (${product.sku}) — redeploying; ${existing} will be superseded`);
      if (!dryRun && fs.existsSync(deploymentPath)) {
        const d = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
        d.supersededSwagCollections = { ...(d.supersededSwagCollections ?? {}), [`${product.sku}@${existing}`]: new Date().toISOString() };
        fs.writeFileSync(deploymentPath, JSON.stringify(d, null, 2));
      }
    } else if (existing) {
      console.log(`⏭  ${product.name} (${product.sku}) — already deployed at ${existing}, skipping`);
      skipped++;
      // Still make sure it can accept vouchers — an earlier run may have had
      // no SWAG_SIGNER, and the key may have been rotated since.
      await ensureSigner(existing, product.sku);
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
        onchainCap: BigInt(variant.onchainCap),
        voucherCap: BigInt(variant.voucherCap),
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
      console.log(
        `   tokenId ${i + 1}  ${v.label.padEnd(10)} ` +
          `onchain ${String(v.onchainCap).padEnd(4)} shopify ${String(v.voucherCap).padEnd(4)} ${priced}`
      );
    }

    if (dryRun) {
      console.log("   (dry run — not deployed)");
      if (signer) console.log(`   signer    (dry run — would pass ${signer} to deployCollection)`);
      else signerMissing.push(`${product.sku}  (not yet deployed)`);
      continue;
    }

    if (!factory) throw new Error("factory unavailable");
    process.stdout.write("   deploying … ");
    // The factory grants SIGNER_ROLE itself while it still holds
    // DEFAULT_ADMIN_ROLE, so the deployer need not be the itemAdmin for a new
    // collection to be claimable. Zero address means "no signer yet".
    const hash = await factory.write.deployCollection([
      product.name,
      product.sku,
      treasury,
      itemAdmin,
      sizes,
      signer ?? ZERO_ADDRESS,
    ]);
    // Wait for the receipt before the next product — consecutive writes without
    // waiting race on nonce.
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`deployCollection reverted (${hash})`);

    // Take the address from this transaction's own CollectionDeployed log, not
    // from a follow-up getCollections() read: that read hit a lagging replica on
    // Base, returned [], and the script crashed on collection = undefined.
    let collection: `0x${string}` | undefined;
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== factory.address.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: factory.abi, data: log.data, topics: log.topics });
        if (ev.eventName === "CollectionDeployed") {
          collection = (ev.args as { collection: `0x${string}` }).collection;
          break;
        }
      } catch {
        // not our event
      }
    }
    if (!collection) throw new Error(`deployCollection mined (${hash}) but no CollectionDeployed log was found`);
    console.log(`ok → ${collection}`);
    deployed++;
    recordCollection(product.sku, collection);

    // Read the role back — a mined deploy is not proof the signer landed.
    await ensureSigner(collection, product.sku);

    for (const op of operators) {
      const swag = await viem.getContractAt("Swag1155", collection);
      const role = (await swag.read.ADMIN_ROLE()) as `0x${string}`;
      if (await swag.read.hasRole([role, op])) {
        console.log(`   operator  ✓ ${op} already holds ADMIN_ROLE`);
        continue;
      }
      process.stdout.write(`   operator  addAdmin(${op}) … `);
      const hash = await swag.write.addAdmin([op]);
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error(`addAdmin(${op}) reverted (${hash})`);
      for (let i = 0; i < 20; i++) {
        if (await swag.read.hasRole([role, op])) break;
        if (i === 19) throw new Error(`addAdmin mined but ${op} still lacks ADMIN_ROLE`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      console.log("ok");
    }
  }

  const spent = startBalance - (await publicClient.getBalance({ address: deployerAddress }));

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  deployed: ${deployed}   skipped: ${skipped}   signers granted: ${signerGrants}`);
  if (!dryRun) console.log(`  gas spent: ${formatEther(spent)}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (signerMissing.length > 0) {
    console.log(`
⚠️  ⚠️  ⚠️  NO VOUCHER SIGNER ON ${signerMissing.length} COLLECTION(S)  ⚠️  ⚠️  ⚠️

    Until a signer is granted, every Shopify voucher claim() on these
    collections reverts with InvalidSignature — customers who paid on Shopify
    cannot claim. New collections get their signer from deployCollection when
    SWAG_SIGNER is set; these are older ones, or this run had no SWAG_SIGNER:

${signerMissing.map((line) => `      • ${line}`).join("\n")}

    Fix: ${
      signer
        ? `have the itemAdmin (${itemAdmin}) call addSigner(${signer}) on each address above.`
        : `re-run with SWAG_SIGNER=<backend voucher signing address> (for already-deployed\n    collections the deployer must be the itemAdmin), or have the itemAdmin (${itemAdmin})\n    call addSigner(<signer>) on each address above.`
    }
`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
