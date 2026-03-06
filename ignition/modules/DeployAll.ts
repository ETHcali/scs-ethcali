import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Combined deployment module - deploys ALL contracts at once:
 * - ZKPassportNFT
 * - FaucetManager (multi-vault faucet system)
 * - Swag1155
 *
 * Environment Variables Required (.env):
 * - SUPER_ADMIN_ADDRESS: Admin address for all contracts
 * - ZKPASSPORT_OWNER_ADDRESS: Owner for ZKPassportNFT
 * - FAUCET_ADMIN_ADDRESS: Admin for FaucetManager
 * - SWAG_TREASURY_ADDRESS: Treasury wallet for Swag1155 USDC payments
 * - USDC_ADDRESS_BASE/ETH/UNI: Network-specific USDC addresses
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/DeployAll.ts --network base
 */
export default buildModule("CompleteSystem", (m) => {
  const network = process.env.HARDHAT_NETWORK || "base";

  // Map network names to USDC env vars
  const usdcEnvMap: Record<string, string> = {
    base: "USDC_ADDRESS_BASE",
    ethereum: "USDC_ADDRESS_ETH",
    unichain: "USDC_ADDRESS_UNI",
    optimism: "USDC_ADDRESS_OP",
  };

  const usdcEnvKey = usdcEnvMap[network] || "USDC_ADDRESS_BASE";
  const usdcEnv = process.env[usdcEnvKey];

  // Get admin addresses from .env
  const zkpassportOwner = process.env.ZKPASSPORT_OWNER_ADDRESS;
  const faucetAdmin = process.env.FAUCET_ADMIN_ADDRESS;
  const swagAdmin = process.env.SUPER_ADMIN_ADDRESS;
  const treasuryEnv = process.env.SWAG_TREASURY_ADDRESS;

  console.log("\n🚀 Deploying Complete ETH Cali System to", network);
  console.log("=".repeat(60));

  // Validate required addresses
  if (!zkpassportOwner || !faucetAdmin || !swagAdmin) {
    throw new Error(
      "❌ Missing admin addresses. Set ZKPASSPORT_OWNER_ADDRESS, FAUCET_ADMIN_ADDRESS, SUPER_ADMIN_ADDRESS in .env"
    );
  }

  // ===== 1. Deploy ZKPassportNFT =====
  console.log("\n📋 Step 1: Deploying ZKPassportNFT...");
  console.log(`   Owner: ${zkpassportOwner}`);
  const zkPassportNFT = m.contract("ZKPassportNFT", ["ZKPassport", "ZKP", zkpassportOwner]);

  // ===== 2. Deploy FaucetManager (Multi-vault system) =====
  console.log("📋 Step 2: Deploying FaucetManager...");
  console.log(`   Admin: ${faucetAdmin}`);
  const faucetManager = m.contract("FaucetManager", [zkPassportNFT, faucetAdmin]);

  // ===== 3. Deploy Swag1155 =====
  console.log("📋 Step 3: Deploying Swag1155...");

  const baseURI = m.getParameter(
    "baseURI",
    process.env.SWAG1155_BASE_URI || "https://wallet.ethcali.org/metadata/{id}.json"
  );
  const usdc = m.getParameter("usdc", usdcEnv);
  const treasury = m.getParameter("treasury", treasuryEnv);

  if (!usdc) {
    throw new Error(
      `❌ USDC address not set. Set ${usdcEnvKey} in .env or use --parameters flag`
    );
  }
  if (!treasury) {
    throw new Error(
      "❌ Treasury address not set. Set SWAG_TREASURY_ADDRESS in .env or use --parameters flag"
    );
  }

  console.log(`   Admin: ${swagAdmin}`);
  console.log(`   Treasury: ${treasury}`);
  console.log(`   USDC: ${usdc}`);
  console.log(`   BaseURI: ${baseURI}`);

  const swag1155 = m.contract("Swag1155", [baseURI, usdc, treasury, swagAdmin]);

  // ===== 4. Deploy SwagFactory =====
  console.log("📋 Step 4: Deploying SwagFactory...");

  if (!swagAdmin) {
    throw new Error("❌ SUPER_ADMIN_ADDRESS is required for SwagFactory deployment");
  }

  // Direct deploy — no proxy needed (factory holds no funds; registry rebuildable from events)
  const swagFactory = m.contract("SwagFactory", [swagAdmin], { id: "SwagFactory" });

  console.log("\n" + "=".repeat(60));
  console.log("✅ All contracts configured for deployment!\n");

  return { zkPassportNFT, faucetManager, swag1155, swagFactory };
});
