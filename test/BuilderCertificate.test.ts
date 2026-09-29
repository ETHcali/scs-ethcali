import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { stringToHex, zeroAddress } from "viem";

/**
 * BuilderCertificate is an issued, soulbound credential. The properties that
 * matter: only ETH Cali operators can issue or revoke; a credential id is live
 * at most once; a certificate never changes hands; and a batch lands whole or
 * not at all.
 */
describe("BuilderCertificate", async function () {
  const { viem } = await network.connect();
  const [deployer, superAdmin, operator, builder, builder2, outsider] = await viem.getWalletClients();

  const cred = (s: string) => stringToHex(s, { size: 32 });
  const same = (a: string, b: string) => assert.equal(a.toLowerCase(), b.toLowerCase());
  const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

  let cert: any;

  async function fresh() {
    return viem.deployContract("BuilderCertificate", [
      superAdmin.account.address,
      [operator.account.address],
    ]);
  }

  async function asRole(client: any) {
    return viem.getContractAt("BuilderCertificate", cert.address, { client: { wallet: client } });
  }

  async function rejects(p: Promise<unknown>, error: string) {
    await assert.rejects(p, (e: any) => {
      assert.match(String(e?.message ?? e), new RegExp(error));
      return true;
    });
  }

  before(async () => {
    cert = await fresh();
  });

  describe("roles", () => {
    it("gives the deployer no role at all", async () => {
      const ADMIN = await cert.read.ADMIN_ROLE();
      const DEFAULT = await cert.read.DEFAULT_ADMIN_ROLE();
      assert.equal(await cert.read.hasRole([ADMIN, deployer.account.address]), false);
      assert.equal(await cert.read.hasRole([DEFAULT, deployer.account.address]), false);
    });

    it("gives the super admin both roles and the operators ADMIN_ROLE only", async () => {
      const ADMIN = await cert.read.ADMIN_ROLE();
      const DEFAULT = await cert.read.DEFAULT_ADMIN_ROLE();
      assert.equal(await cert.read.hasRole([DEFAULT, superAdmin.account.address]), true);
      assert.equal(await cert.read.hasRole([ADMIN, superAdmin.account.address]), true);
      assert.equal(await cert.read.hasRole([ADMIN, operator.account.address]), true);
      assert.equal(await cert.read.hasRole([DEFAULT, operator.account.address]), false);
    });

    it("refuses a zero super admin or a zero operator", async () => {
      await rejects(viem.deployContract("BuilderCertificate", [zeroAddress, []]), "ZeroAddress");
      await rejects(
        viem.deployContract("BuilderCertificate", [superAdmin.account.address, [zeroAddress]]),
        "ZeroAddress"
      );
    });

    it("lets the super admin add an operator, who can then issue", async () => {
      const c = await fresh();
      const ADMIN = await c.read.ADMIN_ROLE();
      const asSuper = await viem.getContractAt("BuilderCertificate", c.address, { client: { wallet: superAdmin } });
      await asSuper.write.grantRole([ADMIN, outsider.account.address]);
      const asNew = await viem.getContractAt("BuilderCertificate", c.address, { client: { wallet: outsider } });
      await asNew.write.issue([[{ to: builder.account.address, credentialId: cred("X-00000001"), cid: CID }]]);
      same(await c.read.ownerOf([1n]), builder.account.address);
    });
  });

  describe("issue", () => {
    it("mints a batch in order, records each credential and serves ipfs:// URIs", async () => {
      const op = await asRole(operator);
      await op.write.issue([
        [
          { to: builder.account.address, credentialId: cred("EAGCALI26-AAAAAAAA"), cid: CID },
          { to: builder2.account.address, credentialId: cred("EAGCALI26-BBBBBBBB"), cid: `${CID}2` },
        ],
      ]);
      assert.equal(await cert.read.totalIssued(), 2n);
      same(await cert.read.ownerOf([1n]), builder.account.address);
      same(await cert.read.ownerOf([2n]), builder2.account.address);
      assert.equal(await cert.read.tokenOfCredential([cred("EAGCALI26-AAAAAAAA")]), 1n);
      assert.equal(await cert.read.credentialOf([2n]), cred("EAGCALI26-BBBBBBBB"));
      assert.equal(await cert.read.tokenURI([1n]), `ipfs://${CID}`);
      assert.equal(await cert.read.locked([1n]), true);
    });

    it("refuses a credential that is already live", async () => {
      const op = await asRole(operator);
      await rejects(
        op.write.issue([[{ to: outsider.account.address, credentialId: cred("EAGCALI26-AAAAAAAA"), cid: CID }]]),
        "AlreadyIssued"
      );
    });

    it("rolls back the whole batch when one item is bad", async () => {
      const op = await asRole(operator);
      const before = await cert.read.totalIssued();
      await rejects(
        op.write.issue([
          [
            { to: builder.account.address, credentialId: cred("EAGCALI26-CCCCCCCC"), cid: CID },
            { to: builder.account.address, credentialId: cred("EAGCALI26-CCCCCCCC"), cid: CID },
          ],
        ]),
        "AlreadyIssued"
      );
      assert.equal(await cert.read.totalIssued(), before);
      assert.equal(await cert.read.tokenOfCredential([cred("EAGCALI26-CCCCCCCC")]), 0n);
    });

    it("validates every field", async () => {
      const op = await asRole(operator);
      await rejects(op.write.issue([[]]), "EmptyBatch");
      await rejects(
        op.write.issue([[{ to: zeroAddress, credentialId: cred("Z-1"), cid: CID }]]),
        "ZeroAddress"
      );
      await rejects(
        op.write.issue([[{ to: builder.account.address, credentialId: `0x${"00".repeat(32)}`, cid: CID }]]),
        "EmptyCredential"
      );
      await rejects(
        op.write.issue([[{ to: builder.account.address, credentialId: cred("Z-2"), cid: "" }]]),
        "EmptyCid"
      );
    });

    it("caps a batch at MAX_BATCH", async () => {
      const op = await asRole(operator);
      const items = Array.from({ length: 101 }, (_, i) => ({
        to: builder.account.address,
        credentialId: cred(`BIG-${i}`),
        cid: CID,
      }));
      await rejects(op.write.issue([items]), "BatchTooLarge");
    });

    it("is closed to everyone without ADMIN_ROLE", async () => {
      const out = await asRole(outsider);
      await rejects(
        out.write.issue([[{ to: outsider.account.address, credentialId: cred("NOPE-1"), cid: CID }]]),
        "AccessControlUnauthorizedAccount"
      );
      const dep = await asRole(deployer);
      await rejects(
        dep.write.issue([[{ to: deployer.account.address, credentialId: cred("NOPE-2"), cid: CID }]]),
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("soulbound", () => {
    it("refuses every transfer path, even by the holder", async () => {
      const asBuilder = await asRole(builder);
      await rejects(
        asBuilder.write.transferFrom([builder.account.address, outsider.account.address, 1n]),
        "Soulbound"
      );
      await rejects(
        asBuilder.write.safeTransferFrom([builder.account.address, outsider.account.address, 1n]),
        "Soulbound"
      );
      await rejects(asBuilder.write.approve([outsider.account.address, 1n]), "Soulbound");
      await rejects(asBuilder.write.setApprovalForAll([outsider.account.address, true]), "Soulbound");
      same(await cert.read.ownerOf([1n]), builder.account.address);
    });

    it("advertises ERC-721, ERC-5192 and ERC-4906", async () => {
      assert.equal(await cert.read.supportsInterface(["0x80ac58cd"]), true); // ERC-721
      assert.equal(await cert.read.supportsInterface(["0xb45a3c0e"]), true); // ERC-5192
      assert.equal(await cert.read.supportsInterface(["0x49064906"]), true); // ERC-4906
      assert.equal(await cert.read.supportsInterface(["0x7965db0b"]), true); // AccessControl
    });
  });

  describe("revoke and re-issue", () => {
    it("burns the token, frees the credential, and re-issues under a new token id", async () => {
      const op = await asRole(operator);
      const credentialId = cred("EAGCALI26-AAAAAAAA");
      await op.write.revoke([1n]);

      await rejects(cert.read.ownerOf([1n]), "ERC721NonexistentToken");
      await rejects(cert.read.tokenURI([1n]), "ERC721NonexistentToken");
      assert.equal(await cert.read.tokenOfCredential([credentialId]), 0n);
      assert.equal(await cert.read.balanceOf([builder.account.address]), 0n);

      const next = (await cert.read.totalIssued()) + 1n;
      await op.write.issue([[{ to: outsider.account.address, credentialId, cid: CID }]]);
      same(await cert.read.ownerOf([next]), outsider.account.address);
      assert.equal(await cert.read.tokenOfCredential([credentialId]), next);
    });

    it("refuses to revoke a token that does not exist, and is admin-only", async () => {
      const op = await asRole(operator);
      await rejects(op.write.revoke([999n]), "ERC721NonexistentToken");
      const out = await asRole(outsider);
      await rejects(out.write.revoke([2n]), "AccessControlUnauthorizedAccount");
    });
  });

  describe("setTokenCid", () => {
    it("re-points a live token's metadata and emits MetadataUpdate", async () => {
      const op = await asRole(operator);
      const publicClient = await viem.getPublicClient();
      const hash = await op.write.setTokenCid([2n, "bafyNEW"]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(await cert.read.tokenURI([2n]), "ipfs://bafyNEW");
      assert.equal(receipt.logs.length, 1);
    });

    it("refuses an empty CID, a missing token and a non-admin", async () => {
      const op = await asRole(operator);
      await rejects(op.write.setTokenCid([2n, ""]), "EmptyCid");
      await rejects(op.write.setTokenCid([999n, CID]), "ERC721NonexistentToken");
      const out = await asRole(outsider);
      await rejects(out.write.setTokenCid([2n, CID]), "AccessControlUnauthorizedAccount");
    });
  });
});
