// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ETH Cali Swag (ERC-1155)
 * @notice One contract per physical product. Sizes/variants are tokenIds (1-indexed).
 *         Deployed exclusively via SwagFactory.deployCollection().
 *
 *         Payment model:
 *         - Admin sets a price per tokenId per payment token via setPaymentOption().
 *         - Accepted tokens: any ERC-20 (USDC, USDT, DAI, WETH, ...) or native ETH.
 *         - Native ETH uses the sentinel address ETH_TOKEN = 0xEeee...EEeE.
 *         - Prices are denominated in each token's own base units.
 *         - Discounts (POAP + holder) stack additively and apply to whichever token is used.
 */
contract Swag1155 is ERC1155, AccessControl, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ── Constants ─────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Sentinel address representing native ETH as a payment token.
    address public constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    uint256 public constant ROYALTY_DENOMINATOR = 10000;

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Variant {
        uint256 maxSupply;
        uint256 minted;
        bool    active;
    }

    struct RoyaltyInfo {
        address recipient;
        uint256 percentage; // Basis points (e.g. 500 = 5%)
    }

    enum RedemptionStatus {
        NotRedeemed,        // 0 - User has not claimed yet
        PendingFulfillment, // 1 - User claimed, waiting for admin to verify shipment
        Fulfilled           // 2 - Admin verified shipment complete
    }

    enum DiscountType { Percentage, Fixed }

    struct PoapDiscount {
        uint256 eventId;
        uint256 discountBps; // Basis points (1000 = 10%)
        bool    active;
    }

    struct HolderDiscount {
        address      token;        // ERC-20 or ERC-721 contract
        DiscountType discountType;
        uint256      value;        // bps for Percentage; payment-token base units for Fixed
        bool         active;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /// @dev Guards the initialize() function — true on the implementation contract itself.
    bool private _initialized;

    address public treasury;

    // Variant inventory per tokenId
    mapping(uint256 => Variant) public variants;

    // Per-token metadata URIs
    mapping(uint256 => string) private _tokenURIs;

    // Redemption status: tokenId => owner => status
    mapping(uint256 => mapping(address => RedemptionStatus)) public redemptions;

    // Payment options:
    //   variantTokenPrice[tokenId][paymentToken] = price in that token's base units
    //   0 means the token is not accepted for that variant.
    mapping(uint256 => mapping(address => uint256)) public variantTokenPrice;

    // Enumerable set of accepted payment tokens per tokenId (for frontend enumeration)
    mapping(uint256 => EnumerableSet.AddressSet) private _variantPaymentTokens;

    // Royalties per tokenId
    mapping(uint256 => RoyaltyInfo[]) public royaltyRecipients;
    mapping(uint256 => uint256)       public totalRoyaltyBps;

    // POAP discounts per tokenId
    mapping(uint256 => PoapDiscount[]) public poapDiscounts;

    // Token-holder discounts per tokenId
    mapping(uint256 => HolderDiscount[]) public holderDiscounts;

    // POAP whitelist: tokenId => eventId => address => whitelisted
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public poapWhitelist;

    // Serial numbers: tokenId => next serial (1-indexed)
    mapping(uint256 => uint256)                         public nextSerial;
    mapping(uint256 => mapping(uint256 => address))     public serialOwner;

    // Known tokenIds for iteration
    EnumerableSet.UintSet private _tokenIds;

    // ── Events ────────────────────────────────────────────────────────────────

    event Purchased(
        address indexed buyer,
        uint256 indexed tokenId,
        uint256 quantity,
        address indexed paymentToken,
        uint256 unitPrice,
        uint256 totalPrice
    );
    event PurchasedBatch(
        address indexed buyer,
        uint256[] tokenIds,
        uint256[] quantities,
        address indexed paymentToken,
        uint256 totalPrice
    );

    event VariantUpdated(uint256 indexed tokenId, uint256 maxSupply, bool active);
    event VariantURISet(uint256 indexed tokenId, string uri);
    event TreasuryUpdated(address indexed newTreasury);
    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);

    event PaymentOptionSet(uint256 indexed tokenId, address indexed token, uint256 price);
    event PaymentOptionRemoved(uint256 indexed tokenId, address indexed token);

    event RedemptionRequested(address indexed owner, uint256 indexed tokenId);
    event RedemptionFulfilled(address indexed owner, uint256 indexed tokenId, address indexed admin);

    event RoyaltyAdded(uint256 indexed tokenId, address indexed recipient, uint256 percentage);
    event RoyaltiesCleared(uint256 indexed tokenId);

    event PoapDiscountAdded(uint256 indexed tokenId, uint256 eventId, uint256 discountBps);
    event PoapDiscountRemoved(uint256 indexed tokenId, uint256 eventId);
    event HolderDiscountAdded(uint256 indexed tokenId, address indexed token, DiscountType discountType, uint256 value);
    event HolderDiscountRemoved(uint256 indexed tokenId, address indexed token);
    event DiscountApplied(address indexed buyer, uint256 indexed tokenId, address paymentToken, uint256 originalPrice, uint256 finalPrice);
    event PoapWhitelistUpdated(uint256 indexed tokenId, uint256 indexed eventId, address[] addresses, bool added);

    event SerialMinted(address indexed buyer, uint256 indexed tokenId, uint256 indexed serial);

    // ── Constructor / Initializer ─────────────────────────────────────────────

    /**
     * @dev Locks the implementation contract against initialization.
     *      Each clone deployed by SwagFactory has its own storage, so clones
     *      start with _initialized = false and must call initialize().
     */
    constructor() ERC1155("") {
        _initialized = true; // prevent direct initialization of the implementation
    }

    /**
     * @notice Initialize a clone deployed by SwagFactory.
     *         Called once immediately after Clones.clone().
     * @param baseURI      Base URI for token metadata (per-token URIs override this)
     * @param _treasury    Address receiving sale proceeds
     * @param initialAdmin Address granted DEFAULT_ADMIN_ROLE + ADMIN_ROLE
     */
    function initialize(
        string memory baseURI,
        address _treasury,
        address initialAdmin
    ) external {
        require(!_initialized, "already initialized");
        _initialized = true;
        _setURI(baseURI);
        require(_treasury != address(0), "invalid treasury");
        treasury = _treasury;
        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ── Admin Management ──────────────────────────────────────────────────────

    function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(admin != address(0), "invalid address");
        _grantRole(ADMIN_ROLE, admin);
        emit AdminAdded(admin);
    }

    function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ADMIN_ROLE, admin);
        emit AdminRemoved(admin);
    }

    function isAdmin(address account) external view returns (bool) {
        return hasRole(ADMIN_ROLE, account);
    }

    function isSuperAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "invalid treasury");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    // ── Variant Management ────────────────────────────────────────────────────

    /**
     * @notice Create or update a variant (supply + active flag).
     *         Use setPaymentOption() separately to configure accepted tokens and prices.
     */
    function setVariant(uint256 tokenId, uint256 maxSupply, bool active) external onlyRole(ADMIN_ROLE) {
        Variant storage v = variants[tokenId];
        require(maxSupply >= v.minted, "maxSupply < minted");
        v.maxSupply = maxSupply;
        v.active    = active;
        _tokenIds.add(tokenId);
        emit VariantUpdated(tokenId, maxSupply, active);
    }

    /**
     * @notice Create or update a variant with a per-token metadata URI.
     */
    function setVariantWithURI(
        uint256 tokenId,
        uint256 maxSupply,
        bool    active,
        string memory tokenURI
    ) external onlyRole(ADMIN_ROLE) {
        require(bytes(tokenURI).length > 0, "invalid URI");
        Variant storage v = variants[tokenId];
        require(maxSupply >= v.minted, "maxSupply < minted");
        v.maxSupply        = maxSupply;
        v.active           = active;
        _tokenURIs[tokenId] = tokenURI;
        _tokenIds.add(tokenId);
        emit VariantUpdated(tokenId, maxSupply, active);
        emit VariantURISet(tokenId, tokenURI);
    }

    function setBaseURI(string memory newURI) external onlyRole(ADMIN_ROLE) {
        _setURI(newURI);
    }

    // ── Payment Options ───────────────────────────────────────────────────────

    /**
     * @notice Set or update the price for a specific payment token on a variant.
     * @param tokenId       Variant token ID
     * @param token         ERC-20 address, or ETH_TOKEN (0xEeee...EEeE) for native ETH
     * @param price         Price in that token's base units (e.g. 25_000_000 for 25 USDC)
     */
    function setPaymentOption(uint256 tokenId, address token, uint256 price) external onlyRole(ADMIN_ROLE) {
        require(token != address(0), "invalid token");
        require(price > 0, "price must be > 0");
        variantTokenPrice[tokenId][token] = price;
        _variantPaymentTokens[tokenId].add(token);
        emit PaymentOptionSet(tokenId, token, price);
    }

    /**
     * @notice Remove a payment token from a variant (token no longer accepted).
     */
    function removePaymentOption(uint256 tokenId, address token) external onlyRole(ADMIN_ROLE) {
        require(_variantPaymentTokens[tokenId].contains(token), "not a payment option");
        delete variantTokenPrice[tokenId][token];
        _variantPaymentTokens[tokenId].remove(token);
        emit PaymentOptionRemoved(tokenId, token);
    }

    /**
     * @notice Get all accepted payment tokens and their prices for a variant.
     * @return tokens  Array of accepted token addresses (ETH_TOKEN for native ETH)
     * @return prices  Corresponding prices in each token's base units
     */
    function getPaymentOptions(uint256 tokenId)
        external view
        returns (address[] memory tokens, uint256[] memory prices)
    {
        uint256 len = _variantPaymentTokens[tokenId].length();
        tokens = new address[](len);
        prices = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            tokens[i] = _variantPaymentTokens[tokenId].at(i);
            prices[i] = variantTokenPrice[tokenId][tokens[i]];
        }
    }

    /**
     * @notice Get the price for a specific token on a variant (0 = not accepted).
     */
    function getTokenPrice(uint256 tokenId, address token) external view returns (uint256) {
        return variantTokenPrice[tokenId][token];
    }

    // ── Royalty Management ────────────────────────────────────────────────────

    function addRoyalty(uint256 tokenId, address recipient, uint256 percentage) external onlyRole(ADMIN_ROLE) {
        require(recipient != address(0), "invalid recipient");
        require(percentage > 0, "percentage must be > 0");
        require(totalRoyaltyBps[tokenId] + percentage < ROYALTY_DENOMINATOR, "total royalty exceeds 100%");
        royaltyRecipients[tokenId].push(RoyaltyInfo({ recipient: recipient, percentage: percentage }));
        totalRoyaltyBps[tokenId] += percentage;
        emit RoyaltyAdded(tokenId, recipient, percentage);
    }

    function clearRoyalties(uint256 tokenId) external onlyRole(ADMIN_ROLE) {
        delete royaltyRecipients[tokenId];
        totalRoyaltyBps[tokenId] = 0;
        emit RoyaltiesCleared(tokenId);
    }

    function getRoyalties(uint256 tokenId) external view returns (RoyaltyInfo[] memory) {
        return royaltyRecipients[tokenId];
    }

    // ── Discount Management ───────────────────────────────────────────────────

    function addPoapDiscount(uint256 tokenId, uint256 eventId, uint256 discountBps) external onlyRole(ADMIN_ROLE) {
        require(discountBps > 0, "discount must be > 0");
        require(discountBps <= ROYALTY_DENOMINATOR, "discount exceeds 100%");
        poapDiscounts[tokenId].push(PoapDiscount({ eventId: eventId, discountBps: discountBps, active: true }));
        emit PoapDiscountAdded(tokenId, eventId, discountBps);
    }

    function removePoapDiscount(uint256 tokenId, uint256 index) external onlyRole(ADMIN_ROLE) {
        PoapDiscount[] storage discounts = poapDiscounts[tokenId];
        require(index < discounts.length, "invalid index");
        uint256 eventId = discounts[index].eventId;
        discounts[index] = discounts[discounts.length - 1];
        discounts.pop();
        emit PoapDiscountRemoved(tokenId, eventId);
    }

    function getPoapDiscounts(uint256 tokenId) external view returns (PoapDiscount[] memory) {
        return poapDiscounts[tokenId];
    }

    function addPoapWhitelist(uint256 tokenId, uint256 eventId, address[] calldata addresses) external onlyRole(ADMIN_ROLE) {
        require(addresses.length > 0, "empty addresses");
        for (uint256 i = 0; i < addresses.length; i++) {
            poapWhitelist[tokenId][eventId][addresses[i]] = true;
        }
        emit PoapWhitelistUpdated(tokenId, eventId, addresses, true);
    }

    function removePoapWhitelist(uint256 tokenId, uint256 eventId, address[] calldata addresses) external onlyRole(ADMIN_ROLE) {
        require(addresses.length > 0, "empty addresses");
        for (uint256 i = 0; i < addresses.length; i++) {
            poapWhitelist[tokenId][eventId][addresses[i]] = false;
        }
        emit PoapWhitelistUpdated(tokenId, eventId, addresses, false);
    }

    function isPoapWhitelisted(uint256 tokenId, uint256 eventId, address buyer) external view returns (bool) {
        return poapWhitelist[tokenId][eventId][buyer];
    }

    function addHolderDiscount(uint256 tokenId, address token, DiscountType discountType, uint256 value) external onlyRole(ADMIN_ROLE) {
        require(token != address(0), "invalid token");
        require(value > 0, "value must be > 0");
        if (discountType == DiscountType.Percentage) {
            require(value <= ROYALTY_DENOMINATOR, "discount exceeds 100%");
        }
        holderDiscounts[tokenId].push(HolderDiscount({ token: token, discountType: discountType, value: value, active: true }));
        emit HolderDiscountAdded(tokenId, token, discountType, value);
    }

    function removeHolderDiscount(uint256 tokenId, uint256 index) external onlyRole(ADMIN_ROLE) {
        HolderDiscount[] storage discounts = holderDiscounts[tokenId];
        require(index < discounts.length, "invalid index");
        address token = discounts[index].token;
        discounts[index] = discounts[discounts.length - 1];
        discounts.pop();
        emit HolderDiscountRemoved(tokenId, token);
    }

    function getHolderDiscounts(uint256 tokenId) external view returns (HolderDiscount[] memory) {
        return holderDiscounts[tokenId];
    }

    /**
     * @notice Calculate the discounted price for a buyer paying with a specific token.
     * @param tokenId      Variant token ID
     * @param buyer        Buyer address (used to check POAP whitelist and token holdings)
     * @param paymentToken Payment token address (or ETH_TOKEN for native ETH)
     * @return finalPrice  Price after all applicable discounts, in paymentToken's base units
     */
    function getDiscountedPrice(uint256 tokenId, address buyer, address paymentToken)
        public view
        returns (uint256 finalPrice)
    {
        uint256 basePrice = variantTokenPrice[tokenId][paymentToken];
        if (basePrice == 0) return 0;

        uint256 totalDiscountBps = 0;
        uint256 fixedDiscount    = 0;

        // POAP discounts (additive) — address whitelist
        PoapDiscount[] storage poaps = poapDiscounts[tokenId];
        for (uint256 i = 0; i < poaps.length; i++) {
            if (!poaps[i].active) continue;
            if (poapWhitelist[tokenId][poaps[i].eventId][buyer]) {
                totalDiscountBps += poaps[i].discountBps;
            }
        }

        // Holder discounts (additive)
        HolderDiscount[] storage holders = holderDiscounts[tokenId];
        for (uint256 i = 0; i < holders.length; i++) {
            if (!holders[i].active) continue;
            uint256 balance;
            try IERC721(holders[i].token).balanceOf(buyer) returns (uint256 bal) {
                balance = bal;
            } catch {
                try IERC20(holders[i].token).balanceOf(buyer) returns (uint256 bal) {
                    balance = bal;
                } catch { continue; }
            }
            if (balance > 0) {
                if (holders[i].discountType == DiscountType.Percentage) {
                    totalDiscountBps += holders[i].value;
                } else {
                    fixedDiscount += holders[i].value;
                }
            }
        }

        // Apply percentage discounts (cap at 100%)
        if (totalDiscountBps >= ROYALTY_DENOMINATOR) return 0;
        uint256 percentOff = (basePrice * totalDiscountBps) / ROYALTY_DENOMINATOR;
        finalPrice = basePrice - percentOff;

        // Apply fixed discounts (floor at 0)
        finalPrice = finalPrice > fixedDiscount ? finalPrice - fixedDiscount : 0;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function remaining(uint256 tokenId) public view returns (uint256) {
        Variant memory v = variants[tokenId];
        if (v.maxSupply <= v.minted) return 0;
        return v.maxSupply - v.minted;
    }

    function getVariant(uint256 tokenId) external view returns (Variant memory) {
        return variants[tokenId];
    }

    function listTokenIds() external view returns (uint256[] memory) {
        return _tokenIds.values();
    }

    function getSerialOwner(uint256 tokenId, uint256 serial) external view returns (address) {
        return serialOwner[tokenId][serial];
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        string memory tokenURI = _tokenURIs[tokenId];
        if (bytes(tokenURI).length > 0) return tokenURI;
        return super.uri(tokenId);
    }

    function getRedemptionStatus(uint256 tokenId, address owner) external view returns (RedemptionStatus) {
        return redemptions[tokenId][owner];
    }

    // ── Redemption ────────────────────────────────────────────────────────────

    function redeem(uint256 tokenId) external {
        require(balanceOf(msg.sender, tokenId) > 0, "not owner");
        require(redemptions[tokenId][msg.sender] == RedemptionStatus.NotRedeemed, "already redeemed");
        redemptions[tokenId][msg.sender] = RedemptionStatus.PendingFulfillment;
        emit RedemptionRequested(msg.sender, tokenId);
    }

    function markFulfilled(uint256 tokenId, address owner) external onlyRole(ADMIN_ROLE) {
        require(redemptions[tokenId][owner] == RedemptionStatus.PendingFulfillment, "not pending");
        redemptions[tokenId][owner] = RedemptionStatus.Fulfilled;
        emit RedemptionFulfilled(owner, tokenId, msg.sender);
    }

    // ── Purchases ─────────────────────────────────────────────────────────────

    /**
     * @notice Purchase a single variant.
     * @param tokenId       Variant to purchase
     * @param quantity      Number of units
     * @param paymentToken  Token to pay with (ERC-20 address or ETH_TOKEN for native ETH)
     *
     * For ERC-20: caller must have approved this contract for the total discounted amount.
     * For ETH:    caller must send >= total discounted amount as msg.value; excess is refunded.
     */
    function buy(uint256 tokenId, uint256 quantity, address paymentToken) external payable nonReentrant {
        require(quantity > 0, "invalid quantity");
        Variant storage v = variants[tokenId];
        require(v.active, "variant inactive");
        require(v.minted + quantity <= v.maxSupply, "exceeds supply");
        require(variantTokenPrice[tokenId][paymentToken] > 0, "token not accepted");

        if (paymentToken != ETH_TOKEN) {
            require(msg.value == 0, "ETH not accepted for ERC20 payment");
        }

        uint256 unitPrice = getDiscountedPrice(tokenId, msg.sender, paymentToken);
        uint256 total     = unitPrice * quantity;

        if (paymentToken == ETH_TOKEN) {
            require(msg.value >= total, "insufficient ETH");
            if (total > 0) _distributePaymentETH(tokenId, total);
            uint256 excess = msg.value - total;
            if (excess > 0) {
                (bool ok,) = msg.sender.call{value: excess}("");
                require(ok, "ETH refund failed");
            }
        } else {
            if (total > 0) _distributePaymentERC20(tokenId, total, paymentToken);
        }

        v.minted += quantity;
        _mint(msg.sender, tokenId, quantity, "");

        for (uint256 s = 0; s < quantity; s++) {
            uint256 serial = ++nextSerial[tokenId];
            serialOwner[tokenId][serial] = msg.sender;
            emit SerialMinted(msg.sender, tokenId, serial);
        }

        emit Purchased(msg.sender, tokenId, quantity, paymentToken, unitPrice, total);
        if (unitPrice < variantTokenPrice[tokenId][paymentToken]) {
            emit DiscountApplied(msg.sender, tokenId, paymentToken, variantTokenPrice[tokenId][paymentToken], unitPrice);
        }
    }

    /**
     * @notice Purchase multiple variants in one transaction.
     *         All items in the batch must use the same paymentToken.
     */
    function buyBatch(
        uint256[] calldata tokenIds,
        uint256[] calldata quantities,
        address paymentToken
    ) external payable nonReentrant {
        require(tokenIds.length == quantities.length, "length mismatch");
        uint256 len = tokenIds.length;
        require(len > 0, "empty batch");
        require(variantTokenPrice[tokenIds[0]][paymentToken] > 0, "token not accepted");

        if (paymentToken != ETH_TOKEN) {
            require(msg.value == 0, "ETH not accepted for ERC20 payment");
        }

        uint256 grandTotal = 0;
        for (uint256 i = 0; i < len; i++) {
            uint256 tid = tokenIds[i];
            uint256 qty = quantities[i];
            require(qty > 0, "invalid quantity");
            Variant storage v = variants[tid];
            require(v.active, "variant inactive");
            require(v.minted + qty <= v.maxSupply, "exceeds supply");
            require(variantTokenPrice[tid][paymentToken] > 0, "token not accepted");
            uint256 unitPrice = getDiscountedPrice(tid, msg.sender, paymentToken);
            grandTotal += unitPrice * qty;
        }

        if (paymentToken == ETH_TOKEN) {
            require(msg.value >= grandTotal, "insufficient ETH");
        }

        // Distribute per-item (preserves royalty splits per tokenId)
        for (uint256 i = 0; i < len; i++) {
            uint256 tid       = tokenIds[i];
            uint256 qty       = quantities[i];
            uint256 unitPrice = getDiscountedPrice(tid, msg.sender, paymentToken);
            uint256 itemTotal = unitPrice * qty;
            if (itemTotal > 0) {
                if (paymentToken == ETH_TOKEN) {
                    _distributePaymentETH(tid, itemTotal);
                } else {
                    _distributePaymentERC20(tid, itemTotal, paymentToken);
                }
            }
        }

        // Update supply and mint
        for (uint256 i = 0; i < len; i++) {
            variants[tokenIds[i]].minted += quantities[i];
        }
        _mintBatch(msg.sender, tokenIds, quantities, "");

        // Assign serial numbers
        for (uint256 i = 0; i < len; i++) {
            for (uint256 s = 0; s < quantities[i]; s++) {
                uint256 serial = ++nextSerial[tokenIds[i]];
                serialOwner[tokenIds[i]][serial] = msg.sender;
                emit SerialMinted(msg.sender, tokenIds[i], serial);
            }
        }

        // Refund excess ETH
        if (paymentToken == ETH_TOKEN && msg.value > grandTotal) {
            (bool ok,) = msg.sender.call{value: msg.value - grandTotal}("");
            require(ok, "ETH refund failed");
        }

        emit PurchasedBatch(msg.sender, tokenIds, quantities, paymentToken, grandTotal);
    }

    // ── Internal: Payment Distribution ───────────────────────────────────────

    /**
     * @dev Distribute native ETH: royalties to recipients, remainder to treasury.
     *      ETH must already be held by this contract (sent via buy/buyBatch msg.value).
     */
    function _distributePaymentETH(uint256 tokenId, uint256 total) internal {
        uint256 royaltyPaid = 0;
        RoyaltyInfo[] storage recipients = royaltyRecipients[tokenId];
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amount = (total * recipients[i].percentage) / ROYALTY_DENOMINATOR;
            if (amount > 0) {
                (bool ok,) = recipients[i].recipient.call{value: amount}("");
                require(ok, "ETH royalty transfer failed");
                royaltyPaid += amount;
            }
        }
        uint256 treasuryAmount = total - royaltyPaid;
        if (treasuryAmount > 0) {
            (bool ok,) = treasury.call{value: treasuryAmount}("");
            require(ok, "ETH treasury transfer failed");
        }
    }

    /**
     * @dev Distribute ERC-20: royalties to recipients, remainder to treasury.
     *      Uses transferFrom — caller must have approved this contract.
     */
    function _distributePaymentERC20(uint256 tokenId, uint256 total, address token) internal {
        uint256 royaltyPaid = 0;
        RoyaltyInfo[] storage recipients = royaltyRecipients[tokenId];
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amount = (total * recipients[i].percentage) / ROYALTY_DENOMINATOR;
            if (amount > 0) {
                IERC20(token).transferFrom(msg.sender, recipients[i].recipient, amount);
                royaltyPaid += amount;
            }
        }
        uint256 treasuryAmount = total - royaltyPaid;
        if (treasuryAmount > 0) {
            IERC20(token).transferFrom(msg.sender, treasury, treasuryAmount);
        }
    }

    // ── Required Overrides ────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
