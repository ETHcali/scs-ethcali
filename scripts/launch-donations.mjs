/**
 * One command to put donations live on every chain.
 *
 * Deploys DonationReceipt1155 + DonationVault and seeds the campaign, chain by
 * chain, and is SAFE TO RE-RUN: every step reads on-chain state first and skips
 * what is already done. That matters because the Celo launch half-failed once —
 * the campaign was created but no currency was ever accepted — and the fix is to
 * re-run, not to hand-patch.
 *
 *   node scripts/launch-donations.mjs                    # dry run, all chains
 *   node scripts/launch-donations.mjs celo base          # dry run, subset
 *   DRY_RUN=0 node scripts/launch-donations.mjs          # send it
 *
 * Flags:
 *   --keep-going          carry on to the next chain after a failure
 *   --no-write-addresses  do not touch wallet_ethcali/frontend/addresses.json
 *
 * DRY RUN IS THE DEFAULT. Nothing is sent unless DRY_RUN=0.
 *
 * Per chain, in order:
 *   1. the beneficiary Safe must have CODE here. Handing custody to an address
 *      that is an EOA on this chain freezes the beneficiary permanently, and it
 *      is the one mistake the deploy cannot undo — so it is checked first and
 *      it is fatal, never a warning.
 *   2. gas estimate vs deployer balance. Underfunded is a SKIP, not a failure:
 *      one unfunded chain must not stop the funded ones.
 *   3. deploy, unless a vault with code is already recorded for this chain.
 *   4. seed the campaign (idempotent on its own).
 */
import { createPublicClient, http, formatEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { CHAINS, estimateChain } from './estimate-deploy-cost.mjs';
import { SINGLETON_FACTORY, donationSalt, predictDonationAddresses } from './deterministic.mjs';

const DEFAULT_ADMIN_ROLE = `0x${'00'.repeat(32)}`;
const WIRING_ABI = [
  { type: 'function', name: 'isSuperAdmin', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'MINTER_ROLE', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
];

/**
 * Deployed is not the same as wired.
 *
 * Celo proved this the hard way: both contracts deployed, then Forno returned
 * an HTTP error partway through role setup. Code existed at both addresses, so
 * a code-presence check would have called the chain done and gone straight to
 * seeding — leaving the deployer holding DEFAULT_ADMIN and the Safe holding
 * nothing. Custody silently never transferred is the worst failure this script
 * could produce, so it is checked explicitly.
 */
async function wiringComplete(client, vault, receipt, custodyAdmin, deployer) {
  const read = (address, functionName, args = []) =>
    client.readContract({ address: getAddress(address), abi: WIRING_ABI, functionName, args });
  try {
    const minterRole = await read(receipt, 'MINTER_ROLE');
    const [minterOk, safeVault, safeReceipt, deployerVault, deployerReceipt] = await Promise.all([
      read(receipt, 'hasRole', [minterRole, getAddress(vault)]),
      read(vault, 'isSuperAdmin', [getAddress(custodyAdmin)]),
      read(receipt, 'hasRole', [DEFAULT_ADMIN_ROLE, getAddress(custodyAdmin)]),
      read(vault, 'isSuperAdmin', [getAddress(deployer)]),
      read(receipt, 'hasRole', [DEFAULT_ADMIN_ROLE, getAddress(deployer)]),
    ]);
    // The Safe holding custody is not enough — the deployer must have stepped
    // down. Base stopped exactly here: both held DEFAULT_ADMIN because a stale
    // read aborted the renounce, and "the Safe has it" would have called that
    // done while a hot EOA could still redirect donations.
    const deployerStoodDown =
      getAddress(deployer) === getAddress(custodyAdmin) || (!deployerVault && !deployerReceipt);
    return minterOk && safeVault && safeReceipt && deployerStoodDown;
  } catch {
    return false;
  }
}

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEPLOYMENTS = path.join(ROOT, 'deployments');
const APP_ADDRESSES = path.join(ROOT, '../wallet_ethcali/frontend/addresses.json');

/** Guards against a mislabelled RPC URL pointing the deploy at the wrong chain. */
const CHAIN_IDS = { ethereum: 1, optimism: 10, base: 8453, unichain: 130, celo: 42220 };

/** Cheapest and most-ready first; mainnet last, where a mistake costs the most. */
const DEFAULT_TARGETS = ['celo', 'optimism', 'base', 'ethereum'];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const targets = argv.filter((a) => !a.startsWith('--'));
const chains = targets.length ? targets : DEFAULT_TARGETS;

const dryRun = process.env.DRY_RUN !== '0';
const keepGoing = flags.has('--keep-going');
const writeAddresses = !flags.has('--no-write-addresses');

const beneficiary = process.env.DONATION_BENEFICIARY || '';
const custodyAdmin = process.env.DONATION_CUSTODY_ADMIN || beneficiary;
const deterministic = process.env.DETERMINISTIC !== '0';

/** The deployer is baked into the constructor args, so it decides the address. */
function deployerAddress() {
  if (process.env.DEPLOYER_ADDRESS) return process.env.DEPLOYER_ADDRESS;
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('Set PRIVATE_KEY or DEPLOYER_ADDRESS.');
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`).address;
}

// Colour only for a real terminal — this output gets piped to a launch log.
const tty = process.stdout.isTTY;
// Chain-independent by construction: same factory, same salt, same init code.
const predicted = deterministic ? predictDonationAddresses(deployerAddress()) : null;

const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);

function rule(label = '') {
  console.log(label ? `\n── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}` : '─'.repeat(59));
}

function clientFor(name) {
  return createPublicClient({ transport: http(CHAINS[name].rpc) });
}

function readRecord(name) {
  const p = path.join(DEPLOYMENTS, `${name}-latest.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

async function hasCode(client, address) {
  if (!address) return false;
  const code = await client.getCode({ address: getAddress(address) });
  return Boolean(code && code !== '0x');
}

/** Run a hardhat script against one network, inheriting stdio so it streams. */
function hardhat(script, network, env = {}) {
  const r = spawnSync(
    'npx',
    ['hardhat', 'run', `scripts/${script}`, '--network', network],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } }
  );
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${script} exited ${r.status} on ${network}`);
}

/**
 * Merge the two donation addresses into the app's registry.
 *
 * Merge, never replace: the file also carries faucet, swag and identity
 * addresses this script knows nothing about.
 */
function recordInApp(name, chainId, vault, receipt) {
  if (!fs.existsSync(APP_ADDRESSES)) {
    console.log(`   ${dim('addresses.json not found — skipping app registry update')}`);
    return;
  }
  const json = JSON.parse(fs.readFileSync(APP_ADDRESSES, 'utf8'));
  const entry = json[name] || { chainId, addresses: {} };
  entry.chainId = chainId;
  entry.addresses = { ...entry.addresses, DonationVault: vault, DonationReceipt1155: receipt };
  json[name] = entry;
  fs.writeFileSync(APP_ADDRESSES, JSON.stringify(json, null, 2) + '\n');
  console.log(`   ✍️  wrote ${name} donation addresses into wallet_ethcali/frontend/addresses.json`);
}

async function runChain(name) {
  rule(name);

  if (!CHAINS[name]) return { name, status: 'unknown chain' };

  const client = clientFor(name);

  // 1. RPC identity — a wrong URL here deploys to the wrong chain.
  const chainId = await client.getChainId();
  if (CHAIN_IDS[name] && chainId !== CHAIN_IDS[name]) {
    throw new Error(
      `RPC for "${name}" reports chain ${chainId}, expected ${CHAIN_IDS[name]}. Check the *_RPC_URL env var.`
    );
  }
  console.log(`   chain id      : ${chainId}`);

  // 2. Beneficiary must be a contract HERE. Fatal, never a warning.
  if (!beneficiary) throw new Error('DONATION_BENEFICIARY is unset — refusing to deploy.');
  if (!(await hasCode(client, beneficiary))) {
    return {
      name,
      status: `BLOCKED — beneficiary ${beneficiary} has no code on ${name}; custody would be frozen`,
    };
  }
  console.log(`   beneficiary   : ${beneficiary} ${dim('(has code ✓)')}`);

  // 3. Existing deployment?
  //
  // In deterministic mode the question is not "does the recorded address have
  // code" but "does the PREDICTED address have code". Celo's first vault was
  // deployed with plain CREATE, so its recorded address is live yet still the
  // wrong one — treating that as done would leave one chain out of the set.
  const record = readRecord(name);
  const expected = deterministic ? predicted : null;

  const vaultAddr = expected ? expected.DonationVault : record.donationVault;
  const receiptAddr = expected ? expected.DonationReceipt1155 : record.donationReceipt;
  const deployed = (await hasCode(client, vaultAddr)) && (await hasCode(client, receiptAddr));

  if (deployed) {
    console.log(`   vault         : ${vaultAddr} ${dim('(already deployed)')}`);
    console.log(`   receipt       : ${receiptAddr} ${dim('(already deployed)')}`);

    if (!(await wiringComplete(client, vaultAddr, receiptAddr, custodyAdmin, deployerAddress()))) {
      console.log(`   ${bold('repair')}        : roles incomplete — ${dryRun ? 'WOULD run' : 'running'} finish-donations.ts`);
      if (!dryRun) {
        hardhat('finish-donations.ts', name, {
          DONATION_VAULT: vaultAddr,
          DONATION_RECEIPT: receiptAddr,
        });
      }
    } else {
      console.log(`   roles         : ${dim('wired, custody with the Safe ✓')}`);
    }
  } else if (expected) {
    console.log(`   vault         : ${vaultAddr} ${dim('(predicted)')}`);
    console.log(`   receipt       : ${receiptAddr} ${dim('(predicted)')}`);
    if (record.donationVault && record.donationVault.toLowerCase() !== vaultAddr.toLowerCase()) {
      console.log(
        `   ${dim(`note: ${record.donationVault} is already deployed here from an earlier`)}\n` +
          `   ${dim('non-deterministic run. It will be left in place and superseded.')}`
      );
    }
  }

  // 4. Gas check — only when there is something to deploy.
  if (!deployed) {
    const est = await estimateChain(name, 'donations');
    const sym = est.symbol;
    console.log(
      `   gas           : ${est.totalGas} @ ${(Number(est.gasPrice) / 1e9).toFixed(3)} gwei ` +
        `= ${formatEther(est.withBuffer)} ${sym} (with buffer)`
    );
    console.log(`   deployer bal  : ${formatEther(est.balance)} ${sym}`);
    if (est.balance < est.withBuffer) {
      const short = formatEther(est.withBuffer - est.balance);
      return { name, status: `SKIPPED — underfunded, needs ${short} ${sym} more` };
    }
    console.log(`   ${bold('deploy')}        : ${dryRun ? 'WOULD deploy vault + receipt' : 'deploying…'}`);
    if (!dryRun) hardhat('deploy-donations.ts', name);
  }

  // A dry run before the deploy has nothing to read state from — the predicted
  // address is still empty, so the seed cannot be previewed, only announced.
  if (!deployed && dryRun) {
    return { name, status: 'PLANNED — deploy, then seed', vault: vaultAddr, receipt: receiptAddr };
  }

  // 5. Addresses to seed against. On a dry run with nothing deployed there is
  //    no vault to read, so the seed step cannot be previewed.
  const rec = readRecord(name);
  const after = expected
    ? { donationVault: expected.DonationVault, donationReceipt: expected.DonationReceipt1155 }
    : rec;
  if (!after.donationVault || !after.donationReceipt) {
    return { name, status: dryRun ? 'PLANNED — deploy, then seed' : 'FAILED — no addresses recorded' };
  }

  // 6. Seed. seed-campaign.ts is idempotent and dry-run-by-default itself.
  console.log(`   ${bold('seed')}          : ${dryRun ? 'previewing…' : 'seeding…'}`);
  hardhat('seed-campaign.ts', name, {
    DONATION_VAULT: after.donationVault,
    DONATION_RECEIPT: after.donationReceipt,
    DRY_RUN: dryRun ? '1' : '0',
  });

  if (!dryRun && writeAddresses) {
    recordInApp(name, chainId, after.donationVault, after.donationReceipt);
  }

  return {
    name,
    status: dryRun ? 'PLANNED' : 'LIVE',
    vault: after.donationVault,
    receipt: after.donationReceipt,
  };
}

console.log(bold('\n  ETH CALI — DONATION LAUNCH') + (dryRun ? dim('   (DRY RUN)') : ''));
rule();
console.log(`  chains      : ${chains.join(', ')}`);
console.log(`  beneficiary : ${beneficiary || dim('(unset)')}`);
if (predicted) {
  console.log(`  salt        : ${donationSalt()}`);
  console.log(`  vault       : ${predicted.DonationVault}   ${dim('same on every chain')}`);
  console.log(`  receipt     : ${predicted.DonationReceipt1155}   ${dim('same on every chain')}`);
}
console.log(`  mode        : ${dryRun ? 'dry run — nothing will be sent' : bold('LIVE — transactions will be sent')}`);

// Receipt metadata is not required to accept a donation, but without it the
// donor gets no NFT. Say so once, up front, rather than per chain.
if (!process.env.RECEIPT_URI_1 || !process.env.RECEIPT_URI_2) {
  console.log(
    `\n  ⚠️  RECEIPT_URI_1/RECEIPT_URI_2 unset — receipt tiers stay inactive and\n` +
      `      NO receipt NFT will be minted for donors. Donations still settle.`
  );
}

const results = [];
for (const name of chains) {
  try {
    results.push(await runChain(name));
  } catch (e) {
    results.push({ name, status: `FAILED — ${e.message}` });
    if (!keepGoing) {
      console.error(`\n✖ ${name} failed. Stopping. Re-run to resume, or pass --keep-going.`);
      break;
    }
  }
}

rule();
console.log(bold('\n  SUMMARY\n'));
for (const r of results) {
  console.log(`   ${r.name.padEnd(10)} ${r.status}`);
  if (r.vault) console.log(`   ${''.padEnd(10)} vault ${r.vault}  receipt ${r.receipt}`);
}
if (dryRun) console.log(`\n   Nothing was sent. Re-run with ${bold('DRY_RUN=0')} to apply.\n`);

process.exitCode = results.some((r) => String(r.status).startsWith('FAILED')) ? 1 : 0;
