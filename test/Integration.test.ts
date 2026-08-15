import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";
import { deployZKPassport, mintPassport, uid, EMPTY_PARAMS } from "./helpers/zkpassport.js";

describe("Integration Tests", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, user1, user2, user3] = await viem.getWalletClients();

  let nftContract: any;
  let mockVerifier: any;
  let faucetVault: any;
  let deployerAddress: `0x${string}`;
  let user1Address: `0x${string}`;
  let user2Address: `0x${string}`;
  let claimAmount: bigint;

  before(async function () {
    deployerAddress = deployer.account.address;
    user1Address = user1.account.address;
    user2Address = user2.account.address;
    claimAmount = parseEther("0.01");

    // Deploy NFT contract (wired to a mock verifier) with deployer as initial owner
    ({ nft: nftContract, verifier: mockVerifier } = await deployZKPassport(
      viem,
      deployerAddress
    ));

    // Deploy FaucetVault
    faucetVault = await viem.deployContract("FaucetVault", [
      nftContract.address,
      claimAmount,
    ]);

    // Fund faucet vault
    await faucetVault.write.deposit({ value: parseEther("10") });
  });

  it("Should complete full flow: verify -> mint -> claim", async function () {
    // Step 1: User proves identity and mints their ZKPassport NFT
    await mintPassport(viem, nftContract, mockVerifier, user1.account, "integration-test-1", {
      nationality: "COL",
    });

    // Step 2: Verify NFT was minted with the proof's disclosed data
    assert.equal(await nftContract.read.balanceOf([user1Address]), 1n);

    const tokenData = await nftContract.read.getTokenData([0n]);
    assert.equal(tokenData.uniqueIdentifier, uid("integration-test-1"));
    assert.equal(tokenData.personhoodVerified, true);
    assert.equal(tokenData.isOver18, true);
    assert.equal(tokenData.nationality, "COL");

    // Step 3: User claims from the faucet
    const initialVaultBalance = await faucetVault.read.getBalance();
    await faucetVault.write.claim({ account: user1.account });
    const newVaultBalance = await faucetVault.read.getBalance();

    assert.equal(newVaultBalance, initialVaultBalance - claimAmount);
    assert.equal(await faucetVault.read.hasClaimed([user1Address]), true);
  });

  it("Should handle multiple users with different disclosed data", async function () {
    await mintPassport(viem, nftContract, mockVerifier, user2.account, "integration-test-2", {
      nationality: "USA",
    });

    const tokenData2 = await nftContract.read.getTokenData([1n]);
    assert.equal(tokenData2.uniqueIdentifier, uid("integration-test-2"));
    assert.equal(tokenData2.personhoodVerified, true);
    assert.equal(tokenData2.nationality, "USA");

    const initialVaultBalance2 = await faucetVault.read.getBalance();
    await faucetVault.write.claim({ account: user2.account });
    const newVaultBalance2 = await faucetVault.read.getBalance();

    assert.equal(newVaultBalance2, initialVaultBalance2 - claimAmount);
  });

  it("Should prevent a second NFT for an address that already holds one", async function () {
    try {
      await mintPassport(viem, nftContract, mockVerifier, user1.account, "integration-test-1-again");
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("address already has NFT"));
    }
  });

  it("Should prevent reusing a nullifier across addresses", async function () {
    // Same uniqueIdentifier as user1's mint, but a fresh address — the scoped
    // nullifier is what makes this sybil-resistant, so it must be rejected.
    const chainId = BigInt(await publicClient.getChainId());
    await mockVerifier.write.setMockResult([
      true,
      uid("integration-test-1"), // already consumed
      true,
      user3.account.address,
      true,
      "COL",
    ]);
    await mockVerifier.write.setChainId([chainId]);

    try {
      await nftContract.write.mint([EMPTY_PARAMS, false], { account: user3.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("identifier already used"));
    }
  });

  it("Should prevent a second faucet claim from the same address", async function () {
    try {
      await faucetVault.write.claim({ account: user1.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("already claimed"));
    }
  });

  it("Should gate the faucet on holding a ZKPassport NFT", async function () {
    // user3 failed to mint above, so still holds nothing.
    assert.equal(await nftContract.read.hasNFTByAddress([user3.account.address]), false);

    try {
      await faucetVault.write.claim({ account: user3.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("must own ZKPassport NFT"));
    }
  });

  it("Should verify the simplified two-contract system end to end", async function () {
    // A fresh holder mints, then immediately claims — the whole system is just
    // ZKPassportNFT gating FaucetVault.
    await mintPassport(viem, nftContract, mockVerifier, user3.account, "integration-test-3");

    assert.equal(await nftContract.read.balanceOf([user3.account.address]), 1n);
    assert.equal(await nftContract.read.hasNFTByAddress([user3.account.address]), true);

    const before = await faucetVault.read.getBalance();
    await faucetVault.write.claim({ account: user3.account });
    const after = await faucetVault.read.getBalance();

    assert.equal(after, before - claimAmount);
  });
});
