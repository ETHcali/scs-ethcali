// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./DonationReceipt1155.sol";

/**
 * @title DonationVault
 * @notice Multi-campaign donation vault. One contract, N relief campaigns, each
 *         accepting donations in any number of tokens.
 *
 *         Built for the ETH Cali earthquake relief appeal:
 *           - A campaign accepts native ETH and/or any ERC-20 (USDC, COPm, ...).
 *           - Each accepted token carries its own tier thresholds, because a
 *             meaningful donation is 10 USDC (6 decimals) or 40,000 COPm
 *             (18 decimals) — one global number cannot express both.
 *           - A qualifying donation mints an ERC-1155 receipt from an
 *             admin-configured DonationReceipt1155 collection.
 *           - Every donation is attributed on-chain, so a public donor wall and
 *             per-token leaderboard can be built from contract state alone.
 *
 * @dev Two deliberate guarantees for donors:
 *
 *      1. Funds can ONLY ever leave to the campaign's `beneficiary`. `withdraw`
 *         takes no destination — changing where money goes requires
 *         DEFAULT_ADMIN_ROLE and emits BeneficiaryUpdated.
 *
 *      2. A donation NEVER fails because of downstream plumbing. Receipt minting
 *         and beneficiary forwarding are both wrapped in try/catch — a
 *         misconfigured NFT tier or an unreachable beneficiary must not block
 *         emergency relief funds.
 *
 *      Custody model — a campaign is either a ROUTER or a HOLDER:
 *
 *        autoForward = true  (router)  Each donation is forwarded to the
 *                                      beneficiary Safe in the same transaction.
 *                                      No admin ever has custody. If the transfer
 *                                      fails the funds simply stay held and can be
 *                                      withdrawn later — the donation still settles.
 *
 *        autoForward = false (holder)  Funds accumulate here until an admin calls
 *                                      withdraw(), which still only pays the
 *                                      beneficiary.
 */
contract DonationVault is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ── Constants ─────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Sentinel address representing native ETH, matching Swag1155.
    address public constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Campaign {
        string  name;              // e.g. "Cali Earthquake Relief 2026"
        string  description;       // Purpose / where funds go
        address beneficiary;       // The ONLY address funds can be withdrawn to
        address receiptCollection; // DonationReceipt1155, or address(0) for none
        uint256 donorCount;        // Distinct donor addresses
        uint256 donationCount;     // Total number of donations
        bool    active;            // Whether the campaign accepts donations
        bool    autoForward;       // Route each donation straight to the beneficiary
        uint256 createdAt;
    }

    /// @notice A receipt tier for one token: donate >= minAmount, get receiptTokenId.
    struct Tier {
        uint256 minAmount;      // In the token's own base units
        uint256 receiptTokenId; // tokenId minted from the receipt collection
    }

    // ── State ─────────────────────────────────────────────────────────────────

    uint256 public campaignCount;
    mapping(uint256 => Campaign) public campaigns;

    /// @dev campaignId => set of accepted token addresses
    mapping(uint256 => EnumerableSet.AddressSet) private _acceptedTokens;

    /// @dev campaignId => token => tiers, kept sorted ascending by minAmount
    mapping(uint256 => mapping(address => Tier[])) private _tiers;

    /// @dev campaignId => token => cumulative raised
    mapping(uint256 => mapping(address => uint256)) public totalRaised;

    /// @dev campaignId => token => cumulative withdrawn to the beneficiary
    mapping(uint256 => mapping(address => uint256)) public totalWithdrawn;

    /// @dev campaignId => donor => token => cumulative donated
    mapping(uint256 => mapping(address => mapping(address => uint256))) public donated;

    /// @dev campaignId => set of donor addresses
    mapping(uint256 => EnumerableSet.AddressSet) private _donors;

    // ── Events ────────────────────────────────────────────────────────────────

    event CampaignCreated(
        uint256 indexed campaignId,
        string  name,
        address indexed beneficiary,
        address indexed receiptCollection,
        bool    autoForward
    );
    event AutoForwardUpdated(uint256 indexed campaignId, bool autoForward);
    event Forwarded(uint256 indexed campaignId, address indexed token, address indexed beneficiary, uint256 amount);
    event ForwardFailed(uint256 indexed campaignId, address indexed token, uint256 amount);
    event CampaignUpdated(uint256 indexed campaignId, string name, string description, bool active);
    event BeneficiaryUpdated(uint256 indexed campaignId, address indexed oldBeneficiary, address indexed newBeneficiary);
    event ReceiptCollectionUpdated(uint256 indexed campaignId, address indexed oldCollection, address indexed newCollection);
    event TokenAccepted(uint256 indexed campaignId, address indexed token, bool accepted);
    event TiersUpdated(uint256 indexed campaignId, address indexed token, uint256 tierCount);

    event Donated(
        uint256 indexed campaignId,
        address indexed donor,
        address indexed token,
        uint256 amount,
        string  message
    );
    event ReceiptIssued(uint256 indexed campaignId, address indexed donor, uint256 receiptTokenId);
    event ReceiptFailed(uint256 indexed campaignId, address indexed donor, uint256 receiptTokenId);
    event Withdrawn(uint256 indexed campaignId, address indexed token, address indexed beneficiary, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────

    error CampaignDoesNotExist(uint256 campaignId);
    error EmptyName();
    error InvalidBeneficiary();
    error InvalidToken();
    error CampaignNotActive(uint256 campaignId);
    error TokenNotAccepted(uint256 campaignId, address token);
    error ZeroAmount();
    error EthNotAccepted();
    error IncorrectEthAmount();
    error TiersNotAscending();
    error InsufficientBalance(uint256 available, uint256 requested);
    error EthTransferFailed();
    error DirectEthNotAccepted();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address initialAdmin) {
        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ── Admin: campaigns ──────────────────────────────────────────────────────

    /**
     * @notice Create a donation campaign.
     * @param name              e.g. "Cali Earthquake Relief 2026"
     * @param description       Where the funds go
     * @param beneficiary       The only address funds can ever be withdrawn to
     * @param receiptCollection DonationReceipt1155 address, or address(0) for none
     */
    function createCampaign(
        string calldata name,
        string calldata description,
        address beneficiary,
        address receiptCollection,
        bool autoForward
    ) external onlyRole(ADMIN_ROLE) returns (uint256 campaignId) {
        if (bytes(name).length == 0) revert EmptyName();
        if (beneficiary == address(0)) revert InvalidBeneficiary();

        campaignId = campaignCount;
        campaignCount++;

        Campaign storage c = campaigns[campaignId];
        c.name = name;
        c.description = description;
        c.beneficiary = beneficiary;
        c.receiptCollection = receiptCollection;
        c.active = true;
        c.autoForward = autoForward;
        c.createdAt = block.timestamp;

        emit CampaignCreated(campaignId, name, beneficiary, receiptCollection, autoForward);
    }

    /**
     * @notice Switch a campaign between router and holder custody.
     * @dev DEFAULT_ADMIN_ROLE — turning forwarding OFF gives admins custody of
     *      future donations, so it sits behind the same bar as setBeneficiary.
     */
    function setAutoForward(uint256 campaignId, bool autoForward) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireExists(campaignId);
        campaigns[campaignId].autoForward = autoForward;
        emit AutoForwardUpdated(campaignId, autoForward);
    }

    function updateCampaign(
        uint256 campaignId,
        string calldata name,
        string calldata description,
        bool active
    ) external onlyRole(ADMIN_ROLE) {
        _requireExists(campaignId);
        if (bytes(name).length == 0) revert EmptyName();

        Campaign storage c = campaigns[campaignId];
        c.name = name;
        c.description = description;
        c.active = active;

        emit CampaignUpdated(campaignId, name, description, active);
    }

    /**
     * @notice Change where a campaign's funds are withdrawn to.
     * @dev DEFAULT_ADMIN_ROLE only — this is the single most sensitive parameter
     *      in the contract, since it is the sole destination of donated funds.
     */
    function setBeneficiary(uint256 campaignId, address beneficiary) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireExists(campaignId);
        if (beneficiary == address(0)) revert InvalidBeneficiary();

        address old = campaigns[campaignId].beneficiary;
        campaigns[campaignId].beneficiary = beneficiary;

        emit BeneficiaryUpdated(campaignId, old, beneficiary);
    }

    function setReceiptCollection(uint256 campaignId, address collection) external onlyRole(ADMIN_ROLE) {
        _requireExists(campaignId);

        address old = campaigns[campaignId].receiptCollection;
        campaigns[campaignId].receiptCollection = collection;

        emit ReceiptCollectionUpdated(campaignId, old, collection);
    }

    // ── Admin: accepted tokens and tiers ──────────────────────────────────────

    /**
     * @notice Accept or stop accepting a token for a campaign.
     * @param token ERC-20 address, or ETH_TOKEN for native ETH
     * @dev Removing a token does not touch funds already raised in it — those
     *      remain withdrawable to the beneficiary.
     */
    function setAcceptedToken(uint256 campaignId, address token, bool accepted) external onlyRole(ADMIN_ROLE) {
        _requireExists(campaignId);
        if (token == address(0)) revert InvalidToken();

        if (accepted) {
            _acceptedTokens[campaignId].add(token);
        } else {
            _acceptedTokens[campaignId].remove(token);
        }

        emit TokenAccepted(campaignId, token, accepted);
    }

    /**
     * @notice Set the receipt tiers for one token of a campaign.
     * @param tiers Must be sorted strictly ascending by minAmount. Pass an empty
     *              array to disable receipts for this token.
     * @dev Thresholds are per token because decimals and value differ — 10 USDC
     *      is 10e6 while an equivalent COPm amount is ~40_000e18.
     */
    function setTiers(uint256 campaignId, address token, Tier[] calldata tiers) external onlyRole(ADMIN_ROLE) {
        _requireExists(campaignId);
        if (token == address(0)) revert InvalidToken();

        for (uint256 i = 1; i < tiers.length; i++) {
            if (tiers[i].minAmount <= tiers[i - 1].minAmount) revert TiersNotAscending();
        }

        delete _tiers[campaignId][token];
        for (uint256 i = 0; i < tiers.length; i++) {
            _tiers[campaignId][token].push(tiers[i]);
        }

        emit TiersUpdated(campaignId, token, tiers.length);
    }

    // ── Admin: withdrawal ─────────────────────────────────────────────────────

    /**
     * @notice Withdraw raised funds to the campaign's beneficiary.
     * @dev Takes no destination parameter by design — funds can only ever reach
     *      `campaigns[campaignId].beneficiary`.
     */
    function withdraw(uint256 campaignId, address token, uint256 amount)
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
    {
        _requireExists(campaignId);
        if (amount == 0) revert ZeroAmount();

        uint256 available = availableBalance(campaignId, token);
        if (amount > available) revert InsufficientBalance(available, amount);

        totalWithdrawn[campaignId][token] += amount;

        address beneficiary = campaigns[campaignId].beneficiary;
        _payout(token, beneficiary, amount);

        emit Withdrawn(campaignId, token, beneficiary, amount);
    }

    /// @notice Withdraw the campaign's entire balance of `token` to its beneficiary.
    function withdrawAll(uint256 campaignId, address token) external onlyRole(ADMIN_ROLE) nonReentrant {
        _requireExists(campaignId);

        uint256 available = availableBalance(campaignId, token);
        if (available == 0) revert ZeroAmount();

        totalWithdrawn[campaignId][token] += available;

        address beneficiary = campaigns[campaignId].beneficiary;
        _payout(token, beneficiary, available);

        emit Withdrawn(campaignId, token, beneficiary, available);
    }

    // ── Admin: misc ───────────────────────────────────────────────────────────

    function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (admin == address(0)) revert InvalidBeneficiary();
        _grantRole(ADMIN_ROLE, admin);
    }

    function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ADMIN_ROLE, admin);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ── Donations ─────────────────────────────────────────────────────────────

    /**
     * @notice Donate to a campaign.
     * @param campaignId Campaign to support
     * @param token      ERC-20 address, or ETH_TOKEN for native ETH
     * @param amount     Amount in the token's base units. For ETH this must equal msg.value
     * @param message    Optional public message; emitted, not stored
     *
     * @dev ERC-20 donations are credited by measured balance delta, so a
     *      fee-on-transfer token credits what actually arrived rather than
     *      reverting. Receipt minting can never block the donation.
     */
    function donate(
        uint256 campaignId,
        address token,
        uint256 amount,
        string calldata message
    ) external payable nonReentrant whenNotPaused {
        _requireExists(campaignId);

        Campaign storage c = campaigns[campaignId];
        if (!c.active) revert CampaignNotActive(campaignId);
        if (!_acceptedTokens[campaignId].contains(token)) revert TokenNotAccepted(campaignId, token);
        if (amount == 0) revert ZeroAmount();

        uint256 received = _collect(token, amount);

        // Effects.
        totalRaised[campaignId][token] += received;
        donated[campaignId][msg.sender][token] += received;
        c.donationCount++;
        if (_donors[campaignId].add(msg.sender)) {
            c.donorCount++;
        }

        emit Donated(campaignId, msg.sender, token, received, message);

        // Router mode: push straight through to the beneficiary Safe so no admin
        // ever has custody. Best-effort — a failed forward leaves the funds held.
        if (c.autoForward) {
            _tryForward(campaignId, token, received);
        }

        // Receipts are best-effort — never let NFT config block relief funds.
        _tryIssueReceipt(campaignId, token, received);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _requireExists(uint256 campaignId) internal view {
        if (campaignId >= campaignCount) revert CampaignDoesNotExist(campaignId);
    }

    /// @dev Pull `amount` of `token` from the donor. Returns the amount actually received.
    function _collect(address token, uint256 amount) internal returns (uint256 received) {
        if (token == ETH_TOKEN) {
            if (msg.value != amount) revert IncorrectEthAmount();
            received = amount;
        } else {
            if (msg.value != 0) revert EthNotAccepted();

            IERC20 erc20 = IERC20(token);
            uint256 before = erc20.balanceOf(address(this));
            erc20.safeTransferFrom(msg.sender, address(this), amount);
            received = erc20.balanceOf(address(this)) - before;

            if (received == 0) revert ZeroAmount();
        }
    }

    function _payout(address token, address to, uint256 amount) internal {
        if (token == ETH_TOKEN) {
            (bool success, ) = payable(to).call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /**
     * @dev Router mode. Forward a freshly received donation to the beneficiary in
     *      the same transaction, so the vault never holds donor funds and no
     *      admin ever takes custody.
     *
     *      Best-effort by design: if the beneficiary cannot receive right now
     *      (a contract that reverts, an ERC-20 that returns false), the funds
     *      simply remain held and stay withdrawable to that same beneficiary
     *      later. The donation itself always settles — an unreachable
     *      beneficiary must never cost the campaign a donation.
     */
    function _tryForward(uint256 campaignId, address token, uint256 amount) internal {
        address beneficiary = campaigns[campaignId].beneficiary;

        // Book the transfer first so accounting stays consistent, and roll it
        // back if the transfer does not land (CEI, with an explicit undo).
        totalWithdrawn[campaignId][token] += amount;

        bool ok;
        if (token == ETH_TOKEN) {
            (ok, ) = payable(beneficiary).call{value: amount}("");
        } else {
            try IERC20(token).transfer(beneficiary, amount) returns (bool success) {
                ok = success;
            } catch {
                ok = false;
            }
        }

        if (ok) {
            emit Forwarded(campaignId, token, beneficiary, amount);
        } else {
            totalWithdrawn[campaignId][token] -= amount;
            emit ForwardFailed(campaignId, token, amount);
        }
    }

    /**
     * @dev Mint the highest tier this donation qualifies for, if any.
     *      Wrapped in try/catch: a bad tier config, a revoked MINTER_ROLE, or a
     *      receipt contract that reverts must never cost the campaign a donation.
     */
    function _tryIssueReceipt(uint256 campaignId, address token, uint256 amount) internal {
        address collection = campaigns[campaignId].receiptCollection;
        if (collection == address(0)) return;

        (bool found, uint256 receiptTokenId) = resolveTier(campaignId, token, amount);
        if (!found) return;

        try DonationReceipt1155(collection).mint(msg.sender, receiptTokenId, 1) {
            emit ReceiptIssued(campaignId, msg.sender, receiptTokenId);
        } catch {
            emit ReceiptFailed(campaignId, msg.sender, receiptTokenId);
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /**
     * @notice Highest tier a donation of `amount` in `token` qualifies for.
     * @return found          Whether any tier matched
     * @return receiptTokenId The receipt tokenId to mint
     */
    function resolveTier(uint256 campaignId, address token, uint256 amount)
        public
        view
        returns (bool found, uint256 receiptTokenId)
    {
        Tier[] storage tiers = _tiers[campaignId][token];

        // Tiers are stored ascending; walk down for the highest match.
        for (uint256 i = tiers.length; i > 0; i--) {
            if (amount >= tiers[i - 1].minAmount) {
                return (true, tiers[i - 1].receiptTokenId);
            }
        }
        return (false, 0);
    }

    /// @notice Funds raised but not yet withdrawn, per campaign and token.
    function availableBalance(uint256 campaignId, address token) public view returns (uint256) {
        return totalRaised[campaignId][token] - totalWithdrawn[campaignId][token];
    }

    function getCampaign(uint256 campaignId) external view returns (Campaign memory) {
        _requireExists(campaignId);
        return campaigns[campaignId];
    }

    function getAllCampaigns() external view returns (Campaign[] memory) {
        Campaign[] memory all = new Campaign[](campaignCount);
        for (uint256 i = 0; i < campaignCount; i++) {
            all[i] = campaigns[i];
        }
        return all;
    }

    function getActiveCampaigns() external view returns (uint256[] memory, Campaign[] memory) {
        uint256 activeCount;
        for (uint256 i = 0; i < campaignCount; i++) {
            if (campaigns[i].active) activeCount++;
        }

        uint256[] memory ids = new uint256[](activeCount);
        Campaign[] memory active = new Campaign[](activeCount);
        uint256 j;
        for (uint256 i = 0; i < campaignCount; i++) {
            if (campaigns[i].active) {
                ids[j] = i;
                active[j] = campaigns[i];
                j++;
            }
        }
        return (ids, active);
    }

    function getAcceptedTokens(uint256 campaignId) external view returns (address[] memory) {
        _requireExists(campaignId);
        return _acceptedTokens[campaignId].values();
    }

    function isTokenAccepted(uint256 campaignId, address token) external view returns (bool) {
        return _acceptedTokens[campaignId].contains(token);
    }

    function getTiers(uint256 campaignId, address token) external view returns (Tier[] memory) {
        return _tiers[campaignId][token];
    }

    function getDonation(uint256 campaignId, address donor, address token) external view returns (uint256) {
        return donated[campaignId][donor][token];
    }

    function getDonors(uint256 campaignId) external view returns (address[] memory) {
        _requireExists(campaignId);
        return _donors[campaignId].values();
    }

    /// @notice Paginated donor wall, for campaigns too large to return at once.
    function getDonorsPaginated(uint256 campaignId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        _requireExists(campaignId);

        EnumerableSet.AddressSet storage donors = _donors[campaignId];
        total = donors.length();

        if (offset >= total) return (new address[](0), total);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = donors.at(i);
        }
    }

    /**
     * @notice A page of the donor wall with amounts, for a leaderboard.
     * @dev Returned unsorted — sorting on-chain would cost more than it is worth.
     *      Fetch a page and sort client-side.
     */
    function getDonorsWithAmounts(uint256 campaignId, address token, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory donors, uint256[] memory amounts, uint256 total)
    {
        _requireExists(campaignId);

        EnumerableSet.AddressSet storage donorSet = _donors[campaignId];
        total = donorSet.length();

        if (offset >= total) return (new address[](0), new uint256[](0), total);

        uint256 end = offset + limit;
        if (end > total) end = total;

        donors = new address[](end - offset);
        amounts = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            address donor = donorSet.at(i);
            donors[i - offset] = donor;
            amounts[i - offset] = donated[campaignId][donor][token];
        }
    }

    /// @notice Totals raised for every accepted token of a campaign, in one call.
    function getCampaignTotals(uint256 campaignId)
        external
        view
        returns (address[] memory tokens, uint256[] memory raised, uint256[] memory available)
    {
        _requireExists(campaignId);

        tokens = _acceptedTokens[campaignId].values();
        raised = new uint256[](tokens.length);
        available = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            raised[i] = totalRaised[campaignId][tokens[i]];
            available[i] = availableBalance(campaignId, tokens[i]);
        }
    }

    /**
     * @notice Whether a donation would succeed right now, and why not if it would not.
     * @dev Mirrors every check in donate() so the UI can disable the button with
     *      a reason instead of surfacing a failed transaction.
     */
    function canDonate(uint256 campaignId, address token, uint256 amount)
        external
        view
        returns (bool allowed, string memory reason)
    {
        if (campaignId >= campaignCount) return (false, "Campaign does not exist");
        if (paused()) return (false, "Donations are paused");
        if (!campaigns[campaignId].active) return (false, "Campaign not active");
        if (!_acceptedTokens[campaignId].contains(token)) return (false, "Token not accepted");
        if (amount == 0) return (false, "Amount must be greater than zero");
        return (true, "");
    }

    function isAdmin(address account) external view returns (bool) {
        return hasRole(ADMIN_ROLE, account);
    }

    function isSuperAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    /**
     * @dev Reject bare ETH transfers. A donation must name a campaign, otherwise
     *      the funds would be unattributable and unwithdrawable.
     */
    receive() external payable {
        revert DirectEthNotAccepted();
    }
}
