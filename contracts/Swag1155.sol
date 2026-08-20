// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title Swag1155
 * @notice ERC-1155 proof-of-purchase for ETH Cali merch, sold through two
 *         channels into one inventory.
 *
 * Shopify owns commerce: catalogue, fiat pricing, discount codes, customer
 * accounts, orders, fulfilment and shipping. None of that is on-chain, because
 * none of it needs to be and Shopify does it better. What Shopify cannot do is
 * prove that a specific wallet owns a specific item — that is this contract.
 *
 * ── Two channels, two buckets ────────────────────────────────────────────────
 *
 * A variant's supply is split at configuration time:
 *
 *   onchainCap  units sellable here via buy(), paid in USDC or native
 *   voucherCap  units reserved for Shopify, claimable via claim() with a
 *               signed voucher
 *
 * They are deliberately separate counters. If both channels drew from one
 * shared cap, a Shopify checkout and an on-chain buy() landing in the same
 * moment could each see "1 left" and both commit — overselling a physical
 * item that only exists once. Set Shopify's inventory for the product to
 * exactly `voucherCap` and neither channel can eat the other's stock.
 *
 * ── The Shopify path ─────────────────────────────────────────────────────────
 *
 * Order paid -> Shopify webhook -> your backend signs an EIP-712 voucher ->
 * buyer calls claim() whenever they like. No hot wallet holds a minting key,
 * no gas is spent on buyers who never claim, and `orderRef` makes a replayed
 * webhook a no-op rather than a double mint.
 *
 * @dev Clone-only. The constructor sets `_initialized = true`, so a directly
 *      deployed instance can never be configured — get instances from
 *      SwagFactory.deployCollection().
 */
contract Swag1155 is ERC1155, AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ── Constants ─────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Signs Shopify claim vouchers. Hold this on the backend, not on an admin EOA.
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");

    /// @notice Sentinel address representing the chain's native token.
    address public constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 tokenId,address to,uint256 quantity,bytes32 orderRef,uint256 deadline)"
    );

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Variant {
        uint128 onchainCap;     // Units sellable via buy()
        uint128 onchainMinted;
        uint128 voucherCap;     // Units reserved for the Shopify channel
        uint128 voucherMinted;
        bool    active;
    }

    /**
     * @notice A Shopify order, signed by the backend, redeemable once.
     * @param orderRef Hash of the Shopify order id. The idempotency key: a
     *                 replayed webhook produces the same voucher, and the
     *                 second claim reverts instead of minting again.
     */
    struct ClaimVoucher {
        uint256 tokenId;
        address to;
        uint256 quantity;
        bytes32 orderRef;
        uint256 deadline;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    bool private _initialized;

    /// @notice Receives all on-chain sale proceeds.
    address public treasury;

    mapping(uint256 => Variant) public variants;
    mapping(uint256 => string) private _tokenURIs;
    uint256[] private _tokenIds;

    /// @dev tokenId => payment token => unit price, in that token's own base units.
    mapping(uint256 => mapping(address => uint256)) public variantTokenPrice;
    mapping(uint256 => EnumerableSet.AddressSet) private _variantPaymentTokens;

    /// @dev Serial numbers, so a physical item maps to a numbered token.
    mapping(uint256 => uint256) public nextSerial;
    mapping(uint256 => mapping(uint256 => address)) public serialOwner;

    /// @dev Spent vouchers, keyed on the Shopify order reference.
    mapping(bytes32 => bool) public orderClaimed;

    // ── Events ────────────────────────────────────────────────────────────────

    event VariantSet(uint256 indexed tokenId, uint128 onchainCap, uint128 voucherCap, bool active);
    event PaymentOptionSet(uint256 indexed tokenId, address indexed token, uint256 price);
    event PaymentOptionRemoved(uint256 indexed tokenId, address indexed token);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event Purchased(
        uint256 indexed tokenId,
        address indexed buyer,
        uint256 quantity,
        address indexed paymentToken,
        uint256 paid
    );
    event Claimed(
        uint256 indexed tokenId,
        address indexed to,
        uint256 quantity,
        bytes32 indexed orderRef
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error AlreadyInitialized();
    error InvalidTreasury();
    error InvalidRecipient();
    error EmptyURI();
    error VariantNotFound(uint256 tokenId);
    error VariantNotActive(uint256 tokenId);
    error ZeroQuantity();
    error CapBelowMinted();
    error SoldOut(uint256 tokenId, uint256 remaining);
    error PaymentTokenNotAccepted(uint256 tokenId, address token);
    error IncorrectEthAmount(uint256 expected, uint256 sent);
    error EthNotAccepted();
    error EthTransferFailed();
    error VoucherExpired(uint256 deadline);
    error VoucherAlreadyClaimed(bytes32 orderRef);
    error InvalidSignature();
    error DirectEthNotAccepted();

    // ── Constructor / initializer ─────────────────────────────────────────────

    /// @dev Locks the implementation. Only clones are usable.
    constructor() ERC1155("") EIP712("ETHCaliSwag", "1") {
        _initialized = true;
    }

    function initialize(
        string memory baseURI,
        address _treasury,
        address initialAdmin
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (_treasury == address(0)) revert InvalidTreasury();

        _setURI(baseURI);
        treasury = _treasury;

        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ── Admin: roles and treasury ─────────────────────────────────────────────

    function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (admin == address(0)) revert InvalidRecipient();
        _grantRole(ADMIN_ROLE, admin);
    }

    function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ADMIN_ROLE, admin);
    }

    /// @notice Authorise a backend key to sign Shopify vouchers.
    function addSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (signer == address(0)) revert InvalidRecipient();
        _grantRole(SIGNER_ROLE, signer);
    }

    function removeSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(SIGNER_ROLE, signer);
    }

    function isAdmin(address account) external view returns (bool) {
        return hasRole(ADMIN_ROLE, account);
    }

    function isSuperAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert InvalidTreasury();
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ── Admin: variants ───────────────────────────────────────────────────────

    /**
     * @notice Create or reconfigure a variant.
     * @param onchainCap Units sellable via buy()
     * @param voucherCap Units reserved for Shopify. Set the Shopify product's
     *                   inventory to this number.
     * @dev Neither cap may be cut below what that channel has already minted —
     *      that would make `remaining` underflow and strand the counter.
     */
    function setVariant(
        uint256 tokenId,
        uint128 onchainCap,
        uint128 voucherCap,
        bool active
    ) public onlyRole(ADMIN_ROLE) {
        Variant storage v = variants[tokenId];

        if (onchainCap < v.onchainMinted || voucherCap < v.voucherMinted) revert CapBelowMinted();

        if (v.onchainCap == 0 && v.voucherCap == 0 && bytes(_tokenURIs[tokenId]).length == 0) {
            _tokenIds.push(tokenId);
        }

        v.onchainCap = onchainCap;
        v.voucherCap = voucherCap;
        v.active = active;

        emit VariantSet(tokenId, onchainCap, voucherCap, active);
    }

    function setVariantWithURI(
        uint256 tokenId,
        uint128 onchainCap,
        uint128 voucherCap,
        bool active,
        string calldata metadataURI
    ) external onlyRole(ADMIN_ROLE) {
        if (bytes(metadataURI).length == 0) revert EmptyURI();
        setVariant(tokenId, onchainCap, voucherCap, active);
        _tokenURIs[tokenId] = metadataURI;
    }

    function setBaseURI(string calldata newURI) external onlyRole(ADMIN_ROLE) {
        _setURI(newURI);
    }

    // ── Admin: pricing ────────────────────────────────────────────────────────

    /**
     * @notice Set the on-chain unit price of a variant in one payment token.
     * @param price In the token's OWN base units. USDC is 6 decimals, so 50
     *              USDC is 50_000_000 — not 50e18.
     */
    function setPaymentOption(uint256 tokenId, address token, uint256 price)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (token == address(0)) revert PaymentTokenNotAccepted(tokenId, token);
        variantTokenPrice[tokenId][token] = price;
        _variantPaymentTokens[tokenId].add(token);
        emit PaymentOptionSet(tokenId, token, price);
    }

    function removePaymentOption(uint256 tokenId, address token) external onlyRole(ADMIN_ROLE) {
        _variantPaymentTokens[tokenId].remove(token);
        delete variantTokenPrice[tokenId][token];
        emit PaymentOptionRemoved(tokenId, token);
    }

    function getPaymentTokens(uint256 tokenId) external view returns (address[] memory) {
        return _variantPaymentTokens[tokenId].values();
    }

    function getTokenPrice(uint256 tokenId, address token) external view returns (uint256) {
        if (!_variantPaymentTokens[tokenId].contains(token)) {
            revert PaymentTokenNotAccepted(tokenId, token);
        }
        return variantTokenPrice[tokenId][token];
    }

    // ── Channel 1: buy on-chain ───────────────────────────────────────────────

    /**
     * @notice Buy from the on-chain allocation, paying in an accepted token.
     * @dev Proceeds go straight to the treasury. There is no split and no
     *      balance held here, so the contract never has custody of revenue.
     */
    function buy(uint256 tokenId, uint256 quantity, address paymentToken)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        Variant storage v = variants[tokenId];
        if (v.onchainCap == 0 && v.voucherCap == 0) revert VariantNotFound(tokenId);
        if (!v.active) revert VariantNotActive(tokenId);
        if (quantity == 0) revert ZeroQuantity();

        uint256 left = v.onchainCap - v.onchainMinted;
        if (quantity > left) revert SoldOut(tokenId, left);

        if (!_variantPaymentTokens[tokenId].contains(paymentToken)) {
            revert PaymentTokenNotAccepted(tokenId, paymentToken);
        }

        uint256 total = variantTokenPrice[tokenId][paymentToken] * quantity;

        // Effects before the external calls.
        v.onchainMinted += uint128(quantity);
        _assignSerials(tokenId, msg.sender, quantity);

        if (paymentToken == ETH_TOKEN) {
            if (msg.value != total) revert IncorrectEthAmount(total, msg.value);
            (bool ok, ) = payable(treasury).call{value: total}("");
            if (!ok) revert EthTransferFailed();
        } else {
            if (msg.value != 0) revert EthNotAccepted();
            // safeTransferFrom, not transferFrom: a token that returns false
            // instead of reverting would otherwise hand out free merch.
            IERC20(paymentToken).safeTransferFrom(msg.sender, treasury, total);
        }

        _mint(msg.sender, tokenId, quantity, "");

        emit Purchased(tokenId, msg.sender, quantity, paymentToken, total);
    }

    // ── Channel 2: claim a Shopify order ──────────────────────────────────────

    /**
     * @notice Claim merch already paid for on Shopify, using a backend-signed voucher.
     * @dev The signature must come from a SIGNER_ROLE holder. `orderRef` is
     *      burned on use, so a replayed webhook cannot mint twice.
     */
    function claim(ClaimVoucher calldata voucher, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        if (block.timestamp > voucher.deadline) revert VoucherExpired(voucher.deadline);
        if (orderClaimed[voucher.orderRef]) revert VoucherAlreadyClaimed(voucher.orderRef);
        if (voucher.quantity == 0) revert ZeroQuantity();
        if (voucher.to == address(0)) revert InvalidRecipient();

        Variant storage v = variants[voucher.tokenId];
        if (v.onchainCap == 0 && v.voucherCap == 0) revert VariantNotFound(voucher.tokenId);
        if (!v.active) revert VariantNotActive(voucher.tokenId);

        uint256 left = v.voucherCap - v.voucherMinted;
        if (voucher.quantity > left) revert SoldOut(voucher.tokenId, left);

        address signer = ECDSA.recover(_hashVoucher(voucher), signature);
        if (!hasRole(SIGNER_ROLE, signer)) revert InvalidSignature();

        orderClaimed[voucher.orderRef] = true;
        v.voucherMinted += uint128(voucher.quantity);
        _assignSerials(voucher.tokenId, voucher.to, voucher.quantity);

        _mint(voucher.to, voucher.tokenId, voucher.quantity, "");

        emit Claimed(voucher.tokenId, voucher.to, voucher.quantity, voucher.orderRef);
    }

    /// @notice The EIP-712 digest a backend must sign for `voucher`.
    function hashVoucher(ClaimVoucher calldata voucher) external view returns (bytes32) {
        return _hashVoucher(voucher);
    }

    function _hashVoucher(ClaimVoucher calldata voucher) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLAIM_TYPEHASH,
                    voucher.tokenId,
                    voucher.to,
                    voucher.quantity,
                    voucher.orderRef,
                    voucher.deadline
                )
            )
        );
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _assignSerials(uint256 tokenId, address owner, uint256 quantity) internal {
        uint256 next = nextSerial[tokenId];
        for (uint256 i; i < quantity; i++) {
            serialOwner[tokenId][next + i] = owner;
        }
        nextSerial[tokenId] = next + quantity;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getVariant(uint256 tokenId) external view returns (Variant memory) {
        return variants[tokenId];
    }

    function listTokenIds() external view returns (uint256[] memory) {
        return _tokenIds;
    }

    /// @notice Units still buyable on-chain.
    function remainingOnchain(uint256 tokenId) public view returns (uint256) {
        Variant storage v = variants[tokenId];
        return v.onchainCap - v.onchainMinted;
    }

    /// @notice Units still claimable against a Shopify voucher.
    function remainingVoucher(uint256 tokenId) public view returns (uint256) {
        Variant storage v = variants[tokenId];
        return v.voucherCap - v.voucherMinted;
    }

    function totalMinted(uint256 tokenId) external view returns (uint256) {
        Variant storage v = variants[tokenId];
        return uint256(v.onchainMinted) + uint256(v.voucherMinted);
    }

    function getSerialOwner(uint256 tokenId, uint256 serial) external view returns (address) {
        return serialOwner[tokenId][serial];
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        string memory custom = _tokenURIs[tokenId];
        return bytes(custom).length > 0 ? custom : super.uri(tokenId);
    }

    /**
     * @notice Whether a purchase would succeed right now, and why not if it would not.
     * @dev Mirrors every check in buy() except the buyer's balance and
     *      allowance, which are wallet state rather than contract state.
     */
    function canBuy(uint256 tokenId, uint256 quantity, address paymentToken)
        external
        view
        returns (bool allowed, string memory reason)
    {
        Variant storage v = variants[tokenId];
        if (v.onchainCap == 0 && v.voucherCap == 0) return (false, "Variant does not exist");
        if (paused()) return (false, "Sales are paused");
        if (!v.active) return (false, "Variant not active");
        if (quantity == 0) return (false, "Quantity must be greater than zero");
        if (quantity > v.onchainCap - v.onchainMinted) return (false, "Sold out on-chain");
        if (!_variantPaymentTokens[tokenId].contains(paymentToken)) {
            return (false, "Payment token not accepted");
        }
        return (true, "");
    }

    /// @notice Whether a voucher would be claimable right now.
    function canClaim(ClaimVoucher calldata voucher, bytes calldata signature)
        external
        view
        returns (bool allowed, string memory reason)
    {
        if (block.timestamp > voucher.deadline) return (false, "Voucher expired");
        if (orderClaimed[voucher.orderRef]) return (false, "Order already claimed");
        if (voucher.quantity == 0) return (false, "Quantity must be greater than zero");
        if (voucher.to == address(0)) return (false, "Invalid recipient");

        Variant storage v = variants[voucher.tokenId];
        if (v.onchainCap == 0 && v.voucherCap == 0) return (false, "Variant does not exist");
        if (paused()) return (false, "Claims are paused");
        if (!v.active) return (false, "Variant not active");
        if (voucher.quantity > v.voucherCap - v.voucherMinted) {
            return (false, "No voucher allocation left");
        }

        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(_hashVoucher(voucher), signature);
        if (err != ECDSA.RecoverError.NoError) return (false, "Malformed signature");
        if (!hasRole(SIGNER_ROLE, signer)) return (false, "Voucher not signed by an authorised signer");

        return (true, "");
    }

    // ── Required overrides ────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /// @dev Merch is bought, not airdropped. Bare ETH would be unattributable.
    receive() external payable {
        revert DirectEthNotAccepted();
    }
}
