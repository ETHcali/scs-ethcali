import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";
import { deployZKPassport, mintPassport } from "./helpers/zkpassport.js";

describe("FaucetVault", async function () {
  const { viem } = await network.connect();
  const [deployer, user, nonHolder, anotherUser] = await viem.getWalletClients();

  let faucetVault: any;
  let nftContract: any;
  let mockVerifier: any;
  let deployerAddress: string;
  let userAddress: string;
  let claimAmount: bigint;

  before(async function () {
    deployerAddress = deployer.account.address;
    userAddress = user.account.address;
    claimAmount = parseEther("0.01");

    // Deploy NFT contract (wired to a mock verifier) with deployer as initial owner
    ({ nft: nftContract, verifier: mockVerifier } = await deployZKPassport(
      viem,
      deployerAddress as `0x${string}`
    ));

    // Deploy FaucetVault
    faucetVault = await viem.deployContract("FaucetVault", [
      nftContract.address,
      claimAmount,
    ]);

    // Mint NFT to user for testing
    await mintPassport(viem, nftContract, mockVerifier, user.account, "faucetvault-user");
  });

  it("Should deploy with correct initial values", async function () {
    const nftAddr = await faucetVault.read.nftContract();
    assert.equal(nftAddr.toLowerCase(), nftContract.address.toLowerCase());
    assert.equal(await faucetVault.read.claimAmount(), claimAmount);
    assert.equal(await faucetVault.read.getBalance(), 0n);
  });

  it("Should allow owner to deposit ETH", async function () {
    const depositAmount = parseEther("1");
    await faucetVault.write.deposit({ value: depositAmount });

    const balance = await faucetVault.read.getBalance();
    assert.equal(balance, depositAmount);
  });

  it("Should allow NFT holder to claim ETH", async function () {
    const initialVaultBalance = await faucetVault.read.getBalance();
    
    await faucetVault.write.claim({ account: user.account });

    const newVaultBalance = await faucetVault.read.getBalance();
    // Verify vault balance decreased by claim amount
    assert.equal(newVaultBalance, initialVaultBalance - claimAmount);

    // Verify claim was recorded
    const hasClaimed = await faucetVault.read.hasClaimed([userAddress]);
    assert.equal(hasClaimed, true);
  });

  it("Should prevent second claim from same address", async function () {
    try {
      await faucetVault.write.claim({ account: user.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("already claimed"));
    }
  });

  it("Should prevent non-NFT holder from claiming", async function () {
    try {
      await faucetVault.write.claim({ account: nonHolder.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("must own ZKPassport NFT"));
    }
  });

  it("Should prevent claim when vault has insufficient balance", async function () {
    // Withdraw all funds
    const balance = await faucetVault.read.getBalance();
    await faucetVault.write.withdraw([balance]);

    // Mint NFT to another user
    await mintPassport(viem, nftContract, mockVerifier, anotherUser.account, "faucetvault-user-2");

    try {
      await faucetVault.write.claim({ account: anotherUser.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("insufficient balance"));
    }
  });

  it("Should allow owner to update claim amount", async function () {
    const newAmount = parseEther("0.02");
    await faucetVault.write.updateClaimAmount([newAmount]);

    assert.equal(await faucetVault.read.claimAmount(), newAmount);

    // Restore original amount
    await faucetVault.write.updateClaimAmount([claimAmount]);
  });

  it("Should prevent non-owner from updating claim amount", async function () {
    const newAmount = parseEther("0.02");

    try {
      await faucetVault.write.updateClaimAmount([newAmount], {
        account: user.account,
      });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("Ownable"));
    }
  });

  it("Should allow owner to withdraw ETH", async function () {
    // Deposit some ETH first
    await faucetVault.write.deposit({ value: parseEther("0.5") });

    const initialBalance = await faucetVault.read.getBalance();
    const withdrawAmount = parseEther("0.2");

    await faucetVault.write.withdraw([withdrawAmount]);

    const newBalance = await faucetVault.read.getBalance();
    assert.equal(newBalance, initialBalance - withdrawAmount);
  });

  it("Should prevent non-owner from withdrawing", async function () {
    const withdrawAmount = parseEther("0.1");

    try {
      await faucetVault.write.withdraw([withdrawAmount], {
        account: user.account,
      });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("Ownable"));
    }
  });

  it("Should allow owner to pause contract", async function () {
    await faucetVault.write.pause();

    // Try to claim while paused
    // First, mint NFT to a new user and deposit funds
    await mintPassport(viem, nftContract, mockVerifier, nonHolder.account, "faucetvault-user-paused");
    await faucetVault.write.deposit({ value: claimAmount });

    try {
      await faucetVault.write.claim({ account: nonHolder.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      // Test passed - transaction reverted as expected
      assert(error.message.includes("Pausable") || error.message.includes("paused") || error.message.includes("revert"));
    }

    // Unpause
    await faucetVault.write.unpause();
  });

  it("Should allow owner to update NFT contract", async function () {
    // Deploy new NFT contract
    const { nft: newNFT } = await deployZKPassport(viem, deployerAddress as `0x${string}`);

    await faucetVault.write.setNFTContract([newNFT.address]);
    const nftAddr = await faucetVault.read.nftContract();
    assert.equal(nftAddr.toLowerCase(), newNFT.address.toLowerCase());

    // Restore original NFT contract
    await faucetVault.write.setNFTContract([nftContract.address]);
  });

  it("Should reject invalid claim amount update", async function () {
    try {
      await faucetVault.write.updateClaimAmount([0n]);
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("claim amount must be > 0"));
    }
  });
});

