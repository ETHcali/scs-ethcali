import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseSignature } from "viem";

const USDC_DECIMALS = 6n;
const USDC = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;

const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

/**
 * Swag1155 sells one inventory through two channels: buy() on-chain, and
 * claim() against an EIP-712 voucher signed by the Shopify backend.
 *
 * The property that matters most is that the two channels have separate supply
 * buckets and cannot oversell each other — a physical hoodie exists once.
 */
describe("Swag1155", async function () {
  const { viem } = await network.connect();
  const [deployer, buyer, buyer2, treasury, signer, outsider] =
    await viem.getWalletClients();

  let usdc: any;
  let swag: any;
  let factory: any;
  let chainId: number;

  const BASE_URI = "https://app.ethcali.org/metadata/{id}.json";

  /** Deploy a fresh collection so tests never depend on each other's supply. */
  async function freshCollection(onchainCap: bigint, voucherCap: bigint) {
    await factory.write.deployCollection([
      "Test Product",
      `SKU-${onchainCap}-${voucherCap}-${Math.floor(Number(onchainCap) + Number(voucherCap))}`,
      treasury.account.address,
      deployer.account.address,
      [
        {
          metadataURI: BASE_URI,
          onchainCap,
          voucherCap,
          active: true,
          payments: [{ token: usdc.address, price: USDC(50) }],
        },
      ],
    ]);
    const all = await factory.read.getCollections();
    return viem.getContractAt("Swag1155", all[all.length - 1]);
  }

  /** Sign a claim voucher as `account`, using the contract's own EIP-712 domain. */
  async function signVoucher(voucher: any, account: any, contract: any) {
    const signature = await account.signTypedData({
      domain: {
        name: "ETHCaliSwag",
        version: "1",
        chainId,
        verifyingContract: contract.address,
      },
      types: {
        Claim: [
          { name: "tokenId", type: "uint256" },
          { name: "to", type: "address" },
          { name: "quantity", type: "uint256" },
          { name: "orderRef", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Claim",
      message: voucher,
    });
    return signature;
  }

  function voucherFor(overrides: any = {}) {
    return {
      tokenId: 1n,
      to: buyer.account.address,
      quantity: 1n,
      orderRef: `0x${"11".repeat(32)}`,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      ...overrides,
    };
  }

  before(async function () {
    const publicClient = await viem.getPublicClient();
    chainId = await publicClient.getChainId();

    usdc = await viem.deployContract("MockUSDC", []);
    await usdc.write.mint([buyer.account.address, USDC(10_000)]);
    await usdc.write.mint([buyer2.account.address, USDC(10_000)]);

    const implementation = await viem.deployContract("Swag1155", []);
    factory = await viem.deployContract("SwagFactory", [
      deployer.account.address,
      implementation.address,
    ]);

    swag = await freshCollection(100n, 100n);
    await swag.write.addSigner([signer.account.address]);
  });

  // ── Clone-only ─────────────────────────────────────────────────────────────

  it("a directly deployed implementation can never be initialized", async function () {
    const impl = await viem.deployContract("Swag1155", []);
    await assert.rejects(
      impl.write.initialize([BASE_URI, treasury.account.address, deployer.account.address]),
      /AlreadyInitialized/
    );
  });

  // ── Variants and the two buckets ───────────────────────────────────────────

  it("splits supply into an on-chain bucket and a voucher bucket", async function () {
    const v = await swag.read.getVariant([1n]);
    assert.equal(v.onchainCap, 100n);
    assert.equal(v.voucherCap, 100n);
    assert.equal(await swag.read.remainingOnchain([1n]), 100n);
    assert.equal(await swag.read.remainingVoucher([1n]), 100n);
  });

  it("refuses to cut a cap below what that channel already minted", async function () {
    const c = await freshCollection(5n, 5n);
    await usdc.write.approve([c.address, USDC(500)], { account: buyer.account });
    await c.write.buy([1n, 2n, usdc.address], { account: buyer.account });

    await assert.rejects(
      c.write.setVariant([1n, 1n, 5n, true]),
      /CapBelowMinted/
    );
  });

  // ── Channel 1: buy() ───────────────────────────────────────────────────────

  it("buys on-chain, paying the treasury directly", async function () {
    const c = await freshCollection(10n, 10n);
    const before = await usdc.read.balanceOf([treasury.account.address]);

    await usdc.write.approve([c.address, USDC(100)], { account: buyer.account });
    await c.write.buy([1n, 2n, usdc.address], { account: buyer.account });

    assert.equal(await c.read.balanceOf([buyer.account.address, 1n]), 2n);
    assert.equal(
      await usdc.read.balanceOf([treasury.account.address]),
      before + USDC(100)
    );
    // The contract itself never holds revenue.
    assert.equal(await usdc.read.balanceOf([c.address]), 0n);
  });

  it("rejects a payment token that was never configured", async function () {
    const c = await freshCollection(10n, 10n);
    await assert.rejects(
      c.write.buy([1n, 1n, ETH_TOKEN], { account: buyer.account }),
      /PaymentTokenNotAccepted/
    );
  });

  it("requires the exact native amount when paying in the native token", async function () {
    const c = await freshCollection(10n, 10n);
    await c.write.setPaymentOption([1n, ETH_TOKEN, 1000000000000000n]); // 0.001

    await assert.rejects(
      c.write.buy([1n, 1n, ETH_TOKEN], { account: buyer.account, value: 1n }),
      /IncorrectEthAmount/
    );

    await c.write.buy([1n, 1n, ETH_TOKEN], {
      account: buyer.account,
      value: 1000000000000000n,
    });
    assert.equal(await c.read.balanceOf([buyer.account.address, 1n]), 1n);
  });

  it("stops at the on-chain cap without touching voucher stock", async function () {
    const c = await freshCollection(2n, 5n);
    await usdc.write.approve([c.address, USDC(1000)], { account: buyer.account });

    await c.write.buy([1n, 2n, usdc.address], { account: buyer.account });
    assert.equal(await c.read.remainingOnchain([1n]), 0n);

    await assert.rejects(
      c.write.buy([1n, 1n, usdc.address], { account: buyer.account }),
      /SoldOut/
    );

    // The Shopify allocation is untouched by on-chain demand.
    assert.equal(await c.read.remainingVoucher([1n]), 5n);
  });

  it("refuses purchases while paused", async function () {
    const c = await freshCollection(10n, 10n);
    await c.write.pause();
    await usdc.write.approve([c.address, USDC(100)], { account: buyer.account });
    await assert.rejects(
      c.write.buy([1n, 1n, usdc.address], { account: buyer.account }),
      /EnforcedPause/
    );
  });

  // ── Channel 2: claim() ─────────────────────────────────────────────────────

  it("claims a Shopify order against a signed voucher", async function () {
    const c = await freshCollection(10n, 10n);
    await c.write.addSigner([signer.account.address]);

    const voucher = voucherFor({ orderRef: `0x${"a1".repeat(32)}` });
    const sig = await signVoucher(voucher, signer, c);

    const [allowed] = await c.read.canClaim([voucher, sig]);
    assert.equal(allowed, true);

    await c.write.claim([voucher, sig], { account: buyer2.account });

    assert.equal(await c.read.balanceOf([buyer.account.address, 1n]), 1n);
    assert.equal(await c.read.remainingVoucher([1n]), 9n);
    // Claiming costs the buyer nothing and draws only from the voucher bucket.
    assert.equal(await c.read.remainingOnchain([1n]), 10n);
  });

  it("burns the order reference, so a replayed webhook cannot mint twice", async function () {
    const c = await freshCollection(10n, 10n);
    await c.write.addSigner([signer.account.address]);

    const voucher = voucherFor({ orderRef: `0x${"b2".repeat(32)}` });
    const sig = await signVoucher(voucher, signer, c);

    await c.write.claim([voucher, sig], { account: buyer.account });
    await assert.rejects(
      c.write.claim([voucher, sig], { account: buyer.account }),
      /VoucherAlreadyClaimed/
    );
    assert.equal(await c.read.balanceOf([buyer.account.address, 1n]), 1n);
  });

  it("rejects a voucher signed by someone without SIGNER_ROLE", async function () {
    const c = await freshCollection(10n, 10n);
    await c.write.addSigner([signer.account.address]);

    const voucher = voucherFor({ orderRef: `0x${"c3".repeat(32)}` });
    const sig = await signVoucher(voucher, outsider, c);

    await assert.rejects(c.write.claim([voucher, sig]), /InvalidSignature/);
  });

  it("rejects an expired voucher", async function () {
    const c = await freshCollection(10n, 10n);
    await c.write.addSigner([signer.account.address]);

    const voucher = voucherFor({ orderRef: `0x${"d4".repeat(32)}`, deadline: 1n });
    const sig = await signVoucher(voucher, signer, c);

    await assert.rejects(c.write.claim([voucher, sig]), /VoucherExpired/);
  });

  it("rejects a voucher whose fields were altered after signing", async function () {
    const c = await freshCollection(10n, 10n);
    await c.write.addSigner([signer.account.address]);

    const voucher = voucherFor({ orderRef: `0x${"e5".repeat(32)}` });
    const sig = await signVoucher(voucher, signer, c);

    // Same signature, larger quantity — the digest no longer matches.
    const tampered = { ...voucher, quantity: 5n };
    await assert.rejects(c.write.claim([tampered, sig]), /InvalidSignature/);
  });

  it("a voucher signed for one collection cannot be replayed on another", async function () {
    const a = await freshCollection(10n, 10n);
    const b = await freshCollection(10n, 10n);
    await a.write.addSigner([signer.account.address]);
    await b.write.addSigner([signer.account.address]);

    const voucher = voucherFor({ orderRef: `0x${"f6".repeat(32)}` });
    const sigForA = await signVoucher(voucher, signer, a);

    // The EIP-712 domain binds verifyingContract, so B rejects A's signature.
    await assert.rejects(b.write.claim([voucher, sigForA]), /InvalidSignature/);
    await b.write.claim([voucher, await signVoucher(voucher, signer, b)]);
    assert.equal(await b.read.balanceOf([buyer.account.address, 1n]), 1n);
  });

  it("stops at the voucher cap without touching on-chain stock", async function () {
    const c = await freshCollection(5n, 1n);
    await c.write.addSigner([signer.account.address]);

    const first = voucherFor({ orderRef: `0x${"07".repeat(32)}` });
    await c.write.claim([first, await signVoucher(first, signer, c)]);

    const second = voucherFor({ orderRef: `0x${"08".repeat(32)}` });
    await assert.rejects(
      c.write.claim([second, await signVoucher(second, signer, c)]),
      /SoldOut/
    );

    assert.equal(await c.read.remainingOnchain([1n]), 5n);
  });

  // ── The property the whole split exists for ────────────────────────────────

  it("the two channels cannot oversell each other", async function () {
    const c = await freshCollection(3n, 2n); // 5 physical items
    await c.write.addSigner([signer.account.address]);
    await usdc.write.approve([c.address, USDC(1000)], { account: buyer.account });

    await c.write.buy([1n, 3n, usdc.address], { account: buyer.account });

    const v1 = voucherFor({ orderRef: `0x${"09".repeat(32)}` });
    const v2 = voucherFor({ orderRef: `0x${"0a".repeat(32)}` });
    await c.write.claim([v1, await signVoucher(v1, signer, c)]);
    await c.write.claim([v2, await signVoucher(v2, signer, c)]);

    assert.equal(await c.read.totalMinted([1n]), 5n);
    assert.equal(await c.read.remainingOnchain([1n]), 0n);
    assert.equal(await c.read.remainingVoucher([1n]), 0n);

    // Both channels exhausted: no sixth item can exist by either route.
    const v3 = voucherFor({ orderRef: `0x${"0b".repeat(32)}` });
    await assert.rejects(
      c.write.claim([v3, await signVoucher(v3, signer, c)]),
      /SoldOut/
    );
    await assert.rejects(
      c.write.buy([1n, 1n, usdc.address], { account: buyer.account }),
      /SoldOut/
    );
  });

  // ── Serials ────────────────────────────────────────────────────────────────

  it("assigns a serial per unit across both channels", async function () {
    const c = await freshCollection(2n, 2n);
    await c.write.addSigner([signer.account.address]);
    await usdc.write.approve([c.address, USDC(1000)], { account: buyer.account });

    await c.write.buy([1n, 2n, usdc.address], { account: buyer.account });
    const v = voucherFor({ to: buyer2.account.address, orderRef: `0x${"0c".repeat(32)}` });
    await c.write.claim([v, await signVoucher(v, signer, c)]);

    assert.equal(await c.read.nextSerial([1n]), 3n);
    assert.equal(
      (await c.read.getSerialOwner([1n, 0n])).toLowerCase(),
      buyer.account.address.toLowerCase()
    );
    assert.equal(
      (await c.read.getSerialOwner([1n, 2n])).toLowerCase(),
      buyer2.account.address.toLowerCase()
    );
  });

  // ── canBuy / canClaim mirror the writes ────────────────────────────────────

  it("canBuy reports the same reason the write would revert with", async function () {
    const c = await freshCollection(1n, 1n);
    await usdc.write.approve([c.address, USDC(1000)], { account: buyer.account });

    let [allowed, reason] = await c.read.canBuy([1n, 1n, usdc.address]);
    assert.equal(allowed, true);
    assert.equal(reason, "");

    // Unconfigured payment token, checked while stock remains — buy() runs the
    // sold-out check first, so this reason is only reachable before the cap.
    [allowed, reason] = await c.read.canBuy([1n, 1n, ETH_TOKEN]);
    assert.equal(allowed, false);
    assert.equal(reason, "Payment token not accepted");

    await c.write.buy([1n, 1n, usdc.address], { account: buyer.account });
    [allowed, reason] = await c.read.canBuy([1n, 1n, usdc.address]);
    assert.equal(allowed, false);
    assert.equal(reason, "Sold out on-chain");

    await c.write.pause();
    [allowed, reason] = await c.read.canBuy([1n, 1n, usdc.address]);
    assert.equal(reason, "Sales are paused");
  });

  it("canClaim rejects an already-claimed order", async function () {
    const c = await freshCollection(5n, 5n);
    await c.write.addSigner([signer.account.address]);

    const voucher = voucherFor({ orderRef: `0x${"0d".repeat(32)}` });
    const sig = await signVoucher(voucher, signer, c);

    await c.write.claim([voucher, sig]);
    const [allowed, reason] = await c.read.canClaim([voucher, sig]);
    assert.equal(allowed, false);
    assert.equal(reason, "Order already claimed");
  });

  // ── Accounting invariant ───────────────────────────────────────────────────

  it("minted supply always equals the sum of both channel counters", async function () {
    const c = await freshCollection(4n, 4n);
    await c.write.addSigner([signer.account.address]);
    await usdc.write.approve([c.address, USDC(1000)], { account: buyer.account });

    await c.write.buy([1n, 3n, usdc.address], { account: buyer.account });
    const v = voucherFor({ to: buyer2.account.address, orderRef: `0x${"0e".repeat(32)}`, quantity: 2n });
    await c.write.claim([v, await signVoucher(v, signer, c)]);

    const variant = await c.read.getVariant([1n]);
    const held =
      (await c.read.balanceOf([buyer.account.address, 1n])) +
      (await c.read.balanceOf([buyer2.account.address, 1n]));

    assert.equal(await c.read.totalMinted([1n]), held);
    assert.equal(variant.onchainMinted + variant.voucherMinted, held);
  });
});
