import { network } from "hardhat";
import { encodeDeployData, formatEther, getAddress } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deploy ONLY ZKPassportNFT and the FaucetManager that gates on it.
 *
 * Why: the Ethereum pair deployed in January predates on-chain proof
 * verification (no proof mint, no domain/scope), so nobody could ever mint and
 * every faucet claim was locked. This replaces both; nothing else is touched.
 *
 * The policy is fixed here, not read from env, so a typo cannot deploy a
 * contract that rejects every proof. It mirrors the ZKPassport dashboard
 * policy (owner decision 2026-10-10): domain `ethcali.org`, scope `policy-1`,
 * age 18+, non-strict sanctions, and one exclusion list for nationality and
 * issuing country. Change the dashboard and this together.
 *
 * The deployer receives no role. ZKPassportNFT is owned by IDENTITY_OWNER from
 * the constructor; FaucetManager gives DEFAULT_ADMIN_ROLE + ADMIN_ROLE to
 * FAUCET_SUPER_ADMIN.
 *
 * Usage:
 *   IDENTITY_ESTIMATE=1 npm run deploy:identity:ethereum   # MANDATORY first: gas vs balance
 *   npm run deploy:identity:ethereum
 *
 * Rehearse on a fork first:
 *   anvil --fork-url <mainnet rpc> --port 8545
 *   PRIVATE_KEY=<anvil key> IDENTITY_OWNER=… FAUCET_SUPER_ADMIN=… \
 *     npx hardhat run scripts/deploy-identity.ts --network localhost
 *
 * Addresses are MERGED into deployments/<network>-latest.json (zkPassportNFT,
 * faucetManager), the replaced ones kept under identityConfig.supersedes. A
 * rehearsal on --network localhost writes nothing.
 */

const ZKPASSPORT_DOMAIN = "ethcali.org";
const ZKPASSPORT_SCOPE = "policy-1";
/** Sorted: ZKPassport requires the proof's exclusion list in alphabetical order, and the contract enforces it. */
const EXCLUDED_COUNTRIES = ["AFG", "BLR", "CUB", "IRN", "MMR", "PRK", "RUS", "SDN", "SYR", "VEN", "YEM", "ZWE"];
/** ZKPassport's root verifier, fixed in the NFT at deploy. Must have code where we deploy. */
const ZKPASSPORT_VERIFIER = "0x1D000001000EFD9a6371f4d90bB8920D5431c0D8";

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  31337: "hardhat",
};

const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

function requireAddress(name: string): `0x${string}` {
  const raw = (process.env[name] || "").trim();
  if (!isAddress(raw)) throw new Error(`${name} is not an address. Refusing to deploy a contract nobody can administer.`);
  return getAddress(raw);
}

function artifact(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`), "utf8"));
}

async function main() {
  const estimateOnly = process.env.IDENTITY_ESTIMATE === "1";
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`   ETHCALI IDENTITY (ZKPassportNFT + FaucetManager) ${estimateOnly ? "— ESTIMATE ONLY" : "DEPLOYMENT"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address as `0x${string}`;
  const chainId = await publicClient.getChainId();
  // An anvil fork keeps the forked chain's id, so the chain id cannot tell a
  // rehearsal from the real thing. The Hardhat network name can.
  const rehearsal = connection.networkName === "localhost";
  const networkName = rehearsal ? "fork" : CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;

  const owner = requireAddress("IDENTITY_OWNER");
  const faucetAdmin = requireAddress("FAUCET_SUPER_ADMIN");

  const verifierCode = await publicClient.getBytecode({ address: ZKPASSPORT_VERIFIER });
  if (!verifierCode || verifierCode === "0x") {
    throw new Error(`No ZKPassport verifier at ${ZKPASSPORT_VERIFIER} on chain ${chainId}. Every mint would revert.`);
  }

  const balance = await publicClient.getBalance({ address: deployerAddress });
  console.log(`\n🌐 Network:        ${networkName} (${chainId})`);
  console.log(`👤 Deployer:       ${deployerAddress}  (gets no role)`);
  console.log(`💰 Balance:        ${formatEther(balance)} ETH`);
  console.log(`🪪 NFT owner:      ${owner}`);
  console.log(`🚰 Faucet admin:   ${faucetAdmin}  (DEFAULT_ADMIN_ROLE + ADMIN_ROLE)`);
  console.log(`📜 Policy:         ${ZKPASSPORT_DOMAIN} / ${ZKPASSPORT_SCOPE}, 18+, sanctions (non-strict), excluded ${EXCLUDED_COUNTRIES.join(" ")}`);

  const nftArgs = ["ZKPassport Verification", "ZKPASS", owner, ZKPASSPORT_DOMAIN, ZKPASSPORT_SCOPE, EXCLUDED_COUNTRIES, ZKPASSPORT_VERIFIER] as const;

  // ── Cost vs balance, before anything is sent ─────────────────────────────
  const nftArtifact = artifact("ZKPassportNFT");
  const faucetArtifact = artifact("FaucetManager");
  const nftGas = await publicClient.estimateGas({
    account: deployerAddress,
    data: encodeDeployData({ abi: nftArtifact.abi, bytecode: nftArtifact.bytecode, args: nftArgs }),
  });
  // The faucet's real NFT address does not exist yet; any non-zero address costs the same.
  const faucetGas = await publicClient.estimateGas({
    account: deployerAddress,
    data: encodeDeployData({ abi: faucetArtifact.abi, bytecode: faucetArtifact.bytecode, args: [ZKPASSPORT_VERIFIER, faucetAdmin] }),
  });
  const fees = await publicClient.estimateFeesPerGas();
  const maxFee = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
  const cost = (nftGas + faucetGas) * maxFee;
  console.log(`\n⛽ Gas:            NFT ${nftGas} + faucet ${faucetGas}`);
  console.log(`   Max fee:        ${Number(maxFee) / 1e9} gwei`);
  console.log(`   Worst case:     ${formatEther(cost)} ETH`);
  if (cost > balance) {
    throw new Error(`Balance ${formatEther(balance)} ETH is below the worst-case cost ${formatEther(cost)} ETH. Top up the deployer first.`);
  }
  console.log(`   Headroom:       ${formatEther(balance - cost)} ETH`);
  if (estimateOnly) {
    console.log("\n✅ Estimate only — nothing was sent.");
    return;
  }

  const waitForCode = async (label: string, address: `0x${string}`) => {
    // Public RPCs load-balance across replicas; wait until the code is visible.
    for (let i = 0; i < 20; i++) {
      const code = await publicClient.getBytecode({ address });
      if (code && code !== "0x") return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`${label} at ${address} has no code after 30s`);
  };

  console.log("\n📦 Deploying ZKPassportNFT...");
  const nft = await viem.deployContract("ZKPassportNFT", [...nftArgs]);
  await waitForCode("ZKPassportNFT", nft.address);
  console.log(`   ✅ ${nft.address}`);

  console.log("📦 Deploying FaucetManager...");
  const faucet = await viem.deployContract("FaucetManager", [nft.address, faucetAdmin]);
  await waitForCode("FaucetManager", faucet.address);
  console.log(`   ✅ ${faucet.address}`);

  // Read everything back rather than trust the constructors.
  const ADMIN = (await faucet.read.ADMIN_ROLE()) as `0x${string}`;
  const DEFAULT = (await faucet.read.DEFAULT_ADMIN_ROLE()) as `0x${string}`;
  const sameList = JSON.stringify(await nft.read.excludedCountries()) === JSON.stringify(EXCLUDED_COUNTRIES);
  const checks: [string, boolean][] = [
    ["NFT owner is IDENTITY_OWNER", getAddress((await nft.read.owner()) as string) === owner],
    ["NFT verifier is ZKPassport's root verifier", getAddress((await nft.read.zkPassportVerifier()) as string) === getAddress(ZKPASSPORT_VERIFIER)],
    [`NFT domain is ${ZKPASSPORT_DOMAIN}`, (await nft.read.domain()) === ZKPASSPORT_DOMAIN],
    [`NFT scope is ${ZKPASSPORT_SCOPE}`, (await nft.read.scope()) === ZKPASSPORT_SCOPE],
    ["NFT exclusion list matches the policy", sameList],
    ["faucet points at the new NFT", getAddress((await faucet.read.nftContract()) as string) === getAddress(nft.address)],
    ["faucet admin holds DEFAULT_ADMIN_ROLE", (await faucet.read.hasRole([DEFAULT, faucetAdmin])) as boolean],
    ["faucet admin holds ADMIN_ROLE", (await faucet.read.hasRole([ADMIN, faucetAdmin])) as boolean],
    ["deployer holds no faucet role", deployerAddress === faucetAdmin || !((await faucet.read.hasRole([DEFAULT, deployerAddress])) as boolean)],
  ];
  for (const [label, ok] of checks) {
    if (!ok) throw new Error(`Check failed: ${label}`);
    console.log(`   ✅ ${label}`);
  }

  if (rehearsal) {
    console.log("\n🧪 Rehearsal on a fork: nothing written to deployments/.");
    return;
  }

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const latestPath = path.join(deploymentsDir, `${networkName}-latest.json`);
  const existing = fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, "utf8")) : {};
  const result = {
    ...existing,
    zkPassportNFT: nft.address,
    faucetManager: faucet.address,
    network: networkName,
    // Not the top-level `timestamp`: sync-contracts reads that as the swag collection's deployedAt.
    identityConfig: {
      deployer: deployerAddress,
      owner,
      faucetAdmin,
      domain: ZKPASSPORT_DOMAIN,
      scope: ZKPASSPORT_SCOPE,
      excludedCountries: EXCLUDED_COUNTRIES,
      supersedes: { zkPassportNFT: existing.zkPassportNFT ?? null, faucetManager: existing.faucetManager ?? null },
      deployedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(deploymentsDir, `${networkName}-identity-${Date.now()}.json`), JSON.stringify(result, null, 2));

  const spent = balance - (await publicClient.getBalance({ address: deployerAddress }));
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`   ZKPassportNFT:  ${nft.address}`);
  console.log(`   FaucetManager:  ${faucet.address}`);
  console.log(`   Gas spent:      ${formatEther(spent)} ETH`);
  console.log(`   Saved to:       ${latestPath}`);
  console.log(`\n📌 Next: verify both on Etherscan (npm run verify:${networkName}), then npm run sync:contracts in ../wallet_ethcali.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
