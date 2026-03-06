import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";

const USDC_DECIMALS = 6n;
const USDC = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;

describe("Swag1155", async function () {
  const { viem } = await network.connect();
  const [deployer, buyer, buyer2, treasury] = await viem.getWalletClients();

  let usdc: any;
  let swag: any;
  let mockNft: any;

  const BASE_URI = "https://wallet.ethcali.org/metadata/{id}.json";

  before(async function () {
    // Deploy mocks
    usdc = await viem.deployContract("MockUSDC", []);
    mockNft = await viem.deployContract("MockERC721", []);

    // Mint USDC to buyers
    await usdc.write.mint([buyer.account.address, USDC(1000)]);
    await usdc.write.mint([buyer2.account.address, USDC(1000)]);

    // Deploy Swag1155 with deployer as initial admin
    swag = await viem.deployContract("Swag1155", [
      BASE_URI,
      usdc.address,
      treasury.account.address,
      deployer.account.address, // initialAdmin
    ]);
  });

  it("Initial configuration set correctly", async function () {
    // OZ ERC1155 returns the base URI; clients replace {id}
    assert.equal(await swag.read.uri([0n]), BASE_URI);
    const usdcAddr = await swag.read.usdc();
    const treasAddr = await swag.read.treasury();
    assert.equal(usdcAddr.toLowerCase(), usdc.address.toLowerCase());
    assert.equal(treasAddr.toLowerCase(), treasury.account.address.toLowerCase());
  });

  it("Admin can upsert variant and users can buy", async function () {
    const tokenId = 102n; // Product 1, size 02 (M)

    // Upsert variant: price 25 USDC, maxSupply 100, active
    await swag.write.setVariant([tokenId, USDC(25), 100n, true]);

    // Approve USDC
    await usdc.write.approve([swag.address, USDC(1000)], { account: buyer.account });

    // Buy 2 units
    await swag.write.buy([tokenId, 2n], { account: buyer.account });

    const bal = await swag.read.balanceOf([buyer.account.address, tokenId]);
    assert.equal(bal, 2n);

    const v = await swag.read.getVariant([tokenId]);
    assert.equal(v.minted, 2n);
    assert.equal(v.price, USDC(25));
    assert.equal(v.maxSupply, 100n);

    // Treasury received 50 USDC
    const tBal = await usdc.read.balanceOf([treasury.account.address]);
    assert.equal(tBal, USDC(50));
  });

  it("Enforces supply limits and active status", async function () {
    const tokenId = 103n; // Product 1, size 03 (L)

    await swag.write.setVariant([tokenId, USDC(15), 3n, false]);

    // Inactive should revert
    try {
      await swag.write.buy([tokenId, 1n], { account: buyer.account });
      assert.fail("Should revert for inactive variant");
    } catch (e: any) {
      assert(e.message.includes("variant inactive"));
    }

    // Activate and test supply enforcement
    await swag.write.setVariant([tokenId, USDC(15), 3n, true]);
    await usdc.write.approve([swag.address, USDC(100)], { account: buyer.account });

    await swag.write.buy([tokenId, 2n], { account: buyer.account });

    // Exceed remaining
    try {
      await swag.write.buy([tokenId, 2n], { account: buyer.account });
      assert.fail("Should revert for exceeds supply");
    } catch (e: any) {
      assert(e.message.includes("exceeds supply"));
    }
  });

  it("Batch purchase works with single payment", async function () {
    const ids = [201n, 202n];
    const qtys = [1n, 3n];

    await swag.write.setVariant([ids[0], USDC(10), 10n, true]);
    await swag.write.setVariant([ids[1], USDC(5), 10n, true]);

    const total = USDC(10) + USDC(5) * 3n; // 25 USDC

    await usdc.write.approve([swag.address, USDC(100)], { account: buyer2.account });
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);

    await swag.write.buyBatch([ids, qtys], { account: buyer2.account });

    const b1 = await swag.read.balanceOf([buyer2.account.address, ids[0]]);
    const b2 = await swag.read.balanceOf([buyer2.account.address, ids[1]]);
    assert.equal(b1, 1n);
    assert.equal(b2, 3n);

    const tAfter = await usdc.read.balanceOf([treasury.account.address]);
    assert.equal(tAfter - tBefore, total);

    const v201 = await swag.read.getVariant([ids[0]]);
    const v202 = await swag.read.getVariant([ids[1]]);
    assert.equal(v201.minted, 1n);
    assert.equal(v202.minted, 3n);
  });

  it("Reverts on zero quantity and length mismatch", async function () {
    const id = 301n;
    await swag.write.setVariant([id, USDC(1), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });

    try {
      await swag.write.buy([id, 0n], { account: buyer.account });
      assert.fail("Should revert invalid quantity");
    } catch (e: any) {
      assert(e.message.includes("invalid quantity"));
    }

    try {
      await swag.write.buyBatch([[id], [1n, 2n]], { account: buyer.account } as any);
      assert.fail("Should revert length mismatch");
    } catch (e: any) {
      assert(e.message.includes("length mismatch"));
    }
  });

  it("Admin can set variant with per-token URI", async function () {
    const tokenId = 401n;
    const metadataURI = "ipfs://QmAbc123/metadata.json";

    await swag.write.setVariantWithURI([
      tokenId,
      USDC(30),
      50n,
      true,
      metadataURI,
    ]);

    const v = await swag.read.getVariant([tokenId]);
    assert.equal(v.price, USDC(30));
    assert.equal(v.maxSupply, 50n);
    assert.equal(v.active, true);

    const uri = await swag.read.uri([tokenId]);
    assert.equal(uri, metadataURI);
  });

  it("Per-token URI overrides baseURI", async function () {
    const tokenId = 402n;
    const metadataURI = "ipfs://QmCustom/token.json";

    await swag.write.setVariantWithURI([tokenId, USDC(20), 20n, true, metadataURI]);

    const uri = await swag.read.uri([tokenId]);
    assert.equal(uri, metadataURI);

    // Token without per-token URI should use baseURI
    const tokenId2 = 403n;
    await swag.write.setVariant([tokenId2, USDC(20), 20n, true]);

    const uri2 = await swag.read.uri([tokenId2]);
    assert(uri2.includes(BASE_URI) || uri2.includes("0000000000000000000000000000000000000000000000000000000000000193"));
  });

  // ==================== REDEMPTION TESTS ====================

  it("User can redeem their NFT", async function () {
    const tokenId = 501n;

    // Setup: create variant and buy
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });
    await swag.write.buy([tokenId, 1n], { account: buyer.account });

    // Check initial status is NotRedeemed (0)
    const statusBefore = await swag.read.getRedemptionStatus([tokenId, buyer.account.address]);
    assert.equal(statusBefore, 0); // NotRedeemed

    // Redeem
    await swag.write.redeem([tokenId], { account: buyer.account });

    // Check status is PendingFulfillment (1)
    const statusAfter = await swag.read.getRedemptionStatus([tokenId, buyer.account.address]);
    assert.equal(statusAfter, 1); // PendingFulfillment
  });

  it("User cannot redeem if they don't own the NFT", async function () {
    const tokenId = 502n;

    // Setup: create variant but don't buy
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);

    // Try to redeem without owning
    try {
      await swag.write.redeem([tokenId], { account: buyer2.account });
      assert.fail("Should revert for non-owner");
    } catch (e: any) {
      assert(e.message.includes("not owner"));
    }
  });

  it("User cannot redeem same token twice", async function () {
    const tokenId = 503n;

    // Setup: create variant and buy
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });
    await swag.write.buy([tokenId, 1n], { account: buyer.account });

    // First redemption should succeed
    await swag.write.redeem([tokenId], { account: buyer.account });

    // Second redemption should fail
    try {
      await swag.write.redeem([tokenId], { account: buyer.account });
      assert.fail("Should revert for already redeemed");
    } catch (e: any) {
      assert(e.message.includes("already redeemed"));
    }
  });

  it("Admin can mark redemption as fulfilled", async function () {
    const tokenId = 504n;

    // Setup: create variant, buy, and redeem
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    await swag.write.redeem([tokenId], { account: buyer.account });

    // Verify status is PendingFulfillment
    const statusBefore = await swag.read.getRedemptionStatus([tokenId, buyer.account.address]);
    assert.equal(statusBefore, 1); // PendingFulfillment

    // Admin marks as fulfilled
    await swag.write.markFulfilled([tokenId, buyer.account.address]);

    // Check status is Fulfilled (2)
    const statusAfter = await swag.read.getRedemptionStatus([tokenId, buyer.account.address]);
    assert.equal(statusAfter, 2); // Fulfilled
  });

  it("Non-admin cannot mark as fulfilled", async function () {
    const tokenId = 505n;

    // Setup: create variant, buy, and redeem
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    await swag.write.redeem([tokenId], { account: buyer.account });

    // Non-admin tries to mark as fulfilled
    try {
      await swag.write.markFulfilled([tokenId, buyer.account.address], { account: buyer2.account });
      assert.fail("Should revert for non-admin");
    } catch (e: any) {
      assert(e.message.includes("AccessControl"));
    }
  });

  it("Cannot mark as fulfilled if not pending", async function () {
    const tokenId = 506n;

    // Setup: create variant and buy but DON'T redeem
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });
    await swag.write.buy([tokenId, 1n], { account: buyer.account });

    // Try to mark as fulfilled without redemption request
    try {
      await swag.write.markFulfilled([tokenId, buyer.account.address]);
      assert.fail("Should revert for not pending");
    } catch (e: any) {
      assert(e.message.includes("not pending"));
    }
  });

  it("Full redemption flow: buy -> redeem -> fulfill", async function () {
    const tokenId = 507n;

    // Setup variant
    await swag.write.setVariant([tokenId, USDC(20), 5n, true]);
    await usdc.write.approve([swag.address, USDC(20)], { account: buyer2.account });

    // Step 1: Buy
    await swag.write.buy([tokenId, 1n], { account: buyer2.account });
    const balance = await swag.read.balanceOf([buyer2.account.address, tokenId]);
    assert.equal(balance, 1n);

    // Step 2: Check initial status
    let status = await swag.read.getRedemptionStatus([tokenId, buyer2.account.address]);
    assert.equal(status, 0); // NotRedeemed

    // Step 3: Redeem
    await swag.write.redeem([tokenId], { account: buyer2.account });
    status = await swag.read.getRedemptionStatus([tokenId, buyer2.account.address]);
    assert.equal(status, 1); // PendingFulfillment

    // Step 4: Admin fulfills
    await swag.write.markFulfilled([tokenId, buyer2.account.address]);
    status = await swag.read.getRedemptionStatus([tokenId, buyer2.account.address]);
    assert.equal(status, 2); // Fulfilled

    // User still owns the NFT (proof of purchase)
    const finalBalance = await swag.read.balanceOf([buyer2.account.address, tokenId]);
    assert.equal(finalBalance, 1n);
  });

  // ==================== ROYALTY TESTS ====================

  it("Should add royalty recipient", async function () {
    const tokenId = 601n;
    await swag.write.setVariant([tokenId, USDC(100), 100n, true]);
    await swag.write.addRoyalty([tokenId, buyer.account.address, 1000n]); // 10%

    const royalties = await swag.read.getRoyalties([tokenId]);
    assert.equal(royalties.length, 1);
    assert.equal(royalties[0].recipient.toLowerCase(), buyer.account.address.toLowerCase());
    assert.equal(royalties[0].percentage, 1000n);
  });

  it("Should distribute royalties on purchase", async function () {
    const tokenId = 602n;
    const price = USDC(100);
    const artistAddress = buyer2.account.address;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addRoyalty([tokenId, artistAddress, 1000n]); // 10%

    // Mint USDC to deployer for purchase
    await usdc.write.mint([deployer.account.address, USDC(200)]);
    await usdc.write.approve([swag.address, price], { account: deployer.account });

    const artistBefore = await usdc.read.balanceOf([artistAddress]);
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);

    await swag.write.buy([tokenId, 1n], { account: deployer.account });

    const artistAfter = await usdc.read.balanceOf([artistAddress]);
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    // Artist gets 10%
    assert.equal(artistAfter - artistBefore, USDC(10));
    // Treasury gets 90%
    assert.equal(treasuryAfter - treasuryBefore, USDC(90));
  });

  it("Should support multiple royalty recipients", async function () {
    const tokenId = 603n;
    const price = USDC(100);

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addRoyalty([tokenId, buyer.account.address, 500n]); // 5%
    await swag.write.addRoyalty([tokenId, buyer2.account.address, 300n]); // 3%

    await usdc.write.mint([deployer.account.address, USDC(200)]);
    await usdc.write.approve([swag.address, price], { account: deployer.account });

    const artist1Before = await usdc.read.balanceOf([buyer.account.address]);
    const artist2Before = await usdc.read.balanceOf([buyer2.account.address]);
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);

    await swag.write.buy([tokenId, 1n], { account: deployer.account });

    const artist1After = await usdc.read.balanceOf([buyer.account.address]);
    const artist2After = await usdc.read.balanceOf([buyer2.account.address]);
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(artist1After - artist1Before, USDC(5));
    assert.equal(artist2After - artist2Before, USDC(3));
    assert.equal(treasuryAfter - treasuryBefore, USDC(92));
  });

  it("Should prevent exceeding 100% royalty", async function () {
    const tokenId = 604n;
    await swag.write.setVariant([tokenId, USDC(100), 100n, true]);
    await swag.write.addRoyalty([tokenId, buyer.account.address, 5000n]); // 50%

    try {
      await swag.write.addRoyalty([tokenId, buyer2.account.address, 5100n]); // Would exceed 100%
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("total royalty exceeds 100%"));
    }
  });

  it("Should clear royalties", async function () {
    const tokenId = 605n;
    await swag.write.setVariant([tokenId, USDC(100), 100n, true]);
    await swag.write.addRoyalty([tokenId, buyer.account.address, 1000n]);

    let royalties = await swag.read.getRoyalties([tokenId]);
    assert.equal(royalties.length, 1);

    await swag.write.clearRoyalties([tokenId]);

    royalties = await swag.read.getRoyalties([tokenId]);
    assert.equal(royalties.length, 0);

    const totalBps = await swag.read.totalRoyaltyBps([tokenId]);
    assert.equal(totalBps, 0n);
  });

  it("Should send full amount to treasury when no royalties", async function () {
    const tokenId = 606n;
    const price = USDC(50);

    await swag.write.setVariant([tokenId, price, 100n, true]);

    await usdc.write.mint([deployer.account.address, USDC(200)]);
    await usdc.write.approve([swag.address, price], { account: deployer.account });

    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: deployer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, price);
  });

  // ==================== DISCOUNT TESTS ====================

  it("POAP discount: buyer with POAP gets reduced price", async function () {
    const tokenId = 701n;
    const price = USDC(100);
    const eventId = 12345n;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, eventId, 1000n]); // 10%

    // Whitelist buyer for this POAP event
    await swag.write.addPoapWhitelist([tokenId, eventId, [buyer.account.address]]);

    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    // Should pay 90 USDC (10% off 100)
    assert.equal(treasuryAfter - treasuryBefore, USDC(90));
  });

  it("POAP discount: buyer without POAP pays full price", async function () {
    const tokenId = 702n;
    const price = USDC(100);

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, 99999n, 2000n]); // 20% for event 99999

    // buyer2 does NOT have this POAP
    await usdc.write.approve([swag.address, USDC(200)], { account: buyer2.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer2.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, price);
  });

  it("Remove POAP discount: buyer pays full price after removal", async function () {
    const tokenId = 703n;
    const price = USDC(100);
    const eventId = 55555n;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, eventId, 5000n]); // 50%
    await swag.write.addPoapWhitelist([tokenId, eventId, [buyer.account.address]]);

    // Remove the discount (index 0)
    await swag.write.removePoapDiscount([tokenId, 0n]);

    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, price);
  });

  it("Holder discount (percentage): NFT holder gets discount", async function () {
    const tokenId = 704n;
    const price = USDC(100);

    await swag.write.setVariant([tokenId, price, 100n, true]);
    // DiscountType.Percentage = 0
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 2000n]); // 20%

    // Give buyer an NFT
    await mockNft.write.mint([buyer.account.address]);

    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    // Should pay 80 USDC (20% off 100)
    assert.equal(treasuryAfter - treasuryBefore, USDC(80));
  });

  it("Holder discount (fixed): holder gets fixed amount off", async function () {
    const tokenId = 705n;
    const price = USDC(100);

    await swag.write.setVariant([tokenId, price, 100n, true]);
    // DiscountType.Fixed = 1, value = 15 USDC
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 1, USDC(15)]);

    // buyer already has NFT from previous test
    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    // Should pay 85 USDC (100 - 15 fixed)
    assert.equal(treasuryAfter - treasuryBefore, USDC(85));
  });

  it("Holder without token pays full price", async function () {
    const tokenId = 706n;
    const price = USDC(100);

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 2000n]); // 20%

    // buyer2 does NOT have the NFT
    await usdc.write.approve([swag.address, USDC(200)], { account: buyer2.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer2.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, price);
  });

  it("Additive stacking: POAP 10% + holder 20% = 30% off", async function () {
    const tokenId = 707n;
    const price = USDC(100);
    const eventId = 77777n;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, eventId, 1000n]); // 10%
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 2000n]); // 20%

    // buyer has NFT (from earlier) + whitelist for POAP
    await swag.write.addPoapWhitelist([tokenId, eventId, [buyer.account.address]]);

    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    // Should pay 70 USDC (30% off 100)
    assert.equal(treasuryAfter - treasuryBefore, USDC(70));
  });

  it("100% discount: POAP 50% + holder 50% = free", async function () {
    const tokenId = 708n;
    const price = USDC(100);
    const eventId = 88888n;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, eventId, 5000n]); // 50%
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 5000n]); // 50%

    await swag.write.addPoapWhitelist([tokenId, eventId, [buyer.account.address]]);

    const buyerUsdcBefore = await usdc.read.balanceOf([buyer.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const buyerUsdcAfter = await usdc.read.balanceOf([buyer.account.address]);

    // No USDC spent
    assert.equal(buyerUsdcAfter, buyerUsdcBefore);

    // But NFT minted
    const bal = await swag.read.balanceOf([buyer.account.address, tokenId]);
    assert.equal(bal, 1n);
  });

  it("Over 100% discount caps at free (no revert)", async function () {
    const tokenId = 709n;
    const price = USDC(100);
    const eventId = 99998n;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, eventId, 6000n]); // 60%
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 6000n]); // 60%

    await swag.write.addPoapWhitelist([tokenId, eventId, [buyer.account.address]]);

    const buyerUsdcBefore = await usdc.read.balanceOf([buyer.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const buyerUsdcAfter = await usdc.read.balanceOf([buyer.account.address]);

    assert.equal(buyerUsdcAfter, buyerUsdcBefore);
    const bal = await swag.read.balanceOf([buyer.account.address, tokenId]);
    assert.equal(bal, 1n);
  });

  it("Only POAP set, no holder discount", async function () {
    const tokenId = 710n;
    const price = USDC(100);
    const eventId = 11111n;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, eventId, 1500n]); // 15%

    await swag.write.addPoapWhitelist([tokenId, eventId, [buyer.account.address]]);

    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, USDC(85));
  });

  it("Only holder set, no POAP discount", async function () {
    const tokenId = 711n;
    const price = USDC(100);

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 2500n]); // 25%

    // buyer has NFT from earlier
    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, USDC(75));
  });

  it("getDiscountedPrice view returns correct price", async function () {
    const tokenId = 712n;
    const price = USDC(200);
    const eventId = 22222n;

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addPoapDiscount([tokenId, eventId, 1000n]); // 10%
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 500n]); // 5%

    await swag.write.addPoapWhitelist([tokenId, eventId, [buyer.account.address]]);

    const discounted = await swag.read.getDiscountedPrice([tokenId, buyer.account.address]);
    // 15% off 200 = 170
    assert.equal(discounted, USDC(170));

    // buyer2 has no POAP or NFT — full price
    const full = await swag.read.getDiscountedPrice([tokenId, buyer2.account.address]);
    assert.equal(full, price);
  });

  it("Admin-only access on discount functions", async function () {
    const tokenId = 713n;
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);

    try {
      await swag.write.addPoapDiscount([tokenId, 1n, 100n], { account: buyer.account });
      assert.fail("Should revert for non-admin");
    } catch (e: any) {
      assert(e.message.includes("AccessControl"));
    }

    try {
      await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 100n], { account: buyer.account });
      assert.fail("Should revert for non-admin");
    } catch (e: any) {
      assert(e.message.includes("AccessControl"));
    }
  });

  it("Remove holder discount: buyer pays full price after removal", async function () {
    const tokenId = 714n;
    const price = USDC(100);

    await swag.write.setVariant([tokenId, price, 100n, true]);
    await swag.write.addHolderDiscount([tokenId, mockNft.address, 0, 3000n]); // 30%

    // Remove it
    await swag.write.removeHolderDiscount([tokenId, 0n]);

    await usdc.write.approve([swag.address, USDC(200)], { account: buyer.account });
    const treasuryBefore = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    const treasuryAfter = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, price);
  });

  // ==================== SERIAL NUMBER TESTS ====================

  it("Single buy assigns serial #1 to buyer", async function () {
    const tokenId = 801n;

    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });
    await swag.write.buy([tokenId, 1n], { account: buyer.account });

    const serial1Owner = await swag.read.getSerialOwner([tokenId, 1n]);
    assert.equal(serial1Owner.toLowerCase(), buyer.account.address.toLowerCase());

    const nextSerial = await swag.read.nextSerial([tokenId]);
    assert.equal(nextSerial, 1n);
  });

  it("Buying quantity 3 assigns serials #1, #2, #3 sequentially", async function () {
    const tokenId = 802n;

    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(50)], { account: buyer.account });
    await swag.write.buy([tokenId, 3n], { account: buyer.account });

    for (let s = 1n; s <= 3n; s++) {
      const owner = await swag.read.getSerialOwner([tokenId, s]);
      assert.equal(owner.toLowerCase(), buyer.account.address.toLowerCase());
    }

    const nextSerial = await swag.read.nextSerial([tokenId]);
    assert.equal(nextSerial, 3n);
  });

  it("Two different buyers get distinct serials", async function () {
    const tokenId = 803n;

    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer.account });
    await usdc.write.approve([swag.address, USDC(10)], { account: buyer2.account });

    await swag.write.buy([tokenId, 1n], { account: buyer.account });
    await swag.write.buy([tokenId, 1n], { account: buyer2.account });

    const owner1 = await swag.read.getSerialOwner([tokenId, 1n]);
    const owner2 = await swag.read.getSerialOwner([tokenId, 2n]);

    assert.equal(owner1.toLowerCase(), buyer.account.address.toLowerCase());
    assert.equal(owner2.toLowerCase(), buyer2.account.address.toLowerCase());

    const nextSerial = await swag.read.nextSerial([tokenId]);
    assert.equal(nextSerial, 2n);
  });

  it("Serial counter is independent per tokenId", async function () {
    const tokenIdA = 804n;
    const tokenIdB = 805n;

    await swag.write.setVariant([tokenIdA, USDC(10), 10n, true]);
    await swag.write.setVariant([tokenIdB, USDC(10), 10n, true]);
    await usdc.write.approve([swag.address, USDC(50)], { account: buyer.account });

    await swag.write.buy([tokenIdA, 2n], { account: buyer.account });
    await swag.write.buy([tokenIdB, 1n], { account: buyer.account });

    assert.equal(await swag.read.nextSerial([tokenIdA]), 2n);
    assert.equal(await swag.read.nextSerial([tokenIdB]), 1n);

    // Serial #1 of tokenIdB belongs to buyer, not affected by tokenIdA's counter
    const ownerB1 = await swag.read.getSerialOwner([tokenIdB, 1n]);
    assert.equal(ownerB1.toLowerCase(), buyer.account.address.toLowerCase());
  });

  it("Batch buy assigns serials across multiple tokenIds", async function () {
    const tokenIdX = 806n;
    const tokenIdY = 807n;

    await swag.write.setVariant([tokenIdX, USDC(10), 10n, true]);
    await swag.write.setVariant([tokenIdY, USDC(5), 10n, true]);
    await usdc.write.approve([swag.address, USDC(50)], { account: buyer2.account });

    // Buy 2 of X and 3 of Y in one batch
    await swag.write.buyBatch([[tokenIdX, tokenIdY], [2n, 3n]], { account: buyer2.account });

    assert.equal(await swag.read.nextSerial([tokenIdX]), 2n);
    assert.equal(await swag.read.nextSerial([tokenIdY]), 3n);

    // All serials belong to buyer2
    for (let s = 1n; s <= 2n; s++) {
      const owner = await swag.read.getSerialOwner([tokenIdX, s]);
      assert.equal(owner.toLowerCase(), buyer2.account.address.toLowerCase());
    }
    for (let s = 1n; s <= 3n; s++) {
      const owner = await swag.read.getSerialOwner([tokenIdY, s]);
      assert.equal(owner.toLowerCase(), buyer2.account.address.toLowerCase());
    }
  });

  it("Unassigned serial returns address(0)", async function () {
    const tokenId = 808n;
    await swag.write.setVariant([tokenId, USDC(10), 10n, true]);

    // Nothing minted yet
    const owner = await swag.read.getSerialOwner([tokenId, 1n]);
    assert.equal(owner, "0x0000000000000000000000000000000000000000");
  });
});
