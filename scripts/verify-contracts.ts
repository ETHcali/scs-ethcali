import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Verify the contracts written by scripts/deploy-all.ts on the block explorer.
 *
 * Constructor arguments MUST match deploy-all.ts exactly:
 *   ZKPassportNFT : [name, symbol, owner, domain, scope]
 *   FaucetManager : [zkPassportNFT, admin]
 *   Swag1155      : []   — the clone implementation takes no arguments
 *   SwagFactory   : [admin, swag1155Implementation]
 *
 * Swag1155 collections are EIP-1167 clones of the implementation; explorers
 * resolve them automatically once the implementation is verified.
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
    swagAdmin: string;
    faucetAdmin: string;
    zkPassportAdmin: string;
    swagTreasury: string;
    usdcAddress: string;
  };
}

async function main() {
  // Get network from command line arguments
  const networkIndex = process.argv.indexOf("--network");
  const networkName =
    networkIndex >= 0 && networkIndex < process.argv.length - 1
      ? process.argv[networkIndex + 1]
      : "base";

  if (!networkName) {
    console.error("❌ Network not specified. Use --network flag");
    process.exit(1);
  }

  console.log(`\n🔍 Verifying contracts on ${networkName}...`);

  // Read deployment info
  const deploymentPath = join(__dirname, "..", "deployments", `${networkName}-latest.json`);

  if (!existsSync(deploymentPath)) {
    console.error(`❌ Deployment file not found: ${deploymentPath}`);
    console.error(`   Run 'npm run deploy:${networkName}' first`);
    process.exit(1);
  }

  const deployment: DeploymentResult = JSON.parse(readFileSync(deploymentPath, "utf-8"));

  console.log(`\n📋 Contract Addresses (from deployment):`);
  console.log(`   ZKPassportNFT:   ${deployment.zkPassportNFT}`);
  console.log(`   FaucetManager:   ${deployment.faucetManager}`);
  if (deployment.swag1155Implementation) console.log(`   Swag1155 (impl): ${deployment.swag1155Implementation}`);
  if (deployment.swagFactory)            console.log(`   SwagFactory:     ${deployment.swagFactory}`);

  console.log(`\n📋 Config (from deployment):`);
  console.log(`   Owner/Admin:    ${deployment.config.zkPassportAdmin}`);
  console.log(`   Swag admin:     ${deployment.swagConfig?.swagAdmin ?? deployment.config.swagAdmin}`);
  console.log(`   Treasury:       ${deployment.config.swagTreasury}`);

  const verify = (label: string, address: string, args: string[]) => {
    console.log(`\n📝 Verifying ${label} at ${address}...`);
    console.log(`   Constructor args: ${JSON.stringify(args)}`);
    try {
      // argv array, no shell: addresses and args are passed verbatim, never interpolated.
      execFileSync("npx", ["hardhat", "verify", "--network", networkName, address, ...args], {
        stdio: "inherit",
        cwd: join(__dirname, ".."),
      });
      console.log(`✅ ${label} verified`);
    } catch {
      console.log(`ℹ️  ${label} verification attempted (may already be verified or failed)`);
    }
  };

  // Domain and scope fall back to the same defaults deploy-all.ts uses.
  verify("ZKPassportNFT", deployment.zkPassportNFT, [
    "ZKPassport Verification",
    "ZKPASS",
    deployment.config.zkPassportAdmin,
    process.env.ZKPASSPORT_DOMAIN || "ethcali.com",
    process.env.ZKPASSPORT_SCOPE || "ethcali-verification",
  ]);

  verify("FaucetManager", deployment.faucetManager, [
    deployment.zkPassportNFT,
    deployment.config.faucetAdmin,
  ]);

  if (deployment.swag1155Implementation) {
    verify("Swag1155 implementation", deployment.swag1155Implementation, []);
  } else {
    console.log(`\n⚠️  No swag1155Implementation in ${deploymentPath} — this deployment predates the clone-only Swag1155. Re-run deploy-all.ts.`);
  }

  if (deployment.swagFactory) {
    if (!deployment.swag1155Implementation) {
      console.log(`⚠️  Skipping SwagFactory: its constructor takes (admin, implementation) and the implementation address is missing.`);
    } else {
      // deploy-swag.ts records its own admin under swagConfig; the top-level
      // config block is from the last full deploy-all run and may be older.
      verify("SwagFactory", deployment.swagFactory, [
        deployment.swagConfig?.swagAdmin ?? deployment.config.swagAdmin,
        deployment.swag1155Implementation,
      ]);
    }
  }

  console.log(`\n✅ Verification complete for ${networkName}!`);
  console.log(`\n🔗 View on explorer:`);

  const explorerUrls: Record<string, string> = {
    base: "https://basescan.org/address",
    ethereum: "https://etherscan.io/address",
    unichain: "https://uniscan.xyz/address",
    optimism: "https://optimistic.etherscan.io/address",
    celo: "https://celoscan.io/address",
  };
  const explorerUrl = explorerUrls[networkName] || "";

  if (explorerUrl) {
    console.log(`   ZKPassportNFT:   ${explorerUrl}/${deployment.zkPassportNFT}`);
    console.log(`   FaucetManager:   ${explorerUrl}/${deployment.faucetManager}`);
    if (deployment.swag1155Implementation) console.log(`   Swag1155 (impl): ${explorerUrl}/${deployment.swag1155Implementation}`);
    if (deployment.swagFactory)            console.log(`   SwagFactory:     ${explorerUrl}/${deployment.swagFactory}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
