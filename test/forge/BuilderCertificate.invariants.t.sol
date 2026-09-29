// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BuilderCertificate} from "../../contracts/BuilderCertificate.sol";

/**
 * Invariant and fuzz tests for BuilderCertificate.
 *
 * The Hardhat suite proves each flow. This proves the registry stays coherent
 * under ANY interleaving of issues, revokes, re-issues, metadata changes and
 * transfer attempts — the class of bug where a credential ends up pointing at
 * the wrong token, or a soulbound certificate moves.
 *
 * Properties under test:
 *
 *   1. A certificate never changes owner between its mint and its burn.
 *   2. Every live credential maps to exactly one live token, and back.
 *   3. The sum of balances equals the number of live certificates.
 *   4. `totalIssued` only grows, and a token id is never minted twice.
 *   5. Nobody without ADMIN_ROLE can issue, revoke or re-point metadata.
 */
contract BuilderCertificateHandler is Test {
    BuilderCertificate public immutable cert;
    address public immutable admin;

    address[] public actors;
    bytes32[] public credentials;

    // Ghost state: what the contract should look like.
    uint256[] public liveTokens;
    mapping(uint256 => address) public mintedTo;
    mapping(uint256 => bool) public everMinted;
    uint256 public maxTotalSeen;
    bool public transferSucceeded;
    bool public duplicateMint;

    constructor(BuilderCertificate cert_, address admin_) {
        cert = cert_;
        admin = admin_;
        for (uint256 i; i < 4; ++i) actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        // A small credential space so re-issues and collisions actually happen.
        for (uint256 i; i < 6; ++i) credentials.push(keccak256(abi.encode("cred", i)));
    }

    function liveCount() external view returns (uint256) {
        return liveTokens.length;
    }

    function actorsCount() external view returns (uint256) {
        return actors.length;
    }

    function credentialsCount() external view returns (uint256) {
        return credentials.length;
    }

    function issue(uint256 actorSeed, uint256 credSeed) external {
        address to = actors[actorSeed % actors.length];
        bytes32 c = credentials[credSeed % credentials.length];
        BuilderCertificate.Issuance[] memory items = new BuilderCertificate.Issuance[](1);
        items[0] = BuilderCertificate.Issuance({to: to, credentialId: c, cid: "bafyTEST"});

        bool live = cert.tokenOfCredential(c) != 0;
        vm.prank(admin);
        if (live) {
            vm.expectRevert();
            cert.issue(items);
            return;
        }
        uint256 id = cert.issue(items);
        if (everMinted[id]) duplicateMint = true;
        everMinted[id] = true;
        mintedTo[id] = to;
        liveTokens.push(id);
        if (cert.totalIssued() > maxTotalSeen) maxTotalSeen = cert.totalIssued();
    }

    function revoke(uint256 seed) external {
        if (liveTokens.length == 0) return;
        uint256 idx = seed % liveTokens.length;
        uint256 id = liveTokens[idx];
        vm.prank(admin);
        cert.revoke(id);
        liveTokens[idx] = liveTokens[liveTokens.length - 1];
        liveTokens.pop();
    }

    function setCid(uint256 seed) external {
        if (liveTokens.length == 0) return;
        vm.prank(admin);
        cert.setTokenCid(liveTokens[seed % liveTokens.length], "bafyNEW");
    }

    /// Every transfer path, by the holder and by strangers, must fail.
    function tryTransfer(uint256 seed, uint256 toSeed, bool byHolder, uint8 path) external {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[seed % liveTokens.length];
        address holder = cert.ownerOf(id);
        address to = actors[toSeed % actors.length];
        address caller = byHolder ? holder : to;

        vm.startPrank(caller);
        bool ok;
        uint256 p = path % 4;
        if (p == 0) (ok,) = address(cert).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", holder, to, id));
        else if (p == 1) (ok,) = address(cert).call(abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", holder, to, id));
        else if (p == 2) (ok,) = address(cert).call(abi.encodeWithSignature("approve(address,uint256)", to, id));
        else (ok,) = address(cert).call(abi.encodeWithSignature("setApprovalForAll(address,bool)", to, true));
        vm.stopPrank();

        if (ok || cert.ownerOf(id) != mintedTo[id]) transferSucceeded = true;
    }

    /// A random non-admin must never be able to write.
    function strangerWrites(uint256 actorSeed, uint256 credSeed) external {
        address who = actors[actorSeed % actors.length];
        BuilderCertificate.Issuance[] memory items = new BuilderCertificate.Issuance[](1);
        items[0] = BuilderCertificate.Issuance({to: who, credentialId: credentials[credSeed % credentials.length], cid: "x"});
        vm.startPrank(who);
        vm.expectRevert();
        cert.issue(items);
        if (liveTokens.length > 0) {
            uint256 id = liveTokens[credSeed % liveTokens.length];
            vm.expectRevert();
            cert.revoke(id);
            vm.expectRevert();
            cert.setTokenCid(id, "y");
        }
        vm.stopPrank();
    }
}

contract BuilderCertificateInvariants is StdInvariant, Test {
    BuilderCertificate internal cert;
    BuilderCertificateHandler internal handler;
    address internal admin = makeAddr("admin");

    function setUp() public {
        cert = new BuilderCertificate(admin, new address[](0));
        handler = new BuilderCertificateHandler(cert, admin);
        targetContract(address(handler));
    }

    /// 1. Soulbound.
    function invariant_neverTransfers() public view {
        assertFalse(handler.transferSucceeded(), "a certificate changed hands");
    }

    /// 2. Credential <-> token is a bijection over live tokens, and owners match the mint.
    function invariant_registryCoherent() public view {
        uint256 n = handler.liveCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            bytes32 c = cert.credentialOf(id);
            assertTrue(c != bytes32(0), "live token without credential");
            assertEq(cert.tokenOfCredential(c), id, "credential does not point back");
            assertEq(cert.ownerOf(id), handler.mintedTo(id), "owner is not the minted recipient");
            assertTrue(cert.locked(id), "live token not locked");
        }
        // No credential points at a dead token.
        for (uint256 j; j < handler.credentialsCount(); ++j) {
            uint256 id = cert.tokenOfCredential(handler.credentials(j));
            if (id != 0) assertEq(cert.credentialOf(id), handler.credentials(j), "credential points at a token that is not its own");
        }
    }

    /// 3. Balances add up to live certificates.
    function invariant_balancesMatchLive() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorsCount(); ++i) sum += cert.balanceOf(handler.actors(i));
        assertEq(sum, handler.liveCount(), "balances do not add up to live certificates");
    }

    /// 4. Ids are never reused and the counter never goes back.
    function invariant_idsMonotonic() public view {
        assertFalse(handler.duplicateMint(), "a token id was minted twice");
        assertGe(cert.totalIssued(), handler.maxTotalSeen(), "totalIssued went backwards");
        assertGe(cert.totalIssued(), handler.liveCount(), "more live tokens than ever issued");
    }
}

/// Stateless fuzz: roles and the soulbound guard against arbitrary inputs.
contract BuilderCertificateFuzz is Test {
    BuilderCertificate internal cert;
    address internal admin = makeAddr("admin");

    function setUp() public {
        cert = new BuilderCertificate(admin, new address[](0));
    }

    function testFuzz_onlyAdminIssues(address caller, address to, bytes32 c) public {
        vm.assume(caller != admin && to != address(0) && c != bytes32(0));
        BuilderCertificate.Issuance[] memory items = new BuilderCertificate.Issuance[](1);
        items[0] = BuilderCertificate.Issuance({to: to, credentialId: c, cid: "bafy"});
        vm.prank(caller);
        vm.expectRevert();
        cert.issue(items);
    }

    function testFuzz_issuedCertificateCannotMove(address holder, address to, bytes32 c) public {
        vm.assume(holder != address(0) && to != address(0) && holder != to && c != bytes32(0));
        vm.assume(holder.code.length == 0);
        BuilderCertificate.Issuance[] memory items = new BuilderCertificate.Issuance[](1);
        items[0] = BuilderCertificate.Issuance({to: holder, credentialId: c, cid: "bafy"});
        vm.prank(admin);
        uint256 id = cert.issue(items);

        vm.startPrank(holder);
        vm.expectRevert(BuilderCertificate.Soulbound.selector);
        cert.transferFrom(holder, to, id);
        vm.expectRevert(BuilderCertificate.Soulbound.selector);
        cert.safeTransferFrom(holder, to, id);
        vm.stopPrank();
        assertEq(cert.ownerOf(id), holder);
    }

    function testFuzz_batchIsAtomic(uint8 size, uint8 badAt) public {
        uint256 n = bound(size, 2, 50);
        uint256 bad = bound(badAt, 0, n - 1);
        BuilderCertificate.Issuance[] memory items = new BuilderCertificate.Issuance[](n);
        for (uint256 i; i < n; ++i) {
            items[i] = BuilderCertificate.Issuance({to: makeAddr("b"), credentialId: keccak256(abi.encode(i)), cid: "bafy"});
        }
        items[bad].cid = ""; // one bad item
        vm.prank(admin);
        vm.expectRevert(BuilderCertificate.EmptyCid.selector);
        cert.issue(items);
        assertEq(cert.totalIssued(), 0, "partial batch landed");
    }
}
