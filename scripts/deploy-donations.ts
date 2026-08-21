import { network } from "hardhat";
import { formatEther } from "viem";
import {
  SINGLETON_FACTORY,
  donationPlan,
  donationSalt,
  factoryCalldata,
  predictAddress,
} from "./deterministic.mjs";
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

/**
 * Reference token addresses recorded alongside a deployment, per chain.
 *
 * Metadata only — the vault learns which tokens it accepts from
 * seed-campaign.ts, never from this record. It was hardcoded to the Celo
 * env vars, which silently stamped Celo's USDC onto every other chain.
 */
function tokensForChain(chainId: number): Record<string, string> {
  switch (chainId) {
    case 42220:
      return {
        usdc: process.env.USDC_ADDRESS_CELO || "",
        copm: process.env.COPM_ADDRESS_CELO || "",
      };
    case 8453:
      return { usdc: process.env.USDC_ADDRESS_BASE || "" };
    case 10:
      return { usdc: process.env.USDC_ADDRESS_OP || "" };
    case 1:
      return { usdc: process.env.USDC_ADDRESS_ETH || "" };
    default:
      return {};
  }
}

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
  // CREATE2 by default, so the vault and receipt carry the SAME address on
  // every chain. DETERMINISTIC=0 falls back to plain CREATE (nonce-derived,
  // therefore different everywhere).
  const deterministic = process.env.DETERMINISTIC !== "0";

  const salt = donationSalt();
  const plan = Object.fromEntries(donationPlan(deployerAddress));

  /**
   * Poll a boolean read until it turns true.
   *
   * A single read is not evidence of absence: public RPCs load-balance and a
   * read issued right after a write can hit a replica behind the tip. This
   * matters most just before renouncing DEFAULT_ADMIN — a false negative there
   * aborts the handoff and leaves two keys holding custody.
   */
  const pollTrue = async (read: () => Promise<boolean>, tries = 10, delayMs = 2000) => {
    for (let i = 0; i < tries; i++) {
      if (await read()) return true;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  };

  /** Poll for code at `address`, tolerating replicas that lag the tip. */
  const waitForCode = async (address: `0x${string}`, tries = 12, delayMs = 2000) => {
    for (let i = 0; i < tries; i++) {
      const code = await publicClient.getBytecode({ address });
      if (code && code !== "0x") return true;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  };

  /**
   * Deploy through the singleton factory and return a bound contract.
   *
   * Idempotent by construction: if the predicted address already has code, the
   * contract is already there and we attach to it. Re-running after a partial
   * deploy costs nothing.
   */
  const deployVia2 = async (contract: string, args: readonly unknown[]) => {
    const predicted = predictAddress(contract, args, salt) as `0x${string}`;
    const already = await publicClient.getBytecode({ address: predicted });

    if (already && already !== "0x") {
      console.log(`   ↩︎  ${contract} already at ${predicted} — reusing`);
      return viem.getContractAt(contract as never, predicted);
    }

    const hash = await deployer.sendTransaction({
      to: SINGLETON_FACTORY as `0x${string}`,
      data: factoryCalldata(contract, args, salt) as `0x${string}`,
    });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${contract} CREATE2 reverted (${hash})`);

    // Never trust the factory's word for it: attaching to an empty address
    // would fail much later, mid-role-setup.
    //
    // But do not trust a SINGLE read either. Public RPCs load-balance, and a
    // getCode issued immediately after a write can land on a replica still
    // behind the tip — it reported "no code" for a vault that was in fact
    // deployed, and killed the launch on a chain that had actually succeeded.
    // Same race as the campaignCount bug; poll instead of judging on one read.
    if (!(await waitForCode(predicted))) {
      throw new Error(
        `${contract}: factory mined ${hash} but ${predicted} still has no code after retries`
      );
    }
    console.log(`   ✅ ${predicted}`);
    return viem.getContractAt(contract as never, predicted);
  };

  if (deterministic) {
    const factoryCode = await publicClient.getBytecode({ address: SINGLETON_FACTORY as `0x${string}` });
    if (!factoryCode || factoryCode === "0x") {
      throw new Error(
        `Safe Singleton Factory is not deployed on ${networkName}. ` +
          `Re-run with DETERMINISTIC=0 to accept a chain-specific address.`
      );
    }
    console.log(`\n🧬 Deterministic deploy — salt ${salt}`);
  }

  console.log("\n📦 Deploying DonationReceipt1155...");
  const donationReceipt = deterministic
    ? await deployVia2("DonationReceipt1155", plan.DonationReceipt1155)
    : await viem.deployContract("DonationReceipt1155", [
        process.env.DONATION_RECEIPT_NAME || "ETH Cali Relief Receipts",
        process.env.DONATION_RECEIPT_SYMBOL || "ETHCALI-RELIEF",
        process.env.DONATION_RECEIPT_BASE_URI || "",
        deployerAddress,
      ]);
  if (!deterministic) console.log(`   ✅ ${donationReceipt.address}`);

  console.log("\n📦 Deploying DonationVault...");
  const donationVault = deterministic
    ? await deployVia2("DonationVault", plan.DonationVault)
    : await viem.deployContract("DonationVault", [deployerAddress]);
  if (!deterministic) console.log(`   ✅ ${donationVault.address}`);

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

  // A deterministic deploy always constructs the receipt with an EMPTY baseURI
  // so the address never depends on metadata that is not pinned yet — set it
  // here instead. Storage, not address: safe to change later, and safe to
  // differ between chains while the pinning catches up.
  const configuredBaseURI = process.env.DONATION_RECEIPT_BASE_URI || "";
  const baseURIIsReal = configuredBaseURI && !configuredBaseURI.includes("YourBaseCid");
  if (deterministic && baseURIIsReal) {
    await send(`set receipt baseURI`, () => donationReceipt.write.setBaseURI([configuredBaseURI]));
  } else if (deterministic && configuredBaseURI) {
    console.log(
      `   ⚠️  DONATION_RECEIPT_BASE_URI is still the placeholder — receipt metadata\n` +
        `       is unset. Pin the JSON, then call setBaseURI(). No redeploy needed.`
    );
  }

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
      const hasVault = await pollTrue(() =>
        donationVault.read.isSuperAdmin([custodyAdmin as `0x${string}`])
      );
      const hasReceipt = await pollTrue(() =>
        donationReceipt.read.hasRole([DEFAULT_ADMIN_ROLE, custodyAdmin as `0x${string}`])
      );

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
      ...tokensForChain(chainId),
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
