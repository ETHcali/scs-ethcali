/**
 * Pre-deploy gas estimator.
 *
 * MANDATORY before any mainnet deploy. Running out of gas partway through
 * leaves a half-deployed set of contracts: money spent, nothing usable, and a
 * dirty deployments file to untangle.
 *
 * Estimates real deployment gas per contract against each live chain, multiplies
 * by that chain's current gas price, and compares to the deployer's balance.
 *
 *   node scripts/estimate-deploy-cost.mjs              # all chains, full suite
 *   node scripts/estimate-deploy-cost.mjs celo         # one chain
 *   node scripts/estimate-deploy-cost.mjs celo donations   # donations only
 */
import { createPublicClient, http, formatEther, encodeDeployData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CHAINS = {
  celo: { rpc: process.env.CELO_RPC_URL || 'https://forno.celo.org', symbol: 'CELO' },
  base: { rpc: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com', symbol: 'ETH' },
  optimism: { rpc: process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com', symbol: 'ETH' },
  unichain: { rpc: process.env.UNICHAIN_RPC_URL || 'https://unichain-rpc.publicnode.com', symbol: 'ETH' },
  ethereum: { rpc: process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com', symbol: 'ETH' },
};

/** Role-management transactions performed after deployment. */
const ROLE_TX_GAS = { full: 9n * 60_000n, donations: 7n * 60_000n };

function artifact(name) {
  const p = path.join(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing artifact for ${name} — run: npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// A placeholder for constructor args that are addresses of not-yet-deployed
// contracts. Gas cost does not depend on the value.
const PLACEHOLDER = '0x0000000000000000000000000000000000000001';

function buildPlan(scope) {
  const deployer = process.env.DEPLOYER_ADDRESS || PLACEHOLDER;
  const zk = process.env.ZK_PASSPORT_ADMIN || PLACEHOLDER;
  const faucet = process.env.FAUCET_ADMIN || PLACEHOLDER;
  const swag = process.env.SWAG_ADMIN || PLACEHOLDER;

  const donations = [
    ['DonationReceipt1155', ['ETH Cali Relief Receipts', 'ETHCALI-RELIEF', '', deployer]],
    ['DonationVault', [deployer]],
  ];

  if (scope === 'donations') return donations;

  return [
    ['ZKPassportNFT', ['ZKPassport Verification', 'ZKPASS', zk, 'ethcali.com', 'ethcali-verification']],
    ['FaucetManager', [PLACEHOLDER, faucet]],
    ['Swag1155', []],
    ['SwagFactory', [swag, PLACEHOLDER]],
    ['HackathonStaking', [PLACEHOLDER, faucet]],
    ...donations,
  ];
}

export async function estimateChain(name, scope) {
  const { rpc, symbol } = CHAINS[name];
  const client = createPublicClient({ transport: http(rpc) });

  let deployerAddress = process.env.DEPLOYER_ADDRESS;
  if (!deployerAddress && process.env.PRIVATE_KEY) {
    const pk = process.env.PRIVATE_KEY.startsWith('0x')
      ? process.env.PRIVATE_KEY
      : `0x${process.env.PRIVATE_KEY}`;
    try {
      deployerAddress = privateKeyToAccount(pk).address;
    } catch {
      /* fall through to placeholder */
    }
  }
  deployerAddress = deployerAddress || PLACEHOLDER;

  const [gasPrice, balance] = await Promise.all([
    client.getGasPrice(),
    client.getBalance({ address: deployerAddress }),
  ]);

  let totalGas = 0n;
  const rows = [];

  for (const [contract, args] of buildPlan(scope)) {
    const art = artifact(contract);
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    try {
      const gas = await client.estimateGas({ account: deployerAddress, data });
      totalGas += gas;
      rows.push([contract, gas]);
    } catch {
      // Fall back to a bytecode-derived approximation when the node refuses to
      // estimate (usually an unfunded account).
      const approx = BigInt(Math.ceil((art.bytecode.length / 2) * 200 + 32000));
      totalGas += approx;
      rows.push([`${contract} (approx)`, approx]);
    }
  }

  totalGas += ROLE_TX_GAS[scope] ?? ROLE_TX_GAS.full;
  rows.push(['role transactions', ROLE_TX_GAS[scope] ?? ROLE_TX_GAS.full]);

  const cost = totalGas * gasPrice;
  const withBuffer = (cost * 13n) / 10n; // 30% headroom for gas-price drift

  return { name, symbol, gasPrice, balance, totalGas, cost, withBuffer, rows, deployerAddress };
}

// Only run the CLI when invoked directly. launch-donations.mjs imports
// estimateChain() from here so the two never disagree about gas.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [chainArg, scopeArg] = process.argv.slice(2);
  const scope = scopeArg === 'donations' ? 'donations' : 'full';
  const targets = chainArg ? [chainArg] : Object.keys(CHAINS);

  console.log(`\nPre-deploy gas estimate — scope: ${scope}\n`);

  for (const name of targets) {
    if (!CHAINS[name]) {
      console.log(`unknown chain: ${name}`);
      continue;
    }

    try {
      const r = await estimateChain(name, scope);

      console.log(`── ${name} ${'─'.repeat(Math.max(0, 46 - name.length))}`);
      for (const [label, gas] of r.rows) {
        console.log(`   ${label.padEnd(28)} ${String(gas).padStart(9)} gas`);
      }
      console.log(`   ${'TOTAL'.padEnd(28)} ${String(r.totalGas).padStart(9)} gas`);
      console.log(`   gas price      : ${(Number(r.gasPrice) / 1e9).toFixed(2)} gwei`);
      console.log(`   estimated cost : ${formatEther(r.cost)} ${r.symbol}`);
      console.log(`   with 30% buffer: ${formatEther(r.withBuffer)} ${r.symbol}`);
      console.log(`   deployer bal   : ${formatEther(r.balance)} ${r.symbol}`);

      const verdict =
        r.balance >= r.withBuffer
          ? 'GO'
          : r.balance >= r.cost
            ? `TIGHT — top up ${formatEther(r.withBuffer - r.balance)} ${r.symbol} for safe headroom`
            : `INSUFFICIENT — need ${formatEther(r.withBuffer - r.balance)} ${r.symbol} more`;
      console.log(`   VERDICT        : ${verdict}\n`);
    } catch (e) {
      console.log(`── ${name}: failed — ${e.message}\n`);
    }
  }
}
