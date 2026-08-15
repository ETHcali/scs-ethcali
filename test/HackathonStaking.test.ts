import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits, keccak256, toBytes } from "viem";

/** Deterministic bytes32 from a test label */
function uid(label: string): `0x${string}` {
  return keccak256(toBytes(label));
}

/** Empty ProofVerificationParams — the mock verifier ignores every field */
const EMPTY_PARAMS = {
  version: ("0x" + "00".repeat(32)) as `0x${string}`,
  proofVerificationData: {
    vkeyHash: ("0x" + "00".repeat(32)) as `0x${string}`,
    proof: "0x" as `0x${string}`,
    publicInputs: [] as `0x${string}`[],
  },
  committedInputs: "0x" as `0x${string}`,
  serviceConfig: {
    validityPeriodInSeconds: 0n,
    domain: "",
    scope: "",
    devMode: false,
  },
};

describe("HackathonStaking", async function () {
  const { viem } = await network.connect();
  const [owner, admin, user1, user2, user3, treasury] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const ZERO = "0x0000000000000000000000000000000000000000";

  let staking: any;
  let zkPassportNFT: any;
  let mockVerifier: any;

  // Current chain time — hackathon deadlines are always set relative to this,
  // since the forfeit tests move the clock forward.
  async function now(): Promise<bigint> {
    const block = await publicClient.getBlock();
    return block.timestamp;
  }

  async function advance(seconds: number) {
    await testClient.increaseTime({ seconds });
    await testClient.mine({ blocks: 1 });
  }

  /** Create an ETH hackathon with sane defaults, returning its id. */
  async function createHackathon(overrides: Record<string, any> = {}): Promise<bigint> {
    const t = await now();
    await staking.write.createHackathon([
      {
        name: "Test Hackathon",
        description: "A hackathon",
        stakeAsset: ETH_TOKEN,
        stakeAmount: parseEther("0.05"),
        registrationDeadline: t + 86400n,
        submissionDeadline: t + 172800n,
        whitelistEnabled: false,
        zkPassportRequired: false,
        allowedToken: ZERO,
        ...overrides,
      },
    ]);
    return (await staking.read.hackathonCount()) - 1n;
  }

  /** Mint a ZKPassport NFT to `account` via the mock verifier. */
  async function mintPassport(account: any, label: string) {
    const chainId = BigInt(await publicClient.getChainId());
    await mockVerifier.write.setMockResult([
      true,                    // verified
      uid(label),              // uniqueId
      true,                    // scopesValid
      account.address,         // sender
      true,                    // isOver18
      "COL",                   // nationality
    ]);
    await mockVerifier.write.setChainId([chainId]);
    await zkPassportNFT.write.mint([EMPTY_PARAMS, false], { account });
  }

  before(async function () {
    mockVerifier = await viem.deployContract("MockZKPassportVerifier", []);

    zkPassportNFT = await viem.deployContract("ZKPassportNFT", [
      "ZKPassport",
      "ZKPASS",
      owner.account.address,
      "ethcali.com",
      "ethcali-verification",
    ]);

    // Point at the mock so minting works on the local network.
    await zkPassportNFT.write.setVerifier([mockVerifier.address]);

    staking = await viem.deployContract("HackathonStaking", [
      zkPassportNFT.address,
      owner.account.address,
    ]);

    // user1 and user2 are verified humans; user3 deliberately is not.
    await mintPassport(user1.account, "user1");
    await mintPassport(user2.account, "user2");
  });

  // ==================== DEPLOYMENT TESTS ====================

  it("Should deploy with correct NFT contract", async function () {
    const nftContract = await staking.read.nftContract();
    assert.equal(nftContract.toLowerCase(), zkPassportNFT.address.toLowerCase());
  });

  it("Should grant deployer admin roles", async function () {
    assert.equal(await staking.read.isAdmin([owner.account.address]), true);
    assert.equal(await staking.read.isSuperAdmin([owner.account.address]), true);
  });

  it("Should expose the ETH sentinel constant", async function () {
    const sentinel = await staking.read.ETH_TOKEN();
    assert.equal(sentinel.toLowerCase(), ETH_TOKEN.toLowerCase());
  });

  // ==================== HACKATHON CREATION TESTS ====================

  it("Should create a hackathon with the given configuration", async function () {
    const id = await createHackathon({ name: "ETHGlobal Cali 2026" });
    const h = await staking.read.getHackathon([id]);

    assert.equal(h.name, "ETHGlobal Cali 2026");
    assert.equal(h.stakeAsset.toLowerCase(), ETH_TOKEN.toLowerCase());
    assert.equal(h.stakeAmount, parseEther("0.05"));
    assert.equal(h.active, true);
    assert.equal(h.totalStaked, 0n);
    assert.equal(h.stakerCount, 0n);
  });

  it("Should start every hackathon with no yield strategy (phase 1)", async function () {
    const id = await createHackathon();
    const h = await staking.read.getHackathon([id]);
    assert.equal(h.yieldStrategy.toLowerCase(), ZERO);
  });

  it("Should reject a hackathon with an empty name", async function () {
    const t = await now();
    try {
      await staking.write.createHackathon([
        {
          name: "",
          description: "",
          stakeAsset: ETH_TOKEN,
          stakeAmount: parseEther("0.05"),
          registrationDeadline: t + 86400n,
          submissionDeadline: t + 172800n,
          whitelistEnabled: false,
          zkPassportRequired: false,
          allowedToken: ZERO,
        },
      ]);
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("empty name"));
    }
  });

  it("Should reject a zero stake amount", async function () {
    try {
      await createHackathon({ stakeAmount: 0n });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("stake amount must be > 0"));
    }
  });

  it("Should reject a registration deadline in the past", async function () {
    const t = await now();
    try {
      await createHackathon({ registrationDeadline: t - 1n, submissionDeadline: t + 86400n });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("registration deadline in the past"));
    }
  });

  it("Should reject a submission deadline before the registration deadline", async function () {
    const t = await now();
    try {
      await createHackathon({
        registrationDeadline: t + 172800n,
        submissionDeadline: t + 86400n,
      });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("submission before registration deadline"));
    }
  });

  it("Should only let admins create hackathons", async function () {
    const t = await now();
    try {
      await staking.write.createHackathon(
        [
          {
            name: "Rogue",
            description: "",
            stakeAsset: ETH_TOKEN,
            stakeAmount: parseEther("0.05"),
            registrationDeadline: t + 86400n,
            submissionDeadline: t + 172800n,
            whitelistEnabled: false,
            zkPassportRequired: false,
            allowedToken: ZERO,
          },
        ],
        { account: user1.account }
      );
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("AccessControl"));
    }
  });

  // ==================== STAKING TESTS ====================

  it("Should let a user stake the exact bond", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    const s = await staking.read.getStake([id, user1.account.address]);
    assert.equal(s.principal, parseEther("0.05"));
    assert.equal(s.submitted, false);
    assert.equal(s.unstaked, false);
    assert.equal(s.forfeited, false);

    const h = await staking.read.getHackathon([id]);
    assert.equal(h.totalStaked, parseEther("0.05"));
    assert.equal(h.stakerCount, 1n);
  });

  it("Should hold the staked ETH in the contract", async function () {
    const id = await createHackathon();
    const before = await publicClient.getBalance({ address: staking.address });

    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    const after = await publicClient.getBalance({ address: staking.address });
    assert.equal(after - before, parseEther("0.05"));
  });

  it("Should reject an incorrect ETH amount", async function () {
    const id = await createHackathon();
    try {
      await staking.write.stake([id], { account: user1.account, value: parseEther("0.04") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("incorrect ETH amount"));
    }
  });

  it("Should reject a double stake", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    try {
      await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("already staked"));
    }
  });

  it("Should reject a stake on an inactive hackathon", async function () {
    const id = await createHackathon();
    await staking.write.updateHackathon([id, "Test Hackathon", "closed", false]);

    try {
      await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("hackathon not active"));
    }
  });

  it("Should track multiple stakers", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
    await staking.write.stake([id], { account: user2.account, value: parseEther("0.05") });

    const h = await staking.read.getHackathon([id]);
    assert.equal(h.stakerCount, 2n);
    assert.equal(h.totalStaked, parseEther("0.1"));

    const stakers = await staking.read.getStakers([id]);
    assert.equal(stakers.length, 2);
  });

  // ==================== GATING TESTS ====================

  it("Should enforce the ZKPassport requirement", async function () {
    const id = await createHackathon({ zkPassportRequired: true });

    // user1 holds a ZKPassport NFT
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    // user3 does not
    try {
      await staking.write.stake([id], { account: user3.account, value: parseEther("0.05") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("must own ZKPassport NFT"));
    }
  });

  it("Should enforce the whitelist when enabled", async function () {
    const id = await createHackathon({ whitelistEnabled: true });
    await staking.write.addToWhitelist([id, user1.account.address]);

    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    try {
      await staking.write.stake([id], { account: user2.account, value: parseEther("0.05") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("not whitelisted"));
    }
  });

  it("Should support batch whitelisting", async function () {
    const id = await createHackathon({ whitelistEnabled: true });
    await staking.write.addBatchToWhitelist([
      id,
      [user1.account.address, user2.account.address],
    ]);

    assert.equal(await staking.read.isWhitelisted([id, user1.account.address]), true);
    assert.equal(await staking.read.isWhitelisted([id, user2.account.address]), true);
    assert.equal(await staking.read.isWhitelisted([id, user3.account.address]), false);
  });

  it("Should enforce token gating", async function () {
    const token = await viem.deployContract("MockUSDC");
    await token.write.mint([user1.account.address, parseUnits("100", 6)]);

    const id = await createHackathon({ allowedToken: token.address });

    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    try {
      await staking.write.stake([id], { account: user3.account, value: parseEther("0.05") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("must hold required token"));
    }
  });

  // ==================== SUBMISSION TESTS ====================

  it("Should mark submissions and bump the good-actor counter", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    const before = await staking.read.getSubmissionCount([user1.account.address]);
    await staking.write.markSubmitted([id, [user1.account.address]]);

    const s = await staking.read.getStake([id, user1.account.address]);
    assert.equal(s.submitted, true);
    assert(s.submittedAt > 0n);

    const after = await staking.read.getSubmissionCount([user1.account.address]);
    assert.equal(after, before + 1n);
  });

  it("Should skip non-stakers in a submission batch instead of reverting", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    // user3 never staked — the batch must still succeed for user1.
    await staking.write.markSubmitted([id, [user1.account.address, user3.account.address]]);

    assert.equal((await staking.read.getStake([id, user1.account.address])).submitted, true);
    assert.equal((await staking.read.getStake([id, user3.account.address])).submitted, false);
  });

  it("Should not double-count a repeated submission mark", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    const before = await staking.read.getSubmissionCount([user1.account.address]);
    await staking.write.markSubmitted([id, [user1.account.address]]);
    await staking.write.markSubmitted([id, [user1.account.address]]);

    assert.equal(await staking.read.getSubmissionCount([user1.account.address]), before + 1n);
  });

  it("Should let an admin unmark a submission", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
    await staking.write.markSubmitted([id, [user1.account.address]]);

    const before = await staking.read.getSubmissionCount([user1.account.address]);
    await staking.write.unmarkSubmitted([id, user1.account.address]);

    const s = await staking.read.getStake([id, user1.account.address]);
    assert.equal(s.submitted, false);
    assert.equal(await staking.read.getSubmissionCount([user1.account.address]), before - 1n);
  });

  it("Should only let admins mark submissions", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    try {
      await staking.write.markSubmitted([id, [user1.account.address]], { account: user1.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("AccessControl"));
    }
  });

  // ==================== UNSTAKING TESTS ====================

  it("Should return the full principal after a confirmed submission", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
    await staking.write.markSubmitted([id, [user1.account.address]]);

    const contractBefore = await publicClient.getBalance({ address: staking.address });
    await staking.write.unstake([id], { account: user1.account });
    const contractAfter = await publicClient.getBalance({ address: staking.address });

    assert.equal(contractBefore - contractAfter, parseEther("0.05"));

    const s = await staking.read.getStake([id, user1.account.address]);
    assert.equal(s.unstaked, true);
    assert.equal(s.principal, parseEther("0.05")); // retained as history

    const h = await staking.read.getHackathon([id]);
    assert.equal(h.totalStaked, 0n);
    assert.equal(h.totalRefunded, parseEther("0.05"));
  });

  it("Should reject unstaking before a submission is confirmed", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    try {
      await staking.write.unstake([id], { account: user1.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("submission not confirmed"));
    }
  });

  it("Should reject a double unstake", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
    await staking.write.markSubmitted([id, [user1.account.address]]);
    await staking.write.unstake([id], { account: user1.account });

    try {
      await staking.write.unstake([id], { account: user1.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("already unstaked"));
    }
  });

  it("Should reject unstaking by someone who never staked", async function () {
    const id = await createHackathon();
    try {
      await staking.write.unstake([id], { account: user3.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("nothing staked"));
    }
  });

  // ==================== ERC-20 HACKATHON TESTS ====================

  it("Should support an ERC-20 bond end to end", async function () {
    const usdc = await viem.deployContract("MockUSDC");
    const bond = parseUnits("50", 6);
    await usdc.write.mint([user1.account.address, parseUnits("100", 6)]);

    const id = await createHackathon({ stakeAsset: usdc.address, stakeAmount: bond });

    await usdc.write.approve([staking.address, bond], { account: user1.account });
    await staking.write.stake([id], { account: user1.account });

    assert.equal(await usdc.read.balanceOf([staking.address]), bond);

    await staking.write.markSubmitted([id, [user1.account.address]]);
    await staking.write.unstake([id], { account: user1.account });

    assert.equal(await usdc.read.balanceOf([staking.address]), 0n);
    assert.equal(await usdc.read.balanceOf([user1.account.address]), parseUnits("100", 6));
  });

  it("Should reject ETH sent to an ERC-20 hackathon", async function () {
    const usdc = await viem.deployContract("MockUSDC");
    const bond = parseUnits("50", 6);
    await usdc.write.mint([user1.account.address, bond]);

    const id = await createHackathon({ stakeAsset: usdc.address, stakeAmount: bond });
    await usdc.write.approve([staking.address, bond], { account: user1.account });

    try {
      await staking.write.stake([id], { account: user1.account, value: parseEther("0.01") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("ETH not accepted for this hackathon"));
    }
  });

  // ==================== VIEW / GUARD TESTS ====================

  it("Should report why a user cannot stake", async function () {
    const id = await createHackathon({ zkPassportRequired: true });

    const [canStake, reason] = await staking.read.canUserStake([id, user3.account.address]);
    assert.equal(canStake, false);
    assert.equal(reason, "Must own ZKPassport NFT");

    const [ok] = await staking.read.canUserStake([id, user1.account.address]);
    assert.equal(ok, true);
  });

  it("Should report why a user cannot unstake", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    const [before, reason] = await staking.read.canUserUnstake([id, user1.account.address]);
    assert.equal(before, false);
    assert.equal(reason, "Submission not confirmed");

    await staking.write.markSubmitted([id, [user1.account.address]]);
    const [after] = await staking.read.canUserUnstake([id, user1.account.address]);
    assert.equal(after, true);
  });

  it("Should reject direct ETH transfers", async function () {
    // A bare value transfer hits receive(), which reverts. Hardhat cannot decode
    // the revert string for a plain transfer, so assert on the revert itself and
    // on the balance staying put.
    const before = await publicClient.getBalance({ address: staking.address });

    await assert.rejects(
      owner.sendTransaction({ to: staking.address, value: parseEther("1") })
    );

    const after = await publicClient.getBalance({ address: staking.address });
    assert.equal(after, before);
  });

  it("Should refuse to attach a yield strategy while principal is staked", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    try {
      await staking.write.setYieldStrategy([id, user2.account.address]);
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("principal still staked"));
    }
  });

  // ==================== ADMIN TESTS ====================

  it("Should let a super admin add and remove admins", async function () {
    await staking.write.addAdmin([admin.account.address]);
    assert.equal(await staking.read.isAdmin([admin.account.address]), true);

    const id = await createHackathon();
    await staking.write.updateHackathon([id, "Renamed", "by new admin", true], {
      account: admin.account,
    });
    assert.equal((await staking.read.getHackathon([id])).name, "Renamed");

    await staking.write.removeAdmin([admin.account.address]);
    assert.equal(await staking.read.isAdmin([admin.account.address]), false);
  });

  it("Should block staking while paused", async function () {
    const id = await createHackathon();
    await staking.write.pause();

    try {
      await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("EnforcedPause"));
    }

    const [canStake, reason] = await staking.read.canUserStake([id, user1.account.address]);
    assert.equal(canStake, false);
    assert.equal(reason, "Staking is paused");

    await staking.write.unpause();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
  });

  it("Should update gating configuration", async function () {
    const id = await createHackathon();
    await staking.write.updateHackathonGating([id, true, ZERO]);

    const h = await staking.read.getHackathon([id]);
    assert.equal(h.zkPassportRequired, true);
  });

  // ==================== DEADLINE + FORFEIT TESTS ====================
  // These move the chain clock forward, so they run last.

  it("Should reject staking after the registration deadline", async function () {
    const t = await now();
    const id = await createHackathon({
      registrationDeadline: t + 3600n,
      submissionDeadline: t + 7200n,
    });

    await advance(3601);

    try {
      await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("registration closed"));
    }

    const [canStake, reason] = await staking.read.canUserStake([id, user1.account.address]);
    assert.equal(canStake, false);
    assert.equal(reason, "Registration closed");
  });

  it("Should refuse to sweep before the submission deadline", async function () {
    const id = await createHackathon();
    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });

    try {
      await staking.write.sweepForfeited([id, treasury.account.address, 10n]);
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("submission period not over"));
    }
  });

  it("Should forfeit no-show bonds and spare the ones that submitted", async function () {
    const t = await now();
    const id = await createHackathon({
      registrationDeadline: t + 3600n,
      submissionDeadline: t + 7200n,
    });

    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
    await staking.write.stake([id], { account: user2.account, value: parseEther("0.05") });

    // Only user1 submits.
    await staking.write.markSubmitted([id, [user1.account.address]]);

    await advance(7201);

    const treasuryBefore = await publicClient.getBalance({ address: treasury.account.address });
    await staking.write.sweepForfeited([id, treasury.account.address, 10n]);
    const treasuryAfter = await publicClient.getBalance({ address: treasury.account.address });

    // Exactly user2's bond moved to the prize pool.
    assert.equal(treasuryAfter - treasuryBefore, parseEther("0.05"));

    const s1 = await staking.read.getStake([id, user1.account.address]);
    const s2 = await staking.read.getStake([id, user2.account.address]);
    assert.equal(s1.forfeited, false);
    assert.equal(s2.forfeited, true);

    const h = await staking.read.getHackathon([id]);
    assert.equal(h.totalForfeited, parseEther("0.05"));
    assert.equal(h.totalStaked, parseEther("0.05")); // user1's bond still held

    // user1 can still reclaim their bond after the sweep.
    await staking.write.unstake([id], { account: user1.account });
    assert.equal((await staking.read.getHackathon([id])).totalStaked, 0n);
  });

  it("Should reject unstaking a forfeited bond", async function () {
    const t = await now();
    const id = await createHackathon({
      registrationDeadline: t + 3600n,
      submissionDeadline: t + 7200n,
    });
    await staking.write.stake([id], { account: user2.account, value: parseEther("0.05") });

    await advance(7201);
    await staking.write.sweepForfeited([id, treasury.account.address, 10n]);

    // Even a late submission mark cannot rescue a forfeited bond.
    await staking.write.markSubmitted([id, [user2.account.address]]);

    try {
      await staking.write.unstake([id], { account: user2.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("stake forfeited"));
    }
  });

  it("Should paginate the forfeit sweep", async function () {
    const t = await now();
    const id = await createHackathon({
      registrationDeadline: t + 3600n,
      submissionDeadline: t + 7200n,
    });

    await staking.write.stake([id], { account: user1.account, value: parseEther("0.05") });
    await staking.write.stake([id], { account: user2.account, value: parseEther("0.05") });
    await staking.write.stake([id], { account: user3.account, value: parseEther("0.05") });

    await advance(7201);

    assert.equal(await staking.read.pendingForfeitCount([id]), 3n);

    await staking.write.sweepForfeited([id, treasury.account.address, 2n]);
    assert.equal(await staking.read.forfeitCursor([id]), 2n);
    assert.equal(await staking.read.pendingForfeitCount([id]), 1n);

    await staking.write.sweepForfeited([id, treasury.account.address, 2n]);
    assert.equal(await staking.read.pendingForfeitCount([id]), 0n);

    const h = await staking.read.getHackathon([id]);
    assert.equal(h.totalForfeited, parseEther("0.15"));
    assert.equal(h.totalStaked, 0n);
  });

  it("Should leave contract balance consistent with tracked principal", async function () {
    // After every test above, the ETH held must equal the sum of live principal
    // across all ETH hackathons — no drift from sweeps, refunds, or forfeits.
    const count = await staking.read.hackathonCount();
    let expected = 0n;
    for (let i = 0n; i < count; i++) {
      const h = await staking.read.getHackathon([i]);
      if (h.stakeAsset.toLowerCase() === ETH_TOKEN.toLowerCase()) {
        expected += h.totalStaked;
      }
    }

    const actual = await publicClient.getBalance({ address: staking.address });
    assert.equal(actual, expected);
  });
});
