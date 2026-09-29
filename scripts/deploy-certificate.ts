import { network } from "hardhat";
import { encodeDeployData, formatEther, getAddress } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deploy ONLY BuilderCertificate — ETH Cali's soulbound builder certificate.
 * One contract serves every hackathon; nothing else is touched.
 *
 * The deployer receives no role. The constructor hands DEFAULT_ADMIN_ROLE and
 * ADMIN_ROLE to CERT_SUPER_ADMIN and ADMIN_ROLE to each CERT_ADMINS address,
 * so there is nothing to renounce afterwards.
 *
 * Usage:
 *   CERT_ESTIMATE=1 npm run deploy:certificate:ethereum   # MANDATORY first: gas vs balance
 *   npm run deploy:certificate:ethereum
 *
 * Env: PRIVATE_KEY (deployer), CERT_SUPER_ADMIN (address), CERT_ADMINS
 * (comma-separated addresses, may be empty).
 *
 * The address is MERGED into deployments/<network>-latest.json under
 * `builderCertificate`, with a timestamped copy beside it.
 */

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  31337: "hardhat",
};

const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

async function main() {
  const estimateOnly = process.env.CERT_ESTIMATE === "1";
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`        ETHCALI BUILDER CERTIFICATE ${estimateOnly ? "— ESTIMATE ONLY" : "DEPLOYMENT"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address as `0x${string}`;
  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;

  const superAdminRaw = (process.env.CERT_SUPER_ADMIN || "").trim();
  if (!isAddress(superAdminRaw)) throw new Error("CERT_SUPER_ADMIN is not an address. Refusing to deploy a contract nobody can administer.");
  const superAdmin = getAddress(superAdminRaw);
  const admins = (process.env.CERT_ADMINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => {
      if (!isAddress(a)) throw new Error(`CERT_ADMINS contains a non-address: ${a}`);
      return getAddress(a);
    });

  const balance = await publicClient.getBalance({ address: deployerAddress });
  console.log(`\n🌐 Network:      ${networkName} (${chainId})`);
  console.log(`👤 Deployer:     ${deployerAddress}  (gets no role)`);
  console.log(`💰 Balance:      ${formatEther(balance)} ETH`);
  console.log(`🛡  Super admin:  ${superAdmin}  (DEFAULT_ADMIN_ROLE + ADMIN_ROLE)`);
  for (const a of admins) console.log(`🛠  Admin:        ${a}  (ADMIN_ROLE)`);

  // ── Cost vs balance, before anything is sent ─────────────────────────────
  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../artifacts/contracts/BuilderCertificate.sol/BuilderCertificate.json"), "utf8")
  );
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode as `0x${string}`, args: [superAdmin, admins] });
  const gas = await publicClient.estimateGas({ account: deployerAddress, data });
  const fees = await publicClient.estimateFeesPerGas();
  const maxFee = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
  const cost = gas * maxFee;
  console.log(`\n⛽ Gas:          ${gas}`);
  console.log(`   Max fee:      ${Number(maxFee) / 1e9} gwei`);
  console.log(`   Worst case:   ${formatEther(cost)} ETH`);
  if (cost > balance) {
    throw new Error(`Balance ${formatEther(balance)} ETH is below the worst-case cost ${formatEther(cost)} ETH. Top up the deployer first.`);
  }
  console.log(`   Headroom:     ${formatEther(balance - cost)} ETH`);
  if (estimateOnly) {
    console.log("\n✅ Estimate only — nothing was sent.");
    return;
  }

  console.log("\n📦 Deploying BuilderCertificate...");
  const cert = await viem.deployContract("BuilderCertificate", [superAdmin, admins]);
  console.log(`   ✅ ${cert.address}`);

  // Public RPCs load-balance across replicas; wait until the code is visible.
  for (let i = 0; i < 20; i++) {
    const code = await publicClient.getBytecode({ address: cert.address });
    if (code && code !== "0x") break;
    if (i === 19) throw new Error(`BuilderCertificate at ${cert.address} has no code after 30s`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Read the roles back rather than trust the constructor.
  const ADMIN = (await cert.read.ADMIN_ROLE()) as `0x${string}`;
  const DEFAULT = (await cert.read.DEFAULT_ADMIN_ROLE()) as `0x${string}`;
  const checks: [string, boolean][] = [
    ["super admin holds DEFAULT_ADMIN_ROLE", (await cert.read.hasRole([DEFAULT, superAdmin])) as boolean],
    ["super admin holds ADMIN_ROLE", (await cert.read.hasRole([ADMIN, superAdmin])) as boolean],
    ...(await Promise.all(admins.map(async (a) => [`${a} holds ADMIN_ROLE`, (await cert.read.hasRole([ADMIN, a])) as boolean] as [string, boolean]))),
    ["deployer holds no DEFAULT_ADMIN_ROLE", !((await cert.read.hasRole([DEFAULT, deployerAddress])) as boolean) || deployerAddress === superAdmin],
    ["deployer holds no ADMIN_ROLE", !((await cert.read.hasRole([ADMIN, deployerAddress])) as boolean) || deployerAddress === superAdmin || admins.includes(deployerAddress)],
  ];
  for (const [label, ok] of checks) {
    if (!ok) throw new Error(`Role check failed: ${label}`);
    console.log(`   ✅ ${label}`);
  }

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const latestPath = path.join(deploymentsDir, `${networkName}-latest.json`);
  const existing = fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, "utf8")) : {};
  const result = {
    ...existing,
    builderCertificate: cert.address,
    network: networkName,
    // Not the top-level `timestamp`: sync-contracts reads that as the swag
    // collection's deployedAt, and this deploy is not that one.
    builderCertificateConfig: { deployer: deployerAddress, superAdmin, admins, deployedAt: new Date().toISOString() },
  };
  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(deploymentsDir, `${networkName}-certificate-${Date.now()}.json`), JSON.stringify(result, null, 2));

  const spent = balance - (await publicClient.getBalance({ address: deployerAddress }));
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`   BuilderCertificate: ${cert.address}`);
  console.log(`   Gas spent:          ${formatEther(spent)} ETH`);
  console.log(`   Saved to:           ${latestPath}`);
  console.log(`\n📌 Next: npx hardhat verify --network ${networkName} ${cert.address} ${superAdmin} '${JSON.stringify(admins)}'`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
