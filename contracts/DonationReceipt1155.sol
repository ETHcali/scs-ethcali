// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title DonationReceipt1155
 * @notice Admin-configurable ERC-1155 collection of donation receipts.
 *         Each tokenId is a tier ("Supporter", "Guardian", ...) with its own
 *         metadata URI. DonationVault holds MINTER_ROLE and mints a receipt when
 *         a donation clears a tier threshold.
 *
 *         Receipts are soulbound by default: a donation receipt attests that a
 *         specific address gave, so it should not be resellable. An admin can
 *         open transfers per collection if a campaign wants tradeable art.
 *
 * @dev Deployed one collection per campaign (or shared across campaigns — the
 *      vault references a collection address per campaign). Unlike Swag1155 this
 *      is not clone-based; donation collections are few and cheap to deploy.
 */
contract DonationReceipt1155 is ERC1155, AccessControl {
    using EnumerableSet for EnumerableSet.UintSet;

    // ── Roles ─────────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Tier {
        string  name;        // Human-readable tier name, e.g. "Guardian"
        string  metadataURI; // Full IPFS/HTTPS URI for this tier's metadata
        uint256 minted;      // Total receipts issued at this tier
        bool    active;      // Whether the vault may mint this tier
    }

    // ── State ─────────────────────────────────────────────────────────────────

    string public name;
    string public symbol;

    /// @notice When false (the default), receipts are soulbound.
    bool public transfersEnabled;

    mapping(uint256 => Tier) public tiers;
    EnumerableSet.UintSet private _tierIds;

    // ── Events ────────────────────────────────────────────────────────────────

    event TierSet(uint256 indexed tokenId, string name, string metadataURI, bool active);
    event TierRemoved(uint256 indexed tokenId);
    event ReceiptMinted(address indexed to, uint256 indexed tokenId, uint256 amount);
    event TransfersEnabledSet(bool enabled);

    // ── Errors ────────────────────────────────────────────────────────────────

    error Soulbound();
    error TierNotActive(uint256 tokenId);
    error EmptyURI();
    error InvalidRecipient();
    error TierHasSupply(uint256 tokenId);

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _name        Collection name, e.g. "ETH Cali Earthquake Relief"
     * @param _symbol      Collection symbol, e.g. "ETHCALI-RELIEF"
     * @param baseURI      Fallback URI for tokenIds without their own metadata
     * @param initialAdmin Address granted DEFAULT_ADMIN_ROLE + ADMIN_ROLE
     */
    constructor(
        string memory _name,
        string memory _symbol,
        string memory baseURI,
        address initialAdmin
    ) ERC1155(baseURI) {
        name = _name;
        symbol = _symbol;

        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ── Admin: tiers ──────────────────────────────────────────────────────────

    /**
     * @notice Create or update a receipt tier.
     * @param tokenId     Tier id — the vault maps donation thresholds onto these
     * @param tierName    Human-readable name
     * @param metadataURI Full metadata URI for this tier
     * @param active      Whether the vault may mint it
     */
    function setTier(
        uint256 tokenId,
        string calldata tierName,
        string calldata metadataURI,
        bool active
    ) external onlyRole(ADMIN_ROLE) {
        if (bytes(metadataURI).length == 0) revert EmptyURI();

        Tier storage t = tiers[tokenId];
        t.name = tierName;
        t.metadataURI = metadataURI;
        t.active = active;
        _tierIds.add(tokenId);

        emit TierSet(tokenId, tierName, metadataURI, active);
    }

    /**
     * @notice Remove a tier that has never been minted.
     * @dev A tier with supply is permanent — holders' metadata must keep resolving.
     *      Deactivate it with setTier(..., active: false) instead.
     */
    function removeTier(uint256 tokenId) external onlyRole(ADMIN_ROLE) {
        if (tiers[tokenId].minted > 0) revert TierHasSupply(tokenId);

        delete tiers[tokenId];
        _tierIds.remove(tokenId);

        emit TierRemoved(tokenId);
    }

    function setBaseURI(string calldata newURI) external onlyRole(ADMIN_ROLE) {
        _setURI(newURI);
    }

    /// @notice Open or close secondary transfers. Receipts start soulbound.
    function setTransfersEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        transfersEnabled = enabled;
        emit TransfersEnabledSet(enabled);
    }

    function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (admin == address(0)) revert InvalidRecipient();
        _grantRole(ADMIN_ROLE, admin);
    }

    function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ADMIN_ROLE, admin);
    }

    /// @notice Grant a DonationVault permission to issue receipts.
    function addMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minter == address(0)) revert InvalidRecipient();
        _grantRole(MINTER_ROLE, minter);
    }

    function removeMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(MINTER_ROLE, minter);
    }

    // ── Minting ───────────────────────────────────────────────────────────────

    /**
     * @notice Issue a receipt. Called by DonationVault after a qualifying donation.
     * @dev Reverts if the tier is not active, so a misconfigured vault cannot
     *      mint receipts nobody can render.
     */
    function mint(address to, uint256 tokenId, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert InvalidRecipient();

        Tier storage t = tiers[tokenId];
        if (!t.active) revert TierNotActive(tokenId);

        t.minted += amount;
        _mint(to, tokenId, amount, "");

        emit ReceiptMinted(to, tokenId, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function uri(uint256 tokenId) public view override returns (string memory) {
        string memory tokenURI = tiers[tokenId].metadataURI;
        return bytes(tokenURI).length > 0 ? tokenURI : super.uri(tokenId);
    }

    function getTier(uint256 tokenId) external view returns (Tier memory) {
        return tiers[tokenId];
    }

    function listTierIds() external view returns (uint256[] memory) {
        return _tierIds.values();
    }

    function tierCount() external view returns (uint256) {
        return _tierIds.length();
    }

    /// @notice Whether a tier exists and may currently be minted.
    function isTierActive(uint256 tokenId) external view returns (bool) {
        return tiers[tokenId].active;
    }

    // ── Soulbound enforcement ─────────────────────────────────────────────────

    /**
     * @dev Blocks transfers while soulbound. Mints (from == 0) and burns
     *      (to == 0) always pass, so issuing a receipt and a holder discarding
     *      one both remain possible.
     */
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        if (!transfersEnabled && from != address(0) && to != address(0)) {
            revert Soulbound();
        }
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
