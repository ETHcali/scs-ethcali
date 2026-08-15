import { network } from "hardhat";
import { formatEther } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deploy ONLY the donation contracts: DonationReceipt1155 + DonationVault.
 *
 * Why separate from deploy-all.ts: the full suite is seven contracts (~22.7M gas)
 * and DonationVault depends on none of them — unlike HackathonStaking it takes
 * no ZKPassport address. For an urgent relief launch you should not have to fund
 * and deploy the faucet, swag and identity stack first.
 *
 * Custody model (same as deploy-all.ts):
 *   DEFAULT_ADMIN_ROLE → the multisig. Only role that can change the beneficiary.
 *   ADMIN_ROLE         → operator EOAs. Can run campaigns and withdraw, but
 *                        withdraw has no destination — it always pays the beneficiary.
 *
 * The deployer holds DEFAULT_ADMIN_ROLE only long enough to wire things up, then
 * renounces it, so no single key can redirect donations afterwards.
 *
 * Results are MERGED into <network>-latest.json so a later full deploy, or a
 * previous one, is preserved.
 */

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  10: "optimism",
  42220: "celo",
  31337: "hardhat",
};

const DEFAULT_ADMIN_ROLE = ("0x" + "00".repeat(32)) as `0x${string}`;

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("           ETHCALI DONATION CONTRACTS DEPLOYMENT");
  console.log("═══════════════════════════════════════════════════════════");

  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address as `0x${string}`;

  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;

  const custodyAdmin = process.env.DONATION_CUSTODY_ADMIN || "";
  const beneficiary =
    process.env.DONATION_BENEFICIARY || process.env.SWAG_TREASURY_ADDRESS || "";
  const opsAdmins = (process.env.DONATION_OPS_ADMINS || process.env.DONATION_ADMIN || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const balance = await publicClient.getBalance({ address: deployerAddress });

  console.log(`\n🌐 Network:      ${networkName} (${chainId})`);
  console.log(`👤 Deployer:     ${deployerAddress}`);
  console.log(`💰 Balance:      ${formatEther(balance)}`);
  console.log(`🔐 Custody:      ${custodyAdmin || "(unset — deployer keeps it)"}`);
  console.log(`🏦 Beneficiary:  ${beneficiary || "(unset)"}`);
  console.log(`👥 Ops admins:   ${opsAdmins.join(", ") || "(none)"}`);

  if (!beneficiary) {
    throw new Error(
      "DONATION_BENEFICIARY is not set. Refusing to deploy — campaigns would have nowhere to send funds."
    );
  }

  // ── Deploy ────────────────────────────────────────────────────────────────
  console.log("\n📦 Deploying DonationReceipt1155...");
  const donationReceipt = await viem.deployContract("DonationReceipt1155", [
    process.env.DONATION_RECEIPT_NAME || "ETH Cali Relief Receipts",
    process.env.DONATION_RECEIPT_SYMBOL || "ETHCALI-RELIEF",
    process.env.DONATION_RECEIPT_BASE_URI || "",
    deployerAddress,
  ]);
  console.log(`   ✅ ${donationReceipt.address}`);

  console.log("\n📦 Deploying DonationVault...");
  const donationVault = await viem.deployContract("DonationVault", [deployerAddress]);
  console.log(`   ✅ ${donationVault.address}`);

  /**
   * Send a write and WAIT for the receipt before returning.
   *
   * Consecutive `write` calls that do not wait will estimate gas against stale
   * state and can race on nonce — that is exactly how the first Celo deploy
   * failed partway through role setup.
   */
  const send = async (label: string, fn: () => Promise<`0x${string}`>) => {
    process.stdout.write(`   ${label} … `);
    const hash = await fn();
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(rcpt.status === "success" ? "ok" : "FAILED");
    if (rcpt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  };

  // ── Wire up ───────────────────────────────────────────────────────────────
  // Without MINTER_ROLE every qualifying donation still settles but silently
  // emits ReceiptFailed and the donor receives no NFT.
  console.log("\n🔗 Wiring roles...");
  await send("grant vault MINTER_ROLE", () => donationReceipt.write.addMinter([donationVault.address]));

  for (const admin of opsAdmins) {
    if (admin.toLowerCase() === deployerAddress.toLowerCase()) continue;
    await send(`grant vault ADMIN_ROLE to ${admin}`, () =>
      donationVault.write.addAdmin([admin as `0x${string}`])
    );
    await send(`grant receipt ADMIN_ROLE to ${admin}`, () =>
      donationReceipt.write.addAdmin([admin as `0x${string}`])
    );
  }

  // ── Hand custody to the multisig ─────────────────────────────────────────
  let custodyTransferred = false;

  if (custodyAdmin && custodyAdmin.toLowerCase() !== deployerAddress.toLowerCase()) {
    const code = await publicClient.getBytecode({ address: custodyAdmin as `0x${string}` });

    if (!code || code === "0x") {
      console.log(
        `\n   ⚠️  DONATION_CUSTODY_ADMIN ${custodyAdmin} has NO CODE on ${networkName}.\n` +
          `       Skipping handoff — a smart account that is not deployed here could\n` +
          `       never sign, and the beneficiary would be frozen permanently.\n` +
          `       The deployer keeps DEFAULT_ADMIN_ROLE for now.`
      );
    } else {
      await send("grant vault DEFAULT_ADMIN to multisig", () =>
        donationVault.write.grantRole([DEFAULT_ADMIN_ROLE, custodyAdmin as `0x${string}`])
      );
      await send("grant receipt DEFAULT_ADMIN to multisig", () =>
        donationReceipt.write.grantRole([DEFAULT_ADMIN_ROLE, custodyAdmin as `0x${string}`])
      );

      // Renounce ONLY after confirming the multisig actually holds both roles.
      // Renouncing first would lock custody out permanently.
      const hasVault = await donationVault.read.isSuperAdmin([custodyAdmin as `0x${string}`]);
      const hasReceipt = await donationReceipt.read.hasRole([
        DEFAULT_ADMIN_ROLE,
        custodyAdmin as `0x${string}`,
      ]);

      if (hasVault && hasReceipt) {
        await send("deployer renounce vault DEFAULT_ADMIN", () =>
          donationVault.write.renounceRole([DEFAULT_ADMIN_ROLE, deployerAddress])
        );
        await send("deployer renounce receipt DEFAULT_ADMIN", () =>
          donationReceipt.write.renounceRole([DEFAULT_ADMIN_ROLE, deployerAddress])
        );
        custodyTransferred = true;
      } else {
        console.log("   ⚠️  multisig missing a role — NOT renouncing deployer custody");
      }
    }
  } else {
    console.log(
      `\n   ⚠️  DONATION_CUSTODY_ADMIN not set. The deployer keeps DEFAULT_ADMIN_ROLE,\n` +
        `       so a single key can change where donations go.`
    );
  }

  // ── Verify the end state on-chain rather than assuming ───────────────────
  console.log("\n🔍 Verifying final roles on-chain...");
  const deployerStillSuper = await donationVault.read.isSuperAdmin([deployerAddress]);
  const custodyIsSuper = custodyAdmin
    ? await donationVault.read.isSuperAdmin([custodyAdmin as `0x${string}`])
    : false;
  console.log(`   deployer isSuperAdmin : ${deployerStillSuper}`);
  console.log(`   multisig isSuperAdmin : ${custodyIsSuper}`);
  for (const admin of opsAdmins) {
    const ok = await donationVault.read.isAdmin([admin as `0x${string}`]);
    console.log(`   ${admin} isAdmin : ${ok}`);
  }

  // ── Persist, merging with any existing deployment ────────────────────────
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const latestPath = path.join(deploymentsDir, `${networkName}-latest.json`);
  const existing = fs.existsSync(latestPath)
    ? JSON.parse(fs.readFileSync(latestPath, "utf8"))
    : {};

  const result = {
    ...existing,
    donationVault: donationVault.address,
    donationReceipt: donationReceipt.address,
    network: networkName,
    timestamp: new Date().toISOString(),
    donationConfig: {
      deployer: deployerAddress,
      custodyAdmin,
      beneficiary,
      opsAdmins,
      custodyTransferred,
      usdc: process.env.USDC_ADDRESS_CELO || "",
      copm: process.env.COPM_ADDRESS_CELO || "",
    },
  };

  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(deploymentsDir, `${networkName}-donations-${Date.now()}.json`),
    JSON.stringify(result, null, 2)
  );

  const spent = balance - (await publicClient.getBalance({ address: deployerAddress }));

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                  DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`   DonationVault:       ${donationVault.address}`);
  console.log(`   DonationReceipt1155: ${donationReceipt.address}`);
  console.log(`   Gas spent:           ${formatEther(spent)}`);
  console.log(`   Saved to:            ${latestPath}`);
  console.log(`\n📌 Next:`);
  console.log(`   1. npx hardhat verify --network ${networkName} ${donationVault.address} "${deployerAddress}"`);
  console.log(`   2. Configure receipt tiers, then create the campaign`);
  console.log(`   3. Copy ABIs to ../wallet_ethcali/frontend/abis/ and run setup:frontend`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
