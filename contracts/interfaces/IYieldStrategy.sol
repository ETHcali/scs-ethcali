// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IYieldStrategy
 * @notice Interface for an external yield venue that HackathonStaking can route
 *         staked principal into (Aave, a 4626 vault, an LST, ...).
 *
 * @dev PHASE 2 SEAM — nothing implements this yet.
 *
 *      HackathonStaking is deployed with every hackathon's `yieldStrategy` set to
 *      address(0), which makes the staking/unstaking hooks inert: principal simply
 *      rests in the staking contract. When a strategy is later attached via
 *      `setYieldStrategy`, principal begins routing through these calls WITHOUT
 *      requiring a redeploy or a migration of existing stakes.
 *
 *      Contract invariants a strategy MUST uphold:
 *      - `withdraw(id, amount, to)` must deliver at least `amount` of `asset()`,
 *        or revert. HackathonStaking accounts in principal terms and will not
 *        tolerate a short withdrawal — a participant's bond is not at risk of
 *        strategy losses.
 *      - `asset()` must equal the hackathon's `stakeAsset`. HackathonStaking
 *        enforces this at attach time.
 *      - For native ETH the sentinel `0xEeee...EEeE` is used, matching Swag1155.
 */
interface IYieldStrategy {
    /// @notice The asset this strategy accepts. ETH uses the 0xEeee...EEeE sentinel.
    function asset() external view returns (address);

    /**
     * @notice Deposit `amount` of `asset()` on behalf of a hackathon.
     * @dev For ETH strategies the amount arrives as msg.value.
     *      For ERC-20 strategies the caller has already approved `amount`.
     */
    function deposit(uint256 hackathonId, uint256 amount) external payable;

    /**
     * @notice Withdraw `amount` of principal and send it to `to`.
     * @return withdrawn Amount actually delivered. MUST be >= `amount` or revert.
     */
    function withdraw(uint256 hackathonId, uint256 amount, address to) external returns (uint256 withdrawn);

    /// @notice Yield accrued above principal for this hackathon, in `asset()` units.
    function pendingYield(uint256 hackathonId) external view returns (uint256);

    /// @notice Principal currently held by the strategy for this hackathon.
    function totalDeposited(uint256 hackathonId) external view returns (uint256);
}
