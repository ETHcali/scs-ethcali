// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title BuilderCertificate
 * @notice ETH Cali's onchain certificate for people who built and shipped a
 *         project at one of its hackathons. One token per builder per project,
 *         soulbound: it proves who did the work, so it cannot be sold or moved.
 *
 * @dev Design, and why:
 *
 *   - One contract for every event. What differs between hackathons (name,
 *     dates, sponsors, the diploma image) lives in each token's metadata on
 *     IPFS, not in code, so the next hackathon is more tokens, not a redeploy.
 *
 *   - Issued by ETH Cali (`ADMIN_ROLE`), not claimed. The operator mints to
 *     the builder's wallet — for most, an embedded wallet pregenerated against
 *     the email they registered with. There is no signature scheme to get
 *     wrong and nothing a builder has to do to receive it.
 *
 *   - `credentialId` is the certificate's public identifier (the "Credential
 *     ID" on LinkedIn, e.g. EAGCALI26-7K3P9QXM), stored as bytes32. It can be
 *     issued once. `revoke` burns the token and frees the id, which is how a
 *     mistake is fixed or a certificate moved to another wallet: revoke, then
 *     issue again. Token ids are never reused.
 *
 *   - Soulbound per ERC-5192: `locked` is always true, every transfer and
 *     approval reverts. Mint and burn are the only state changes a token has.
 *
 *   - `tokenURI` is `ipfs://<cid>`, never a gateway URL: the CID is permanent,
 *     a gateway is a vendor. Storage, the ERC-4906 `MetadataUpdate` event and
 *     its ERC-165 id come from OpenZeppelin's ERC721URIStorage, with
 *     `_baseURI` fixed to `ipfs://`. `setTokenCid` re-points a corrected diploma.
 *     OpenZeppelin v5 does not clear a burned token's URI; it is unreachable,
 *     since `tokenURI` requires a live owner and token ids are never reused.
 *
 *   - Mints with `_mint`, not `_safeMint`: no call into the recipient, so no
 *     reentrancy surface, and a certificate cannot be blocked by a recipient
 *     contract that refuses it.
 *
 *   - No Pausable and no upgradeability. The contract holds no value; a pause
 *     key would only be a way to freeze people's credentials, and a record of
 *     who built what should not have an admin who can rewrite the code.
 *
 *   - The deployer receives no role. The constructor hands `DEFAULT_ADMIN_ROLE`
 *     and `ADMIN_ROLE` straight to the operator addresses, so there is nothing
 *     to renounce after deployment.
 */
contract BuilderCertificate is ERC721URIStorage, AccessControl {
    // ── Roles ────────────────────────────────────────────────────────────────

    /// @notice Issues, revokes and re-points metadata. Held by ETH Cali operators.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ── Interfaces ───────────────────────────────────────────────────────────

    /// @dev ERC-5192 (minimal soulbound). ERC-4906 comes with ERC721URIStorage.
    bytes4 private constant _INTERFACE_ERC5192 = 0xb45a3c0e;

    /// @notice Upper bound on one `issue` call, so a batch can never run out of gas.
    uint256 public constant MAX_BATCH = 100;

    // ── Types ────────────────────────────────────────────────────────────────

    struct Issuance {
        address to;
        /// @dev The credential id, ASCII, right-padded into bytes32.
        bytes32 credentialId;
        /// @dev CID of the token's metadata JSON on IPFS, without the `ipfs://`.
        string cid;
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    /// @notice Tokens minted so far, burned ones included. The next id is this + 1.
    uint256 public totalIssued;

    /// @notice Live token for a credential id, or 0 if never issued or revoked.
    mapping(bytes32 credentialId => uint256 tokenId) public tokenOfCredential;

    /// @notice Credential id of a live token.
    mapping(uint256 tokenId => bytes32 credentialId) public credentialOf;

    // ── Events ───────────────────────────────────────────────────────────────

    /// @notice ERC-5192: emitted once per token, at mint, since it never unlocks.
    event Locked(uint256 tokenId);

    event CertificateIssued(uint256 indexed tokenId, address indexed to, bytes32 indexed credentialId, string cid);
    event CertificateRevoked(uint256 indexed tokenId, address indexed from, bytes32 indexed credentialId);

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error EmptyCredential();
    error EmptyCid();
    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error AlreadyIssued(bytes32 credentialId, uint256 tokenId);
    error Soulbound();

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param superAdmin Holds `DEFAULT_ADMIN_ROLE` (grants and revokes roles) and `ADMIN_ROLE`.
     * @param admins     Additional `ADMIN_ROLE` holders. May be empty.
     */
    constructor(address superAdmin, address[] memory admins)
        ERC721("ETH Cali Builder Certificate", "ETHCALI-BUILDER")
    {
        if (superAdmin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, superAdmin);
        _grantRole(ADMIN_ROLE, superAdmin);
        for (uint256 i; i < admins.length; ++i) {
            if (admins[i] == address(0)) revert ZeroAddress();
            _grantRole(ADMIN_ROLE, admins[i]);
        }
    }

    // ── Issue / revoke ───────────────────────────────────────────────────────

    /**
     * @notice Mint one certificate per item. Reverts the whole batch if any item
     *         is invalid or its credential id is already live, so a batch either
     *         lands complete or not at all.
     * @return firstTokenId Id of the first token minted; the rest follow in order.
     */
    function issue(Issuance[] calldata items) external onlyRole(ADMIN_ROLE) returns (uint256 firstTokenId) {
        uint256 n = items.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n);

        firstTokenId = totalIssued + 1;
        for (uint256 i; i < n; ++i) {
            Issuance calldata it = items[i];
            if (it.to == address(0)) revert ZeroAddress();
            if (it.credentialId == bytes32(0)) revert EmptyCredential();
            if (bytes(it.cid).length == 0) revert EmptyCid();
            uint256 live = tokenOfCredential[it.credentialId];
            if (live != 0) revert AlreadyIssued(it.credentialId, live);

            uint256 tokenId = firstTokenId + i;
            // Effects before the mint, though _mint makes no external call.
            tokenOfCredential[it.credentialId] = tokenId;
            credentialOf[tokenId] = it.credentialId;

            _mint(it.to, tokenId);
            _setTokenURI(tokenId, it.cid);
            emit Locked(tokenId);
            emit CertificateIssued(tokenId, it.to, it.credentialId, it.cid);
        }
        totalIssued = firstTokenId + n - 1;
    }

    /**
     * @notice Burn a certificate and free its credential id for re-issue.
     *         Used to correct a mistake or move a certificate to another wallet.
     */
    function revoke(uint256 tokenId) external onlyRole(ADMIN_ROLE) {
        address holder = _requireOwned(tokenId);
        bytes32 credentialId = credentialOf[tokenId];

        delete tokenOfCredential[credentialId];
        delete credentialOf[tokenId];

        _burn(tokenId);
        emit CertificateRevoked(tokenId, holder, credentialId);
    }

    /// @notice Point a live token at corrected metadata.
    function setTokenCid(uint256 tokenId, string calldata cid) external onlyRole(ADMIN_ROLE) {
        _requireOwned(tokenId);
        if (bytes(cid).length == 0) revert EmptyCid();
        _setTokenURI(tokenId, cid);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function _baseURI() internal pure override returns (string memory) {
        return "ipfs://";
    }

    /// @notice ERC-5192. Every live certificate is locked, always.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return interfaceId == _INTERFACE_ERC5192 || super.supportsInterface(interfaceId);
    }

    // ── Soulbound ────────────────────────────────────────────────────────────

    /// @dev The single choke point for every ownership change: only mint and burn pass.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @dev Approvals would be meaningless on a token that cannot move; refuse them outright.
    function approve(address, uint256) public pure override(ERC721, IERC721) {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override(ERC721, IERC721) {
        revert Soulbound();
    }
}
