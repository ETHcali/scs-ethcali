import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";

const USDC_DECIMALS = 6n;
const USDC = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;

const ZERO = "0x0000000000000000000000000000000000000000";

describe("SwagFactory", async function () {
  const { viem } = await network.connect();
  const [deployer, factoryAdmin2, itemAdmin, buyer, treasury] = await viem.getWalletClients();

  let usdc: any;
  let implementation: any;
  let factory: any;

  /**
   * Three sizes for a standard product. Prices live in per-size `payments`
   * entries now — a size can accept several tokens, so price is no longer a
   * single field on the variant.
   */
  function threeSizes() {
    return [
      {
        metadataURI: "ipfs://QmSmall/metadata.json",
        maxSupply: 50n,
        active: true,
        payments: [{ token: usdc.address, price: USDC(25) }],
      },
      {
        metadataURI: "ipfs://QmMedium/metadata.json",
        maxSupply: 100n,
        active: true,
        payments: [{ token: usdc.address, price: USDC(25) }],
      },
      {
        metadataURI: "ipfs://QmLarge/metadata.json",
        maxSupply: 75n,
        active: true,
        payments: [{ token: usdc.address, price: USDC(30) }],
      },
    ];
  }

  before(async function () {
    usdc = await viem.deployContract("MockUSDC", []);

    // The factory clones this implementation via EIP-1167 for every collection.
    implementation = await viem.deployContract("Swag1155", []);

    factory = await viem.deployContract("SwagFactory", [
      deployer.account.address,
      implementation.address,
    ]);
  });

  // ── Initialization ──────────────────────────────────────────────────────────

  it("constructor grants DEFAULT_ADMIN_ROLE and ADMIN_ROLE to admin", async function () {
    const [defaultAdminRole, adminRole] = await Promise.all([
      factory.read.DEFAULT_ADMIN_ROLE(),
      factory.read.ADMIN_ROLE(),
    ]);
    assert.equal(await factory.read.hasRole([defaultAdminRole, deployer.account.address]), true);
    assert.equal(await factory.read.hasRole([adminRole, deployer.account.address]), true);
  });

  it("constructor stores the implementation address", async function () {
    const impl = await factory.read.implementation();
    assert.equal(impl.toLowerCase(), implementation.address.toLowerCase());
  });

  it("reverts when deployed with a zero implementation", async function () {
    await assert.rejects(
      () => viem.deployContract("SwagFactory", [deployer.account.address, ZERO]),
      /InvalidAddress/
    );
  });

  it("reverts when deployed with a zero admin", async function () {
    await assert.rejects(
      () => viem.deployContract("SwagFactory", [ZERO, implementation.address]),
      /InvalidAdmin/
    );
  });

  // ── deployCollection ────────────────────────────────────────────────────────

  it("deploys a collection with 3 sizes (S/M/L)", async function () {
    await factory.write.deployCollection([
      "ETH Cali Hoodie",
      "ETH-CALI-HOODIE-2025",
      treasury.account.address,
      itemAdmin.account.address,
      threeSizes(),
    ]);

    assert.equal(await factory.read.getCollectionCount(), 1n);
  });

  it("getCollections returns the deployed address", async function () {
    const all = await factory.read.getCollections();
    assert.equal(all.length, 1);
  });

  it("getActiveCollections returns the new collection", async function () {
    const active = await factory.read.getActiveCollections();
    assert.equal(active.length, 1);
  });

  it("collectionMeta stores correct metadata", async function () {
    const [addr] = await factory.read.getCollections();
    const meta = await factory.read.getCollectionMeta([addr]);
    assert.equal(meta.name, "ETH Cali Hoodie");
    assert.equal(meta.sku, "ETH-CALI-HOODIE-2025");
    assert.equal(meta.treasury.toLowerCase(), treasury.account.address.toLowerCase());
    assert.equal(meta.creator.toLowerCase(), deployer.account.address.toLowerCase());
    assert.equal(meta.variantCount, 3n);
    assert.equal(meta.active, true);
    assert.ok(meta.deployedAt > 0n, "deployedAt should be non-zero");
  });

  it("isCollection returns true for deployed address", async function () {
    const [addr] = await factory.read.getCollections();
    assert.equal(await factory.read.isCollection([addr]), true);
  });

  it("isCollection returns false for random address", async function () {
    assert.equal(await factory.read.isCollection([deployer.account.address]), false);
  });

  it("each clone is a distinct address from the implementation", async function () {
    const [addr] = await factory.read.getCollections();
    assert.notEqual(addr.toLowerCase(), implementation.address.toLowerCase());
  });

  // ── Deployed Swag1155 state ─────────────────────────────────────────────────

  it("deployed Swag1155 tokenId 1 has correct price and maxSupply", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const v = await swag.read.getVariant([1n]);
    assert.equal(v.maxSupply, 50n);
    assert.equal(v.active, true);
    assert.equal(await swag.read.getTokenPrice([1n, usdc.address]), USDC(25));
  });

  it("deployed Swag1155 tokenId 2 has correct price and maxSupply", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const v = await swag.read.getVariant([2n]);
    assert.equal(v.maxSupply, 100n);
    assert.equal(v.active, true);
    assert.equal(await swag.read.getTokenPrice([2n, usdc.address]), USDC(25));
  });

  it("deployed Swag1155 tokenId 3 has correct price and maxSupply", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const v = await swag.read.getVariant([3n]);
    assert.equal(v.maxSupply, 75n);
    assert.equal(v.active, true);
    assert.equal(await swag.read.getTokenPrice([3n, usdc.address]), USDC(30));
  });

  it("deployed Swag1155 per-token URIs are set correctly", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    assert.equal(await swag.read.uri([1n]), "ipfs://QmSmall/metadata.json");
    assert.equal(await swag.read.uri([2n]), "ipfs://QmMedium/metadata.json");
    assert.equal(await swag.read.uri([3n]), "ipfs://QmLarge/metadata.json");
  });

  it("deployed Swag1155 lists exactly its three tokenIds", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const ids = await swag.read.listTokenIds();
    assert.deepEqual([...ids].sort((a: bigint, b: bigint) => Number(a - b)), [1n, 2n, 3n]);
  });

  it("the implementation itself cannot be initialized", async function () {
    await assert.rejects(
      () =>
        implementation.write.initialize([
          "ipfs://x",
          treasury.account.address,
          deployer.account.address,
        ]),
      /already initialized/
    );
  });

  // ── Role handoff after deployCollection ────────────────────────────────────

  it("factory holds NO roles on the deployed Swag1155 after deployCollection", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const [defaultAdmin, adminRole] = await Promise.all([
      swag.read.DEFAULT_ADMIN_ROLE(),
      swag.read.ADMIN_ROLE(),
    ]);

    assert.equal(
      await swag.read.hasRole([defaultAdmin, factory.address]),
      false,
      "factory must not hold DEFAULT_ADMIN_ROLE on Swag1155"
    );
    assert.equal(
      await swag.read.hasRole([adminRole, factory.address]),
      false,
      "factory must not hold ADMIN_ROLE on Swag1155"
    );
  });

  it("itemAdmin holds DEFAULT_ADMIN_ROLE on the deployed Swag1155", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const defaultAdmin = await swag.read.DEFAULT_ADMIN_ROLE();
    assert.equal(await swag.read.hasRole([defaultAdmin, itemAdmin.account.address]), true);
  });

  it("itemAdmin holds ADMIN_ROLE on the deployed Swag1155", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const adminRole = await swag.read.ADMIN_ROLE();
    assert.equal(await swag.read.hasRole([adminRole, itemAdmin.account.address]), true);
  });

  it("itemAdmin can set a new variant on the Swag1155", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    // tokenId 4 = XL — itemAdmin creates it directly, then prices it.
    await swag.write.setVariantWithURI([4n, 25n, true, "ipfs://QmXL/metadata.json"], {
      account: itemAdmin.account,
    });
    await swag.write.setPaymentOption([4n, usdc.address, USDC(35)], {
      account: itemAdmin.account,
    });

    const v = await swag.read.getVariant([4n]);
    assert.equal(v.maxSupply, 25n);
    assert.equal(await swag.read.getTokenPrice([4n, usdc.address]), USDC(35));
  });

  it("a non-itemAdmin cannot set a variant on the Swag1155", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    await assert.rejects(
      () =>
        swag.write.setVariantWithURI([9n, 5n, true, "ipfs://QmNope/metadata.json"], {
          account: buyer.account,
        }),
      /AccessControlUnauthorizedAccount/
    );
  });

  it("buyer can purchase from a factory-deployed Swag1155", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    await usdc.write.mint([buyer.account.address, USDC(1000)]);
    await usdc.write.approve([addr, USDC(1000)], { account: buyer.account });

    await swag.write.buy([1n, 2n, usdc.address], { account: buyer.account });

    assert.equal(await swag.read.balanceOf([buyer.account.address, 1n]), 2n);
  });

  it("sale proceeds land in the collection treasury", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);

    const before = await usdc.read.balanceOf([treasury.account.address]);
    await swag.write.buy([2n, 1n, usdc.address], { account: buyer.account });
    const after = await usdc.read.balanceOf([treasury.account.address]);

    assert.equal(after - before, USDC(25));
  });

  it("buying with an unaccepted token reverts", async function () {
    const [addr] = await factory.read.getCollections();
    const swag = await viem.getContractAt("Swag1155", addr);
    const other = await viem.deployContract("MockUSDC", []);

    await assert.rejects(
      () => swag.write.buy([1n, 1n, other.address], { account: buyer.account }),
      /token not accepted/
    );
  });

  // ── setCollectionActive ─────────────────────────────────────────────────────

  it("setCollectionActive toggles active status", async function () {
    const [addr] = await factory.read.getCollections();

    await factory.write.setCollectionActive([addr, false]);
    const meta = await factory.read.getCollectionMeta([addr]);
    assert.equal(meta.active, false);

    // getActiveCollections should now return empty
    const active = await factory.read.getActiveCollections();
    assert.equal(active.length, 0);

    // Re-enable
    await factory.write.setCollectionActive([addr, true]);
    const meta2 = await factory.read.getCollectionMeta([addr]);
    assert.equal(meta2.active, true);
  });

  it("setCollectionActive reverts for unknown address", async function () {
    await assert.rejects(
      () => factory.write.setCollectionActive([deployer.account.address, false]),
      /NotACollection/
    );
  });

  // ── A second collection (independent registry) ──────────────────────────────

  it("deploying a second collection increments count to 2", async function () {
    await factory.write.deployCollection([
      "ETH Cali Tee",
      "ETH-CALI-TEE-2025",
      treasury.account.address,
      itemAdmin.account.address,
      [
        {
          metadataURI: "ipfs://QmTeeS/metadata.json",
          maxSupply: 200n,
          active: true,
          payments: [{ token: usdc.address, price: USDC(15) }],
        },
      ],
    ]);

    assert.equal(await factory.read.getCollectionCount(), 2n);
    assert.equal((await factory.read.getActiveCollections()).length, 2);
  });

  it("two collections have independent tokenId namespaces", async function () {
    const [addr1, addr2] = await factory.read.getCollections();
    const swag1 = await viem.getContractAt("Swag1155", addr1);
    const swag2 = await viem.getContractAt("Swag1155", addr2);

    // Hoodie tokenId 1 = S at 25 USDC / supply 50
    // Tee   tokenId 1 = S at 15 USDC / supply 200
    const v1 = await swag1.read.getVariant([1n]);
    const v2 = await swag2.read.getVariant([1n]);
    assert.equal(v1.maxSupply, 50n);
    assert.equal(v2.maxSupply, 200n);
    assert.equal(await swag1.read.getTokenPrice([1n, usdc.address]), USDC(25));
    assert.equal(await swag2.read.getTokenPrice([1n, usdc.address]), USDC(15));
  });

  // ── Admin-only gates ────────────────────────────────────────────────────────

  it("non-admin cannot call deployCollection", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection(
          [
            "Hacker Shirt",
            "HACK-001",
            treasury.account.address,
            itemAdmin.account.address,
            threeSizes(),
          ],
          { account: buyer.account }
        ),
      /AccessControlUnauthorizedAccount/
    );
  });

  it("non-admin cannot call setCollectionActive", async function () {
    const [addr] = await factory.read.getCollections();
    await assert.rejects(
      () => factory.write.setCollectionActive([addr, false], { account: buyer.account }),
      /AccessControlUnauthorizedAccount/
    );
  });

  it("non-DEFAULT_ADMIN_ROLE cannot call addAdmin", async function () {
    await assert.rejects(
      () => factory.write.addAdmin([buyer.account.address], { account: buyer.account }),
      /AccessControlUnauthorizedAccount/
    );
  });

  // ── addAdmin / removeAdmin ──────────────────────────────────────────────────

  it("DEFAULT_ADMIN can grant ADMIN_ROLE via addAdmin", async function () {
    await factory.write.addAdmin([factoryAdmin2.account.address]);

    const adminRole = await factory.read.ADMIN_ROLE();
    assert.equal(await factory.read.hasRole([adminRole, factoryAdmin2.account.address]), true);
  });

  it("new admin can deployCollection", async function () {
    const countBefore = await factory.read.getCollectionCount();
    await factory.write.deployCollection(
      [
        "ETH Cali Cap",
        "ETH-CALI-CAP-2025",
        treasury.account.address,
        itemAdmin.account.address,
        [
          {
            metadataURI: "ipfs://QmCapOneSize/metadata.json",
            maxSupply: 150n,
            active: true,
            payments: [{ token: usdc.address, price: USDC(20) }],
          },
        ],
      ],
      { account: factoryAdmin2.account }
    );
    assert.equal(await factory.read.getCollectionCount(), countBefore + 1n);
  });

  it("DEFAULT_ADMIN can revoke ADMIN_ROLE via removeAdmin", async function () {
    await factory.write.removeAdmin([factoryAdmin2.account.address]);

    const adminRole = await factory.read.ADMIN_ROLE();
    assert.equal(await factory.read.hasRole([adminRole, factoryAdmin2.account.address]), false);
  });

  it("revoked admin cannot deployCollection", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection(
          [
            "Another Item",
            "ITEM-001",
            treasury.account.address,
            itemAdmin.account.address,
            threeSizes(),
          ],
          { account: factoryAdmin2.account }
        ),
      /AccessControlUnauthorizedAccount/
    );
  });

  // ── deployCollection input validation ──────────────────────────────────────

  it("reverts with empty name", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection([
          "",
          "SKU-001",
          treasury.account.address,
          itemAdmin.account.address,
          threeSizes(),
        ]),
      /EmptyName/
    );
  });

  it("reverts with empty sku", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection([
          "Valid Name",
          "",
          treasury.account.address,
          itemAdmin.account.address,
          threeSizes(),
        ]),
      /EmptySku/
    );
  });

  it("reverts with zero treasury", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection([
          "Valid Name",
          "VALID-001",
          ZERO,
          itemAdmin.account.address,
          threeSizes(),
        ]),
      /InvalidTreasury/
    );
  });

  it("reverts with zero itemAdmin", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection([
          "Valid Name",
          "VALID-001",
          treasury.account.address,
          ZERO,
          threeSizes(),
        ]),
      /InvalidItemAdmin/
    );
  });

  it("reverts with empty sizes array", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection([
          "Valid Name",
          "VALID-001",
          treasury.account.address,
          itemAdmin.account.address,
          [],
        ]),
      /NoSizes/
    );
  });

  it("reverts when a size has no payment options", async function () {
    await assert.rejects(
      () =>
        factory.write.deployCollection([
          "Valid Name",
          "VALID-001",
          treasury.account.address,
          itemAdmin.account.address,
          [
            {
              metadataURI: "ipfs://QmNoPay/metadata.json",
              maxSupply: 10n,
              active: true,
              payments: [],
            },
          ],
        ]),
      /NoPaymentOptions/
    );
  });
});
