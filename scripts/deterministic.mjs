/**
 * Same donation addresses on every chain, via CREATE2.
 *
 * This is how the ethcali.eth Safe has one address across five chains, and it
 * is worth copying: donors, block explorers, the indexer and the app all get
 * to treat "the donation vault" as a single identity instead of a per-chain
 * lookup table.
 *
 * Plain CREATE cannot do it — the address depends on the deployer's nonce, and
 * this deployer already has different nonces on every chain. CREATE2 derives
 * the address from (factory, salt, initCodeHash) instead, none of which
 * involve the sender, so anyone can send the transaction and the address still
 * lands in the same place.
 *
 * The catch, and the thing to protect: **the init code must be byte-identical
 * on every chain.** That means identical compiler settings AND identical
 * constructor arguments. Two consequences baked into this module:
 *
 *   - the receipt is always constructed with an EMPTY baseURI, then configured
 *     afterwards with setBaseURI(). Baking the URI into the constructor would
 *     tie the contract's address to metadata that is not pinned yet, and any
 *     later change of mind would move the address on the chains not yet done.
 *   - the arguments live here, in one place, rather than being spelled out
 *     separately by the deployer and the launcher.
 *
 * Front-running is not a risk. The address is a function of the init code, so
 * the only contract anyone can deploy at our address is our own bytecode with
 * our own admin already baked in.
 *
 * Changing a contract's source changes its address. That is intended — bump
 * DONATION_SALT for a v2 rather than trying to keep an address across a
 * rewrite.
 */
import { encodeDeployData, getContractAddress, keccak256, toBytes } from 'viem';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Safe Singleton Factory — the one Safe itself uses to hold one address across
 * chains. Verified present with byte-identical code on ethereum, optimism,
 * base and celo. Its calldata is raw: 32-byte salt followed by the init code.
 * Unlike Arachnid's proxy (0x4e59b448…, also present on all four) it REVERTS
 * on a failed deploy rather than silently returning nothing.
 *
 * Do not swap in 0xce0042B868300000d44A59004Da54A005ffdcf9f. That address is
 * also called "singleton factory" and is deployed on these chains too, but it
 * is EIP-2470, whose interface is an ABI call — `deploy(bytes,bytes32)`. Raw
 * salt-prefixed calldata just reverts there.
 */
export const SINGLETON_FACTORY = '0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7';

export const DEFAULT_SALT_SEED = 'ethcali.donations.v1';

/** bytes32 salt. Override with DONATION_SALT to mint a fresh address set. */
export function donationSalt() {
  const raw = process.env.DONATION_SALT;
  if (!raw) return keccak256(toBytes(DEFAULT_SALT_SEED));
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : keccak256(toBytes(raw));
}

function artifact(name) {
  const p = path.join(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing artifact for ${name} — run: npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Constructor arguments, identical on every chain.
 *
 * Note the empty baseURI — see the module comment. `initialAdmin` is the
 * deployer, which holds DEFAULT_ADMIN_ROLE only long enough to wire roles and
 * hand custody to the Safe.
 */
export function donationPlan(deployer) {
  return [
    [
      'DonationReceipt1155',
      [
        process.env.DONATION_RECEIPT_NAME || 'ETH Cali Relief Receipts',
        process.env.DONATION_RECEIPT_SYMBOL || 'ETHCALI-RELIEF',
        '',
        deployer,
      ],
    ],
    ['DonationVault', [deployer]],
  ];
}

export function initCodeFor(contract, args) {
  const a = artifact(contract);
  return encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
}

/** The address `contract` will occupy on EVERY chain, given these args. */
export function predictAddress(contract, args, salt = donationSalt()) {
  return getContractAddress({
    opcode: 'CREATE2',
    from: SINGLETON_FACTORY,
    salt,
    bytecodeHash: keccak256(initCodeFor(contract, args)),
  });
}

/** Both donation addresses at once, keyed by contract name. */
export function predictDonationAddresses(deployer, salt = donationSalt()) {
  const out = {};
  for (const [name, args] of donationPlan(deployer)) {
    out[name] = predictAddress(name, args, salt);
  }
  return out;
}

/** Calldata for the factory: 32-byte salt followed by the init code. */
export function factoryCalldata(contract, args, salt = donationSalt()) {
  return salt + initCodeFor(contract, args).slice(2);
}
