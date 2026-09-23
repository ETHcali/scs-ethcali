import { network } from "hardhat";
import { formatEther } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deploy ONLY the swag pair: the Swag1155 clone implementation and the
 * SwagFactory that points at it. Nothing else is touched, so this can run on a
 * chain where the faucet, identity and donation contracts already exist
 * without redeploying them (deploy-all.ts redeploys the whole suite).
 *
 * Results are MERGED into deployments/<network>-latest.json under the keys
 * `swag1155Implementation` and `swagFactory` — the keys seed-swag.ts reads —
 * and a timestamped <network>-swag-<ts>.json copy is written beside it.
 *
 * Usage:
 *   npm run estimate:swag:base        # MANDATORY first: gas vs balance
 *   npm run deploy:swag:base
 *   npm run seed:swag -- --network base
 *
 * Required env: PRIVATE_KEY (deployer), SWAG_ADMIN (factory ADMIN_ROLE and
 * DEFAULT_ADMIN_ROLE holder; must be the key that will run seed-swag.ts or
 * that key must be granted via factory.addAdmin afterwards).
 */

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  10: "optimism",
  42220: "celo",
  31337: "hardhat",
};

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("              ETHCALI SWAG CONTRACTS DEPLOYMENT");
  console.log("═══════════════════════════════════════════════════════════");

  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address as `0x${string}`;

  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;

  const swagAdmin = (process.env.SWAG_ADMIN || "") as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(swagAdmin)) {
    throw new Error("SWAG_ADMIN is not set to an address. Refusing to deploy a factory nobody can operate.");
  }

  const balance = await publicClient.getBalance({ address: deployerAddress });

  console.log(`\n🌐 Network:     ${networkName} (${chainId})`);
  console.log(`👤 Deployer:    ${deployerAddress}`);
  console.log(`💰 Balance:     ${formatEther(balance)}`);
  console.log(`🛠  Swag admin:  ${swagAdmin}`);
  if (swagAdmin.toLowerCase() !== deployerAddress.toLowerCase()) {
    console.log(
      `   ⚠️  Swag admin is not the deployer. seed-swag.ts must then run with the admin's key,\n` +
        `      or the admin must call factory.addAdmin(${deployerAddress}) first.`
    );
  }

  // The implementation locks itself in its constructor (_initialized = true);
  // it is never used directly, only cloned by the factory.
  console.log("\n📦 Deploying Swag1155 implementation (clone reference)...");
  const swag1155Impl = await viem.deployContract("Swag1155", []);
  console.log(`   ✅ ${swag1155Impl.address}`);

  console.log("\n📦 Deploying SwagFactory...");
  const swagFactory = await viem.deployContract("SwagFactory", [swagAdmin, swag1155Impl.address]);
  console.log(`   ✅ ${swagFactory.address}`);

  // Public RPCs load-balance across replicas. A read issued right after the
  // deploy receipt can land on one still behind the tip and see no code — the
  // first Base deploy of this script died exactly there, after both contracts
  // were already on chain and before anything was saved. Poll until the code
  // is visible everywhere we ask, then read back.
  const waitForCode = async (address: `0x${string}`) => {
    for (let i = 0; i < 20; i++) {
      const code = await publicClient.getBytecode({ address });
      if (code && code !== "0x") return true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  };
  for (const [label, addr] of [
    ["Swag1155 implementation", swag1155Impl.address],
    ["SwagFactory", swagFactory.address],
  ] as const) {
    if (!(await waitForCode(addr))) throw new Error(`${label} at ${addr} has no code after 30s`);
  }

  // Read back rather than trust the constructor: a wrong admin here means a
  // factory nobody can call deployCollection on, discovered only at seed time.
  const adminRole = (await swagFactory.read.ADMIN_ROLE()) as `0x${string}`;
  const hasAdmin = (await swagFactory.read.hasRole([adminRole, swagAdmin])) as boolean;
  const implOnChain = (await swagFactory.read.implementation()) as `0x${string}`;
  if (!hasAdmin) throw new Error(`SwagFactory did not grant ADMIN_ROLE to ${swagAdmin}`);
  if (implOnChain.toLowerCase() !== swag1155Impl.address.toLowerCase()) {
    throw new Error(`SwagFactory.implementation() is ${implOnChain}, expected ${swag1155Impl.address}`);
  }
  console.log(`   ✅ ADMIN_ROLE held by ${swagAdmin}; implementation wired`);

  // ── Persist, merging with any existing deployment ────────────────────────
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const latestPath = path.join(deploymentsDir, `${networkName}-latest.json`);
  const existing = fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, "utf8")) : {};

  const result = {
    ...existing,
    // The pre-Aug-2026 direct Swag1155 deploy is superseded; drop the key so
    // nothing downstream mistakes the old contract for the implementation.
    swag1155: undefined,
    swag1155Implementation: swag1155Impl.address,
    swagFactory: swagFactory.address,
    network: networkName,
    timestamp: new Date().toISOString(),
    swagConfig: {
      deployer: deployerAddress,
      swagAdmin,
      previousSwagFactory: existing.swagFactory ?? null,
    },
  };

  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(deploymentsDir, `${networkName}-swag-${Date.now()}.json`),
    JSON.stringify(result, null, 2)
  );

  const spent = balance - (await publicClient.getBalance({ address: deployerAddress }));

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                  DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`   Swag1155 impl:  ${swag1155Impl.address}`);
  console.log(`   SwagFactory:    ${swagFactory.address}`);
  console.log(`   Gas spent:      ${formatEther(spent)}`);
  console.log(`   Saved to:       ${latestPath}`);
  console.log(`\n📌 Next:`);
  console.log(`   1. npm run verify:${networkName}`);
  console.log(`   2. SWAG_SIGNER=<backend signer> npm run seed:swag -- --network ${networkName}`);
  console.log(`   3. npm run setup:frontend, then publish the contracts package`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
