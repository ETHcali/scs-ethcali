// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";
import {DonationVault} from "../../contracts/DonationVault.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";

/**
 * Invariant tests for DonationVault.
 *
 * The Hardhat suite proves specific flows behave correctly. This proves an
 * accounting property holds under ANY sequence of donations and withdrawals the
 * fuzzer can construct — which is the class of bug that costs donors money and
 * that example-based tests systematically miss.
 *
 * The property under test:
 *
 *     For every token, the vault's actual balance equals exactly the sum of
 *     what each campaign has raised but not yet paid out.
 *
 * If this ever breaks, either the vault is holding funds no campaign can
 * withdraw (donations stranded), or a campaign believes it can withdraw more
 * than the vault holds (a withdrawal will revert, or worse, drain another
 * campaign's funds).
 */
contract DonationVaultHandler is Test {
    address internal constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    DonationVault public immutable vault;
    MockERC20 public immutable token;

    uint256 public immutable campaignA;
    uint256 public immutable campaignB;

    address[] internal donors;

    // Counters, printed by `forge test -vv`, to confirm the fuzzer is actually
    // reaching each branch rather than reverting on everything.
    uint256 public ethDonations;
    uint256 public tokenDonations;
    uint256 public withdrawals;

    constructor(DonationVault _vault, MockERC20 _token, uint256 _campaignA, uint256 _campaignB) {
        vault = _vault;
        token = _token;
        campaignA = _campaignA;
        campaignB = _campaignB;

        for (uint160 i = 0; i < 5; i++) {
            donors.push(address(uint160(0x10000) + i));
        }
    }

    function _campaign(uint256 seed) internal view returns (uint256) {
        return seed % 2 == 0 ? campaignA : campaignB;
    }

    function donateEth(uint256 donorSeed, uint256 campaignSeed, uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 100 ether);
        address donor = donors[donorSeed % donors.length];

        vm.deal(donor, amount);
        vm.prank(donor);
        vault.donate{value: amount}(_campaign(campaignSeed), ETH_TOKEN, amount, "");

        ethDonations++;
    }

    function donateToken(uint256 donorSeed, uint256 campaignSeed, uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000e18);
        address donor = donors[donorSeed % donors.length];

        token.mint(donor, amount);
        vm.startPrank(donor);
        token.approve(address(vault), amount);
        vault.donate(_campaign(campaignSeed), address(token), amount, "");
        vm.stopPrank();

        tokenDonations++;
    }

    function withdrawEth(uint256 campaignSeed, uint96 rawAmount) external {
        uint256 id = _campaign(campaignSeed);
        uint256 available = vault.availableBalance(id, ETH_TOKEN);
        if (available == 0) return;

        vault.withdraw(id, ETH_TOKEN, bound(uint256(rawAmount), 1, available));
        withdrawals++;
    }

    function withdrawToken(uint256 campaignSeed, uint96 rawAmount) external {
        uint256 id = _campaign(campaignSeed);
        uint256 available = vault.availableBalance(id, address(token));
        if (available == 0) return;

        vault.withdraw(id, address(token), bound(uint256(rawAmount), 1, available));
        withdrawals++;
    }

    function withdrawAllEth(uint256 campaignSeed) external {
        uint256 id = _campaign(campaignSeed);
        if (vault.availableBalance(id, ETH_TOKEN) == 0) return;

        vault.withdrawAll(id, ETH_TOKEN);
        withdrawals++;
    }
}

contract DonationVaultInvariants is StdInvariant, Test {
    address internal constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    DonationVault internal vault;
    MockERC20 internal token;
    DonationVaultHandler internal handler;

    uint256 internal campaignA;
    uint256 internal campaignB;

    // A plain address with no code, so it always accepts ETH.
    address internal beneficiary = address(0xBEEF);

    function setUp() public {
        vault = new DonationVault(address(this));
        token = new MockERC20("Mento Colombian Peso", "COPm", 18);

        // Two campaigns, both in holder mode so funds accumulate and the
        // invariant has something to check. Router mode is covered by the
        // Hardhat suite.
        campaignA = vault.createCampaign("Relief A", "", beneficiary, address(0), false);
        campaignB = vault.createCampaign("Relief B", "", beneficiary, address(0), false);

        for (uint256 i = 0; i < 2; i++) {
            uint256 id = i == 0 ? campaignA : campaignB;
            vault.setAcceptedToken(id, ETH_TOKEN, true);
            vault.setAcceptedToken(id, address(token), true);
        }

        handler = new DonationVaultHandler(vault, token, campaignA, campaignB);

        // The handler needs to withdraw, and to mint the donation token.
        vault.addAdmin(address(handler));
        token.transferOwnership(address(handler));

        targetContract(address(handler));
    }

    /**
     * The vault's ETH balance must equal exactly what campaigns have raised and
     * not yet withdrawn. Not more (stranded funds), not less (over-promised).
     */
    function invariant_ethBalanceMatchesUnwithdrawn() public view {
        uint256 expected = vault.availableBalance(campaignA, ETH_TOKEN)
            + vault.availableBalance(campaignB, ETH_TOKEN);

        assertEq(address(vault).balance, expected, "ETH balance drifted from tracked funds");
    }

    /** The same property for an ERC-20 donation currency. */
    function invariant_tokenBalanceMatchesUnwithdrawn() public view {
        uint256 expected = vault.availableBalance(campaignA, address(token))
            + vault.availableBalance(campaignB, address(token));

        assertEq(token.balanceOf(address(vault)), expected, "Token balance drifted from tracked funds");
    }

    /**
     * A campaign can never withdraw more than it raised, and totalRaised is a
     * permanent record that only ever grows.
     */
    function invariant_withdrawnNeverExceedsRaised() public view {
        assertLe(
            vault.totalWithdrawn(campaignA, ETH_TOKEN),
            vault.totalRaised(campaignA, ETH_TOKEN),
            "campaign A withdrew more ETH than it raised"
        );
        assertLe(
            vault.totalWithdrawn(campaignB, address(token)),
            vault.totalRaised(campaignB, address(token)),
            "campaign B withdrew more tokens than it raised"
        );
    }

    /**
     * Campaign isolation: neither campaign's available balance may exceed the
     * whole vault's holdings. This is the property that stops campaign B from
     * spending campaign A's relief funds.
     */
    function invariant_campaignsCannotOverlapFunds() public view {
        assertLe(
            vault.availableBalance(campaignA, ETH_TOKEN),
            address(vault).balance,
            "campaign A claims more ETH than the vault holds"
        );
        assertLe(
            vault.availableBalance(campaignB, ETH_TOKEN),
            address(vault).balance,
            "campaign B claims more ETH than the vault holds"
        );
    }

    function invariant_callSummary() public view {
        console.log("eth donations  :", handler.ethDonations());
        console.log("token donations:", handler.tokenDonations());
        console.log("withdrawals    :", handler.withdrawals());
    }
}
