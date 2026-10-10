import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import {
  deployZKPassport,
  uid,
  EMPTY_PARAMS,
  EXCLUDED_COUNTRIES,
  VALIDITY_PERIOD_SECONDS,
} from "./helpers/zkpassport.js";

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
    ({ nft: nftContract, verifier: mockVerifier } = await deployZKPassport(viem, deployerAddress));
  });

  /** Configure the mock for a mint call */
  async function setupMock(opts: {
    uniqueId:      `0x${string}`;
    sender:        `0x${string}`;
    verified?:     boolean;
    scopesValid?:  boolean;
    isOver18?:     boolean;
    nationality?:  string;
    issuingCountry?: string;
    sanctioned?:   boolean;
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
    await mockVerifier.write.setMockPolicy([opts.issuingCountry ?? "USA", opts.sanctioned ?? false]);
  }

  /** Expect a mint by `account` to revert with `reason` in its message. */
  async function expectMintRevert(account: any, reason: string, params: any = EMPTY_PARAMS) {
    try {
      await nftContract.write.mint([params, false], { account });
      assert.fail("Should have reverted");
    } catch (error: any) {
      assert(error.message.includes(reason), `expected "${reason}", got: ${error.message.slice(0, 200)}`);
    }
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

  // ── Policy (dashboard policy-1, owner decision 2026-10-10) ───────────────────

  it("Should reject a proof under the minimum age", async function () {
    await setupMock({ uniqueId: uid("id-minor"), sender: user2.account.address, isOver18: false });
    await expectMintRevert(user2.account, "under minimum age");
  });

  it("Should reject an excluded nationality", async function () {
    await setupMock({ uniqueId: uid("id-nat"), sender: user2.account.address, nationality: "PRK" });
    await expectMintRevert(user2.account, "nationality not allowed");
  });

  it("Should reject a document issued by an excluded country", async function () {
    await setupMock({ uniqueId: uid("id-issuer"), sender: user2.account.address, issuingCountry: "IRN" });
    await expectMintRevert(user2.account, "issuing country not allowed");
  });

  it("Should reject a proof that fails the sanctions screen", async function () {
    await setupMock({ uniqueId: uid("id-sanctioned"), sender: user2.account.address, sanctioned: true });
    await expectMintRevert(user2.account, "sanctioned");
  });

  it("Should reject a dev-mode proof before calling the verifier", async function () {
    await setupMock({ uniqueId: uid("id-dev"), sender: user2.account.address });
    const params = { ...EMPTY_PARAMS, serviceConfig: { ...EMPTY_PARAMS.serviceConfig, devMode: true } };
    await expectMintRevert(user2.account, "dev mode proof", params);
  });

  it("Should reject a proof with another validity period", async function () {
    await setupMock({ uniqueId: uid("id-validity"), sender: user2.account.address });
    const params = { ...EMPTY_PARAMS, serviceConfig: { ...EMPTY_PARAMS.serviceConfig, validityPeriodInSeconds: VALIDITY_PERIOD_SECONDS + 1n } };
    await expectMintRevert(user2.account, "invalid validity period", params);
  });

  it("Should mint Ukrainian nationals (UKR is not excluded)", async function () {
    await setupMock({ uniqueId: uid("id-ukr"), sender: user2.account.address, nationality: "UKR", issuingCountry: "UKR" });
    await nftContract.write.mint([EMPTY_PARAMS, false], { account: user2.account });
    const data = await nftContract.read.getTokenData([1n]);
    assert.equal(data.isOver18, true);
    assert.equal(data.nationality, "UKR");
  });

  it("canMint explains why an address cannot mint", async function () {
    const [okUser, reasonUser] = await nftContract.read.canMint([user3.account.address]);
    assert.equal(okUser, true);
    assert.equal(reasonUser, "");
    const [okHolder, reasonHolder] = await nftContract.read.canMint([userAddress]);
    assert.equal(okHolder, false);
    assert.match(reasonHolder, /already has an NFT/);
  });

  it("stores the exclusion list it was deployed with", async function () {
    assert.deepEqual(await nftContract.read.excludedCountries(), EXCLUDED_COUNTRIES);
  });

  it("Only the owner can change the exclusion list, and only to alpha-3 codes", async function () {
    await assert.rejects(
      nftContract.write.setExcludedCountries([["PRK"]], { account: user.account }),
      /OwnableUnauthorizedAccount/
    );
    await assert.rejects(nftContract.write.setExcludedCountries([["KP"]]), /ISO alpha-3/);

    // An empty list switches the country checks off; the age and sanctions checks remain.
    await nftContract.write.setExcludedCountries([[]]);
    await setupMock({ uniqueId: uid("id-empty-list"), sender: user3.account.address, nationality: "PRK", issuingCountry: "PRK" });
    await nftContract.write.mint([EMPTY_PARAMS, false], { account: user3.account });
    assert.equal(await nftContract.read.hasNFTByAddress([user3.account.address]), true);

    await nftContract.write.setExcludedCountries([EXCLUDED_COUNTRIES]);
    assert.deepEqual(await nftContract.read.excludedCountries(), EXCLUDED_COUNTRIES);
  });

  it("Should refuse an empty domain or scope", async function () {
    await assert.rejects(
      viem.deployContract("ZKPassportNFT", ["Z", "Z", deployerAddress, "", "policy-1", EXCLUDED_COUNTRIES, mockVerifier.address]),
      /empty domain/
    );
    await assert.rejects(nftContract.write.setScope([""]), /empty scope/);
  });

  it("hasNFTByAddress returns true for minted address", async function () {
    assert.equal(await nftContract.read.hasNFTByAddress([userAddress]), true);
  });

  it("hasNFTByAddress returns false for unminted address", async function () {
    assert.equal(await nftContract.read.hasNFTByAddress([deployerAddress]), false);
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

  it("Has no way to repoint the verifier", async function () {
    assert.equal((nftContract.abi as any[]).some((f) => f.name === "setVerifier"), false);
    assert.equal((await nftContract.read.zkPassportVerifier()).toLowerCase(), mockVerifier.address.toLowerCase());
  });

  it("Refuses a verifier without code", async function () {
    await assert.rejects(
      viem.deployContract("ZKPassportNFT", ["Z", "Z", deployerAddress, "ethcali.org", "policy-1", EXCLUDED_COUNTRIES, user.account.address]),
      /verifier has no code/
    );
  });

  it("Refuses a country list that is unsorted, duplicated, lowercase or too long", async function () {
    await assert.rejects(nftContract.write.setExcludedCountries([["PRK", "IRN"]]), /sorted and unique/);
    await assert.rejects(nftContract.write.setExcludedCountries([["IRN", "IRN"]]), /sorted and unique/);
    await assert.rejects(nftContract.write.setExcludedCountries([["prk"]]), /uppercase A-Z/);
    const tooMany = Array.from({ length: 65 }, (_, i) => `A${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    await assert.rejects(nftContract.write.setExcludedCountries([tooMany]), /too many countries/);
    assert.deepEqual(await nftContract.read.excludedCountries(), EXCLUDED_COUNTRIES);
  });

  it("A refused mint consumes neither the identifier nor the address", async function () {
    await setupMock({ uniqueId: uid("id-retry"), sender: deployerAddress, nationality: "PRK" });
    await expectMintRevert(deployer.account, "nationality not allowed");
    assert.equal(await nftContract.read.hasNFTByIdentifier([uid("id-retry")]), false);
    assert.equal(await nftContract.read.hasNFTByAddress([deployerAddress]), false);
  });
});

