// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice A contract that refuses every incoming ETH transfer.
 *         Stands in for an unreachable beneficiary, to prove that a donation
 *         still settles (and the funds stay held and withdrawable) when
 *         DonationVault's router-mode forward cannot land.
 */
contract MockEthRejecter {
    receive() external payable {
        revert("MockEthRejecter: no ETH");
    }
}
