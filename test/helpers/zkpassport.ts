import { keccak256, toBytes } from "viem";

/**
 * Shared ZKPassportNFT test setup.
 *
 * ZKPassportNFT verifies real ZK proofs against an on-chain verifier that does not
 * exist on the local network, so every suite that needs a verified holder deploys
 * MockZKPassportVerifier and points the NFT at it. This helper centralises that
 * plumbing — before it existed, each suite hand-rolled it and drifted out of sync
 * with the contract's constructor.
 */

/** Deterministic bytes32 unique-id from a test label. */
export function uid(label: string): `0x${string}` {
  return keccak256(toBytes(label));
}

/** The contract's required validity window (VALIDITY_PERIOD_SECONDS). */
export const VALIDITY_PERIOD_SECONDS = 604800n;

/**
 * ProofVerificationParams the mock accepts. The mock ignores the proof itself;
 * the contract still checks devMode and the validity window before calling it.
 */
export const EMPTY_PARAMS = {
  version: ("0x" + "00".repeat(32)) as `0x${string}`,
  proofVerificationData: {
    vkeyHash: ("0x" + "00".repeat(32)) as `0x${string}`,
    proof: "0x" as `0x${string}`,
    publicInputs: [] as `0x${string}`[],
  },
  committedInputs: "0x" as `0x${string}`,
  serviceConfig: {
    validityPeriodInSeconds: VALIDITY_PERIOD_SECONDS,
    domain: "",
    scope: "",
    devMode: false,
  },
};

export const DEFAULT_DOMAIN = "ethcali.org";
export const DEFAULT_SCOPE = "policy-1";

/**
 * The production exclusion list (owner decision 2026-10-10), for nationality and
 * issuing country. Sorted: ZKPassport requires the proof's list in that order.
 */
export const EXCLUDED_COUNTRIES = ["AFG", "BLR", "CUB", "IRN", "MMR", "PRK", "RUS", "SDN", "SYR", "VEN", "YEM", "ZWE"];

/**
 * Deploy ZKPassportNFT wired to a mock verifier.
 * @param viem   The viem helper from `network.connect()`
 * @param owner  Address granted ownership of the NFT contract
 */
export async function deployZKPassport(
  viem: any,
  owner: `0x${string}`,
  opts: { name?: string; symbol?: string } = {}
): Promise<{ nft: any; verifier: any }> {
  const verifier = await viem.deployContract("MockZKPassportVerifier", []);

  const nft = await viem.deployContract("ZKPassportNFT", [
    opts.name ?? "ZKPassport",
    opts.symbol ?? "ZKP",
    owner,
    DEFAULT_DOMAIN,
    DEFAULT_SCOPE,
    EXCLUDED_COUNTRIES,
    // The verifier is fixed at deploy; locally it is the mock.
    verifier.address,
  ]);

  return { nft, verifier };
}

/**
 * Mint a ZKPassport NFT to `account` through the mock verifier.
 * @param label Unique per holder — reusing a label reuses the unique-id and the
 *              contract will reject it as a duplicate identity.
 */
export async function mintPassport(
  viem: any,
  nft: any,
  verifier: any,
  account: any,
  label: string,
  opts: { isIDCard?: boolean; isOver18?: boolean; nationality?: string } = {}
): Promise<void> {
  const publicClient = await viem.getPublicClient();
  const chainId = BigInt(await publicClient.getChainId());

  await verifier.write.setMockResult([
    true,                          // verified
    uid(label),                    // uniqueId
    true,                          // scopesValid
    account.address,               // sender
    opts.isOver18 ?? true,         // isOver18
    opts.nationality ?? "COL",     // nationality
  ]);
  await verifier.write.setChainId([chainId]);

  await nft.write.mint([EMPTY_PARAMS, opts.isIDCard ?? false], { account });
}
