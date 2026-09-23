import { network } from "hardhat";
import { formatEther } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Move DEFAULT_ADMIN_ROLE on the swag contracts to the custody Safe.
 *
 * The workspace rule: the role that can change where funds go or who holds
 * power belongs to the Safe; day-to-day operations stay on an operator key.
 * The seed left both roles on the operator. This script, run once per chain
 * with the operator's key:
 *
 *   for the collection(s) and the factory:
 *     1. grantRole(DEFAULT_ADMIN_ROLE, SAFE)   — and read it back
 *     2. revokeRole(DEFAULT_ADMIN_ROLE, ops)   — only after (1) is confirmed
 *     3. assert ops still holds ADMIN_ROLE     — stock, prices, pause, cancel
 *
 *   DRY_RUN=1 npx hardhat run scripts/transfer-swag-custody.ts --network base
 *   npx hardhat run scripts/transfer-swag-custody.ts --network base
 *
 * Env: SWAG_CUSTODY_SAFE (defaults to DONATION_CUSTODY_ADMIN, the ethcali.eth Safe).
 * After this, adding/removing admins or signers and setTreasury need a Safe tx.
 */

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  10: "optimism",
  42220: "celo",
  31337: "hardhat",
};

const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}` as `0x${string}`;

async function readBack(read: () => Promise<boolean>, want: boolean, what: string) {
  for (let i = 0; i < 20; i++) {
    if ((await read()) === want) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${what}: read-back still differs after 30s`);
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const safe = (process.env.SWAG_CUSTODY_SAFE || process.env.DONATION_CUSTODY_ADMIN || "") as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(safe)) throw new Error("SWAG_CUSTODY_SAFE (or DONATION_CUSTODY_ADMIN) must be an address");

  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [signer] = await viem.getWalletClients();
  const ops = signer.account.address as `0x${string}`;
  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/${networkName}-latest.json`), "utf8")
  ) as { swagFactory?: `0x${string}`; swagCollections?: Record<string, `0x${string}`> };

  const targets: { label: string; address: `0x${string}`; name: "Swag1155" | "SwagFactory" }[] = [];
  for (const [sku, address] of Object.entries(deployment.swagCollections ?? {})) {
    targets.push({ label: `collection ${sku}`, address, name: "Swag1155" });
  }
  if (deployment.swagFactory) targets.push({ label: "SwagFactory", address: deployment.swagFactory, name: "SwagFactory" });
  if (targets.length === 0) throw new Error(`No swag contracts recorded for ${networkName}`);

  // The Safe must be a contract on this chain, or we would hand the role to
  // an address nobody controls here.
  const safeCode = await publicClient.getBytecode({ address: safe });
  if (!safeCode || safeCode === "0x") throw new Error(`${safe} has no code on ${networkName}; refusing`);

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`      SWAG CUSTODY → SAFE — ${networkName}${dryRun ? " (DRY RUN)" : ""}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ops  : ${ops}`);
  console.log(`  safe : ${safe}`);

  const start = await publicClient.getBalance({ address: ops });

  for (const t of targets) {
    const c = await viem.getContractAt(t.name, t.address);
    const adminRole = (await c.read.ADMIN_ROLE()) as `0x${string}`;
    const has = async (role: `0x${string}`, who: `0x${string}`) => (await c.read.hasRole([role, who])) as boolean;

    const opsDefault = await has(DEFAULT_ADMIN_ROLE, ops);
    const safeDefault = await has(DEFAULT_ADMIN_ROLE, safe);
    const opsAdmin = await has(adminRole, ops);
    console.log(`\n📦 ${t.label} @ ${t.address}`);
    console.log(`   before: ops DEFAULT_ADMIN=${opsDefault} ADMIN=${opsAdmin} | safe DEFAULT_ADMIN=${safeDefault}`);

    if (!opsAdmin) throw new Error(`${t.label}: ops does not hold ADMIN_ROLE; it would lose all control. Fix first.`);
    if (!opsDefault && !safeDefault) throw new Error(`${t.label}: neither ops nor safe holds DEFAULT_ADMIN_ROLE`);

    if (!safeDefault) {
      console.log(`   grantRole(DEFAULT_ADMIN_ROLE, safe)`);
      if (!dryRun) {
        const hash = await c.write.grantRole([DEFAULT_ADMIN_ROLE, safe]);
        const rcpt = await publicClient.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`grantRole reverted (${hash})`);
        await readBack(() => has(DEFAULT_ADMIN_ROLE, safe), true, `${t.label} safe DEFAULT_ADMIN`);
        console.log(`   ✅ safe holds DEFAULT_ADMIN_ROLE (${hash})`);
      }
    }

    if (opsDefault) {
      console.log(`   revokeRole(DEFAULT_ADMIN_ROLE, ops)`);
      if (!dryRun) {
        if (!(await has(DEFAULT_ADMIN_ROLE, safe))) throw new Error(`${t.label}: safe grant not visible; not revoking`);
        const hash = await c.write.revokeRole([DEFAULT_ADMIN_ROLE, ops]);
        const rcpt = await publicClient.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`revokeRole reverted (${hash})`);
        await readBack(() => has(DEFAULT_ADMIN_ROLE, ops), false, `${t.label} ops DEFAULT_ADMIN`);
        console.log(`   ✅ ops no longer holds DEFAULT_ADMIN_ROLE (${hash})`);
      }
    }

    if (!dryRun) {
      const after = {
        opsDefault: await has(DEFAULT_ADMIN_ROLE, ops),
        safeDefault: await has(DEFAULT_ADMIN_ROLE, safe),
        opsAdmin: await has(adminRole, ops),
      };
      console.log(`   after : ops DEFAULT_ADMIN=${after.opsDefault} ADMIN=${after.opsAdmin} | safe DEFAULT_ADMIN=${after.safeDefault}`);
      if (after.opsDefault || !after.safeDefault || !after.opsAdmin) throw new Error(`${t.label}: final state is wrong`);
    }
  }

  const spent = start - (await publicClient.getBalance({ address: ops }));
  console.log(`\n${dryRun ? "dry run — nothing sent" : `done. gas: ${formatEther(spent)}`}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
