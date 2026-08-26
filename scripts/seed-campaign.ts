import { network } from "hardhat";
import { formatUnits, parseUnits, parseEventLogs } from "viem";

/** Minimal ERC-20 metadata ABI — inline, because IERC20Metadata has no artifact. */
const ERC20_METADATA_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * Create and configure a donation campaign.
 *
 * FULLY IDEMPOTENT and DRY-RUN BY DEFAULT. Every step reads on-chain state
 * first and skips what is already done, so it is safe to re-run after a
 * partial failure. Nothing is sent unless you pass DRY_RUN=0.
 *
 * Like finish-donations.ts, every write waits for its receipt before the next
 * one is sent. Consecutive writes that do not wait estimate gas against stale
 * state and race on nonce — that is how the first Celo deploy failed.
 *
 * Usage:
 *   DONATION_VAULT=0x… DONATION_RECEIPT=0x… \
 *     npx hardhat run scripts/seed-campaign.ts --network celo          # dry run
 *   DRY_RUN=0 DONATION_VAULT=0x… DONATION_RECEIPT=0x… \
 *     npx hardhat run scripts/seed-campaign.ts --network celo          # for real
 *
 * Env:
 *   CAMPAIGN_NAME         default "Cali Relief"
 *   CAMPAIGN_DESCRIPTION  default a short line about where funds go
 *   DONATION_BENEFICIARY  the Safe. Funds can only ever be withdrawn here.
 *   AUTO_FORWARD          "1" routes each donation straight to the Safe so the
 *                         vault never holds custody. Default "1".
 */

const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as `0x${string}`;

const CHAIN_ID_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  10: "optimism",
  42220: "celo",
  31337: "hardhat",
};

/**
 * Tier thresholds are PER TOKEN and expressed in that token's own decimals.
 * COPm is 18 and USDC is 6 — reusing one number across both is off by 10^12,
 * which is exactly the mistake this table exists to prevent.
 */
interface CurrencyPlan {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Human-readable tier floors, converted with the token's own decimals. */
  tiers: { min: string; receiptTokenId: number }[];
}

/**
 * Per-chain currency plans.
 *
 * Tier floors are chosen by VALUE, not by decimal count. CELO and ETH are both
 * 18 decimals but differ by ~4 orders of magnitude in price, so "10" means
 * roughly USD 5 on Celo and roughly USD 40,000 on Ethereum. Getting this wrong
 * does not revert — it silently sets a tier nobody can ever reach.
 */
const CURRENCIES_BY_CHAIN: Record<number, CurrencyPlan[]> = {
  // ── Celo (42220) — COPm is the point of this chain ───────────────────────
  42220: [
    {
      symbol: "COPm",
      address: "0x8a567e2ae79ca692bd748ab832081c45de4041ea",
      decimals: 18,
      tiers: [
        { min: "40000", receiptTokenId: 1 },   // ~USD 10
        { min: "400000", receiptTokenId: 2 },  // ~USD 100
      ],
    },
    {
      symbol: "USDC",
      address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      decimals: 6,
      tiers: [
        { min: "10", receiptTokenId: 1 },
        { min: "100", receiptTokenId: 2 },
      ],
    },
    {
      symbol: "CELO",
      address: ETH_TOKEN,
      decimals: 18,
      tiers: [
        { min: "10", receiptTokenId: 1 },
        { min: "100", receiptTokenId: 2 },
      ],
    },
  ],

  // ── Optimism (10) ────────────────────────────────────────────────────────
  10: [
    {
      // NATIVE Circle USDC, not the bridged USDC.e at 0x7F5c764c…. Both report
      // symbol "USDC" with 6 decimals, so symbol() alone cannot tell them
      // apart — the address is the only thing that distinguishes them.
      symbol: "USDC",
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      decimals: 6,
      tiers: [
        { min: "10", receiptTokenId: 1 },
        { min: "100", receiptTokenId: 2 },
      ],
    },
    {
      symbol: "ETH",
      address: ETH_TOKEN,
      decimals: 18,
      tiers: [
        { min: "0.0025", receiptTokenId: 1 }, // ~USD 10
        { min: "0.025", receiptTokenId: 2 },  // ~USD 100
      ],
    },
  ],

  // ── Base (8453) ──────────────────────────────────────────────────────────
  8453: [
    {
      // NATIVE Circle USDC. The bridged USDbC at 0xd9aAEc86… also answers
      // symbol() with a USDC-ish string, so match on the address, not the name.
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      tiers: [
        { min: "10", receiptTokenId: 1 },
        { min: "100", receiptTokenId: 2 },
      ],
    },
    {
      symbol: "ETH",
      address: ETH_TOKEN,
      decimals: 18,
      tiers: [
        { min: "0.0025", receiptTokenId: 1 }, // ~USD 10
        { min: "0.025", receiptTokenId: 2 },  // ~USD 100
      ],
    },
  ],

  // ── Ethereum (1) ─────────────────────────────────────────────────────────
  1: [
    {
      symbol: "USDC",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
      tiers: [
        { min: "10", receiptTokenId: 1 },
        { min: "100", receiptTokenId: 2 },
      ],
    },
    {
      symbol: "ETH",
      address: ETH_TOKEN,
      decimals: 18,
      tiers: [
        { min: "0.0025", receiptTokenId: 1 },
        { min: "0.025", receiptTokenId: 2 },
      ],
    },
  ],
};

const RECEIPT_TIERS = [
  { tokenId: 1, name: "Supporter", uri: process.env.RECEIPT_URI_1 || "" },
  { tokenId: 2, name: "Guardian", uri: process.env.RECEIPT_URI_2 || "" },
];

async function main() {
  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const [operator] = await viem.getWalletClients();
  const operatorAddress = operator.account.address as `0x${string}`;

  const chainId = await publicClient.getChainId();
  const networkName = CHAIN_ID_TO_NETWORK[chainId] || `chain-${chainId}`;

  const dryRun = process.env.DRY_RUN !== "0";

  const vaultAddress = process.env.DONATION_VAULT as `0x${string}`;
  const receiptAddress = process.env.DONATION_RECEIPT as `0x${string}`;
  if (!vaultAddress || !receiptAddress) {
    throw new Error("Set DONATION_VAULT and DONATION_RECEIPT");
  }

  const beneficiary = (process.env.DONATION_BENEFICIARY || "") as `0x${string}`;
  if (!beneficiary) throw new Error("Set DONATION_BENEFICIARY (the Safe)");

  const name = process.env.CAMPAIGN_NAME || "Cali Relief";
  const description =
    process.env.CAMPAIGN_DESCRIPTION ||
    "Direct relief for Cali. Funds settle onchain to the ethcali.eth Safe.";
  const autoForward = (process.env.AUTO_FORWARD ?? "1") === "1";

  const currencies = CURRENCIES_BY_CHAIN[chainId];
  if (!currencies) {
    throw new Error(
      `No currency plan for chain ${chainId} (${networkName}). ` +
        `Add one to CURRENCIES_BY_CHAIN before seeding here.`
    );
  }

  const vault = await viem.getContractAt("DonationVault", vaultAddress);
  const receipt = await viem.getContractAt("DonationReceipt1155", receiptAddress);

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`        SEED CAMPAIGN — ${networkName}${dryRun ? "  (DRY RUN)" : ""}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  vault       : ${vaultAddress}`);
  console.log(`  receipt     : ${receiptAddress}`);
  console.log(`  operator    : ${operatorAddress}`);
  console.log(`  beneficiary : ${beneficiary}`);
  console.log(`  autoForward : ${autoForward}`);
  console.log("");

  // ── Preflight ────────────────────────────────────────────────────────────
  const isAdmin = await vault.read.isAdmin([operatorAddress]);
  if (!isAdmin) {
    throw new Error(
      `${operatorAddress} does not hold ADMIN_ROLE on the vault. ` +
        `The Safe must grant it before this script can run.`
    );
  }
  console.log("  ✓ operator holds ADMIN_ROLE");

  const minterRole = await receipt.read.MINTER_ROLE();
  const vaultIsMinter = await receipt.read.hasRole([minterRole, vaultAddress]);
  if (!vaultIsMinter) {
    console.log(
      "  ⚠️  vault does NOT hold MINTER_ROLE on the receipt collection.\n" +
        "      Donations will still settle, but no receipt NFT will be minted.\n" +
        "      Fix with finish-donations.ts before going live."
    );
  } else {
    console.log("  ✓ vault holds MINTER_ROLE on the receipt collection");
  }

  let sent = 0;
  /** Returns the mined receipt, or undefined on a dry run. */
  const send = async (label: string, fn: () => Promise<`0x${string}`>) => {
    if (dryRun) {
      console.log(`   WOULD ${label}`);
      return undefined;
    }
    process.stdout.write(`   ${label} … `);
    const hash = await fn();
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(rcpt.status === "success" ? "ok" : "FAILED");
    if (rcpt.status !== "success") throw new Error(`${label} reverted (${hash})`);
    sent++;
    return rcpt;
  };

  // ── 1. Receipt tiers ─────────────────────────────────────────────────────
  console.log("\n1. Receipt tiers");
  for (const tier of RECEIPT_TIERS) {
    const existing = await receipt.read.getTier([BigInt(tier.tokenId)]);
    if (existing.active) {
      console.log(`   tier ${tier.tokenId} (${tier.name}) already active — skip`);
      continue;
    }
    if (!tier.uri) {
      console.log(
        `   ⚠️  tier ${tier.tokenId} (${tier.name}) has no metadata URI ` +
          `(set RECEIPT_URI_${tier.tokenId}) — skip`
      );
      continue;
    }
    await send(`set receipt tier ${tier.tokenId} (${tier.name})`, () =>
      receipt.write.setTier([BigInt(tier.tokenId), tier.name, tier.uri, true])
    );
  }

  // ── 2. Campaign ──────────────────────────────────────────────────────────
  console.log("\n2. Campaign");
  const count = await vault.read.campaignCount();
  let campaignId: bigint | null = null;

  for (let i = 0n; i < count; i++) {
    const c = await vault.read.getCampaign([i]);
    if (c.name === name) {
      campaignId = i;
      console.log(`   campaign "${name}" already exists as #${i} — skip creation`);
      break;
    }
  }

  if (campaignId === null) {
    if (dryRun) {
      console.log(`   WOULD create campaign "${name}" -> #${count}`);
      campaignId = count; // assume the next id for the rest of the dry run
    } else {
      const rcpt = await send(`create campaign "${name}"`, () =>
        vault.write.createCampaign([
          name,
          description,
          beneficiary,
          receiptAddress,
          autoForward,
        ])
      );

      // Read the id out of the receipt's own event, not from campaignCount().
      // Forno load-balances, so a read issued immediately after a write can
      // land on a node still behind the tip: it returned the pre-write count,
      // `count - 1` underflowed to -1, and every later call failed to encode.
      // The receipt is self-contained and cannot race.
      const created = parseEventLogs({
        abi: vault.abi,
        logs: rcpt!.logs,
        eventName: "CampaignCreated",
      });
      if (created.length === 0) {
        throw new Error(
          "createCampaign mined but emitted no CampaignCreated event — refusing to guess the id"
        );
      }
      campaignId = (created[0] as unknown as { args: { campaignId: bigint } }).args.campaignId;
      console.log(`   campaign id: ${campaignId}`);

      // Wait until the RPC can actually SEE the campaign before configuring it.
      // The id from the receipt is correct, but the very next write is gas-
      // estimated against whichever replica answers, and one behind the tip
      // reverts with CampaignDoesNotExist on a campaign that exists.
      let visible = false;
      for (let i = 0; i < 12 && !visible; i++) {
        try {
          visible = (await vault.read.campaignCount()) > campaignId;
        } catch {
          /* transient RPC error — keep waiting */
        }
        if (!visible) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!visible) {
        throw new Error(
          `campaign ${campaignId} was created but is not visible to this RPC yet — re-run to resume`
        );
      }
    }
  }

  // ── 3. Accepted currencies + per-token tiers ─────────────────────────────
  console.log("\n3. Currencies");
  for (const cur of currencies) {
    // Verify the token really is what we think before accepting it. A docs-listed
    // "USDC on Celo" once turned out to be a fee-currency adapter.
    if (cur.address !== ETH_TOKEN) {
      try {
        const onchainSymbol = (await publicClient.readContract({
          address: cur.address,
          abi: ERC20_METADATA_ABI,
          functionName: "symbol",
        })) as string;
        const onchainDecimals = Number(
          await publicClient.readContract({
            address: cur.address,
            abi: ERC20_METADATA_ABI,
            functionName: "decimals",
          })
        );
        if (onchainDecimals !== cur.decimals) {
          throw new Error(
            `${cur.symbol}: expected ${cur.decimals} decimals, chain says ${onchainDecimals}`
          );
        }
        console.log(`   ${cur.symbol}: verified onchain (${onchainSymbol}, ${onchainDecimals} dp)`);
      } catch (e) {
        throw new Error(
          `Could not verify ${cur.symbol} at ${cur.address}: ${(e as Error).message}`
        );
      }
    } else {
      console.log(`   ${cur.symbol}: native sentinel`);
    }

    const accepted = await vault.read.isTokenAccepted([campaignId, cur.address]);
    if (accepted) {
      console.log(`   ${cur.symbol} already accepted — skip`);
    } else {
      await send(`accept ${cur.symbol}`, () =>
        vault.write.setAcceptedToken([campaignId!, cur.address, true])
      );
    }

    const existingTiers = await vault.read.getTiers([campaignId, cur.address]);
    if (existingTiers.length > 0) {
      console.log(`   ${cur.symbol} tiers already set (${existingTiers.length}) — skip`);
      continue;
    }

    const tiers = cur.tiers.map((t) => ({
      minAmount: parseUnits(t.min, cur.decimals),
      receiptTokenId: BigInt(t.receiptTokenId),
    }));
    for (const t of tiers) {
      console.log(
        `     tier -> ${formatUnits(t.minAmount, cur.decimals)} ${cur.symbol} = receipt #${t.receiptTokenId}`
      );
    }
    await send(`set ${cur.symbol} tiers`, () =>
      vault.write.setTiers([campaignId!, cur.address, tiers])
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  if (dryRun) {
    console.log("  DRY RUN — nothing was sent. Re-run with DRY_RUN=0 to apply.");
  } else {
    console.log(`  Done. ${sent} transaction(s) sent. Campaign #${campaignId} is live.`);
    const [allowed, reason] = await vault.read.canDonate([
      campaignId,
      currencies[0].address,
      parseUnits(currencies[0].tiers[0].min, currencies[0].decimals),
    ]);
    console.log(`  canDonate(${currencies[0].tiers[0].min} ${currencies[0].symbol}): ${allowed}${allowed ? "" : ` — ${reason}`}`);
  }
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
