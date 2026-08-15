import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";
import { deployZKPassport, mintPassport } from "./helpers/zkpassport.js";

describe("FaucetManager", async function () {
  const { viem } = await network.connect();
  const [owner, admin, user1, user2, treasury] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  let faucetManager: any;
  let zkPassportNFT: any;
  let mockVerifier: any;

  before(async function () {
    // Deploy ZKPassportNFT (wired to a mock verifier) with owner as initial owner
    ({ nft: zkPassportNFT, verifier: mockVerifier } = await deployZKPassport(
      viem,
      owner.account.address,
      { symbol: "ZKPASS" }
    ));

    // Deploy FaucetManager with owner as initial admin
    faucetManager = await viem.deployContract("FaucetManager", [
      zkPassportNFT.address,
      owner.account.address, // initialAdmin
    ]);

    // Mint ZKPassport NFTs for users
    await mintPassport(viem, zkPassportNFT, mockVerifier, user1.account, "faucetmanager-user1");
    await mintPassport(viem, zkPassportNFT, mockVerifier, user2.account, "faucetmanager-user2");
  });

  // ==================== DEPLOYMENT TESTS ====================

  it("Should deploy with correct NFT contract", async function () {
    const nftContract = await faucetManager.read.nftContract();
    assert.equal(nftContract.toLowerCase(), zkPassportNFT.address.toLowerCase());
  });

  it("Should grant deployer admin roles", async function () {
    const isAdmin = await faucetManager.read.isAdmin([owner.account.address]);
    const isSuperAdmin = await faucetManager.read.isSuperAdmin([owner.account.address]);
    assert.equal(isAdmin, true);
    assert.equal(isSuperAdmin, true);
  });

  // ==================== VAULT CREATION TESTS ====================

  it("Should create a non-returnable vault", async function () {
    await faucetManager.write.createVault([
      "Community Grants",
      "Free ETH for community members",
      parseEther("0.1"),
      0, // NonReturnable
      false, // whitelistEnabled
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vault = await faucetManager.read.getVault([0n]);
    assert.equal(vault.name, "Community Grants");
    assert.equal(vault.vaultType, 0);
    assert.equal(vault.active, true);
    assert.equal(vault.whitelistEnabled, false);
    assert.equal(vault.zkPassportRequired, true);
  });

  it("Should create a returnable vault", async function () {
    await faucetManager.write.createVault([
      "ETHGlobal Hackathon",
      "ETH for hackathon participation",
      parseEther("0.5"),
      1, // Returnable
      false, // whitelistEnabled
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000",
    ]);

    const vault = await faucetManager.read.getVault([1n]);
    assert.equal(vault.name, "ETHGlobal Hackathon");
    assert.equal(vault.vaultType, 1);
  });

  it("Should reject vault with empty name", async function () {
    try {
      await faucetManager.write.createVault([
        "",
        "Description",
        parseEther("0.1"),
        0,
        false,
        true,  // zkPassportRequired
        "0x0000000000000000000000000000000000000000", // allowedToken
      ]);
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("empty name"));
    }
  });

  it("Should reject vault with zero claim amount", async function () {
    try {
      await faucetManager.write.createVault([
        "Test Vault",
        "Description",
        0n,
        0,
        false,
        true,  // zkPassportRequired
        "0x0000000000000000000000000000000000000000", // allowedToken
      ]);
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("claim amount must be > 0"));
    }
  });

  // ==================== DEPOSITS & WITHDRAWALS TESTS ====================

  it("Should allow admin to deposit ETH", async function () {
    await faucetManager.write.createVault([
      "Deposit Test Vault",
      "Description",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 2n; // Third vault created
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    const vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.balance, parseEther("5"));
  });

  it("Should allow admin to withdraw ETH", async function () {
    await faucetManager.write.createVault([
      "Withdraw Test Vault",
      "Description",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 3n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    const balanceBefore = await publicClient.getBalance({ address: owner.account.address });
    await faucetManager.write.withdraw([vaultId, parseEther("2")]);
    const balanceAfter = await publicClient.getBalance({ address: owner.account.address });

    // Balance should increase (minus gas)
    assert(balanceAfter > balanceBefore - parseEther("0.01"));

    const vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.balance, parseEther("3"));
  });

  // ==================== CLAIMS TESTS ====================

  it("Should allow ZKPassport holder to claim", async function () {
    await faucetManager.write.createVault([
      "Claim Test Vault",
      "Description",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 4n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    const balanceBefore = await publicClient.getBalance({ address: user1.account.address });
    await faucetManager.write.claim([vaultId], { account: user1.account });
    const balanceAfter = await publicClient.getBalance({ address: user1.account.address });

    assert(balanceAfter > balanceBefore);

    const claimInfo = await faucetManager.read.getClaimInfo([vaultId, user1.account.address]);
    assert.equal(claimInfo.hasClaimed, true);
    assert.equal(claimInfo.claimedAmount, parseEther("0.1"));
  });

  it("Should prevent double claims from same user", async function () {
    await faucetManager.write.createVault([
      "Double Claim Test",
      "Description",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 5n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });
    await faucetManager.write.claim([vaultId], { account: user1.account });

    try {
      await faucetManager.write.claim([vaultId], { account: user1.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("already claimed"));
    }
  });

  it("Should allow user to claim from multiple vaults", async function () {
    // Create two more vaults
    await faucetManager.write.createVault([
      "Multi Vault A",
      "Description",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    await faucetManager.write.createVault([
      "Multi Vault B",
      "Description",
      parseEther("0.2"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultIdA = 6n;
    const vaultIdB = 7n;

    await faucetManager.write.deposit([vaultIdA], { value: parseEther("5") });
    await faucetManager.write.deposit([vaultIdB], { value: parseEther("5") });

    // User2 claims from both
    await faucetManager.write.claim([vaultIdA], { account: user2.account });
    await faucetManager.write.claim([vaultIdB], { account: user2.account });

    const claimA = await faucetManager.read.getClaimInfo([vaultIdA, user2.account.address]);
    const claimB = await faucetManager.read.getClaimInfo([vaultIdB, user2.account.address]);

    assert.equal(claimA.hasClaimed, true);
    assert.equal(claimB.hasClaimed, true);
  });

  it("Should prevent claim without ZKPassport NFT", async function () {
    await faucetManager.write.createVault([
      "No NFT Test",
      "Description",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 8n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // Admin doesn't have ZKPassport NFT
    try {
      await faucetManager.write.claim([vaultId], { account: admin.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("must own ZKPassport NFT"));
    }
  });

  it("Should prevent claim from inactive vault", async function () {
    await faucetManager.write.createVault([
      "Inactive Test",
      "Description",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 9n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // Deactivate vault
    await faucetManager.write.updateVault([
      vaultId,
      "Inactive Test",
      "Description",
      parseEther("0.1"),
      false,
    ]);

    try {
      await faucetManager.write.claim([vaultId], { account: user1.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("vault not active"));
    }
  });

  // ==================== WHITELIST TESTS ====================

  it("Should create a whitelisted vault", async function () {
    await faucetManager.write.createVault([
      "Whitelisted Vault",
      "Only whitelisted users can claim",
      parseEther("0.1"),
      0, // NonReturnable
      true, // whitelistEnabled
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 10n;
    const vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.whitelistEnabled, true);
  });

  it("Should prevent non-whitelisted user from claiming", async function () {
    const vaultId = 10n; // Whitelisted vault from previous test
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    try {
      await faucetManager.write.claim([vaultId], { account: user1.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("not whitelisted"));
    }
  });

  it("Should allow whitelisted user to claim", async function () {
    const vaultId = 10n;

    // Add user1 to whitelist
    await faucetManager.write.addToWhitelist([vaultId, user1.account.address]);

    // Check whitelist status
    const isWhitelisted = await faucetManager.read.isWhitelisted([vaultId, user1.account.address]);
    assert.equal(isWhitelisted, true);

    // Now user1 can claim
    await faucetManager.write.claim([vaultId], { account: user1.account });

    const claimInfo = await faucetManager.read.getClaimInfo([vaultId, user1.account.address]);
    assert.equal(claimInfo.hasClaimed, true);
  });

  it("Should add batch of users to whitelist", async function () {
    await faucetManager.write.createVault([
      "Batch Whitelist Vault",
      "Test batch whitelist",
      parseEther("0.1"),
      0,
      true,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 11n;

    // Add multiple users
    await faucetManager.write.addBatchToWhitelist([
      vaultId,
      [user1.account.address, user2.account.address],
    ]);

    const isUser1Whitelisted = await faucetManager.read.isWhitelisted([vaultId, user1.account.address]);
    const isUser2Whitelisted = await faucetManager.read.isWhitelisted([vaultId, user2.account.address]);

    assert.equal(isUser1Whitelisted, true);
    assert.equal(isUser2Whitelisted, true);
  });

  it("Should remove user from whitelist", async function () {
    const vaultId = 11n;

    await faucetManager.write.removeFromWhitelist([vaultId, user1.account.address]);

    const isWhitelisted = await faucetManager.read.isWhitelisted([vaultId, user1.account.address]);
    assert.equal(isWhitelisted, false);
  });

  it("Should toggle whitelist on vault", async function () {
    await faucetManager.write.createVault([
      "Toggle Whitelist Vault",
      "Test toggle",
      parseEther("0.1"),
      0,
      false, // Start without whitelist
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 12n;
    let vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.whitelistEnabled, false);

    // Enable whitelist
    await faucetManager.write.setWhitelistEnabled([vaultId, true]);
    vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.whitelistEnabled, true);

    // Disable whitelist
    await faucetManager.write.setWhitelistEnabled([vaultId, false]);
    vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.whitelistEnabled, false);
  });

  it("Should report whitelist status in canUserClaim", async function () {
    await faucetManager.write.createVault([
      "CanClaim Whitelist Test",
      "Test",
      parseEther("0.1"),
      0,
      true,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 13n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // User not whitelisted
    const [canClaim, reason] = await faucetManager.read.canUserClaim([vaultId, user2.account.address]);
    assert.equal(canClaim, false);
    assert.equal(reason, "Not whitelisted");

    // Add to whitelist
    await faucetManager.write.addToWhitelist([vaultId, user2.account.address]);
    const [canClaimNow] = await faucetManager.read.canUserClaim([vaultId, user2.account.address]);
    assert.equal(canClaimNow, true);
  });

  // ==================== RETURNS (RETURNABLE VAULTS) TESTS ====================

  it("Should allow user to return funds", async function () {
    await faucetManager.write.createVault([
      "Return Test Vault",
      "Description",
      parseEther("0.1"),
      1, // Returnable
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 14n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });
    await faucetManager.write.claim([vaultId], { account: user1.account });

    // Return funds
    await faucetManager.write.returnFunds([vaultId], {
      account: user1.account,
      value: parseEther("0.1"),
    });

    const claimInfo = await faucetManager.read.getClaimInfo([vaultId, user1.account.address]);
    assert.equal(claimInfo.hasReturned, true);
    assert.equal(claimInfo.returnedAmount, parseEther("0.1"));

    // Check return count (good actor)
    const returnCount = await faucetManager.read.getReturnCount([user1.account.address]);
    assert(returnCount >= 1n);
  });

  it("Should prevent return on non-returnable vault", async function () {
    await faucetManager.write.createVault([
      "Non-Return Test",
      "Description",
      parseEther("0.1"),
      0, // NonReturnable
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 15n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });
    await faucetManager.write.claim([vaultId], { account: user2.account });

    try {
      await faucetManager.write.returnFunds([vaultId], {
        account: user2.account,
        value: parseEther("0.1"),
      });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("vault is not returnable"));
    }
  });

  it("Should prevent return without claiming first", async function () {
    await faucetManager.write.createVault([
      "No Claim Return Test",
      "Description",
      parseEther("0.1"),
      1,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 16n;

    try {
      await faucetManager.write.returnFunds([vaultId], {
        account: user1.account,
        value: parseEther("0.1"),
      });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("must claim first"));
    }
  });

  it("Should prevent double returns", async function () {
    await faucetManager.write.createVault([
      "Double Return Test",
      "Description",
      parseEther("0.1"),
      1,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = 17n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });
    await faucetManager.write.claim([vaultId], { account: user2.account });
    await faucetManager.write.returnFunds([vaultId], {
      account: user2.account,
      value: parseEther("0.1"),
    });

    try {
      await faucetManager.write.returnFunds([vaultId], {
        account: user2.account,
        value: parseEther("0.1"),
      });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("already returned"));
    }
  });

  // ==================== ADMIN MANAGEMENT TESTS ====================

  it("Should allow super admin to add new admin", async function () {
    await faucetManager.write.addAdmin([admin.account.address]);
    const isAdmin = await faucetManager.read.isAdmin([admin.account.address]);
    assert.equal(isAdmin, true);
  });

  it("Should allow super admin to remove admin", async function () {
    // First ensure admin is added
    await faucetManager.write.addAdmin([treasury.account.address]);
    await faucetManager.write.removeAdmin([treasury.account.address]);
    const isAdmin = await faucetManager.read.isAdmin([treasury.account.address]);
    assert.equal(isAdmin, false);
  });

  it("Should prevent non-super-admin from adding admin", async function () {
    try {
      await faucetManager.write.addAdmin([user1.account.address], { account: admin.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      // AccessControl error
      assert(e.message.includes("AccessControl") || e.message.includes("denied"));
    }
  });

  // ==================== VIEW FUNCTIONS TESTS ====================

  it("Should return all vaults", async function () {
    const allVaults = await faucetManager.read.getAllVaults();
    assert(allVaults.length >= 14); // We created at least 14 vaults in previous tests
  });

  it("Should check if user can claim", async function () {
    await faucetManager.write.createVault([
      "Can Claim Test",
      "Desc",
      parseEther("0.1"),
      0,
      false,
      true,  // zkPassportRequired
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = await faucetManager.read.vaultCount() - 1n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // User with ZKPassport can claim
    const [canClaim1] = await faucetManager.read.canUserClaim([vaultId, user1.account.address]);
    assert.equal(canClaim1, true);

    // Admin without ZKPassport cannot claim
    const [canClaim2, reason2] = await faucetManager.read.canUserClaim([vaultId, admin.account.address]);
    assert.equal(canClaim2, false);
    assert.equal(reason2, "Must own ZKPassport NFT");
  });

  // ==================== OPTIONAL ZKPASSPORT GATING TESTS ====================

  it("Should create vault without ZKPassport requirement", async function () {
    await faucetManager.write.createVault([
      "No ZKPassport Required",
      "Anyone can claim",
      parseEther("0.1"),
      0,
      false,
      false, // zkPassportRequired = false
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = await faucetManager.read.vaultCount() - 1n;
    const vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.zkPassportRequired, false);

    // Deposit funds
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // Admin (who has NO ZKPassport) can claim successfully
    await faucetManager.write.claim([vaultId], { account: admin.account });

    const claimInfo = await faucetManager.read.getClaimInfo([vaultId, admin.account.address]);
    assert.equal(claimInfo.hasClaimed, true);
  });

  it("Should enforce ZKPassport when required", async function () {
    await faucetManager.write.createVault([
      "ZKPassport Enforced",
      "Must have ZKPassport",
      parseEther("0.1"),
      0,
      false,
      true, // zkPassportRequired = true
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = await faucetManager.read.vaultCount() - 1n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // Admin (no ZKPassport) tries to claim, should revert
    try {
      await faucetManager.write.claim([vaultId], { account: admin.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("must own ZKPassport NFT"));
    }
  });

  // ==================== TOKEN-BASED GATING TESTS ====================

  it("Should create vault with token gating", async function () {
    // Deploy a mock ERC20 token (MockUSDC)
    const mockUSDC = await viem.deployContract("MockUSDC");

    // Mint tokens to user1
    await mockUSDC.write.mint([user1.account.address, parseEther("100")]);

    // Create vault with token gating
    await faucetManager.write.createVault([
      "Token Gated Vault",
      "Must hold mock USDC",
      parseEther("0.1"),
      0,
      false,
      false, // zkPassportRequired = false
      mockUSDC.address, // allowedToken = mockUSDC
    ]);

    const vaultId = await faucetManager.read.vaultCount() - 1n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // user1 (has tokens) claims successfully
    await faucetManager.write.claim([vaultId], { account: user1.account });

    const claimInfo = await faucetManager.read.getClaimInfo([vaultId, user1.account.address]);
    assert.equal(claimInfo.hasClaimed, true);
  });

  it("Should prevent claim without required token", async function () {
    // Deploy a mock ERC20 token
    const mockUSDC = await viem.deployContract("MockUSDC");

    // Mint tokens only to user1, NOT to user2
    await mockUSDC.write.mint([user1.account.address, parseEther("100")]);

    // Create vault with token gating
    await faucetManager.write.createVault([
      "Token Required Vault",
      "Must hold mock USDC",
      parseEther("0.1"),
      0,
      false,
      false, // zkPassportRequired = false
      mockUSDC.address, // allowedToken = mockUSDC
    ]);

    const vaultId = await faucetManager.read.vaultCount() - 1n;
    await faucetManager.write.deposit([vaultId], { value: parseEther("5") });

    // user2 (no mock tokens) tries to claim, should revert
    try {
      await faucetManager.write.claim([vaultId], { account: user2.account });
      assert.fail("Should have reverted");
    } catch (e: any) {
      assert(e.message.includes("must hold required token"));
    }
  });

  // ==================== UPDATE VAULT GATING TESTS ====================

  it("Should update vault gating", async function () {
    await faucetManager.write.createVault([
      "Gating Update Test",
      "Test updateVaultGating",
      parseEther("0.1"),
      0,
      false,
      true, // zkPassportRequired = true
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    const vaultId = await faucetManager.read.vaultCount() - 1n;
    let vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.zkPassportRequired, true);

    // Update vault gating to disable ZKPassport requirement
    await faucetManager.write.updateVaultGating([
      vaultId,
      false, // zkPassportRequired = false
      "0x0000000000000000000000000000000000000000", // allowedToken
    ]);

    vault = await faucetManager.read.getVault([vaultId]);
    assert.equal(vault.zkPassportRequired, false);
  });
});
