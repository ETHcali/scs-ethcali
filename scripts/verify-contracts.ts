import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DeploymentResult {
  zkPassportNFT: string;
  faucetManager: string;
  swag1155: string;
  swagFactory?: string;
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
  console.log(`   ZKPassportNFT:  ${deployment.zkPassportNFT}`);
  console.log(`   FaucetManager:  ${deployment.faucetManager}`);
  console.log(`   Swag1155:       ${deployment.swag1155}`);
  if (deployment.swagFactory)     console.log(`   SwagFactory:    ${deployment.swagFactory}`);

  console.log(`\n📋 Config (from deployment):`);
  console.log(`   Owner/Admin:    ${deployment.config.zkPassportAdmin}`);
  console.log(`   Treasury:       ${deployment.config.swagTreasury}`);
  console.log(`   USDC:           ${deployment.config.usdcAddress}`);

  // Constructor arguments MUST match deploy-all.ts exactly:
  // ZKPassportNFT: ["ZKPassport Verification", "ZKPASS", owner]
  // FaucetManager: [nftAddress, admin]
  // Swag1155: ["ipfs://", usdc, treasury, admin]

  // Verify ZKPassportNFT
  console.log(`\n📝 Verifying ZKPassportNFT at ${deployment.zkPassportNFT}...`);
  const zkpArgs = [
    "ZKPassport Verification",  // name - must match deploy script
    "ZKPASS",                    // symbol - must match deploy script
    deployment.config.zkPassportAdmin,
  ];
  console.log(`   Constructor args: ${JSON.stringify(zkpArgs)}`);

  try {
    execSync(
      `npx hardhat verify --network ${networkName} ${deployment.zkPassportNFT} "${zkpArgs[0]}" "${zkpArgs[1]}" "${zkpArgs[2]}"`,
      { stdio: "inherit", cwd: join(__dirname, "..") }
    );
    console.log(`✅ ZKPassportNFT verified`);
  } catch (error: any) {
    console.log(`ℹ️  ZKPassportNFT verification attempted (may already be verified or failed)`);
  }

  // Verify FaucetManager
  console.log(`\n📝 Verifying FaucetManager at ${deployment.faucetManager}...`);
  const faucetArgs = [
    deployment.zkPassportNFT,
    deployment.config.faucetAdmin,
  ];
  console.log(`   Constructor args: ${JSON.stringify(faucetArgs)}`);

  try {
    execSync(
      `npx hardhat verify --network ${networkName} ${deployment.faucetManager} "${faucetArgs[0]}" "${faucetArgs[1]}"`,
      { stdio: "inherit", cwd: join(__dirname, "..") }
    );
    console.log(`✅ FaucetManager verified`);
  } catch (error: any) {
    console.log(`ℹ️  FaucetManager verification attempted (may already be verified or failed)`);
  }

  // Verify Swag1155
  console.log(`\n📝 Verifying Swag1155 at ${deployment.swag1155}...`);
  const swagArgs = [
    "ipfs://",                        // baseURI — must match deploy script
    deployment.config.usdcAddress,
    deployment.config.swagTreasury,
    deployment.config.swagAdmin,
  ];
  console.log(`   Constructor args: ${JSON.stringify(swagArgs)}`);

  try {
    execSync(
      `npx hardhat verify --network ${networkName} ${deployment.swag1155} "${swagArgs[0]}" "${swagArgs[1]}" "${swagArgs[2]}" "${swagArgs[3]}"`,
      { stdio: "inherit", cwd: join(__dirname, "..") }
    );
    console.log(`✅ Swag1155 verified`);
  } catch (error: any) {
    console.log(`ℹ️  Swag1155 verification attempted (may already be verified or failed)`);
  }

  // Verify SwagFactory (direct deploy — constructor arg is swagAdmin)
  if (deployment.swagFactory) {
    console.log(`\n📝 Verifying SwagFactory at ${deployment.swagFactory}...`);
    console.log(`   Constructor arg: ${deployment.config.swagAdmin}`);
    try {
      execSync(
        `npx hardhat verify --network ${networkName} ${deployment.swagFactory} "${deployment.config.swagAdmin}"`,
        { stdio: "inherit", cwd: join(__dirname, "..") }
      );
      console.log(`✅ SwagFactory verified`);
    } catch (error: any) {
      console.log(`ℹ️  SwagFactory verification attempted (may already be verified or failed)`);
    }
  }

  console.log(`\n✅ Verification complete for ${networkName}!`);
  console.log(`\n🔗 View on explorer:`);

  const explorerUrls: Record<string, string> = {
    base: "https://basescan.org/address",
    ethereum: "https://etherscan.io/address",
    unichain: "https://uniscan.xyz/address",
    optimism: "https://optimistic.etherscan.io/address",
  };
  const explorerUrl = explorerUrls[networkName] || "";

  if (explorerUrl) {
    console.log(`   ZKPassportNFT:  ${explorerUrl}/${deployment.zkPassportNFT}`);
    console.log(`   FaucetManager:  ${explorerUrl}/${deployment.faucetManager}`);
    console.log(`   Swag1155:       ${explorerUrl}/${deployment.swag1155}`);
    if (deployment.swagFactory)     console.log(`   SwagFactory:    ${explorerUrl}/${deployment.swagFactory}`);  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
