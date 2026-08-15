import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";

describe("DonationReceipt1155", async function () {
  const { viem } = await network.connect();
  const [deployer, vault, donor, donor2] = await viem.getWalletClients();

  const BASE_URI = "ipfs://QmBase/{id}.json";
  const ZERO = "0x0000000000000000000000000000000000000000";

  let receipt: any;

  before(async function () {
    receipt = await viem.deployContract("DonationReceipt1155", [
      "ETH Cali Earthquake Relief",
      "ETHCALI-RELIEF",
      BASE_URI,
      deployer.account.address,
    ]);

    // The vault is the only minter in production; here an EOA stands in for it.
    await receipt.write.addMinter([vault.account.address]);
  });

  // ==================== DEPLOYMENT ====================

  it("Should deploy with name, symbol and admin roles", async function () {
    assert.equal(await receipt.read.name(), "ETH Cali Earthquake Relief");
    assert.equal(await receipt.read.symbol(), "ETHCALI-RELIEF");

    const defaultAdmin = await receipt.read.DEFAULT_ADMIN_ROLE();
    const adminRole = await receipt.read.ADMIN_ROLE();
    assert.equal(await receipt.read.hasRole([defaultAdmin, deployer.account.address]), true);
    assert.equal(await receipt.read.hasRole([adminRole, deployer.account.address]), true);
  });

  it("Should start soulbound", async function () {
    assert.equal(await receipt.read.transfersEnabled(), false);
  });

  // ==================== TIERS ====================

  it("Admin can create tiers", async function () {
    await receipt.write.setTier([1n, "Supporter", "ipfs://QmSupporter/1.json", true]);
    await receipt.write.setTier([2n, "Guardian", "ipfs://QmGuardian/2.json", true]);

    const t1 = await receipt.read.getTier([1n]);
    assert.equal(t1.name, "Supporter");
    assert.equal(t1.metadataURI, "ipfs://QmSupporter/1.json");
    assert.equal(t1.active, true);
    assert.equal(t1.minted, 0n);

    assert.equal(await receipt.read.tierCount(), 2n);
  });

  it("Per-tier URI overrides the base URI", async function () {
    assert.equal(await receipt.read.uri([1n]), "ipfs://QmSupporter/1.json");
    // An unconfigured tokenId falls back to the collection base URI.
    assert.equal(await receipt.read.uri([999n]), BASE_URI);
  });

  it("Should reject a tier with an empty URI", async function () {
    await assert.rejects(
      () => receipt.write.setTier([3n, "Broken", "", true]),
      /EmptyURI/
    );
  });

  it("Non-admin cannot create tiers", async function () {
    await assert.rejects(
      () =>
        receipt.write.setTier([4n, "Rogue", "ipfs://QmRogue/4.json", true], {
          account: donor.account,
        }),
      /AccessControlUnauthorizedAccount/
    );
  });

  it("Admin can list tier ids", async function () {
    const ids = await receipt.read.listTierIds();
    assert.deepEqual([...ids].sort((a: bigint, b: bigint) => Number(a - b)), [1n, 2n]);
  });

  // ==================== MINTING ====================

  it("Minter can issue a receipt", async function () {
    await receipt.write.mint([donor.account.address, 1n, 1n], { account: vault.account });

    assert.equal(await receipt.read.balanceOf([donor.account.address, 1n]), 1n);
    assert.equal((await receipt.read.getTier([1n])).minted, 1n);
  });

  it("Non-minter cannot issue a receipt", async function () {
    await assert.rejects(
      () => receipt.write.mint([donor.account.address, 1n, 1n], { account: donor.account }),
      /AccessControlUnauthorizedAccount/
    );
  });

  it("Cannot mint an inactive tier", async function () {
    await receipt.write.setTier([2n, "Guardian", "ipfs://QmGuardian/2.json", false]);

    await assert.rejects(
      () => receipt.write.mint([donor.account.address, 2n, 1n], { account: vault.account }),
      /TierNotActive/
    );

    // Re-activate for later tests.
    await receipt.write.setTier([2n, "Guardian", "ipfs://QmGuardian/2.json", true]);
  });

  it("Cannot mint an entirely unconfigured tier", async function () {
    await assert.rejects(
      () => receipt.write.mint([donor.account.address, 777n, 1n], { account: vault.account }),
      /TierNotActive/
    );
  });

  it("Cannot mint to the zero address", async function () {
    await assert.rejects(
      () => receipt.write.mint([ZERO, 1n, 1n], { account: vault.account }),
      /InvalidRecipient/
    );
  });

  it("Repeat donations stack receipts of the same tier", async function () {
    await receipt.write.mint([donor.account.address, 1n, 1n], { account: vault.account });
    assert.equal(await receipt.read.balanceOf([donor.account.address, 1n]), 2n);
  });

  // ==================== SOULBOUND ====================

  it("Receipts cannot be transferred while soulbound", async function () {
    await assert.rejects(
      () =>
        receipt.write.safeTransferFrom(
          [donor.account.address, donor2.account.address, 1n, 1n, "0x"],
          { account: donor.account }
        ),
      /Soulbound/
    );
  });

  it("Admin can open transfers, and then receipts move", async function () {
    await receipt.write.setTransfersEnabled([true]);
    assert.equal(await receipt.read.transfersEnabled(), true);

    await receipt.write.safeTransferFrom(
      [donor.account.address, donor2.account.address, 1n, 1n, "0x"],
      { account: donor.account }
    );

    assert.equal(await receipt.read.balanceOf([donor2.account.address, 1n]), 1n);

    // Restore soulbound for the remaining tests.
    await receipt.write.setTransfersEnabled([false]);
  });

  it("Only a super admin can open transfers", async function () {
    await assert.rejects(
      () => receipt.write.setTransfersEnabled([true], { account: donor.account }),
      /AccessControlUnauthorizedAccount/
    );
  });

  // ==================== TIER REMOVAL ====================

  it("Cannot remove a tier that has supply", async function () {
    await assert.rejects(() => receipt.write.removeTier([1n]), /TierHasSupply/);
  });

  it("Can remove an unminted tier", async function () {
    await receipt.write.setTier([5n, "Unused", "ipfs://QmUnused/5.json", true]);
    const before = await receipt.read.tierCount();

    await receipt.write.removeTier([5n]);

    assert.equal(await receipt.read.tierCount(), before - 1n);
    assert.equal(await receipt.read.isTierActive([5n]), false);
  });

  // ==================== ROLE MANAGEMENT ====================

  it("Super admin can revoke a minter", async function () {
    await receipt.write.removeMinter([vault.account.address]);

    await assert.rejects(
      () => receipt.write.mint([donor.account.address, 1n, 1n], { account: vault.account }),
      /AccessControlUnauthorizedAccount/
    );

    await receipt.write.addMinter([vault.account.address]);
  });

  it("Supports the ERC-1155 and AccessControl interfaces", async function () {
    assert.equal(await receipt.read.supportsInterface(["0xd9b67a26"]), true); // ERC1155
    assert.equal(await receipt.read.supportsInterface(["0x7965db0b"]), true); // AccessControl
  });
});
