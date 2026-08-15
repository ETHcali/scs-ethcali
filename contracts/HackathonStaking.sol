// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./ZKPassportNFT.sol";
import "./interfaces/IYieldStrategy.sol";

/**
 * @title HackathonStaking
 * @notice Commitment-bond staking for hackathons. One contract, N hackathon events.
 *
 *         Phase 1 flow:
 *           1. Admin creates a hackathon with a fixed stake amount and two deadlines.
 *           2. Participant stakes before `registrationDeadline`.
 *           3. Admin marks submissions via `markSubmitted`.
 *           4. Participant unstakes their principal in full.
 *           5. After `submissionDeadline`, admin sweeps the bonds of no-shows
 *              to a prize pool via `sweepForfeited`.
 *
 *         Stakes are a bond, not an investment: a participant who submits always
 *         gets exactly their principal back. Gating mirrors FaucetManager —
 *         optional ZKPassport NFT, optional whitelist, optional token/NFT holding.
 *
 * @dev PHASE 2 SEAM — every hackathon carries a `yieldStrategy` slot that is
 *      address(0) at launch, making `_afterStake` / `_beforeUnstake` no-ops.
 *      Principal is tracked in `Hackathon.totalStaked` and `Stake.principal`
 *      independently of this contract's token balance, so a strategy can be
 *      attached later without redeploying or migrating existing stakes.
 *      See IYieldStrategy.
 */
contract HackathonStaking is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ── Constants ─────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Sentinel address representing native ETH as a stake asset.
    address public constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Hackathon {
        string  name;                   // e.g. "ETHGlobal Cali 2026"
        string  description;            // Purpose / rules summary
        address stakeAsset;             // ETH_TOKEN sentinel, or an ERC-20 address
        uint256 stakeAmount;            // Exact bond per participant, in asset base units
        uint256 registrationDeadline;   // Last timestamp at which stake() is allowed
        uint256 submissionDeadline;     // After this, unswept bonds may be forfeited
        uint256 totalStaked;            // Principal currently held (excludes refunded/forfeited)
        uint256 stakerCount;            // Distinct addresses that have ever staked
        uint256 totalRefunded;          // Cumulative principal returned to participants
        uint256 totalForfeited;         // Cumulative principal swept to the prize pool
        bool    active;                 // Whether the hackathon accepts new stakes
        bool    whitelistEnabled;       // Whether whitelist is required to stake
        bool    zkPassportRequired;     // Whether ZKPassport NFT is required to stake
        address allowedToken;           // Token/NFT required to stake (address(0) = none)
        address yieldStrategy;          // PHASE 2: address(0) = principal rests here
        uint256 createdAt;              // Timestamp of creation
    }

    /// @notice Input descriptor for createHackathon (avoids stack-too-deep).
    struct HackathonInit {
        string  name;
        string  description;
        address stakeAsset;
        uint256 stakeAmount;
        uint256 registrationDeadline;
        uint256 submissionDeadline;
        bool    whitelistEnabled;
        bool    zkPassportRequired;
        address allowedToken;
    }

    /// @notice Per-participant bond record. Retained after unstake as history.
    struct Stake {
        uint256 principal;    // Bond amount; 0 means never staked
        uint256 stakedAt;
        bool    submitted;    // Admin confirmed a submission
        uint256 submittedAt;
        bool    unstaked;     // Principal returned to the participant
        uint256 unstakedAt;
        bool    forfeited;    // Principal swept to the prize pool
        uint256 forfeitedAt;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice ZKPassport NFT contract used for optional anti-sybil gating.
    ZKPassportNFT public nftContract;

    uint256 public hackathonCount;
    mapping(uint256 => Hackathon) public hackathons;

    /// @dev hackathonId => participant => bond record
    mapping(uint256 => mapping(address => Stake)) public stakes;

    /// @dev hackathonId => participant => whitelisted
    mapping(uint256 => mapping(address => bool)) public whitelist;

    /// @dev hackathonId => set of every address that has staked (for sweeps + enumeration)
    mapping(uint256 => EnumerableSet.AddressSet) private _stakers;

    /// @dev hackathonId => next index for paginated sweepForfeited
    mapping(uint256 => uint256) public forfeitCursor;

    /// @notice Good-actor counter: hackathons a participant has submitted to.
    mapping(address => uint256) public submissionCount;

    /// @dev Addresses currently attached as a yield strategy, allowed to return ETH.
    mapping(address => bool) public isYieldStrategy;

    // ── Events ────────────────────────────────────────────────────────────────

    event HackathonCreated(
        uint256 indexed hackathonId,
        string  name,
        address indexed stakeAsset,
        uint256 stakeAmount,
        uint256 registrationDeadline,
        uint256 submissionDeadline
    );
    event HackathonUpdated(uint256 indexed hackathonId, string name, string description, bool active);
    event DeadlinesUpdated(uint256 indexed hackathonId, uint256 registrationDeadline, uint256 submissionDeadline);
    event HackathonGatingUpdated(uint256 indexed hackathonId, bool zkPassportRequired, address allowedToken);
    event WhitelistUpdated(uint256 indexed hackathonId, bool enabled);
    event AddressWhitelisted(uint256 indexed hackathonId, address indexed user);
    event AddressRemovedFromWhitelist(uint256 indexed hackathonId, address indexed user);

    event Staked(uint256 indexed hackathonId, address indexed user, uint256 amount);
    event SubmissionMarked(uint256 indexed hackathonId, address indexed user);
    event SubmissionUnmarked(uint256 indexed hackathonId, address indexed user);
    event Unstaked(uint256 indexed hackathonId, address indexed user, uint256 amount);
    event Forfeited(uint256 indexed hackathonId, address indexed user, uint256 amount, address indexed to);
    event ForfeitSweep(uint256 indexed hackathonId, uint256 count, uint256 total, address indexed to);

    event YieldStrategyUpdated(uint256 indexed hackathonId, address indexed oldStrategy, address indexed newStrategy);
    event NFTContractUpdated(address indexed oldContract, address indexed newContract);

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @notice Constructor
     * @param _nftContract Address of the ZKPassportNFT contract
     * @param initialAdmin Address to set as admin (use address(0) for deployer)
     */
    constructor(address _nftContract, address initialAdmin) {
        require(_nftContract != address(0), "HackathonStaking: invalid NFT contract");
        nftContract = ZKPassportNFT(_nftContract);

        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ── Admin: hackathon lifecycle ────────────────────────────────────────────

    /**
     * @notice Create a new hackathon
     * @param init Hackathon configuration
     * @return hackathonId Id of the newly created hackathon
     */
    function createHackathon(HackathonInit calldata init)
        external
        onlyRole(ADMIN_ROLE)
        returns (uint256 hackathonId)
    {
        require(bytes(init.name).length > 0, "HackathonStaking: empty name");
        require(init.stakeAsset != address(0), "HackathonStaking: invalid stake asset");
        require(init.stakeAmount > 0, "HackathonStaking: stake amount must be > 0");
        require(
            init.registrationDeadline > block.timestamp,
            "HackathonStaking: registration deadline in the past"
        );
        require(
            init.submissionDeadline >= init.registrationDeadline,
            "HackathonStaking: submission before registration deadline"
        );

        hackathonId = hackathonCount;
        hackathonCount++;

        Hackathon storage h = hackathons[hackathonId];
        h.name = init.name;
        h.description = init.description;
        h.stakeAsset = init.stakeAsset;
        h.stakeAmount = init.stakeAmount;
        h.registrationDeadline = init.registrationDeadline;
        h.submissionDeadline = init.submissionDeadline;
        h.active = true;
        h.whitelistEnabled = init.whitelistEnabled;
        h.zkPassportRequired = init.zkPassportRequired;
        h.allowedToken = init.allowedToken;
        h.createdAt = block.timestamp;
        // yieldStrategy intentionally left as address(0) — see IYieldStrategy.

        emit HackathonCreated(
            hackathonId,
            init.name,
            init.stakeAsset,
            init.stakeAmount,
            init.registrationDeadline,
            init.submissionDeadline
        );
    }

    /**
     * @notice Update a hackathon's descriptive fields and active flag
     * @dev stakeAsset and stakeAmount are immutable once created — participants
     *      have already bonded against them.
     */
    function updateHackathon(
        uint256 hackathonId,
        string calldata name,
        string calldata description,
        bool active
    ) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        require(bytes(name).length > 0, "HackathonStaking: empty name");

        Hackathon storage h = hackathons[hackathonId];
        h.name = name;
        h.description = description;
        h.active = active;

        emit HackathonUpdated(hackathonId, name, description, active);
    }

    /**
     * @notice Extend or adjust the deadlines of a hackathon
     * @dev Deadlines may be pushed out (a jury running late) but the ordering
     *      invariant is always enforced.
     */
    function updateDeadlines(
        uint256 hackathonId,
        uint256 registrationDeadline,
        uint256 submissionDeadline
    ) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        require(
            submissionDeadline >= registrationDeadline,
            "HackathonStaking: submission before registration deadline"
        );

        Hackathon storage h = hackathons[hackathonId];
        h.registrationDeadline = registrationDeadline;
        h.submissionDeadline = submissionDeadline;

        emit DeadlinesUpdated(hackathonId, registrationDeadline, submissionDeadline);
    }

    /**
     * @notice Update gating configuration for a hackathon
     * @param zkPassportRequired Whether ZKPassport NFT is required
     * @param allowedToken Token/NFT address required to stake (address(0) to disable)
     */
    function updateHackathonGating(
        uint256 hackathonId,
        bool zkPassportRequired,
        address allowedToken
    ) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        hackathons[hackathonId].zkPassportRequired = zkPassportRequired;
        hackathons[hackathonId].allowedToken = allowedToken;
        emit HackathonGatingUpdated(hackathonId, zkPassportRequired, allowedToken);
    }

    // ── Admin: whitelist ──────────────────────────────────────────────────────

    function setWhitelistEnabled(uint256 hackathonId, bool enabled) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        hackathons[hackathonId].whitelistEnabled = enabled;
        emit WhitelistUpdated(hackathonId, enabled);
    }

    function addToWhitelist(uint256 hackathonId, address user) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        require(user != address(0), "HackathonStaking: invalid address");
        whitelist[hackathonId][user] = true;
        emit AddressWhitelisted(hackathonId, user);
    }

    function addBatchToWhitelist(uint256 hackathonId, address[] calldata users) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] != address(0)) {
                whitelist[hackathonId][users[i]] = true;
                emit AddressWhitelisted(hackathonId, users[i]);
            }
        }
    }

    function removeFromWhitelist(uint256 hackathonId, address user) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        whitelist[hackathonId][user] = false;
        emit AddressRemovedFromWhitelist(hackathonId, user);
    }

    function removeBatchFromWhitelist(uint256 hackathonId, address[] calldata users) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);
        for (uint256 i = 0; i < users.length; i++) {
            whitelist[hackathonId][users[i]] = false;
            emit AddressRemovedFromWhitelist(hackathonId, users[i]);
        }
    }

    // ── Admin: submissions ────────────────────────────────────────────────────

    /**
     * @notice Mark participants as having submitted, unlocking their unstake
     * @param hackathonId Hackathon id
     * @param participants Addresses to mark
     * @dev Silently skips addresses that never staked, already unstaked, or were
     *      forfeited, so a jury can paste a full submission list without it
     *      reverting on one bad row.
     */
    function markSubmitted(uint256 hackathonId, address[] calldata participants)
        external
        onlyRole(ADMIN_ROLE)
    {
        _requireExists(hackathonId);

        for (uint256 i = 0; i < participants.length; i++) {
            Stake storage s = stakes[hackathonId][participants[i]];
            if (s.principal == 0 || s.submitted || s.unstaked || s.forfeited) continue;

            s.submitted = true;
            s.submittedAt = block.timestamp;
            submissionCount[participants[i]]++;

            emit SubmissionMarked(hackathonId, participants[i]);
        }
    }

    /**
     * @notice Revoke a submission mark (correction path, e.g. a disqualification)
     * @dev Only possible while the bond is still held — once unstaked the
     *      principal is gone and the mark is history.
     */
    function unmarkSubmitted(uint256 hackathonId, address participant) external onlyRole(ADMIN_ROLE) {
        _requireExists(hackathonId);

        Stake storage s = stakes[hackathonId][participant];
        require(s.submitted, "HackathonStaking: not marked as submitted");
        require(!s.unstaked, "HackathonStaking: already unstaked");

        s.submitted = false;
        s.submittedAt = 0;
        if (submissionCount[participant] > 0) submissionCount[participant]--;

        emit SubmissionUnmarked(hackathonId, participant);
    }

    /**
     * @notice Sweep the bonds of participants who never submitted to a prize pool
     * @param hackathonId Hackathon id
     * @param to Recipient of the forfeited principal (prize pool / treasury)
     * @param maxCount Max stakers to scan this call — paginate via forfeitCursor
     * @return swept Total principal forfeited in this call
     * @dev Callable only after `submissionDeadline`. Scanning is paginated so a
     *      hackathon with thousands of stakers can never brick the sweep on gas.
     */
    function sweepForfeited(uint256 hackathonId, address to, uint256 maxCount)
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
        returns (uint256 swept)
    {
        _requireExists(hackathonId);
        require(to != address(0), "HackathonStaking: invalid recipient");
        require(maxCount > 0, "HackathonStaking: maxCount must be > 0");

        Hackathon storage h = hackathons[hackathonId];
        require(block.timestamp > h.submissionDeadline, "HackathonStaking: submission period not over");

        EnumerableSet.AddressSet storage stakerSet = _stakers[hackathonId];
        uint256 total = stakerSet.length();
        uint256 cursor = forfeitCursor[hackathonId];
        uint256 end = cursor + maxCount;
        if (end > total) end = total;

        uint256 count;
        for (uint256 i = cursor; i < end; i++) {
            address user = stakerSet.at(i);
            Stake storage s = stakes[hackathonId][user];
            if (s.principal == 0 || s.submitted || s.unstaked || s.forfeited) continue;

            s.forfeited = true;
            s.forfeitedAt = block.timestamp;

            swept += s.principal;
            count++;

            emit Forfeited(hackathonId, user, s.principal, to);
        }

        forfeitCursor[hackathonId] = end;

        if (swept > 0) {
            h.totalStaked -= swept;
            h.totalForfeited += swept;

            _pullFromStrategy(hackathonId, swept);
            _payout(h.stakeAsset, to, swept);
        }

        emit ForfeitSweep(hackathonId, count, swept, to);
    }

    // ── Admin: phase 2 seam ───────────────────────────────────────────────────

    /**
     * @notice Attach or detach a yield strategy for a hackathon
     * @dev PHASE 2. Left unused in phase 1 — every hackathon runs with
     *      address(0) and principal simply rests in this contract.
     *
     *      Attaching is only permitted while no principal is held, so principal
     *      can never be split across "resting here" and "inside a strategy".
     *      Detaching likewise requires the strategy to be fully unwound.
     */
    function setYieldStrategy(uint256 hackathonId, address strategy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireExists(hackathonId);

        Hackathon storage h = hackathons[hackathonId];
        require(h.totalStaked == 0, "HackathonStaking: principal still staked");

        if (strategy != address(0)) {
            require(
                IYieldStrategy(strategy).asset() == h.stakeAsset,
                "HackathonStaking: strategy asset mismatch"
            );
        }

        address old = h.yieldStrategy;
        if (old != address(0)) isYieldStrategy[old] = false;

        h.yieldStrategy = strategy;
        if (strategy != address(0)) isYieldStrategy[strategy] = true;

        emit YieldStrategyUpdated(hackathonId, old, strategy);
    }

    // ── Admin: misc ───────────────────────────────────────────────────────────

    function setNFTContract(address newContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newContract != address(0), "HackathonStaking: invalid contract");
        address oldContract = address(nftContract);
        nftContract = ZKPassportNFT(newContract);
        emit NFTContractUpdated(oldContract, newContract);
    }

    function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(admin != address(0), "HackathonStaking: invalid address");
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

    // ── User functions ────────────────────────────────────────────────────────

    /**
     * @notice Stake the commitment bond for a hackathon
     * @param hackathonId Hackathon id
     * @dev For an ETH hackathon, send exactly `stakeAmount` as msg.value.
     *      For an ERC-20 hackathon, approve `stakeAmount` first and send no ETH.
     */
    function stake(uint256 hackathonId) external payable nonReentrant whenNotPaused {
        _requireExists(hackathonId);

        Hackathon storage h = hackathons[hackathonId];
        require(h.active, "HackathonStaking: hackathon not active");
        require(block.timestamp <= h.registrationDeadline, "HackathonStaking: registration closed");

        Stake storage s = stakes[hackathonId][msg.sender];
        require(s.principal == 0, "HackathonStaking: already staked");

        // Anti-sybil: require ZKPassport NFT (if enabled for this hackathon)
        if (h.zkPassportRequired) {
            require(nftContract.hasNFTByAddress(msg.sender), "HackathonStaking: must own ZKPassport NFT");
        }

        // Check whitelist if enabled
        if (h.whitelistEnabled) {
            require(whitelist[hackathonId][msg.sender], "HackathonStaking: not whitelisted");
        }

        // Check allowed token/NFT holding if configured
        if (h.allowedToken != address(0)) {
            require(_holdsToken(h.allowedToken, msg.sender), "HackathonStaking: must hold required token");
        }

        uint256 amount = h.stakeAmount;

        // Effects before the strategy interaction (CEI).
        s.principal = amount;
        s.stakedAt = block.timestamp;

        h.totalStaked += amount;
        if (_stakers[hackathonId].add(msg.sender)) {
            h.stakerCount++;
        }

        // Collect the bond.
        _collect(h.stakeAsset, amount);

        // PHASE 2 seam — inert while yieldStrategy is address(0).
        _afterStake(hackathonId, amount);

        emit Staked(hackathonId, msg.sender, amount);
    }

    /**
     * @notice Withdraw the bond after a submission has been confirmed
     * @param hackathonId Hackathon id
     * @dev Returns exactly the principal staked. A bond is never slashed for a
     *      participant who submitted.
     */
    function unstake(uint256 hackathonId) external nonReentrant whenNotPaused {
        _requireExists(hackathonId);

        Stake storage s = stakes[hackathonId][msg.sender];
        require(s.principal > 0, "HackathonStaking: nothing staked");
        require(!s.unstaked, "HackathonStaking: already unstaked");
        require(!s.forfeited, "HackathonStaking: stake forfeited");
        require(s.submitted, "HackathonStaking: submission not confirmed");

        Hackathon storage h = hackathons[hackathonId];
        uint256 amount = s.principal;

        // Effects.
        s.unstaked = true;
        s.unstakedAt = block.timestamp;

        h.totalStaked -= amount;
        h.totalRefunded += amount;

        // Interactions. PHASE 2 seam — inert while yieldStrategy is address(0).
        _pullFromStrategy(hackathonId, amount);
        _payout(h.stakeAsset, msg.sender, amount);

        emit Unstaked(hackathonId, msg.sender, amount);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _requireExists(uint256 hackathonId) internal view {
        require(hackathonId < hackathonCount, "HackathonStaking: hackathon does not exist");
    }

    /// @dev True if `user` holds any balance of `token`, whether ERC-721 or ERC-20.
    function _holdsToken(address token, address user) internal view returns (bool) {
        try IERC721(token).balanceOf(user) returns (uint256 bal) {
            return bal > 0;
        } catch {
            return IERC20(token).balanceOf(user) > 0;
        }
    }

    /**
     * @dev Take exactly `amount` of the stake asset from msg.sender.
     *      Fee-on-transfer and rebasing ERC-20s are rejected rather than
     *      silently under-collateralising a bond.
     */
    function _collect(address asset, uint256 amount) internal {
        if (asset == ETH_TOKEN) {
            require(msg.value == amount, "HackathonStaking: incorrect ETH amount");
        } else {
            require(msg.value == 0, "HackathonStaking: ETH not accepted for this hackathon");

            IERC20 token = IERC20(asset);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amount);
            require(
                token.balanceOf(address(this)) - before == amount,
                "HackathonStaking: unsupported transfer-fee token"
            );
        }
    }

    /// @dev Send `amount` of the stake asset to `to`.
    function _payout(address asset, address to, uint256 amount) internal {
        if (asset == ETH_TOKEN) {
            (bool success, ) = payable(to).call{value: amount}("");
            require(success, "HackathonStaking: ETH transfer failed");
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    /**
     * @dev PHASE 2 SEAM. Route freshly staked principal into the yield venue.
     *      No-op while `yieldStrategy` is address(0), which is the phase 1 state.
     */
    function _afterStake(uint256 hackathonId, uint256 amount) internal {
        address strategy = hackathons[hackathonId].yieldStrategy;
        if (strategy == address(0)) return;

        address asset = hackathons[hackathonId].stakeAsset;
        if (asset == ETH_TOKEN) {
            IYieldStrategy(strategy).deposit{value: amount}(hackathonId, amount);
        } else {
            IERC20(asset).forceApprove(strategy, amount);
            IYieldStrategy(strategy).deposit(hackathonId, amount);
            IERC20(asset).forceApprove(strategy, 0);
        }
    }

    /**
     * @dev PHASE 2 SEAM. Recall principal from the yield venue before paying out.
     *      No-op while `yieldStrategy` is address(0), which is the phase 1 state.
     *      A strategy that returns less than requested reverts — a participant's
     *      bond is never exposed to strategy losses.
     */
    function _pullFromStrategy(uint256 hackathonId, uint256 amount) internal {
        address strategy = hackathons[hackathonId].yieldStrategy;
        if (strategy == address(0)) return;

        uint256 withdrawn = IYieldStrategy(strategy).withdraw(hackathonId, amount, address(this));
        require(withdrawn >= amount, "HackathonStaking: strategy returned short");
    }

    // ── View functions ────────────────────────────────────────────────────────

    function getHackathon(uint256 hackathonId) external view returns (Hackathon memory) {
        _requireExists(hackathonId);
        return hackathons[hackathonId];
    }

    function getAllHackathons() external view returns (Hackathon[] memory) {
        Hackathon[] memory all = new Hackathon[](hackathonCount);
        for (uint256 i = 0; i < hackathonCount; i++) {
            all[i] = hackathons[i];
        }
        return all;
    }

    function getActiveHackathons() external view returns (uint256[] memory, Hackathon[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < hackathonCount; i++) {
            if (hackathons[i].active) activeCount++;
        }

        uint256[] memory ids = new uint256[](activeCount);
        Hackathon[] memory active = new Hackathon[](activeCount);
        uint256 j = 0;
        for (uint256 i = 0; i < hackathonCount; i++) {
            if (hackathons[i].active) {
                ids[j] = i;
                active[j] = hackathons[i];
                j++;
            }
        }
        return (ids, active);
    }

    function getStake(uint256 hackathonId, address user) external view returns (Stake memory) {
        _requireExists(hackathonId);
        return stakes[hackathonId][user];
    }

    /// @notice Every address that has staked in a hackathon.
    function getStakers(uint256 hackathonId) external view returns (address[] memory) {
        _requireExists(hackathonId);
        return _stakers[hackathonId].values();
    }

    /// @notice Paginated staker list, for hackathons too large to return at once.
    function getStakersPaginated(uint256 hackathonId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        _requireExists(hackathonId);

        EnumerableSet.AddressSet storage stakerSet = _stakers[hackathonId];
        total = stakerSet.length();

        if (offset >= total) return (new address[](0), total);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = stakerSet.at(i);
        }
    }

    /// @notice A participant's bond record across every hackathon.
    function getUserStakes(address user)
        external
        view
        returns (uint256[] memory hackathonIds, Stake[] memory userStakes)
    {
        hackathonIds = new uint256[](hackathonCount);
        userStakes = new Stake[](hackathonCount);

        for (uint256 i = 0; i < hackathonCount; i++) {
            hackathonIds[i] = i;
            userStakes[i] = stakes[i][user];
        }
    }

    function isWhitelisted(uint256 hackathonId, address user) external view returns (bool) {
        return whitelist[hackathonId][user];
    }

    /**
     * @notice Whether a user can stake right now, and why not if they cannot
     * @dev Mirrors every require in stake() so the UI can disable the button
     *      with a reason instead of surfacing a failed transaction.
     */
    function canUserStake(uint256 hackathonId, address user)
        external
        view
        returns (bool canStake, string memory reason)
    {
        if (hackathonId >= hackathonCount) return (false, "Hackathon does not exist");

        Hackathon storage h = hackathons[hackathonId];
        if (paused()) return (false, "Staking is paused");
        if (!h.active) return (false, "Hackathon not active");
        if (block.timestamp > h.registrationDeadline) return (false, "Registration closed");
        if (stakes[hackathonId][user].principal > 0) return (false, "Already staked");
        if (h.zkPassportRequired && !nftContract.hasNFTByAddress(user)) return (false, "Must own ZKPassport NFT");
        if (h.whitelistEnabled && !whitelist[hackathonId][user]) return (false, "Not whitelisted");
        if (h.allowedToken != address(0) && !_holdsToken(h.allowedToken, user)) {
            return (false, "Must hold required token");
        }

        return (true, "");
    }

    /**
     * @notice Whether a user can unstake right now, and why not if they cannot
     */
    function canUserUnstake(uint256 hackathonId, address user)
        external
        view
        returns (bool canUnstake, string memory reason)
    {
        if (hackathonId >= hackathonCount) return (false, "Hackathon does not exist");
        if (paused()) return (false, "Staking is paused");

        Stake storage s = stakes[hackathonId][user];
        if (s.principal == 0) return (false, "Nothing staked");
        if (s.unstaked) return (false, "Already unstaked");
        if (s.forfeited) return (false, "Stake forfeited");
        if (!s.submitted) return (false, "Submission not confirmed");

        return (true, "");
    }

    /// @notice How many stakers remain unscanned by sweepForfeited.
    function pendingForfeitCount(uint256 hackathonId) external view returns (uint256) {
        _requireExists(hackathonId);
        uint256 total = _stakers[hackathonId].length();
        uint256 cursor = forfeitCursor[hackathonId];
        return cursor >= total ? 0 : total - cursor;
    }

    /// @notice Good-actor counter: hackathons this address has submitted to.
    function getSubmissionCount(address user) external view returns (uint256) {
        return submissionCount[user];
    }

    function isAdmin(address account) external view returns (bool) {
        return hasRole(ADMIN_ROLE, account);
    }

    function isSuperAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    /**
     * @dev Only a currently attached yield strategy may push ETH in. Stray ETH is
     *      rejected so this contract's balance never drifts from tracked principal.
     */
    receive() external payable {
        require(isYieldStrategy[msg.sender], "HackathonStaking: direct ETH not accepted");
    }
}
