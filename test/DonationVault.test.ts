import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits } from "viem";

describe("DonationVault", async function () {
  const { viem } = await network.connect();
  const [owner, admin, donor1, donor2, donor3, beneficiary] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const ZERO = "0x0000000000000000000000000000000000000000";

  // Mirrors the real deployment: USDC has 6 decimals, COPm (Mento Colombian
  // Peso, Celo) has 18. Tier thresholds are per token precisely because of this.
  const USDC = (n: number) => parseUnits(String(n), 6);
  const COP = (n: number) => parseUnits(String(n), 18);

  let vault: any;
  let receipt: any;
  let usdc: any;
  let copm: any;

  /**
   * Create a relief campaign wired to the receipt collection. Returns its id.
   * Defaults to holder mode; pass autoForward: true for router mode.
   */
  async function createCampaign(overrides: Record<string, any> = {}): Promise<bigint> {
    await vault.write.createCampaign([
      overrides.name ?? "Cali Earthquake Relief 2026",
      overrides.description ?? "Emergency relief for families affected by the earthquake",
      overrides.beneficiary ?? beneficiary.account.address,
      overrides.receiptCollection ?? receipt.address,
      overrides.autoForward ?? false,
    ]);
    return (await vault.read.campaignCount()) - 1n;
  }

  before(async function () {
    usdc = await viem.deployContract("MockUSDC", []);
    copm = await viem.deployContract("MockERC20", ["Mento Colombian Peso", "COPm", 18]);

    receipt = await viem.deployContract("DonationReceipt1155", [
      "ETH Cali Earthquake Relief",
      "ETHCALI-RELIEF",
      "ipfs://QmBase/{id}.json",
      owner.account.address,
    ]);

    vault = await viem.deployContract("DonationVault", [owner.account.address]);

    // The vault issues receipts on the collection's behalf.
    await receipt.write.addMinter([vault.address]);

    await receipt.write.setTier([1n, "Supporter", "ipfs://QmSupporter/1.json", true]);
    await receipt.write.setTier([2n, "Guardian", "ipfs://QmGuardian/2.json", true]);

    // Fund donors in both currencies.
    for (const d of [donor1, donor2, donor3]) {
      await usdc.write.mint([d.account.address, USDC(10_000)]);
      await copm.write.mint([d.account.address, COP(50_000_000)]);
    }
  });

  // ==================== DEPLOYMENT ====================

  it("Should grant deployer admin roles", async function () {
    assert.equal(await vault.read.isAdmin([owner.account.address]), true);
    assert.equal(await vault.read.isSuperAdmin([owner.account.address]), true);
  });

  it("Should expose the ETH sentinel", async function () {
    const sentinel = await vault.read.ETH_TOKEN();
    assert.equal(sentinel.toLowerCase(), ETH_TOKEN.toLowerCase());
  });

  // ==================== CAMPAIGN CREATION ====================

  it("Should create a campaign", async function () {
    const id = await createCampaign();
    const c = await vault.read.getCampaign([id]);

    assert.equal(c.name, "Cali Earthquake Relief 2026");
    assert.equal(c.beneficiary.toLowerCase(), beneficiary.account.address.toLowerCase());
    assert.equal(c.receiptCollection.toLowerCase(), receipt.address.toLowerCase());
    assert.equal(c.active, true);
    assert.equal(c.donorCount, 0n);
    assert.equal(c.donationCount, 0n);
  });

  it("Should reject an empty campaign name", async function () {
    await assert.rejects(() => createCampaign({ name: "" }), /EmptyName/);
  });

  it("Should reject a zero beneficiary", async function () {
    await assert.rejects(() => createCampaign({ beneficiary: ZERO }), /InvalidBeneficiary/);
  });

  it("Should allow a campaign with no receipt collection", async function () {
    const id = await createCampaign({ receiptCollection: ZERO });
    const c = await vault.read.getCampaign([id]);
    assert.equal(c.receiptCollection.toLowerCase(), ZERO);
  });

  it("Only admins can create campaigns", async function () {
    await assert.rejects(
      () =>
        vault.write.createCampaign(
          ["Rogue", "", beneficiary.account.address, ZERO, false],
          { account: donor1.account }
        ),
      /AccessControlUnauthorizedAccount/
    );
  });

  // ==================== ROUTER MODE (autoForward) ====================

  it("Router mode forwards each donation straight to the beneficiary", async function () {
    const id = await createCampaign({ autoForward: true });
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    assert.equal((await vault.read.getCampaign([id])).autoForward, true);

    const before = await publicClient.getBalance({ address: beneficiary.account.address });
    await vault.write.donate([id, ETH_TOKEN, parseEther("1"), "router"], {
      account: donor1.account,
      value: parseEther("1"),
    });
    const after = await publicClient.getBalance({ address: beneficiary.account.address });

    // Landed at the Safe in the same transaction — the vault never held it.
    assert.equal(after - before, parseEther("1"));
    assert.equal(await vault.read.availableBalance([id, ETH_TOKEN]), 0n);

    // Raised is still the permanent public record.
    assert.equal(await vault.read.totalRaised([id, ETH_TOKEN]), parseEther("1"));
    assert.equal(await vault.read.totalWithdrawn([id, ETH_TOKEN]), parseEther("1"));
  });

  it("Router mode forwards ERC-20 donations too", async function () {
    const id = await createCampaign({ autoForward: true });
    await vault.write.setAcceptedToken([id, usdc.address, true]);

    const before = await usdc.read.balanceOf([beneficiary.account.address]);
    await usdc.write.approve([vault.address, USDC(250)], { account: donor1.account });
    await vault.write.donate([id, usdc.address, USDC(250), ""], { account: donor1.account });
    const after = await usdc.read.balanceOf([beneficiary.account.address]);

    assert.equal(after - before, USDC(250));
    assert.equal(await vault.read.availableBalance([id, usdc.address]), 0n);
  });

  it("Router mode still issues receipts", async function () {
    const id = await createCampaign({ autoForward: true });
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setTiers([id, usdc.address, [{ minAmount: USDC(10), receiptTokenId: 1n }]]);

    const before = await receipt.read.balanceOf([donor2.account.address, 1n]);
    await usdc.write.approve([vault.address, USDC(50)], { account: donor2.account });
    await vault.write.donate([id, usdc.address, USDC(50), ""], { account: donor2.account });

    assert.equal(await receipt.read.balanceOf([donor2.account.address, 1n]), before + 1n);
  });

  it("A donation still settles when the beneficiary cannot receive", async function () {
    // A beneficiary that rejects ETH — the vault must fall back to holding.
    const rejecter = await viem.deployContract("MockEthRejecter", []);
    const id = await createCampaign({ autoForward: true, beneficiary: rejecter.address });
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await vault.write.donate([id, ETH_TOKEN, parseEther("1"), ""], {
      account: donor1.account,
      value: parseEther("1"),
    });

    // The donation is recorded and the funds are held, not lost.
    assert.equal(await vault.read.totalRaised([id, ETH_TOKEN]), parseEther("1"));
    assert.equal(await vault.read.totalWithdrawn([id, ETH_TOKEN]), 0n);
    assert.equal(await vault.read.availableBalance([id, ETH_TOKEN]), parseEther("1"));
  });

  it("Only a super admin can switch custody mode", async function () {
    const id = await createCampaign({ autoForward: true });

    await vault.write.addAdmin([admin.account.address]);
    await assert.rejects(
      () => vault.write.setAutoForward([id, false], { account: admin.account }),
      /AccessControlUnauthorizedAccount/
    );
    await vault.write.removeAdmin([admin.account.address]);

    await vault.write.setAutoForward([id, false]);
    assert.equal((await vault.read.getCampaign([id])).autoForward, false);
  });

  // ==================== ACCEPTED TOKENS ====================

  it("Admin can accept multiple tokens per campaign", async function () {
    const id = await createCampaign();

    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setAcceptedToken([id, copm.address, true]);

    const tokens = await vault.read.getAcceptedTokens([id]);
    assert.equal(tokens.length, 3);
    assert.equal(await vault.read.isTokenAccepted([id, usdc.address]), true);
    assert.equal(await vault.read.isTokenAccepted([id, copm.address]), true);
  });

  it("Admin can stop accepting a token", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setAcceptedToken([id, usdc.address, false]);

    assert.equal(await vault.read.isTokenAccepted([id, usdc.address]), false);
  });

  it("Should reject the zero address as a token", async function () {
    const id = await createCampaign();
    await assert.rejects(
      () => vault.write.setAcceptedToken([id, ZERO, true]),
      /InvalidToken/
    );
  });

  // ==================== TIERS ====================

  it("Admin can set per-token tiers with different decimals", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setAcceptedToken([id, copm.address, true]);

    // 10 / 100 USDC (6 decimals)
    await vault.write.setTiers([
      id,
      usdc.address,
      [
        { minAmount: USDC(10), receiptTokenId: 1n },
        { minAmount: USDC(100), receiptTokenId: 2n },
      ],
    ]);

    // Roughly equivalent value in COPm (18 decimals)
    await vault.write.setTiers([
      id,
      copm.address,
      [
        { minAmount: COP(40_000), receiptTokenId: 1n },
        { minAmount: COP(400_000), receiptTokenId: 2n },
      ],
    ]);

    assert.equal((await vault.read.getTiers([id, usdc.address])).length, 2);
    assert.equal((await vault.read.getTiers([id, copm.address])).length, 2);
  });

  it("Should reject tiers that are not strictly ascending", async function () {
    const id = await createCampaign();
    await assert.rejects(
      () =>
        vault.write.setTiers([
          id,
          usdc.address,
          [
            { minAmount: USDC(100), receiptTokenId: 1n },
            { minAmount: USDC(10), receiptTokenId: 2n },
          ],
        ]),
      /TiersNotAscending/
    );
  });

  it("resolveTier picks the highest qualifying tier", async function () {
    const id = await createCampaign();
    await vault.write.setTiers([
      id,
      usdc.address,
      [
        { minAmount: USDC(10), receiptTokenId: 1n },
        { minAmount: USDC(100), receiptTokenId: 2n },
      ],
    ]);

    const [belowFound] = await vault.read.resolveTier([id, usdc.address, USDC(5)]);
    assert.equal(belowFound, false);

    const [lowFound, lowId] = await vault.read.resolveTier([id, usdc.address, USDC(50)]);
    assert.equal(lowFound, true);
    assert.equal(lowId, 1n);

    const [highFound, highId] = await vault.read.resolveTier([id, usdc.address, USDC(500)]);
    assert.equal(highFound, true);
    assert.equal(highId, 2n);
  });

  // ==================== DONATIONS ====================

  it("Should accept an ETH donation and attribute it", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await vault.write.donate([id, ETH_TOKEN, parseEther("1"), "Fuerza Cali"], {
      account: donor1.account,
      value: parseEther("1"),
    });

    assert.equal(await vault.read.totalRaised([id, ETH_TOKEN]), parseEther("1"));
    assert.equal(
      await vault.read.getDonation([id, donor1.account.address, ETH_TOKEN]),
      parseEther("1")
    );

    const c = await vault.read.getCampaign([id]);
    assert.equal(c.donorCount, 1n);
    assert.equal(c.donationCount, 1n);
  });

  it("Should accept a USDC donation", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);

    await usdc.write.approve([vault.address, USDC(500)], { account: donor1.account });
    await vault.write.donate([id, usdc.address, USDC(500), ""], { account: donor1.account });

    assert.equal(await vault.read.totalRaised([id, usdc.address]), USDC(500));
    assert.equal(await usdc.read.balanceOf([vault.address]), USDC(500));
  });

  it("Should accept a COPm donation (18 decimals)", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, copm.address, true]);

    await copm.write.approve([vault.address, COP(1_000_000)], { account: donor1.account });
    await vault.write.donate([id, copm.address, COP(1_000_000), "Desde Colombia"], {
      account: donor1.account,
    });

    assert.equal(await vault.read.totalRaised([id, copm.address]), COP(1_000_000));
  });

  it("Should accept donations in several tokens for one campaign", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setAcceptedToken([id, copm.address, true]);

    await vault.write.donate([id, ETH_TOKEN, parseEther("0.5"), ""], {
      account: donor1.account,
      value: parseEther("0.5"),
    });

    await usdc.write.approve([vault.address, USDC(200)], { account: donor2.account });
    await vault.write.donate([id, usdc.address, USDC(200), ""], { account: donor2.account });

    await copm.write.approve([vault.address, COP(800_000)], { account: donor3.account });
    await vault.write.donate([id, copm.address, COP(800_000), ""], { account: donor3.account });

    const [tokens, raised] = await vault.read.getCampaignTotals([id]);
    assert.equal(tokens.length, 3);

    const total = Object.fromEntries(
      tokens.map((t: string, i: number) => [t.toLowerCase(), raised[i]])
    );
    assert.equal(total[ETH_TOKEN.toLowerCase()], parseEther("0.5"));
    assert.equal(total[usdc.address.toLowerCase()], USDC(200));
    assert.equal(total[copm.address.toLowerCase()], COP(800_000));

    const c = await vault.read.getCampaign([id]);
    assert.equal(c.donorCount, 3n);
  });

  it("Should count a repeat donor only once", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await vault.write.donate([id, ETH_TOKEN, parseEther("0.1"), ""], {
      account: donor1.account,
      value: parseEther("0.1"),
    });
    await vault.write.donate([id, ETH_TOKEN, parseEther("0.2"), ""], {
      account: donor1.account,
      value: parseEther("0.2"),
    });

    const c = await vault.read.getCampaign([id]);
    assert.equal(c.donorCount, 1n);
    assert.equal(c.donationCount, 2n);
    assert.equal(
      await vault.read.getDonation([id, donor1.account.address, ETH_TOKEN]),
      parseEther("0.3")
    );
  });

  it("Should reject a donation in an unaccepted token", async function () {
    const id = await createCampaign();
    await usdc.write.approve([vault.address, USDC(10)], { account: donor1.account });

    await assert.rejects(
      () => vault.write.donate([id, usdc.address, USDC(10), ""], { account: donor1.account }),
      /TokenNotAccepted/
    );
  });

  it("Should reject a zero donation", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await assert.rejects(
      () => vault.write.donate([id, ETH_TOKEN, 0n, ""], { account: donor1.account }),
      /ZeroAmount/
    );
  });

  it("Should reject an ETH donation whose value does not match", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await assert.rejects(
      () =>
        vault.write.donate([id, ETH_TOKEN, parseEther("1"), ""], {
          account: donor1.account,
          value: parseEther("0.5"),
        }),
      /IncorrectEthAmount/
    );
  });

  it("Should reject ETH sent alongside an ERC-20 donation", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await usdc.write.approve([vault.address, USDC(10)], { account: donor1.account });

    await assert.rejects(
      () =>
        vault.write.donate([id, usdc.address, USDC(10), ""], {
          account: donor1.account,
          value: parseEther("0.01"),
        }),
      /EthNotAccepted/
    );
  });

  it("Should reject a donation to an inactive campaign", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);
    await vault.write.updateCampaign([id, "Closed", "no longer accepting", false]);

    await assert.rejects(
      () =>
        vault.write.donate([id, ETH_TOKEN, parseEther("0.1"), ""], {
          account: donor1.account,
          value: parseEther("0.1"),
        }),
      /CampaignNotActive/
    );
  });

  it("Should reject direct ETH transfers", async function () {
    const before = await publicClient.getBalance({ address: vault.address });

    await assert.rejects(
      owner.sendTransaction({ to: vault.address, value: parseEther("1") })
    );

    assert.equal(await publicClient.getBalance({ address: vault.address }), before);
  });

  it("Should credit only what actually arrived from a fee-on-transfer token", async function () {
    const fee = await viem.deployContract("MockFeeToken", [100n]); // 1% burned on transfer
    await fee.write.mint([donor1.account.address, parseEther("1000")]);

    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, fee.address, true]);

    await fee.write.approve([vault.address, parseEther("100")], { account: donor1.account });
    await vault.write.donate([id, fee.address, parseEther("100"), ""], {
      account: donor1.account,
    });

    // 1% burned in flight, so 99 arrived — credit the real amount, not the ask.
    const expected = parseEther("99");
    assert.equal(await vault.read.totalRaised([id, fee.address]), expected);
    assert.equal(await fee.read.balanceOf([vault.address]), expected);
    assert.equal(await vault.read.availableBalance([id, fee.address]), expected);
  });

  // ==================== RECEIPTS ====================

  it("Should issue the matching receipt tier on a qualifying donation", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setTiers([
      id,
      usdc.address,
      [
        { minAmount: USDC(10), receiptTokenId: 1n },
        { minAmount: USDC(100), receiptTokenId: 2n },
      ],
    ]);

    const before1 = await receipt.read.balanceOf([donor2.account.address, 1n]);
    const before2 = await receipt.read.balanceOf([donor2.account.address, 2n]);

    // 50 USDC → Supporter (tier 1)
    await usdc.write.approve([vault.address, USDC(50)], { account: donor2.account });
    await vault.write.donate([id, usdc.address, USDC(50), ""], { account: donor2.account });
    assert.equal(await receipt.read.balanceOf([donor2.account.address, 1n]), before1 + 1n);

    // 150 USDC → Guardian (tier 2)
    await usdc.write.approve([vault.address, USDC(150)], { account: donor2.account });
    await vault.write.donate([id, usdc.address, USDC(150), ""], { account: donor2.account });
    assert.equal(await receipt.read.balanceOf([donor2.account.address, 2n]), before2 + 1n);
  });

  it("Should not issue a receipt below the lowest threshold", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setTiers([id, usdc.address, [{ minAmount: USDC(10), receiptTokenId: 1n }]]);

    const before = await receipt.read.balanceOf([donor3.account.address, 1n]);

    await usdc.write.approve([vault.address, USDC(5)], { account: donor3.account });
    await vault.write.donate([id, usdc.address, USDC(5), ""], { account: donor3.account });

    assert.equal(await receipt.read.balanceOf([donor3.account.address, 1n]), before);
    assert.equal(await vault.read.totalRaised([id, usdc.address]), USDC(5));
  });

  it("Should use COPm thresholds for COPm donations", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, copm.address, true]);
    await vault.write.setTiers([
      id,
      copm.address,
      [
        { minAmount: COP(40_000), receiptTokenId: 1n },
        { minAmount: COP(400_000), receiptTokenId: 2n },
      ],
    ]);

    const before = await receipt.read.balanceOf([donor3.account.address, 2n]);

    await copm.write.approve([vault.address, COP(500_000)], { account: donor3.account });
    await vault.write.donate([id, copm.address, COP(500_000), ""], { account: donor3.account });

    assert.equal(await receipt.read.balanceOf([donor3.account.address, 2n]), before + 1n);
  });

  it("A donation must still succeed when receipt minting fails", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);

    // Point at a tier the collection has never configured — minting will revert.
    await vault.write.setTiers([
      id,
      usdc.address,
      [{ minAmount: USDC(10), receiptTokenId: 4242n }],
    ]);

    await usdc.write.approve([vault.address, USDC(100)], { account: donor1.account });
    await vault.write.donate([id, usdc.address, USDC(100), "relief"], {
      account: donor1.account,
    });

    // The money landed even though no receipt could be issued.
    assert.equal(await vault.read.totalRaised([id, usdc.address]), USDC(100));
    assert.equal(await receipt.read.balanceOf([donor1.account.address, 4242n]), 0n);
  });

  it("A donation must still succeed when the vault loses MINTER_ROLE", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setTiers([id, usdc.address, [{ minAmount: USDC(10), receiptTokenId: 1n }]]);

    await receipt.write.removeMinter([vault.address]);

    await usdc.write.approve([vault.address, USDC(50)], { account: donor1.account });
    await vault.write.donate([id, usdc.address, USDC(50), ""], { account: donor1.account });

    assert.equal(await vault.read.totalRaised([id, usdc.address]), USDC(50));

    await receipt.write.addMinter([vault.address]);
  });

  it("Should skip receipts entirely when no collection is configured", async function () {
    const id = await createCampaign({ receiptCollection: ZERO });
    await vault.write.setAcceptedToken([id, usdc.address, true]);
    await vault.write.setTiers([id, usdc.address, [{ minAmount: USDC(10), receiptTokenId: 1n }]]);

    await usdc.write.approve([vault.address, USDC(50)], { account: donor1.account });
    await vault.write.donate([id, usdc.address, USDC(50), ""], { account: donor1.account });

    assert.equal(await vault.read.totalRaised([id, usdc.address]), USDC(50));
  });

  // ==================== WITHDRAWALS ====================

  it("Should withdraw ETH only to the beneficiary", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await vault.write.donate([id, ETH_TOKEN, parseEther("2"), ""], {
      account: donor1.account,
      value: parseEther("2"),
    });

    const before = await publicClient.getBalance({ address: beneficiary.account.address });
    await vault.write.withdraw([id, ETH_TOKEN, parseEther("2")]);
    const after = await publicClient.getBalance({ address: beneficiary.account.address });

    assert.equal(after - before, parseEther("2"));
    assert.equal(await vault.read.availableBalance([id, ETH_TOKEN]), 0n);
    assert.equal(await vault.read.totalWithdrawn([id, ETH_TOKEN]), parseEther("2"));
    // totalRaised is a permanent record and must not be reduced by a withdrawal.
    assert.equal(await vault.read.totalRaised([id, ETH_TOKEN]), parseEther("2"));
  });

  it("Should withdraw ERC-20 to the beneficiary", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, usdc.address, true]);

    await usdc.write.approve([vault.address, USDC(300)], { account: donor1.account });
    await vault.write.donate([id, usdc.address, USDC(300), ""], { account: donor1.account });

    const before = await usdc.read.balanceOf([beneficiary.account.address]);
    await vault.write.withdrawAll([id, usdc.address]);
    const after = await usdc.read.balanceOf([beneficiary.account.address]);

    assert.equal(after - before, USDC(300));
    assert.equal(await vault.read.availableBalance([id, usdc.address]), 0n);
  });

  it("Should reject withdrawing more than a campaign raised", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await vault.write.donate([id, ETH_TOKEN, parseEther("1"), ""], {
      account: donor1.account,
      value: parseEther("1"),
    });

    await assert.rejects(
      () => vault.write.withdraw([id, ETH_TOKEN, parseEther("2")]),
      /InsufficientBalance/
    );
  });

  it("Should keep campaign balances isolated from each other", async function () {
    const idA = await createCampaign({ name: "Campaign A" });
    const idB = await createCampaign({ name: "Campaign B" });
    await vault.write.setAcceptedToken([idA, ETH_TOKEN, true]);
    await vault.write.setAcceptedToken([idB, ETH_TOKEN, true]);

    await vault.write.donate([idA, ETH_TOKEN, parseEther("1"), ""], {
      account: donor1.account,
      value: parseEther("1"),
    });

    // B raised nothing, so it can withdraw nothing — even though the contract
    // holds A's ETH.
    await assert.rejects(
      () => vault.write.withdraw([idB, ETH_TOKEN, parseEther("1")]),
      /InsufficientBalance/
    );
    assert.equal(await vault.read.availableBalance([idB, ETH_TOKEN]), 0n);
    assert.equal(await vault.read.availableBalance([idA, ETH_TOKEN]), parseEther("1"));
  });

  it("Non-admin cannot withdraw", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);
    await vault.write.donate([id, ETH_TOKEN, parseEther("0.5"), ""], {
      account: donor1.account,
      value: parseEther("0.5"),
    });

    await assert.rejects(
      () =>
        vault.write.withdraw([id, ETH_TOKEN, parseEther("0.5")], { account: donor1.account }),
      /AccessControlUnauthorizedAccount/
    );
  });

  // ==================== BENEFICIARY ====================

  it("Only a super admin can change the beneficiary", async function () {
    const id = await createCampaign();

    await vault.write.addAdmin([admin.account.address]);
    await assert.rejects(
      () => vault.write.setBeneficiary([id, donor1.account.address], { account: admin.account }),
      /AccessControlUnauthorizedAccount/
    );

    await vault.write.setBeneficiary([id, donor1.account.address]);
    const c = await vault.read.getCampaign([id]);
    assert.equal(c.beneficiary.toLowerCase(), donor1.account.address.toLowerCase());

    await vault.write.removeAdmin([admin.account.address]);
  });

  it("Should reject a zero beneficiary update", async function () {
    const id = await createCampaign();
    await assert.rejects(() => vault.write.setBeneficiary([id, ZERO]), /InvalidBeneficiary/);
  });

  // ==================== DONOR WALL ====================

  it("Should expose a paginated donor wall with amounts", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await vault.write.donate([id, ETH_TOKEN, parseEther("0.3"), "uno"], {
      account: donor1.account,
      value: parseEther("0.3"),
    });
    await vault.write.donate([id, ETH_TOKEN, parseEther("0.2"), "dos"], {
      account: donor2.account,
      value: parseEther("0.2"),
    });
    await vault.write.donate([id, ETH_TOKEN, parseEther("0.1"), "tres"], {
      account: donor3.account,
      value: parseEther("0.1"),
    });

    assert.equal((await vault.read.getDonors([id])).length, 3);

    const [page, total] = await vault.read.getDonorsPaginated([id, 0n, 2n]);
    assert.equal(page.length, 2);
    assert.equal(total, 3n);

    const [donors, amounts, tot] = await vault.read.getDonorsWithAmounts([
      id,
      ETH_TOKEN,
      0n,
      10n,
    ]);
    assert.equal(tot, 3n);
    const byDonor = Object.fromEntries(
      donors.map((d: string, i: number) => [d.toLowerCase(), amounts[i]])
    );
    assert.equal(byDonor[donor1.account.address.toLowerCase()], parseEther("0.3"));
    assert.equal(byDonor[donor3.account.address.toLowerCase()], parseEther("0.1"));
  });

  it("Should return an empty page past the end of the donor list", async function () {
    const id = await createCampaign();
    const [page, total] = await vault.read.getDonorsPaginated([id, 50n, 10n]);
    assert.equal(page.length, 0);
    assert.equal(total, 0n);
  });

  // ==================== PAUSE + GUARDS ====================

  it("Should block donations while paused", async function () {
    const id = await createCampaign();
    await vault.write.setAcceptedToken([id, ETH_TOKEN, true]);

    await vault.write.pause();

    await assert.rejects(
      () =>
        vault.write.donate([id, ETH_TOKEN, parseEther("0.1"), ""], {
          account: donor1.account,
          value: parseEther("0.1"),
        }),
      /EnforcedPause/
    );

    const [allowed, reason] = await vault.read.canDonate([id, ETH_TOKEN, parseEther("0.1")]);
    assert.equal(allowed, false);
    assert.equal(reason, "Donations are paused");

    await vault.write.unpause();
    await vault.write.donate([id, ETH_TOKEN, parseEther("0.1"), ""], {
      account: donor1.account,
      value: parseEther("0.1"),
    });
  });

  it("canDonate should explain every rejection", async function () {
    const id = await createCampaign();

    let [allowed, reason] = await vault.read.canDonate([999n, ETH_TOKEN, 1n]);
    assert.equal(allowed, false);
    assert.equal(reason, "Campaign does not exist");

    [allowed, reason] = await vault.read.canDonate([id, usdc.address, USDC(1)]);
    assert.equal(allowed, false);
    assert.equal(reason, "Token not accepted");

    await vault.write.setAcceptedToken([id, usdc.address, true]);

    [allowed, reason] = await vault.read.canDonate([id, usdc.address, 0n]);
    assert.equal(allowed, false);
    assert.equal(reason, "Amount must be greater than zero");

    [allowed, reason] = await vault.read.canDonate([id, usdc.address, USDC(1)]);
    assert.equal(allowed, true);
    assert.equal(reason, "");

    await vault.write.updateCampaign([id, "Closed", "", false]);
    [allowed, reason] = await vault.read.canDonate([id, usdc.address, USDC(1)]);
    assert.equal(allowed, false);
    assert.equal(reason, "Campaign not active");
  });

  it("Should reject operations on a nonexistent campaign", async function () {
    await assert.rejects(
      () => vault.write.setAcceptedToken([999n, ETH_TOKEN, true]),
      /CampaignDoesNotExist/
    );
  });

  // ==================== FINAL ACCOUNTING INVARIANT ====================

  it("Contract ETH balance must equal the sum of unwithdrawn ETH across campaigns", async function () {
    const count = await vault.read.campaignCount();
    let expected = 0n;
    for (let i = 0n; i < count; i++) {
      expected += await vault.read.availableBalance([i, ETH_TOKEN]);
    }

    const actual = await publicClient.getBalance({ address: vault.address });
    assert.equal(actual, expected);
  });

  it("Contract USDC balance must equal the sum of unwithdrawn USDC across campaigns", async function () {
    const count = await vault.read.campaignCount();
    let expected = 0n;
    for (let i = 0n; i < count; i++) {
      expected += await vault.read.availableBalance([i, usdc.address]);
    }

    assert.equal(await usdc.read.balanceOf([vault.address]), expected);
  });
});
