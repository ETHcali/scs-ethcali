// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IZKPassport.sol";

/**
 * @title MockZKPassportVerifier
 * @notice Test double that implements both IZKPassportVerifier and IZKPassportHelper.
 *         Returns itself as the helper so a single contract handles the full flow.
 *         All return values are configurable via setMockResult() / setChainId().
 */
contract MockZKPassportVerifier is IZKPassportVerifier, IZKPassportHelper {
    // ── Configurable state ────────────────────────────────────────────────────
    bool    public mockVerified      = true;
    bytes32 public mockUniqueId;
    bool    public mockScopesValid   = true;
    address public mockSenderAddress;
    uint256 public mockChainId;
    bool    public mockIsOver18      = true;
    string  public mockNationality   = "USA";

    constructor() {
        mockChainId = block.chainid;
    }

    /**
     * @notice Configure mock return values for the next verify() call.
     * @param _verified          Whether the proof should be deemed valid
     * @param _uniqueId          The unique identifier to return
     * @param _scopesValid       Whether verifyScopes() should return true
     * @param _senderAddress     The senderAddress in BoundData
     * @param _isOver18          Whether the user is 18+
     * @param _nationality       Nationality string (ISO alpha-3 or raw MRZ)
     */
    function setMockResult(
        bool    _verified,
        bytes32 _uniqueId,
        bool    _scopesValid,
        address _senderAddress,
        bool    _isOver18,
        string  calldata _nationality
    ) external {
        mockVerified      = _verified;
        mockUniqueId      = _uniqueId;
        mockScopesValid   = _scopesValid;
        mockSenderAddress = _senderAddress;
        mockIsOver18      = _isOver18;
        mockNationality   = _nationality;
    }

    function setChainId(uint256 _chainId) external {
        mockChainId = _chainId;
    }

    // ── IZKPassportVerifier ───────────────────────────────────────────────────

    function verify(ProofVerificationParams calldata)
        external
        view
        override
        returns (bool, bytes32, IZKPassportHelper)
    {
        return (mockVerified, mockUniqueId, IZKPassportHelper(address(this)));
    }

    // ── IZKPassportHelper ─────────────────────────────────────────────────────

    function verifyScopes(bytes32[] calldata, string calldata, string calldata)
        external
        view
        override
        returns (bool)
    {
        return mockScopesValid;
    }

    function getBoundData(bytes calldata)
        external
        view
        override
        returns (BoundData memory)
    {
        return BoundData({
            senderAddress: mockSenderAddress,
            chainId:       mockChainId,
            customData:    ""
        });
    }

    function isAgeAboveOrEqual(uint8, bytes calldata)
        external
        view
        override
        returns (bool)
    {
        return mockIsOver18;
    }

    function getDisclosedData(bytes calldata, bool)
        external
        view
        override
        returns (DisclosedData memory)
    {
        DisclosedData memory data;
        data.nationality = mockNationality;
        return data;
    }
}
