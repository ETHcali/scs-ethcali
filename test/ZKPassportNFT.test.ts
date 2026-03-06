import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { keccak256, toBytes } from "viem";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deterministic bytes32 from a test label */
function uid(label: string): `0x${string}` {
  return keccak256(toBytes(label));
}

/** Empty ProofVerificationParams — the mock ignores all fields */
const EMPTY_PARAMS = {
  version: ("0x" + "00".repeat(32)) as `0x${string}`,
  proofVerificationData: {
    vkeyHash:     ("0x" + "00".repeat(32)) as `0x${string}`,
    proof:        "0x" as `0x${string}`,
    publicInputs: [] as `0x${string}`[],
  },
  committedInputs: "0x" as `0x${string}`,
  serviceConfig: {
    validityPeriodInSeconds: 0n,
    domain:  "",
    scope:   "",
    devMode: false,
  },
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe("ZKPassportNFT", async function () {
  const { viem } = await network.connect();
  const [deployer, user, user2, user3] = await viem.getWalletClients();

  let nftContract: any;
  let mockVerifier: any;
  let deployerAddress: `0x${string}`;
  let userAddress: `0x${string}`;

  before(async function () {
    deployerAddress = deployer.account.address;
    userAddress     = user.account.address;

    // Deploy mock verifier
    mockVerifier = await viem.deployContract("MockZKPassportVerifier", []);

    // Deploy NFT contract (default verifier = real on-chain address)
    nftContract = await viem.deployContract("ZKPassportNFT", [
      "ZKPassport",
      "ZKP",
      deployerAddress,
      "ethcali.com",
      "ethcali-verification",
    ]);

    // Point to mock so tests work on local hardhat network
    await nftContract.write.setVerifier([mockVerifier.address]);
  });

  /** Configure the mock for a mint call */
  async function setupMock(opts: {
    uniqueId:      `0x${string}`;
    sender:        `0x${string}`;
    verified?:     boolean;
    scopesValid?:  boolean;
    isOver18?:     boolean;
    nationality?:  string;
    chainId?:      bigint;
  }) {
    const publicClient = await viem.getPublicClient();
    const chainId = opts.chainId ?? BigInt(await publicClient.getChainId());

    await mockVerifier.write.setMockResult([
      opts.verified    ?? true,
      opts.uniqueId,
      opts.scopesValid ?? true,
      opts.sender,
      opts.isOver18    ?? true,
      opts.nationality ?? "USA",
    ]);
    await mockVerifier.write.setChainId([chainId]);
  }

  // ── Tests ──────────────────────────────────────────────────────────────────

  it("Should deploy with correct name and symbol", async function () {
    assert.equal(await nftContract.read.name(), "ZKPassport");
    assert.equal(await nftContract.read.symbol(), "ZKP");
  });

  it("Should mint successfully with a valid ZK proof", async function () {
    await setupMock({ uniqueId: uid("id-user"), sender: userAddress });
    await nftContract.write.mint([EMPTY_PARAMS, false], { account: user.account });

    const balance = await nftContract.read.balanceOf([userAddress]);
    assert.equal(balance, 1n);
  });

  it("Should store correct token data after mint", async function () {
    const data = await nftContract.read.getTokenData([0n]);
    assert.equal(data.personhoodVerified, true);
    assert.equal(data.isOver18, true);
    assert.equal(data.nationality, "USA");
  });

  it("Should reject proof that fails on-chain verification", async function () {
    await setupMock({ uniqueId: uid("id-bad-proof"), sender: user2.account.address, verified: false });
    try {
      await nftContract.write.mint([EMPTY_PARAMS, false], { account: user2.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("proof verification failed"));
    }
  });

  it("Should reject if address already has NFT", async function () {
    await setupMock({ uniqueId: uid("id-duplicate-addr"), sender: userAddress });
    try {
      await nftContract.write.mint([EMPTY_PARAMS, false], { account: user.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("address already has NFT"));
    }
  });

  it("Should reject a duplicate unique identifier", async function () {
    // uid("id-user") was used in the first mint — use it again with deployer
    await setupMock({ uniqueId: uid("id-user"), sender: deployerAddress });
    try {
      await nftContract.write.mint([EMPTY_PARAMS, false], { account: deployer.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("identifier already used"));
    }
  });

  it("Should reject invalid domain or scope", async function () {
    await setupMock({ uniqueId: uid("id-bad-scope"), sender: deployer.account.address, scopesValid: false });
    try {
      await nftContract.write.mint([EMPTY_PARAMS, false], { account: deployer.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("invalid domain or scope"));
    }
  });

  it("Should reject sender address mismatch", async function () {
    // Proof claims senderAddress = userAddress, but deployer is calling
    await setupMock({ uniqueId: uid("id-mismatch-sender"), sender: userAddress });
    try {
      await nftContract.write.mint([EMPTY_PARAMS, false], { account: deployer.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("sender address mismatch"));
    }
  });

  it("Should reject chain id mismatch", async function () {
    await setupMock({ uniqueId: uid("id-mismatch-chain"), sender: deployer.account.address, chainId: 999999n });
    try {
      await nftContract.write.mint([EMPTY_PARAMS, false], { account: deployer.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("chain id mismatch"));
    }
  });

  it("Should store isOver18 = false when proof indicates under 18", async function () {
    await setupMock({ uniqueId: uid("id-user2"), sender: user2.account.address, isOver18: false, nationality: "MEX" });
    await nftContract.write.mint([EMPTY_PARAMS, false], { account: user2.account });

    const data = await nftContract.read.getTokenData([1n]);
    assert.equal(data.isOver18, false);
    assert.equal(data.nationality, "MEX");
  });

  it("hasNFTByAddress returns true for minted address", async function () {
    assert.equal(await nftContract.read.hasNFTByAddress([userAddress]), true);
  });

  it("hasNFTByAddress returns false for unminted address", async function () {
    assert.equal(await nftContract.read.hasNFTByAddress([user3.account.address]), false);
  });

  it("hasNFTByIdentifier returns true for used identifier", async function () {
    assert.equal(await nftContract.read.hasNFTByIdentifier([uid("id-user")]), true);
  });

  it("hasNFTByIdentifier returns false for unused identifier", async function () {
    assert.equal(await nftContract.read.hasNFTByIdentifier([uid("never-used")]), false);
  });

  it("Should generate valid base64 JSON token URI", async function () {
    const uri = await nftContract.read.tokenURI([0n]);
    assert(uri.startsWith("data:application/json;base64,"));
    const json = JSON.parse(Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString());
    assert(json.name.includes("ZKPassport"));
    assert(Array.isArray(json.attributes) && json.attributes.length > 0);
  });

  it("Should prevent transfers (soulbound)", async function () {
    try {
      await nftContract.write.transferFrom([userAddress, user3.account.address, 0n]);
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes("soulbound") || error.message.includes("transfers not allowed"));
    }
  });

  it("Should allow owner to update the verifier address", async function () {
    const newMock = await viem.deployContract("MockZKPassportVerifier", []);
    await nftContract.write.setVerifier([newMock.address]);
    // Restore
    await nftContract.write.setVerifier([mockVerifier.address]);
  });

  it("Should prevent non-owner from updating the verifier address", async function () {
    try {
      await nftContract.write.setVerifier([mockVerifier.address], { account: user.account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(
        error.message.includes("OwnableUnauthorizedAccount") ||
        error.message.includes("caller is not the owner")
      );
    }
  });
});

