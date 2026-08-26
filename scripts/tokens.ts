/**
 * Reference token addresses recorded alongside a donation deployment, per chain.
 *
 * Metadata only — the vault learns which tokens it accepts from
 * seed-campaign.ts, never from this record.
 *
 * Shared by deploy-donations.ts and finish-donations.ts. It lived in both as a
 * copy, and the copy in finish-donations.ts kept the original bug: it read the
 * Celo env vars unconditionally, stamping Celo's USDC and COPm onto Base and
 * Optimism. Keep exactly one definition.
 */
export const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  10: "optimism",
  42220: "celo",
  31337: "hardhat",
};

export function tokensForChain(chainId: number): Record<string, string> {
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
