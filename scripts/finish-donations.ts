import { network } from "hardhat";
import { formatEther } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { CHAIN_ID_TO_NETWORK, tokensForChain } from "./tokens.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Complete (or repair) a donation deployment.
 *
 * Fully IDEMPOTENT: every step reads on-chain state first and skips what is
 * already done, so this is safe to re-run after a partial failure.
 *
 * It also waits for each transaction receipt before sending the next one. The
 * original deploy failed precisely because it did not — consecutive `write`
 * calls estimated gas against stale state and one hit a nonce race.
 *
 * Usage:
 *   DONATION_VAULT=0x… DONATION_RECEIPT=0x… \
 *     npx hardhat run scripts/finish-donations.ts --network celo
 */

const DEFAULT_ADMIN_ROLE = ("0x" + "00".repeat(32)) as `0x${string}`;

async function main() {
  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address as `0x${string}`;

  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;

  const vaultAddress = process.env.DONATION_VAULT as `0x${string}`;
  const receiptAddress = process.env.DONATION_RECEIPT as `0x${string}`;

  if (!vaultAddress || !receiptAddress) {
    throw new Error("Set DONATION_VAULT and DONATION_RECEIPT env vars");
  }

  const custodyAdmin = (process.env.DONATION_CUSTODY_ADMIN || "") as `0x${string}`;
  const beneficiary =
    process.env.DONATION_BENEFICIARY || process.env.SWAG_TREASURY_ADDRESS || "";
  const opsAdmins = (process.env.DONATION_OPS_ADMINS || process.env.DONATION_ADMIN || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const vault = await viem.getContractAt("DonationVault", vaultAddress);
  const receipt = await viem.getContractAt("DonationReceipt1155", receiptAddress);

  const startBalance = await publicClient.getBalance({ address: deployerAddress });

  console.log("═══════════════════════════════════════════════════════════");
  console.log("        FINISHING DONATION DEPLOYMENT — " + networkName);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  vault    : ${vaultAddress}`);
  console.log(`  receipt  : ${receiptAddress}`);
  console.log(`  deployer : ${deployerAddress}`);
  console.log(`  balance  : ${formatEther(startBalance)}\n`);

  /** Send a write and WAIT for it to be mined before returning. */
  const send = async (label: string, fn: () => Promise<`0x${string}`>) => {
    process.stdout.write(`  ${label} … `);
    const hash = await fn();
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(rcpt.status === "success" ? `ok (${hash.slice(0, 10)}…)` : `FAILED (${hash})`);
    if (rcpt.status !== "success") throw new Error(`${label} reverted`);
  };

  const MINTER_ROLE = (await receipt.read.MINTER_ROLE()) as `0x${string}`;
  const RECEIPT_ADMIN_ROLE = (await receipt.read.ADMIN_ROLE()) as `0x${string}`;

  // ── 1. Vault must be able to mint receipts ────────────────────────────────
  if (await receipt.read.hasRole([MINTER_ROLE, vaultAddress])) {
    console.log("  MINTER_ROLE for vault … already set, skipping");
  } else {
    await send("grant MINTER_ROLE to vault", () => receipt.write.addMinter([vaultAddress]));
  }

  // ── 2. Operator admins on both contracts ──────────────────────────────────
  for (const admin of opsAdmins) {
    const a = admin as `0x${string}`;
    if (a.toLowerCase() === deployerAddress.toLowerCase()) continue;

    if (await vault.read.isAdmin([a])) {
      console.log(`  vault ADMIN_ROLE ${a} … already set, skipping`);
    } else {
      await send(`grant vault ADMIN_ROLE to ${a}`, () => vault.write.addAdmin([a]));
    }

    if (await receipt.read.hasRole([RECEIPT_ADMIN_ROLE, a])) {
      console.log(`  receipt ADMIN_ROLE ${a} … already set, skipping`);
    } else {
      await send(`grant receipt ADMIN_ROLE to ${a}`, () => receipt.write.addAdmin([a]));
    }
  }

  // ── 3. Hand custody to the multisig, then step down ──────────────────────
  let custodyTransferred = false;

  if (custodyAdmin && custodyAdmin.toLowerCase() !== deployerAddress.toLowerCase()) {
    const code = await publicClient.getBytecode({ address: custodyAdmin });

    if (!code || code === "0x") {
      console.log(
        `\n  ⚠️  custody admin ${custodyAdmin} has NO CODE on ${networkName} — skipping handoff`
      );
    } else {
      if (await vault.read.isSuperAdmin([custodyAdmin])) {
        console.log("  vault DEFAULT_ADMIN for multisig … already set, skipping");
      } else {
        await send("grant vault DEFAULT_ADMIN to multisig", () =>
          vault.write.grantRole([DEFAULT_ADMIN_ROLE, custodyAdmin])
        );
      }

      if (await receipt.read.hasRole([DEFAULT_ADMIN_ROLE, custodyAdmin])) {
        console.log("  receipt DEFAULT_ADMIN for multisig … already set, skipping");
      } else {
        await send("grant receipt DEFAULT_ADMIN to multisig", () =>
          receipt.write.grantRole([DEFAULT_ADMIN_ROLE, custodyAdmin])
        );
      }

      // Only renounce AFTER confirming the multisig actually holds the role —
      // renouncing first would lock the contracts out of custody permanently.
      // Poll: a read right after the grant can hit a replica behind the tip,
      // and a false negative here aborts the handoff.
      const pollTrue = async (read: () => Promise<boolean>, tries = 10, delayMs = 2000) => {
        for (let i = 0; i < tries; i++) {
          if (await read()) return true;
          if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
        }
        return false;
      };
      const multisigHasVault = await pollTrue(() => vault.read.isSuperAdmin([custodyAdmin]));
      const multisigHasReceipt = await pollTrue(() =>
        receipt.read.hasRole([DEFAULT_ADMIN_ROLE, custodyAdmin])
      );

      if (multisigHasVault && multisigHasReceipt) {
        if (await vault.read.isSuperAdmin([deployerAddress])) {
          await send("deployer renounce vault DEFAULT_ADMIN", () =>
            vault.write.renounceRole([DEFAULT_ADMIN_ROLE, deployerAddress])
          );
        }
        if (await receipt.read.hasRole([DEFAULT_ADMIN_ROLE, deployerAddress])) {
          await send("deployer renounce receipt DEFAULT_ADMIN", () =>
            receipt.write.renounceRole([DEFAULT_ADMIN_ROLE, deployerAddress])
          );
        }
        custodyTransferred = true;
      } else {
        console.log("  ⚠️  multisig does not hold both roles — NOT renouncing deployer custody");
      }
    }
  }

  // ── 4. Verify the end state ───────────────────────────────────────────────
  console.log("\n🔍 Final on-chain state:");
  console.log(`  vault   isSuperAdmin(deployer) : ${await vault.read.isSuperAdmin([deployerAddress])}`);
  console.log(`  vault   isSuperAdmin(multisig) : ${custodyAdmin ? await vault.read.isSuperAdmin([custodyAdmin]) : "n/a"}`);
  console.log(`  receipt DEFAULT_ADMIN(deployer): ${await receipt.read.hasRole([DEFAULT_ADMIN_ROLE, deployerAddress])}`);
  console.log(`  receipt DEFAULT_ADMIN(multisig): ${custodyAdmin ? await receipt.read.hasRole([DEFAULT_ADMIN_ROLE, custodyAdmin]) : "n/a"}`);
  console.log(`  receipt MINTER(vault)          : ${await receipt.read.hasRole([MINTER_ROLE, vaultAddress])}`);
  for (const admin of opsAdmins) {
    const a = admin as `0x${string}`;
    console.log(`  vault   isAdmin(${a}) : ${await vault.read.isAdmin([a])}`);
    console.log(`  receipt ADMIN_ROLE(${a}) : ${await receipt.read.hasRole([RECEIPT_ADMIN_ROLE, a])}`);
  }

  // ── 5. Persist ────────────────────────────────────────────────────────────
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const latestPath = path.join(deploymentsDir, `${networkName}-latest.json`);
  const existing = fs.existsSync(latestPath)
    ? JSON.parse(fs.readFileSync(latestPath, "utf8"))
    : {};

  const result = {
    ...existing,
    donationVault: vaultAddress,
    donationReceipt: receiptAddress,
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

  const spent = startBalance - (await publicClient.getBalance({ address: deployerAddress }));
  console.log(`\n💸 Gas spent this run: ${formatEther(spent)}`);
  console.log(`📄 Saved: ${latestPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
