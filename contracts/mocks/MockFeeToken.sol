// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Mock fee-on-transfer ERC-20: burns `feeBps` of every transfer.
 *         Used to verify that DonationVault credits the amount that actually
 *         arrived rather than the amount requested.
 */
contract MockFeeToken is ERC20, Ownable {
    uint256 public feeBps; // e.g. 100 = 1%

    constructor(uint256 _feeBps) ERC20("Mock Fee Token", "FEE") Ownable(msg.sender) {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        feeBps = _feeBps;
    }

    function _update(address from, address to, uint256 value) internal override {
        // Mints and burns transfer the full value; only real transfers pay a fee.
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee); // burn the fee
    }
}
