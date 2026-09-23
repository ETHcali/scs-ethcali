// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";
import {Swag1155} from "../../contracts/Swag1155.sol";
import {SwagFactory} from "../../contracts/SwagFactory.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";

/**
 * Invariant and fuzz tests for Swag1155.
 *
 * The Hardhat suite proves the individual flows. This proves the inventory
 * accounting holds under ANY interleaving of the two sales channels, admin
 * reconfiguration, pausing and secondary transfers — the class of bug that
 * oversells a hoodie that exists exactly once.
 *
 * Properties under test:
 *
 *   1. Neither channel can mint past its own cap.
 *   2. Every unit in circulation is accounted to exactly one channel counter,
 *      and serials are issued one per unit.
 *   3. Every payment lands in the treasury; the contract never holds a wei or
 *      a token of revenue.
 *   4. A Shopify order reference mints once, ever — and never after a cancel.
 *   5. `canBuy` / `canClaim` never disagree with what `buy` / `claim` do.
 *   6. The tokenId registry never holds a duplicate or an empty variant.
 *
 * Instances come from SwagFactory.deployCollection — Swag1155 is clone-only.
 */
contract Swag1155Handler is Test {
    address internal constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address internal constant NOT_A_PAYMENT_TOKEN = address(0xDEAD);

    Swag1155 public immutable swag;
    MockERC20 public immutable token;
    address public immutable treasury;

    uint256 internal immutable signerPk;
    uint256 internal immutable roguePk;

    uint256[] internal tokenIds;
    address[] internal actors;

    // ── Ghost accounting ────────────────────────────────────────────────────
    uint256 public tokenPaid;   // sum of price * qty over successful ERC-20 buys
    uint256 public ethPaid;     // sum of price * qty over successful ETH buys

    Swag1155.ClaimVoucher[] internal spent;
    bytes[] internal spentSigs;
    bytes32[] internal claimedRefs;
    bytes32[] internal cancelledRefs;
    mapping(bytes32 => bool) internal isCancelled;
    uint256 internal orderNonce;

    uint256 internal constant MAX_TOKEN_IDS = 6;

    // ── Violations — each must stay at zero ─────────────────────────────────
    uint256 public disagreements;    // canBuy/canClaim said one thing, the write did another
    uint256 public replayMinted;     // a spent orderRef minted again
    uint256 public capCutSucceeded;  // a cap was lowered below what was already minted
    uint256 public bareEthAccepted;  // the contract took ETH outside buy()
    uint256 public cancelledMinted;  // a cancelled orderRef minted
    uint256 public cancelAfterClaim; // cancelOrder succeeded on an already-claimed ref
    uint256 public emptyVariantSet;  // a 0/0 variant was accepted

    // ── Counters, printed with -vv to confirm the fuzzer reaches each branch ──
    uint256 public tokenBuys;
    uint256 public ethBuys;
    uint256 public rejectedBuys;
    uint256 public claims;
    uint256 public rejectedClaims;
    uint256 public replaysBlocked;
    uint256 public transfers;
    uint256 public capRaises;
    uint256 public reconfigures;
    uint256 public variantsAdded;
    uint256 public cancels;
    uint256 public pauses;
    uint256 public unpauses;

    constructor(
        Swag1155 _swag,
        MockERC20 _token,
        address _treasury,
        uint256 _signerPk,
        uint256 _roguePk
    ) {
        swag = _swag;
        token = _token;
        treasury = _treasury;
        signerPk = _signerPk;
        roguePk = _roguePk;

        tokenIds.push(1);
        tokenIds.push(2);

        for (uint160 i = 0; i < 5; i++) {
            actors.push(address(uint160(0x20000) + i));
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function tokenIdCount() external view returns (uint256) {
        return tokenIds.length;
    }

    function tokenIdAt(uint256 i) external view returns (uint256) {
        return tokenIds[i];
    }

    function claimedRefCount() external view returns (uint256) {
        return claimedRefs.length;
    }

    function claimedRefAt(uint256 i) external view returns (bytes32) {
        return claimedRefs[i];
    }

    function cancelledRefCount() external view returns (uint256) {
        return cancelledRefs.length;
    }

    function cancelledRefAt(uint256 i) external view returns (bytes32) {
        return cancelledRefs[i];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _tokenId(uint256 seed) internal view returns (uint256) {
        return tokenIds[seed % tokenIds.length];
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── Channel 1: buy() ────────────────────────────────────────────────────

    /// Buys with the ERC-20, funded exactly. Quantity ranges from 0 to one
    /// over the remaining allocation so both ZeroQuantity and SoldOut fire.
    function buyWithToken(uint256 actorSeed, uint256 idSeed, uint256 qtySeed) external {
        address buyer = _actor(actorSeed);
        uint256 id = _tokenId(idSeed);
        uint256 qty = bound(qtySeed, 0, swag.remainingOnchain(id) + 1);
        uint256 total = swag.variantTokenPrice(id, address(token)) * qty;

        if (total > 0) token.mint(buyer, total);

        vm.startPrank(buyer);
        token.approve(address(swag), total);
        (bool allowed, ) = swag.canBuy(id, qty, address(token));

        try swag.buy(id, qty, address(token)) {
            if (!allowed) disagreements++;
            tokenPaid += total;
            tokenBuys++;
        } catch {
            if (allowed) disagreements++;
            rejectedBuys++;
        }
        vm.stopPrank();
    }

    /// Buys with native ETH. One in five sends the wrong amount, which canBuy
    /// cannot see — so the expectation is `allowed && value == total`.
    function buyWithEth(uint256 actorSeed, uint256 idSeed, uint256 qtySeed, uint256 valueSeed) external {
        address buyer = _actor(actorSeed);
        uint256 id = _tokenId(idSeed);
        uint256 qty = bound(qtySeed, 0, swag.remainingOnchain(id) + 1);
        uint256 total = swag.variantTokenPrice(id, ETH_TOKEN) * qty;
        uint256 value = valueSeed % 5 == 0 ? total + 1 : total;

        vm.deal(buyer, value);
        vm.startPrank(buyer);
        (bool allowed, ) = swag.canBuy(id, qty, ETH_TOKEN);
        bool expectOk = allowed && value == total;

        try swag.buy{value: value}(id, qty, ETH_TOKEN) {
            if (!expectOk) disagreements++;
            ethPaid += total;
            ethBuys++;
        } catch {
            if (expectOk) disagreements++;
            rejectedBuys++;
        }
        vm.stopPrank();
    }

    /// A token nobody configured must always be refused, by both the view and the write.
    function buyWithUnacceptedToken(uint256 actorSeed, uint256 idSeed) external {
        address buyer = _actor(actorSeed);
        uint256 id = _tokenId(idSeed);

        vm.startPrank(buyer);
        (bool allowed, ) = swag.canBuy(id, 1, NOT_A_PAYMENT_TOKEN);
        try swag.buy(id, 1, NOT_A_PAYMENT_TOKEN) {
            disagreements++;
        } catch {
            if (allowed) disagreements++;
            rejectedBuys++;
        }
        vm.stopPrank();
    }

    /// Bare ETH must bounce — merch is bought, not airdropped.
    function sendBareEth(uint256 actorSeed) external {
        address sender = _actor(actorSeed);
        vm.deal(sender, 1 ether);
        vm.prank(sender);
        (bool ok, ) = address(swag).call{value: 1 ether}("");
        if (ok) bareEthAccepted++;
    }

    // ── Channel 2: claim() ──────────────────────────────────────────────────

    /**
     * Claims a freshly signed voucher. `twist` occasionally produces an
     * expired deadline, a rogue signer, or a reused order reference, so every
     * rejection path in canClaim is exercised — and must agree with claim().
     * The submitter is a different actor from the recipient: vouchers are
     * relayable, and msg.sender must not matter.
     */
    function claimVoucher(
        uint256 actorSeed,
        uint256 idSeed,
        uint256 qtySeed,
        uint256 orderSeed,
        uint256 twist
    ) external {
        address to = _actor(actorSeed);
        uint256 id = _tokenId(idSeed);
        uint256 qty = bound(qtySeed, 0, swag.remainingVoucher(id) + 1);

        uint256 deadline = twist % 5 == 0 ? block.timestamp - 1 : block.timestamp + 1 days;

        bool reused = twist % 7 == 0 && claimedRefs.length > 0;
        bool cancelled = !reused && twist % 13 == 0 && cancelledRefs.length > 0;
        bytes32 orderRef = reused
            ? claimedRefs[orderSeed % claimedRefs.length]
            : cancelled
                ? cancelledRefs[orderSeed % cancelledRefs.length]
                : keccak256(abi.encode(orderSeed, orderNonce++));

        Swag1155.ClaimVoucher memory voucher = Swag1155.ClaimVoucher({
            tokenId: id,
            to: to,
            quantity: qty,
            orderRef: orderRef,
            deadline: deadline
        });

        bytes memory sig = _sign(twist % 11 == 0 ? roguePk : signerPk, swag.hashVoucher(voucher));

        (bool allowed, ) = swag.canClaim(voucher, sig);

        vm.prank(actors[(actorSeed % actors.length + 1) % actors.length]);
        try swag.claim(voucher, sig) {
            if (!allowed) disagreements++;
            if (reused) replayMinted++;
            else if (cancelled) cancelledMinted++;
            else claimedRefs.push(orderRef);
            spent.push(voucher);
            spentSigs.push(sig);
            claims++;
        } catch {
            if (allowed) disagreements++;
            rejectedClaims++;
        }
    }

    /// Replays a voucher exactly as it was accepted before. Must never mint.
    function replayClaim(uint256 seed) external {
        if (spent.length == 0) return;
        uint256 i = seed % spent.length;
        Swag1155.ClaimVoucher memory voucher = spent[i];
        bytes memory sig = spentSigs[i];

        (bool allowed, ) = swag.canClaim(voucher, sig);
        if (allowed) disagreements++;

        vm.prank(_actor(seed));
        try swag.claim(voucher, sig) {
            replayMinted++;
        } catch {
            replaysBlocked++;
        }
    }

    // ── Secondary market ────────────────────────────────────────────────────

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 idSeed, uint256 qtySeed) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 id = _tokenId(idSeed);

        uint256 balance = swag.balanceOf(from, id);
        if (balance == 0) return;

        vm.prank(from);
        swag.safeTransferFrom(from, to, id, bound(qtySeed, 1, balance), "");
        transfers++;
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    /// Raises either cap by a bounded amount and may flip `active`, so the
    /// fuzzer sees sold-out variants come back into stock.
    function raiseCaps(uint256 idSeed, uint256 onSeed, uint256 voucherSeed, bool active) external {
        uint256 id = _tokenId(idSeed);
        Swag1155.Variant memory v = swag.getVariant(id);

        swag.setVariant(
            id,
            v.onchainCap + uint128(bound(onSeed, 0, 20)),
            v.voucherCap + uint128(bound(voucherSeed, 0, 20)),
            active
        );
        capRaises++;
    }

    /// Reconfigures an existing variant through setVariantWithURI — the path
    /// that used to push a duplicate into the tokenId registry.
    function reconfigureWithURI(uint256 idSeed, uint256 onSeed, uint256 voucherSeed, bool active) external {
        uint256 id = _tokenId(idSeed);
        Swag1155.Variant memory v = swag.getVariant(id);

        swag.setVariantWithURI(
            id,
            v.onchainCap + uint128(bound(onSeed, 0, 20)),
            v.voucherCap + uint128(bound(voucherSeed, 0, 20)),
            active,
            string.concat("ipfs://hoodie/", vm.toString(id), ".json")
        );
        reconfigures++;
    }

    /// Adds a brand-new size mid-run, priced in both currencies, so the
    /// registry grows and the buy/claim handlers start hitting it.
    function addVariant(uint256 onSeed, uint256 voucherSeed) external {
        if (tokenIds.length >= MAX_TOKEN_IDS) return;
        uint256 id = tokenIds.length + 1;

        swag.setVariantWithURI(
            id,
            uint128(bound(onSeed, 0, 20)),
            uint128(bound(voucherSeed, 1, 20)),
            true,
            string.concat("ipfs://hoodie/", vm.toString(id), ".json")
        );
        swag.setPaymentOption(id, address(token), 45e6);
        swag.setPaymentOption(id, ETH_TOKEN, 0.018 ether);
        tokenIds.push(id);
        variantsAdded++;
    }

    /// A variant with no stock in either channel is meaningless. Must revert,
    /// whether the id is new or already configured.
    function setEmptyVariant(uint256 idSeed, bool existing) external {
        uint256 id = existing ? _tokenId(idSeed) : 1000 + (idSeed % 50);
        try swag.setVariant(id, 0, 0, true) {
            emptyVariantSet++;
        } catch {}
    }

    /// Cancels a fresh order reference, or — one time in four — tries to
    /// cancel one that already minted, which must be refused.
    function cancelOrder(uint256 seed) external {
        bool afterClaim = seed % 4 == 0 && claimedRefs.length > 0;
        bytes32 orderRef = afterClaim
            ? claimedRefs[seed % claimedRefs.length]
            : keccak256(abi.encode("cancel", seed, orderNonce++));

        try swag.cancelOrder(orderRef) {
            if (afterClaim) {
                cancelAfterClaim++;
            } else {
                cancelledRefs.push(orderRef);
                isCancelled[orderRef] = true;
                cancels++;
            }
        } catch {
            // A fresh ref can only collide with an earlier cancel of the same seed.
            if (!afterClaim && !isCancelled[orderRef]) disagreements++;
        }
    }

    /// Tries to cut a cap below what that channel already minted. Must revert.
    function cutCapBelowMinted(uint256 idSeed, bool onchainSide) external {
        uint256 id = _tokenId(idSeed);
        Swag1155.Variant memory v = swag.getVariant(id);

        uint128 onCap = v.onchainCap;
        uint128 vCap = v.voucherCap;
        if (onchainSide) {
            if (v.onchainMinted == 0) return;
            onCap = v.onchainMinted - 1;
        } else {
            if (v.voucherMinted == 0) return;
            vCap = v.voucherMinted - 1;
        }

        try swag.setVariant(id, onCap, vCap, v.active) {
            capCutSucceeded++;
        } catch {}
    }

    function pause() external {
        if (swag.paused()) return;
        swag.pause();
        pauses++;
    }

    function unpause() external {
        if (!swag.paused()) return;
        swag.unpause();
        unpauses++;
    }

    /// Lets voucher deadlines lapse mid-run.
    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 12 hours));
    }
}

contract Swag1155Invariants is StdInvariant, Test {
    address internal constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    Swag1155 internal swag;
    SwagFactory internal factory;
    MockERC20 internal token;
    Swag1155Handler internal handler;

    // A plain address with no code, so it always accepts ETH.
    address internal treasury = address(0xBEEF);

    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant ROGUE_PK = 0xBAD;

    function setUp() public {
        // A real-looking clock, so "deadline = now - 1" cannot underflow.
        vm.warp(1_700_000_000);

        Swag1155 implementation = new Swag1155();
        factory = new SwagFactory(address(this), address(implementation));
        token = new MockERC20("USD Coin", "USDC", 6);

        SwagFactory.VariantInit[] memory sizes = new SwagFactory.VariantInit[](2);
        sizes[0] = _size("ipfs://hoodie/s.json", 40, 60, 45e6, 0.018 ether);
        sizes[1] = _size("ipfs://hoodie/m.json", 30, 50, 45e6, 0.018 ether);

        // The backend key is granted SIGNER_ROLE by the factory, before it
        // renounces its own roles — no post-hoc addSigner needed.
        address deployed = factory.deployCollection(
            "ETH Cali Hoodie", "HOODIE", treasury, address(this), sizes, vm.addr(SIGNER_PK)
        );
        swag = Swag1155(payable(deployed));
        assertTrue(swag.hasRole(swag.SIGNER_ROLE(), vm.addr(SIGNER_PK)), "factory did not grant the signer");

        handler = new Swag1155Handler(swag, token, treasury, SIGNER_PK, ROGUE_PK);

        // The handler runs day-to-day ops.
        swag.addAdmin(address(handler));
        token.transferOwnership(address(handler));

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](16);
        selectors[0] = handler.buyWithToken.selector;
        selectors[1] = handler.buyWithEth.selector;
        selectors[2] = handler.buyWithUnacceptedToken.selector;
        selectors[3] = handler.sendBareEth.selector;
        selectors[4] = handler.claimVoucher.selector;
        selectors[5] = handler.replayClaim.selector;
        selectors[6] = handler.transfer.selector;
        selectors[7] = handler.raiseCaps.selector;
        selectors[8] = handler.cutCapBelowMinted.selector;
        selectors[9] = handler.pause.selector;
        selectors[10] = handler.unpause.selector;
        selectors[11] = handler.warp.selector;
        selectors[12] = handler.reconfigureWithURI.selector;
        selectors[13] = handler.addVariant.selector;
        selectors[14] = handler.setEmptyVariant.selector;
        selectors[15] = handler.cancelOrder.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _size(
        string memory uri,
        uint128 onchainCap,
        uint128 voucherCap,
        uint256 tokenPrice,
        uint256 ethPrice
    ) internal view returns (SwagFactory.VariantInit memory) {
        SwagFactory.PaymentOption[] memory payments = new SwagFactory.PaymentOption[](2);
        payments[0] = SwagFactory.PaymentOption({token: address(token), price: tokenPrice});
        payments[1] = SwagFactory.PaymentOption({token: ETH_TOKEN, price: ethPrice});
        return SwagFactory.VariantInit({
            metadataURI: uri,
            onchainCap: onchainCap,
            voucherCap: voucherCap,
            active: true,
            payments: payments
        });
    }

    function _circulating(uint256 id) internal view returns (uint256 total) {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            total += swag.balanceOf(handler.actorAt(i), id);
        }
    }

    /** Neither channel may ever mint past its own allocation. */
    function invariant_mintedNeverExceedsCap() public view {
        for (uint256 i = 0; i < handler.tokenIdCount(); i++) {
            Swag1155.Variant memory v = swag.getVariant(handler.tokenIdAt(i));
            assertLe(v.onchainMinted, v.onchainCap, "on-chain channel oversold");
            assertLe(v.voucherMinted, v.voucherCap, "voucher channel oversold");
        }
    }

    /**
     * Every unit in circulation belongs to exactly one channel counter. The
     * handler's actors are a closed set, so their balances sum to total supply.
     */
    function invariant_supplyEqualsChannelCounters() public view {
        for (uint256 i = 0; i < handler.tokenIdCount(); i++) {
            uint256 id = handler.tokenIdAt(i);
            Swag1155.Variant memory v = swag.getVariant(id);
            uint256 counted = uint256(v.onchainMinted) + uint256(v.voucherMinted);

            assertEq(_circulating(id), counted, "supply drifted from channel counters");
            assertEq(swag.totalMinted(id), counted, "totalMinted disagrees with counters");
        }
    }

    /**
     * Serials are issued one per unit: the counter never drifts from what was
     * minted. Who holds which serial is in the SerialsAssigned log, which the
     * Hardhat suite checks; storage only owes the counter.
     */
    function invariant_serialsTrackMints() public view {
        for (uint256 i = 0; i < handler.tokenIdCount(); i++) {
            uint256 id = handler.tokenIdAt(i);
            assertEq(swag.nextSerial(id), swag.totalMinted(id), "nextSerial drifted from totalMinted");
        }
    }

    /** Every successful payment, and nothing else, reaches the treasury. */
    function invariant_treasuryReceivesEveryPayment() public view {
        assertEq(token.balanceOf(treasury), handler.tokenPaid(), "ERC-20 proceeds drifted");
        assertEq(treasury.balance, handler.ethPaid(), "ETH proceeds drifted");
    }

    /** The contract is a pass-through. It never has custody of revenue. */
    function invariant_contractNeverHoldsFunds() public view {
        assertEq(address(swag).balance, 0, "contract is holding ETH");
        assertEq(token.balanceOf(address(swag)), 0, "contract is holding tokens");
        assertEq(handler.bareEthAccepted(), 0, "bare ETH was accepted");
    }

    /** A Shopify order reference mints once, ever. */
    function invariant_claimedOrderNeverMintsAgain() public view {
        assertEq(handler.replayMinted(), 0, "a spent voucher minted again");
        for (uint256 i = 0; i < handler.claimedRefCount(); i++) {
            assertTrue(swag.orderClaimed(handler.claimedRefAt(i)), "claimed orderRef was forgotten");
        }
    }

    /**
     * A cancelled order never mints, stays burned, and a cancel that lands
     * after the claim is refused rather than silently absorbed.
     */
    function invariant_cancelledOrderNeverMints() public view {
        assertEq(handler.cancelledMinted(), 0, "a cancelled voucher minted");
        assertEq(handler.cancelAfterClaim(), 0, "cancelOrder succeeded on a claimed ref");
        for (uint256 i = 0; i < handler.cancelledRefCount(); i++) {
            assertTrue(swag.orderClaimed(handler.cancelledRefAt(i)), "cancelled orderRef was forgotten");
        }
    }

    /**
     * The UI disables buttons from canBuy/canClaim. If they ever disagree with
     * the write, a user either sees a dead button or a failed transaction.
     */
    function invariant_viewsAgreeWithWrites() public view {
        assertEq(handler.disagreements(), 0, "canBuy/canClaim disagreed with buy/claim");
    }

    /** A cap can never be cut below what that channel already sold. */
    function invariant_capsNeverCutBelowMinted() public view {
        assertEq(handler.capCutSucceeded(), 0, "cap was lowered below minted");
    }

    /** The registry lists exactly the variants that exist: no duplicates, no 0/0 ghosts. */
    function invariant_tokenIdRegistryStable() public view {
        uint256[] memory ids = swag.listTokenIds();
        assertEq(ids.length, handler.tokenIdCount(), "tokenId registry changed size");
        assertEq(handler.emptyVariantSet(), 0, "a variant with no stock was accepted");

        for (uint256 i = 0; i < ids.length; i++) {
            Swag1155.Variant memory v = swag.getVariant(ids[i]);
            assertTrue(v.onchainCap != 0 || v.voucherCap != 0, "registry lists a variant that does not exist");
            for (uint256 j = i + 1; j < ids.length; j++) {
                assertTrue(ids[i] != ids[j], "duplicate tokenId in registry");
            }
        }
    }

    function invariant_callSummary() public view {
        console.log("token buys      :", handler.tokenBuys());
        console.log("eth buys        :", handler.ethBuys());
        console.log("rejected buys   :", handler.rejectedBuys());
        console.log("claims          :", handler.claims());
        console.log("rejected claims :", handler.rejectedClaims());
        console.log("replays blocked :", handler.replaysBlocked());
        console.log("transfers       :", handler.transfers());
        console.log("cap raises      :", handler.capRaises());
        console.log("reconfigures    :", handler.reconfigures());
        console.log("variants added  :", handler.variantsAdded());
        console.log("cancels         :", handler.cancels());
        console.log("pauses/unpauses :", handler.pauses(), handler.unpauses());
    }
}

/**
 * Stateless fuzz: for any single state the admin can put a variant in, the
 * `can*` view and the write must agree. The invariant suite catches this over
 * sequences; this catches it over the full input space of one call.
 */
contract Swag1155ViewFuzz is Test {
    address internal constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant ROGUE_PK = 0xBAD;

    uint128 internal constant ONCHAIN_CAP = 10;
    uint128 internal constant VOUCHER_CAP = 10;
    uint256 internal constant TOKEN_PRICE = 45e6;
    uint256 internal constant ETH_PRICE = 0.018 ether;

    Swag1155 internal swag;
    MockERC20 internal token;
    address internal treasury = address(0xBEEF);
    address internal buyer = address(0x30000);

    function setUp() public {
        vm.warp(1_700_000_000);

        Swag1155 implementation = new Swag1155();
        SwagFactory factory = new SwagFactory(address(this), address(implementation));
        token = new MockERC20("USD Coin", "USDC", 6);

        SwagFactory.PaymentOption[] memory payments = new SwagFactory.PaymentOption[](2);
        payments[0] = SwagFactory.PaymentOption({token: address(token), price: TOKEN_PRICE});
        payments[1] = SwagFactory.PaymentOption({token: ETH_TOKEN, price: ETH_PRICE});

        SwagFactory.VariantInit[] memory sizes = new SwagFactory.VariantInit[](1);
        sizes[0] = SwagFactory.VariantInit({
            metadataURI: "ipfs://tee/m.json",
            onchainCap: ONCHAIN_CAP,
            voucherCap: VOUCHER_CAP,
            active: true,
            payments: payments
        });

        swag = Swag1155(
            payable(factory.deployCollection("ETH Cali Tee", "TEE", treasury, address(this), sizes, vm.addr(SIGNER_PK)))
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _voucher(address to, uint256 qty, bytes32 orderRef, uint256 deadline)
        internal
        pure
        returns (Swag1155.ClaimVoucher memory)
    {
        return Swag1155.ClaimVoucher({tokenId: 1, to: to, quantity: qty, orderRef: orderRef, deadline: deadline});
    }

    function testFuzz_canBuyAgreesWithBuy(
        uint256 qtySeed,
        uint8 tokenChoice,
        uint8 preSoldSeed,
        bool paused,
        bool active
    ) public {
        // Sell some of the allocation first so the cap edge is reachable.
        uint256 preSold = bound(preSoldSeed, 0, ONCHAIN_CAP);
        if (preSold > 0) {
            token.mint(buyer, TOKEN_PRICE * preSold);
            vm.startPrank(buyer);
            token.approve(address(swag), TOKEN_PRICE * preSold);
            swag.buy(1, preSold, address(token));
            vm.stopPrank();
        }

        if (!active) swag.setVariant(1, ONCHAIN_CAP, VOUCHER_CAP, false);
        if (paused) swag.pause();

        uint256 qty = bound(qtySeed, 0, ONCHAIN_CAP + 2);
        address paymentToken =
            tokenChoice % 3 == 0 ? address(token) : tokenChoice % 3 == 1 ? ETH_TOKEN : address(0xDEAD);

        uint256 price = paymentToken == address(0xDEAD) ? 0 : swag.variantTokenPrice(1, paymentToken);
        uint256 total = price * qty;
        uint256 value = paymentToken == ETH_TOKEN ? total : 0;

        // Fund the buyer exactly: canBuy deliberately ignores wallet state.
        token.mint(buyer, total);
        vm.deal(buyer, value);

        (bool allowed, string memory reason) = swag.canBuy(1, qty, paymentToken);

        vm.startPrank(buyer);
        token.approve(address(swag), total);
        (bool ok, ) = address(swag).call{value: value}(abi.encodeCall(swag.buy, (1, qty, paymentToken)));
        vm.stopPrank();

        assertEq(ok, allowed, string.concat("canBuy disagreed with buy: ", reason));
    }

    function testFuzz_canClaimAgreesWithClaim(
        address to,
        uint256 qtySeed,
        uint256 deadlineSeed,
        bool expired,
        bool rogueSigner,
        bool alreadyClaimed,
        bool paused,
        bool active
    ) public {
        // Contracts without an ERC-1155 receiver reject mints; that is wallet
        // state, not contract state, and out of scope for canClaim.
        if (to.code.length > 0) to = address(0xCAFE);

        uint256 qty = bound(qtySeed, 0, VOUCHER_CAP + 2);
        uint256 deadline = expired ? block.timestamp - 1 : block.timestamp + bound(deadlineSeed, 0, 30 days);
        bytes32 orderRef = keccak256(abi.encode("order", qtySeed, deadlineSeed));

        if (alreadyClaimed) {
            Swag1155.ClaimVoucher memory first = _voucher(buyer, 1, orderRef, block.timestamp + 1 hours);
            swag.claim(first, _sign(SIGNER_PK, swag.hashVoucher(first)));
        }

        if (!active) swag.setVariant(1, ONCHAIN_CAP, VOUCHER_CAP, false);
        if (paused) swag.pause();

        Swag1155.ClaimVoucher memory voucher = _voucher(to, qty, orderRef, deadline);
        bytes memory sig = _sign(rogueSigner ? ROGUE_PK : SIGNER_PK, swag.hashVoucher(voucher));

        (bool allowed, string memory reason) = swag.canClaim(voucher, sig);
        (bool ok, ) = address(swag).call(abi.encodeCall(swag.claim, (voucher, sig)));

        assertEq(ok, allowed, string.concat("canClaim disagreed with claim: ", reason));
    }

    /// Garbage signatures are refused by the view and the write alike.
    function testFuzz_malformedSignatureNeverClaims(bytes calldata sig, uint256 qtySeed) public {
        uint256 qty = bound(qtySeed, 1, VOUCHER_CAP);
        Swag1155.ClaimVoucher memory voucher = _voucher(buyer, qty, keccak256(sig), block.timestamp + 1 days);

        (bool allowed, ) = swag.canClaim(voucher, sig);
        assertFalse(allowed, "canClaim accepted a signature nobody authorised");

        (bool ok, ) = address(swag).call(abi.encodeCall(swag.claim, (voucher, sig)));
        assertFalse(ok, "claim accepted a signature nobody authorised");
        assertEq(swag.totalMinted(1), 0, "something minted");
    }

    /// A price near uint256 max must make canBuy say no instead of panicking,
    /// and buy() must refuse too.
    function testFuzz_canBuyRefusesOverflowingTotal(uint256 priceSeed, uint256 qtySeed) public {
        uint256 qty = bound(qtySeed, 2, ONCHAIN_CAP);
        uint256 price = bound(priceSeed, type(uint256).max / qty + 1, type(uint256).max);
        swag.setPaymentOption(1, address(token), price);

        (bool allowed, string memory reason) = swag.canBuy(1, qty, address(token));
        assertFalse(allowed, "canBuy allowed an overflowing total");
        assertEq(reason, "Quantity too large");

        vm.prank(buyer);
        (bool ok, ) = address(swag).call(abi.encodeCall(swag.buy, (1, qty, address(token))));
        assertFalse(ok, "buy accepted an overflowing total");
    }

    /// Cancel and claim share one idempotency key, in either order.
    function testFuzz_cancelAndClaimAreMutuallyExclusive(bytes32 orderRef, bool cancelFirst) public {
        Swag1155.ClaimVoucher memory voucher = _voucher(buyer, 1, orderRef, block.timestamp + 1 days);
        bytes memory sig = _sign(SIGNER_PK, swag.hashVoucher(voucher));

        if (cancelFirst) {
            swag.cancelOrder(orderRef);
            (bool allowed, string memory reason) = swag.canClaim(voucher, sig);
            assertFalse(allowed);
            assertEq(reason, "Order already claimed or cancelled");
            vm.expectRevert(abi.encodeWithSelector(Swag1155.VoucherAlreadyClaimed.selector, orderRef));
            swag.claim(voucher, sig);
            assertEq(swag.totalMinted(1), 0, "cancelled order minted");
        } else {
            swag.claim(voucher, sig);
            vm.expectRevert(abi.encodeWithSelector(Swag1155.VoucherAlreadyClaimed.selector, orderRef));
            swag.cancelOrder(orderRef);
            assertEq(swag.balanceOf(buyer, 1), 1, "claimed unit vanished");
        }
        assertTrue(swag.orderClaimed(orderRef));
    }

    /// A voucher is bound to the contract it was signed for.
    function testFuzz_voucherCannotCrossCollections(uint256 qtySeed, bytes32 orderRef) public {
        uint256 qty = bound(qtySeed, 1, VOUCHER_CAP);

        Swag1155 implementation = new Swag1155();
        SwagFactory otherFactory = new SwagFactory(address(this), address(implementation));
        SwagFactory.PaymentOption[] memory payments = new SwagFactory.PaymentOption[](1);
        payments[0] = SwagFactory.PaymentOption({token: address(token), price: TOKEN_PRICE});
        SwagFactory.VariantInit[] memory sizes = new SwagFactory.VariantInit[](1);
        sizes[0] = SwagFactory.VariantInit({
            metadataURI: "ipfs://cap/one.json",
            onchainCap: ONCHAIN_CAP,
            voucherCap: VOUCHER_CAP,
            active: true,
            payments: payments
        });
        // Deployed without a signer, then granted one — the path for collections
        // that predate the factory's `signer` parameter.
        Swag1155 other = Swag1155(
            payable(otherFactory.deployCollection("ETH Cali Cap", "CAP", treasury, address(this), sizes, address(0)))
        );
        assertFalse(other.hasRole(other.SIGNER_ROLE(), vm.addr(SIGNER_PK)));
        other.addSigner(vm.addr(SIGNER_PK));

        Swag1155.ClaimVoucher memory voucher = _voucher(buyer, qty, orderRef, block.timestamp + 1 days);
        bytes memory sigForSwag = _sign(SIGNER_PK, swag.hashVoucher(voucher));

        (bool allowed, ) = other.canClaim(voucher, sigForSwag);
        assertFalse(allowed, "voucher for one collection was accepted by another");

        vm.expectRevert(Swag1155.InvalidSignature.selector);
        other.claim(voucher, sigForSwag);

        // The same voucher signed against the right domain works.
        other.claim(voucher, _sign(SIGNER_PK, other.hashVoucher(voucher)));
        assertEq(other.balanceOf(buyer, 1), qty);
    }
}
