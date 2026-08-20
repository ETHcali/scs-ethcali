import { network } from "hardhat";
import { formatEther, parseEther } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * ETHCALI Contracts Deployment Script
 *
 * Deploys all contracts with proper admin/treasury configuration from .env
 *
 * Deploys infrastructure contracts only:
 *   ZKPassportNFT + FaucetManager + SwagFactory
 *
 * Products (Swag1155) are NOT deployed here.
 * Use scripts/deploy-collection.ts to create products via the factory.
 *
 * Security Model:
 * - ZKPassportNFT: Uses Ownable (single owner, can transfer)
 * - FaucetManager: Uses AccessControl (DEFAULT_ADMIN_ROLE + ADMIN_ROLE)
 * - SwagFactory:   Uses AccessControl — factory admin calls deployCollection per product
 */

interface DeploymentConfig {
  network: string;
  swagAdmin: string;
  faucetAdmin: string;
  zkPassportAdmin: string;
  swagTreasury: string;
  usdcAddress: string;
  donationAdmin: string;
  donationBeneficiary: string;
  donationCustodyAdmin: string;
  donationOpsAdmins: string[];
  copmAddress: string;
}

interface DeploymentResult {
  zkPassportNFT: string;
  faucetManager: string;
  swag1155Implementation: string;
  swagFactory: string;
  hackathonStaking: string;
  donationVault: string;
  donationReceipt: string;
  network: string;
  timestamp: string;
  config: DeploymentConfig;
}

/**
 * COPm — Mento Colombian Peso, 18 decimals. Celo mainnet only.
 * Verified on-chain via forno.celo.org: symbol "COPm", decimals 18.
 */
const COPM_ADDRESS_CELO = "0x8a567e2ae79ca692bd748ab832081c45de4041ea";

function getConfig(networkName: string): DeploymentConfig {
  // Get USDC address based on network
  let usdcAddress: string;
  switch (networkName) {
    case "ethereum":
      usdcAddress = process.env.USDC_ADDRESS_ETH!;
      break;
    case "base":
      usdcAddress = process.env.USDC_ADDRESS_BASE!;
      break;
    case "unichain":
      usdcAddress = process.env.USDC_ADDRESS_UNI!;
      break;
    case "optimism":
      usdcAddress = process.env.USDC_ADDRESS_OP!;
      break;
    case "celo":
      usdcAddress = process.env.USDC_ADDRESS_CELO!;
      break;
    default:
      // For local/test networks, we'll deploy a mock
      usdcAddress = "";
  }

  // COPm only exists on Celo.
  const copmAddress =
    networkName === "celo" ? process.env.COPM_ADDRESS_CELO || COPM_ADDRESS_CELO : "";

  return {
    network: networkName,
    swagAdmin: process.env.SWAG_ADMIN!,
    faucetAdmin: process.env.FAUCET_ADMIN!,
    zkPassportAdmin: process.env.ZK_PASSPORT_ADMIN!,
    swagTreasury: process.env.SWAG_TREASURY_ADDRESS!,
    usdcAddress,
    // Donation admin falls back to the faucet admin so an existing .env still works.
    donationAdmin: process.env.DONATION_ADMIN || process.env.FAUCET_ADMIN!,
    // DEFAULT_ADMIN_ROLE — can change the beneficiary and custody mode. Belongs
    // to the multisig, never an EOA or a smart account that may not exist on
    // every chain. Verified: the ethcali.eth Safe has code on all five networks.
    donationCustodyAdmin:
      process.env.DONATION_CUSTODY_ADMIN || process.env.DONATION_BENEFICIARY || '',
    // ADMIN_ROLE — day-to-day ops. These can create campaigns, set tiers and
    // withdraw, but ONLY ever to the beneficiary. Prefer plain EOAs: a smart
    // account cannot sign on a chain where it has no code.
    donationOpsAdmins: (process.env.DONATION_OPS_ADMINS || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    donationBeneficiary:
      process.env.DONATION_BENEFICIARY || process.env.SWAG_TREASURY_ADDRESS!,
    copmAddress,
  };
}

async function saveDeployment(result: DeploymentResult) {
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `${result.network}-${Date.now()}.json`;
  const filepath = path.join(deploymentsDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
  console.log(`\n📄 Deployment saved to: ${filepath}`);

  // Also save as latest
  const latestPath = path.join(deploymentsDir, `${result.network}-latest.json`);
  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("              ETHCALI CONTRACTS DEPLOYMENT");
  console.log("═══════════════════════════════════════════════════════════");

  // Connect to network and get viem client
  const connection = await network.connect();
  const viem = connection.viem;

  // Get chainId and map to network name
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const chainIdToNetwork: Record<number, string> = {
    1: "ethereum",
    8453: "base",
    130: "unichain",
    10: "optimism",
    42220: "celo",
    31337: "hardhat",
  };
  const networkName = chainIdToNetwork[chainId] || `chain-${chainId}`;

  // Get configuration
  const config = getConfig(networkName);
  console.log(`\n🌐 Network: ${config.network}`);
  console.log(`👤 Swag Admin: ${config.swagAdmin}`);
  console.log(`👤 Faucet Admin: ${config.faucetAdmin}`);
  console.log(`👤 ZK Passport Admin: ${config.zkPassportAdmin}`);
  console.log(`💰 Swag Treasury: ${config.swagTreasury}`);

  // Validate addresses
  if (!config.swagAdmin || !config.faucetAdmin || !config.zkPassportAdmin || !config.swagTreasury) {
    throw new Error("Missing required addresses in .env (SWAG_ADMIN, FAUCET_ADMIN, ZK_PASSPORT_ADMIN, SWAG_TREASURY_ADDRESS)");
  }

  // Get USDC address or deploy mock for testnets
  let usdcAddress = config.usdcAddress;
  if (!usdcAddress) {
    console.log("\n📦 Deploying Mock USDC (testnet only)...");
    const mockUSDC = await viem.deployContract("MockUSDC", []);
    usdcAddress = mockUSDC.address;
    config.usdcAddress = usdcAddress;
    console.log(`   Mock USDC deployed: ${usdcAddress}`);
  }
  console.log(`💵 USDC Address: ${usdcAddress}`);

  // Deploy ZKPassportNFT
  console.log("\n📦 Deploying ZKPassportNFT...");
  console.log(`   Owner will be: ${config.zkPassportAdmin}`);
  const zkPassportNFT = await viem.deployContract("ZKPassportNFT", [
    "ZKPassport Verification",
    "ZKPASS",
    config.zkPassportAdmin as `0x${string}`,
    process.env.ZKPASSPORT_DOMAIN  || "ethcali.com",
    process.env.ZKPASSPORT_SCOPE   || "ethcali-verification",
  ]);
  const zkPassportAddress = zkPassportNFT.address;
  console.log(`   ZKPassportNFT deployed: ${zkPassportAddress}`);
  console.log(`   ✅ Owner set to: ${config.zkPassportAdmin}`);

  // Set metadata if configured
  const [deployer] = await viem.getWalletClients();
  if (
    deployer.account.address.toLowerCase() === config.zkPassportAdmin.toLowerCase() &&
    process.env.NFT_IMAGE_URI &&
    process.env.NFT_DESCRIPTION
  ) {
    console.log(`   Setting NFT metadata...`);
    await send("set ZKPassport metadata", () => zkPassportNFT.write.setMetadata([
      process.env.NFT_IMAGE_URI,
      process.env.NFT_DESCRIPTION,
      process.env.NFT_EXTERNAL_URL || "",
      true,
    ]));
  }

  // Deploy FaucetManager
  console.log("\n📦 Deploying FaucetManager...");
  console.log(`   Admin will be: ${config.faucetAdmin}`);
  const faucetManager = await viem.deployContract("FaucetManager", [
    zkPassportAddress as `0x${string}`,
    config.faucetAdmin as `0x${string}`,
  ]);
  const faucetManagerAddress = faucetManager.address;
  console.log(`   FaucetManager deployed: ${faucetManagerAddress}`);
  console.log(`   ✅ Admin set to: ${config.faucetAdmin}`);


  // Deploy Swag1155 reference implementation (no constructor args — clones call initialize())
  console.log("\n📦 Deploying Swag1155 implementation (clone reference)...");
  const swag1155Impl = await viem.deployContract("Swag1155", []);
  const swag1155ImplAddress = swag1155Impl.address;
  console.log(`   Swag1155 implementation deployed: ${swag1155ImplAddress}`);

  // Deploy SwagFactory with implementation address
  console.log("\n📦 Deploying SwagFactory...");
  console.log(`   Factory admin will be: ${config.swagAdmin}`);

  const swagFactory = await viem.deployContract("SwagFactory", [
    config.swagAdmin as `0x${string}`,
    swag1155ImplAddress as `0x${string}`,
  ]);
  const swagFactoryAddress = swagFactory.address;
  console.log(`   SwagFactory deployed: ${swagFactoryAddress}`);
  console.log(`   ✅ Factory admin set to: ${config.swagAdmin}`);

  // Deploy HackathonStaking
  console.log("\n📦 Deploying HackathonStaking...");
  console.log(`   Admin will be: ${config.faucetAdmin}`);
  const hackathonStaking = await viem.deployContract("HackathonStaking", [
    zkPassportAddress as `0x${string}`,
    config.faucetAdmin as `0x${string}`,
  ]);
  const hackathonStakingAddress = hackathonStaking.address;
  console.log(`   HackathonStaking deployed: ${hackathonStakingAddress}`);

  // ── Donation contracts ──────────────────────────────────────────────────
  //
  // Custody model, deliberately two-tier:
  //
  //   DEFAULT_ADMIN_ROLE → the multisig. It alone can change the beneficiary or
  //                        switch router/holder mode, i.e. where money goes.
  //   ADMIN_ROLE         → operator accounts. They run campaigns and can call
  //                        withdraw, but withdraw has no destination parameter —
  //                        it always pays the beneficiary.
  //
  // Both contracts are deployed with the DEPLOYER as initial admin so this
  // script can configure them, then custody is handed to the multisig and the
  // deployer renounces DEFAULT_ADMIN_ROLE. It keeps ADMIN_ROLE for day-to-day ops.
  //
  // Why the deployer and not a smart account: a smart contract wallet only
  // exists on chains where it has been deployed. An admin with no code on Celo
  // cannot sign anything there. A plain EOA works on every chain.
  const deployerAddress = deployer.account.address as `0x${string}`;

  /**
   * Send a write and WAIT for it to be mined. Consecutive writes that do not
   * wait estimate gas against stale state and can race on nonce — exactly how
   * the first Celo deploy failed partway through role setup.
   */
  const send = async (label: string, fn: () => Promise<`0x${string}`>) => {
    process.stdout.write(`   ${label} … `);
    const hash = await fn();
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(rcpt.status === "success" ? "ok" : "FAILED");
    if (rcpt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  };

  console.log("\n📦 Deploying DonationReceipt1155...");
  const donationReceipt = await viem.deployContract("DonationReceipt1155", [
    process.env.DONATION_RECEIPT_NAME || "ETH Cali Relief Receipts",
    process.env.DONATION_RECEIPT_SYMBOL || "ETHCALI-RELIEF",
    process.env.DONATION_RECEIPT_BASE_URI || "",
    deployerAddress,
  ]);
  const donationReceiptAddress = donationReceipt.address;
  console.log(`   DonationReceipt1155 deployed: ${donationReceiptAddress}`);

  console.log("\n📦 Deploying DonationVault...");
  const donationVault = await viem.deployContract("DonationVault", [deployerAddress]);
  const donationVaultAddress = donationVault.address;
  console.log(`   DonationVault deployed: ${donationVaultAddress}`);

  // The vault must hold MINTER_ROLE or every qualifying donation silently
  // emits ReceiptFailed and the donor gets no NFT. Deployer is the receipt
  // admin at this point, so this always succeeds.
  await send("grant vault MINTER_ROLE", () =>
    donationReceipt.write.addMinter([donationVaultAddress as `0x${string}`])
  );

  // ── Grant ADMIN_ROLE to the operator accounts ───────────────────────────
  const opsAdmins = config.donationOpsAdmins.length
    ? config.donationOpsAdmins
    : [config.donationAdmin];

  for (const admin of opsAdmins) {
    if (admin.toLowerCase() === deployerAddress.toLowerCase()) continue;
    await send(`grant vault ADMIN_ROLE to ${admin}`, () =>
      donationVault.write.addAdmin([admin as `0x${string}`])
    );
    await send(`grant receipt ADMIN_ROLE to ${admin}`, () =>
      donationReceipt.write.addAdmin([admin as `0x${string}`])
    );
  }

  // ── Hand custody to the multisig, then step down ────────────────────────
  const custodyAdmin = config.donationCustodyAdmin;

  if (custodyAdmin && custodyAdmin.toLowerCase() !== deployerAddress.toLowerCase()) {
    // Refuse to hand custody to an address with no code on this chain — a smart
    // account that is not deployed here could never execute an admin call, and
    // the beneficiary could never be changed again.
    const custodyCode = await publicClient.getBytecode({
      address: custodyAdmin as `0x${string}`,
    });

    if (!custodyCode || custodyCode === "0x") {
      console.log(
        `\n   ⚠️  DONATION_CUSTODY_ADMIN ${custodyAdmin} has NO CODE on ${networkName}.\n` +
        `       Skipping the custody handoff — the deployer keeps DEFAULT_ADMIN_ROLE.\n` +
        `       If this is meant to be a multisig, deploy it on ${networkName} first,\n` +
        `       then grant DEFAULT_ADMIN_ROLE and renounce the deployer's.`
      );
    } else {
      const DEFAULT_ADMIN_ROLE = ("0x" + "00".repeat(32)) as `0x${string}`;

      await send("grant vault DEFAULT_ADMIN to multisig", () =>
        donationVault.write.grantRole([DEFAULT_ADMIN_ROLE, custodyAdmin as `0x${string}`])
      );
      await send("grant receipt DEFAULT_ADMIN to multisig", () =>
        donationReceipt.write.grantRole([DEFAULT_ADMIN_ROLE, custodyAdmin as `0x${string}`])
      );

      // Renounce ONLY after confirming the multisig holds both roles —
      // renouncing first would lock custody out permanently.
      const msHasVault = await donationVault.read.isSuperAdmin([custodyAdmin as `0x${string}`]);
      const msHasReceipt = await donationReceipt.read.hasRole([
        DEFAULT_ADMIN_ROLE,
        custodyAdmin as `0x${string}`,
      ]);

      if (msHasVault && msHasReceipt) {
        await send("deployer renounce vault DEFAULT_ADMIN", () =>
          donationVault.write.renounceRole([DEFAULT_ADMIN_ROLE, deployerAddress])
        );
        await send("deployer renounce receipt DEFAULT_ADMIN", () =>
          donationReceipt.write.renounceRole([DEFAULT_ADMIN_ROLE, deployerAddress])
        );
      } else {
        console.log("   ⚠️  multisig missing a role — NOT renouncing deployer custody");
      }
    }
  } else {
    console.log(
      `\n   ⚠️  DONATION_CUSTODY_ADMIN not set. The deployer keeps DEFAULT_ADMIN_ROLE,\n` +
      `       meaning a single key can change where donations go. Set it to the\n` +
      `       multisig before accepting real donations.`
    );
  }

  if (config.copmAddress) {
    console.log(`   💱 COPm available on this network: ${config.copmAddress}`);
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                    DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`\n📋 Contract Addresses:`);
  console.log(`   ZKPassportNFT:          ${zkPassportAddress}`);
  console.log(`   FaucetManager:          ${faucetManagerAddress}`);
  console.log(`   Swag1155 (impl):        ${swag1155ImplAddress}`);
  console.log(`   SwagFactory:            ${swagFactoryAddress}`);
  console.log(`   HackathonStaking:       ${hackathonStakingAddress}`);
  console.log(`   DonationVault:          ${donationVaultAddress}`);
  console.log(`   DonationReceipt1155:    ${donationReceiptAddress}`);

  console.log(`\n🔐 Security Configuration:`);
  console.log(`   ZKPassportNFT Owner:    ${config.zkPassportAdmin}`);
  console.log(`   FaucetManager Admin:    ${config.faucetAdmin}`);
  console.log(`   SwagFactory Admin:      ${config.swagAdmin}`);
  console.log(`   HackathonStaking Admin: ${config.faucetAdmin}`);
  console.log(`   Donation Admin:         ${config.donationAdmin}`);
  console.log(`   Donation Beneficiary:   ${config.donationBeneficiary}`);

  console.log(`\n📌 Next steps for the donation campaign:`);
  console.log(`   1. DonationReceipt1155.setTier(...) for each receipt tier`);
  console.log(`   2. DonationVault.createCampaign("...", "...", beneficiary, ${donationReceiptAddress})`);
  console.log(`   3. DonationVault.setAcceptedToken(campaignId, token, true) per currency`);
  console.log(`   4. DonationVault.setTiers(campaignId, token, [...]) per currency`);

  // Save deployment
  const result: DeploymentResult = {
    zkPassportNFT: zkPassportAddress,
    faucetManager: faucetManagerAddress,
    swag1155Implementation: swag1155ImplAddress,
    swagFactory: swagFactoryAddress,
    hackathonStaking: hackathonStakingAddress,
    donationVault: donationVaultAddress,
    donationReceipt: donationReceiptAddress,
    network: config.network,
    timestamp: new Date().toISOString(),
    config,
  };

  await saveDeployment(result);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                 POST-DEPLOYMENT ACTIONS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`
📝 After deployment, admins can:

ZKPassportNFT (Owner: ${config.zkPassportAdmin}):
  - setMetadata(imageURI, description, externalURL, useIPFS)
  - transferOwnership(newOwner)

FaucetManager (Admin: ${config.faucetAdmin}):
  - addAdmin(address)      - Add new admin
  - removeAdmin(address)   - Remove admin
  - createVault(...)       - Create new faucet
  - setNFTContract(addr)   - Change ZKPassport contract

SwagFactory (${swagFactoryAddress}):
  - deployCollection(name, sku, paymentToken, treasury, itemAdmin, sizes[])
      Deploys a new Swag1155 per product, configures all sizes, grants
      itemAdmin full control, and registers it in the factory registry.
  - setCollectionActive(collection, bool) - Show/hide product in storefront
  - addAdmin(address) / removeAdmin(address)

  To create a product:
    ITEM_NAME="ETH Cali Hoodie" ITEM_SKU="ETH-CALI-HOODIE-2025" \\
    ITEM_ADMIN=0x... ITEM_SIZES_JSON='[...]' \\
    npx hardhat run scripts/deploy-collection.ts --network <network>
`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
