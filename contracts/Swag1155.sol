// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ETH Cali Swag (ERC-1155)
 * @notice Admin-managed onchain inventory for swag using ERC-1155.
 *         Users buy with USDC (6 decimals). Each size/variant is a tokenId.
 *         Supports multiple admins via AccessControl.
 */
contract Swag1155 is ERC1155, AccessControl, ReentrancyGuard {
    // Role definitions
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct Variant {
        uint256 price;      // USDC price (6 decimals)
        uint256 maxSupply;  // Total available stock
        uint256 minted;     // Already sold/minted
        bool active;        // Sale status
    }

    struct RoyaltyInfo {
        address recipient;
        uint256 percentage; // Basis points (e.g., 500 = 5%)
    }

    // Redemption status for physical swag
    enum RedemptionStatus {
        NotRedeemed,        // User hasn't claimed yet
        PendingFulfillment, // User claimed, waiting for admin to verify shipment
        Fulfilled           // Admin verified shipment complete
    }

    // Payment token (USDC)
    address public usdc;

    // Treasury receiver
    address public treasury;

    // Variants by tokenId
    mapping(uint256 => Variant) public variants;

    // Per-token metadata URIs (for dynamic product creation)
    mapping(uint256 => string) private _tokenURIs;

    // Redemption tracking: tokenId => owner => status
    mapping(uint256 => mapping(address => RedemptionStatus)) public redemptions;

    // Royalty recipients per tokenId
    mapping(uint256 => RoyaltyInfo[]) public royaltyRecipients;
    // Total royalty percentage per tokenId (sum of all royalties in basis points)
    mapping(uint256 => uint256) public totalRoyaltyBps;
    // Basis points denominator (10000 = 100%)
    uint256 public constant ROYALTY_DENOMINATOR = 10000;

    // ---------- Discount System ----------

    enum DiscountType { Percentage, Fixed }

    struct PoapDiscount {
        uint256 eventId;
        uint256 discountBps;   // basis points (1000 = 10%)
        bool active;
    }

    struct HolderDiscount {
        address token;          // ERC20/ERC721 contract address
        DiscountType discountType;
        uint256 value;          // bps for Percentage, USDC base units for Fixed
        bool active;
    }

    // Per-tokenId discount tiers
    mapping(uint256 => PoapDiscount[]) public poapDiscounts;
    mapping(uint256 => HolderDiscount[]) public holderDiscounts;

    // POAP whitelist: tokenId => eventId => address => whitelisted
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public poapWhitelist;

    // Serial numbers: tokenId => next serial to assign (1-indexed)
    mapping(uint256 => uint256) public nextSerial;
    // Serial ownership: tokenId => serial => buyer address
    mapping(uint256 => mapping(uint256 => address)) public serialOwner;

    // Track known tokenIds for optional iteration (not required but helpful)
    using EnumerableSet for EnumerableSet.UintSet;
    EnumerableSet.UintSet private _tokenIds;

    event Purchased(address indexed buyer, uint256 indexed tokenId, uint256 quantity, uint256 unitPrice, uint256 totalPrice);
    event PurchasedBatch(address indexed buyer, uint256[] tokenIds, uint256[] quantities, uint256 totalPrice);

    event VariantUpdated(uint256 indexed tokenId, uint256 price, uint256 maxSupply, bool active);
    event VariantURISet(uint256 indexed tokenId, string uri);
    event TreasuryUpdated(address indexed newTreasury);
    event USDCUpdated(address indexed newUSDC);
    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);
    event RedemptionRequested(address indexed owner, uint256 indexed tokenId);
    event RedemptionFulfilled(address indexed owner, uint256 indexed tokenId, address indexed admin);
    event RoyaltyAdded(uint256 indexed tokenId, address indexed recipient, uint256 percentage);
    event RoyaltiesCleared(uint256 indexed tokenId);
    event PoapDiscountAdded(uint256 indexed tokenId, uint256 eventId, uint256 discountBps);
    event PoapDiscountRemoved(uint256 indexed tokenId, uint256 eventId);
    event HolderDiscountAdded(uint256 indexed tokenId, address indexed token, DiscountType discountType, uint256 value);
    event HolderDiscountRemoved(uint256 indexed tokenId, address indexed token);
    event DiscountApplied(address indexed buyer, uint256 indexed tokenId, uint256 originalPrice, uint256 finalPrice);
    event PoapWhitelistUpdated(uint256 indexed tokenId, uint256 indexed eventId, address[] addresses, bool added);
    event SerialMinted(address indexed buyer, uint256 indexed tokenId, uint256 indexed serial);

    /**
     * @notice Constructor
     * @param baseURI Base URI for token metadata
     * @param _usdc USDC token address
     * @param _treasury Treasury address for payments
     * @param initialAdmin Address to set as admin (use address(0) for deployer)
     */
    constructor(
        string memory baseURI,
        address _usdc,
        address _treasury,
        address initialAdmin
    ) ERC1155(baseURI) {
        require(_usdc != address(0), "invalid USDC");
        require(_treasury != address(0), "invalid treasury");
        usdc = _usdc;
        treasury = _treasury;

        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ---------- Admin Management ----------

    /**
     * @notice Add a new admin who can manage products
     * @param admin Address to grant admin role
     */
    function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(admin != address(0), "invalid address");
        _grantRole(ADMIN_ROLE, admin);
        emit AdminAdded(admin);
    }

    /**
     * @notice Remove an admin
     * @param admin Address to revoke admin role
     */
    function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ADMIN_ROLE, admin);
        emit AdminRemoved(admin);
    }

    /**
     * @notice Check if an address is an admin
     * @param account Address to check
     */
    function isAdmin(address account) external view returns (bool) {
        return hasRole(ADMIN_ROLE, account);
    }

    /**
     * @notice Check if an address is the super admin (can add/remove admins)
     * @param account Address to check
     */
    function isSuperAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    // ---------- Product Admin (ADMIN_ROLE) ----------

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "invalid treasury");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setUSDC(address newUSDC) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newUSDC != address(0), "invalid USDC");
        usdc = newUSDC;
        emit USDCUpdated(newUSDC);
    }

    /**
     * @notice Create or update a variant for tokenId
     * @dev maxSupply must be >= current minted to avoid invalid state
     */
    function setVariant(uint256 tokenId, uint256 price, uint256 maxSupply, bool active) external onlyRole(ADMIN_ROLE) {
        Variant storage v = variants[tokenId];
        require(maxSupply >= v.minted, "maxSupply < minted");
        v.price = price;
        v.maxSupply = maxSupply;
        v.active = active;
        _tokenIds.add(tokenId);
        emit VariantUpdated(tokenId, price, maxSupply, active);
    }

    /**
     * @notice Create a variant with a per-token metadata URI (for dynamic product creation)
     * @param tokenId Unique identifier for this variant
     * @param price USDC price (6 decimals)
     * @param maxSupply Maximum supply available
     * @param active Sale status
     * @param tokenURI Full IPFS URI for this token's metadata (e.g., ipfs://Qm.../metadata.json)
     */
    function setVariantWithURI(
        uint256 tokenId,
        uint256 price,
        uint256 maxSupply,
        bool active,
        string memory tokenURI
    ) external onlyRole(ADMIN_ROLE) {
        require(bytes(tokenURI).length > 0, "invalid URI");
        Variant storage v = variants[tokenId];
        require(maxSupply >= v.minted, "maxSupply < minted");
        v.price = price;
        v.maxSupply = maxSupply;
        v.active = active;
        _tokenURIs[tokenId] = tokenURI;
        _tokenIds.add(tokenId);
        emit VariantUpdated(tokenId, price, maxSupply, active);
        emit VariantURISet(tokenId, tokenURI);
    }

    function setBaseURI(string memory newURI) external onlyRole(ADMIN_ROLE) {
        _setURI(newURI);
    }

    // ---------- Royalty Management ----------

    /**
     * @notice Add a royalty recipient for a specific token
     * @param tokenId Token ID
     * @param recipient Royalty recipient address (e.g., artist)
     * @param percentage Royalty percentage in basis points (e.g., 500 = 5%)
     */
    function addRoyalty(uint256 tokenId, address recipient, uint256 percentage) external onlyRole(ADMIN_ROLE) {
        require(recipient != address(0), "invalid recipient");
        require(percentage > 0, "percentage must be > 0");
        require(totalRoyaltyBps[tokenId] + percentage < ROYALTY_DENOMINATOR, "total royalty exceeds 100%");

        royaltyRecipients[tokenId].push(RoyaltyInfo({
            recipient: recipient,
            percentage: percentage
        }));
        totalRoyaltyBps[tokenId] += percentage;
        emit RoyaltyAdded(tokenId, recipient, percentage);
    }

    /**
     * @notice Remove all royalties for a token
     * @param tokenId Token ID
     */
    function clearRoyalties(uint256 tokenId) external onlyRole(ADMIN_ROLE) {
        delete royaltyRecipients[tokenId];
        totalRoyaltyBps[tokenId] = 0;
        emit RoyaltiesCleared(tokenId);
    }

    /**
     * @notice Get all royalty recipients for a token
     * @param tokenId Token ID
     */
    function getRoyalties(uint256 tokenId) external view returns (RoyaltyInfo[] memory) {
        return royaltyRecipients[tokenId];
    }

    // ---------- Discount Management ----------

    /**
     * @notice Add a POAP-based discount for a specific product
     * @param tokenId Product token ID
     * @param eventId POAP event ID
     * @param discountBps Discount in basis points (1000 = 10%)
     */
    function addPoapDiscount(uint256 tokenId, uint256 eventId, uint256 discountBps) external onlyRole(ADMIN_ROLE) {
        require(discountBps > 0, "discount must be > 0");
        require(discountBps <= ROYALTY_DENOMINATOR, "discount exceeds 100%");
        poapDiscounts[tokenId].push(PoapDiscount({
            eventId: eventId,
            discountBps: discountBps,
            active: true
        }));
        emit PoapDiscountAdded(tokenId, eventId, discountBps);
    }

    /**
     * @notice Remove a POAP discount tier by index
     */
    function removePoapDiscount(uint256 tokenId, uint256 index) external onlyRole(ADMIN_ROLE) {
        PoapDiscount[] storage discounts = poapDiscounts[tokenId];
        require(index < discounts.length, "invalid index");
        uint256 eventId = discounts[index].eventId;
        discounts[index] = discounts[discounts.length - 1];
        discounts.pop();
        emit PoapDiscountRemoved(tokenId, eventId);
    }

    /**
     * @notice Get all POAP discounts for a product
     */
    function getPoapDiscounts(uint256 tokenId) external view returns (PoapDiscount[] memory) {
        return poapDiscounts[tokenId];
    }

    /**
     * @notice Add addresses to the POAP whitelist for a specific product and event
     * @param tokenId Product token ID
     * @param eventId POAP event ID (organizational key)
     * @param addresses Array of addresses to whitelist (max ~100 per tx)
     */
    function addPoapWhitelist(uint256 tokenId, uint256 eventId, address[] calldata addresses) external onlyRole(ADMIN_ROLE) {
        require(addresses.length > 0, "empty addresses");
        for (uint256 i = 0; i < addresses.length; i++) {
            poapWhitelist[tokenId][eventId][addresses[i]] = true;
        }
        emit PoapWhitelistUpdated(tokenId, eventId, addresses, true);
    }

    /**
     * @notice Remove addresses from the POAP whitelist for a specific product and event
     * @param tokenId Product token ID
     * @param eventId POAP event ID (organizational key)
     * @param addresses Array of addresses to remove
     */
    function removePoapWhitelist(uint256 tokenId, uint256 eventId, address[] calldata addresses) external onlyRole(ADMIN_ROLE) {
        require(addresses.length > 0, "empty addresses");
        for (uint256 i = 0; i < addresses.length; i++) {
            poapWhitelist[tokenId][eventId][addresses[i]] = false;
        }
        emit PoapWhitelistUpdated(tokenId, eventId, addresses, false);
    }

    /**
     * @notice Check if an address is whitelisted for a POAP discount
     * @param tokenId Product token ID
     * @param eventId POAP event ID
     * @param buyer Address to check
     */
    function isPoapWhitelisted(uint256 tokenId, uint256 eventId, address buyer) external view returns (bool) {
        return poapWhitelist[tokenId][eventId][buyer];
    }

    /**
     * @notice Add a token-holder discount for a specific product
     * @param tokenId Product token ID
     * @param token ERC20/ERC721 contract address
     * @param discountType Percentage or Fixed
     * @param value Basis points for Percentage, USDC base units for Fixed
     */
    function addHolderDiscount(uint256 tokenId, address token, DiscountType discountType, uint256 value) external onlyRole(ADMIN_ROLE) {
        require(token != address(0), "invalid token");
        require(value > 0, "value must be > 0");
        if (discountType == DiscountType.Percentage) {
            require(value <= ROYALTY_DENOMINATOR, "discount exceeds 100%");
        }
        holderDiscounts[tokenId].push(HolderDiscount({
            token: token,
            discountType: discountType,
            value: value,
            active: true
        }));
        emit HolderDiscountAdded(tokenId, token, discountType, value);
    }

    /**
     * @notice Remove a holder discount tier by index
     */
    function removeHolderDiscount(uint256 tokenId, uint256 index) external onlyRole(ADMIN_ROLE) {
        HolderDiscount[] storage discounts = holderDiscounts[tokenId];
        require(index < discounts.length, "invalid index");
        address token = discounts[index].token;
        discounts[index] = discounts[discounts.length - 1];
        discounts.pop();
        emit HolderDiscountRemoved(tokenId, token);
    }

    /**
     * @notice Get all holder discounts for a product
     */
    function getHolderDiscounts(uint256 tokenId) external view returns (HolderDiscount[] memory) {
        return holderDiscounts[tokenId];
    }

    /**
     * @notice Calculate discounted price for a buyer (additive stacking)
     * @param tokenId Product token ID
     * @param buyer Buyer address
     * @return finalPrice The price after all applicable discounts
     */
    function getDiscountedPrice(uint256 tokenId, address buyer) public view returns (uint256 finalPrice) {
        uint256 basePrice = variants[tokenId].price;
        if (basePrice == 0) return 0;

        uint256 totalDiscountBps = 0;
        uint256 fixedDiscount = 0;

        // Check POAP discounts (additive) — uses address whitelist
        PoapDiscount[] storage poaps = poapDiscounts[tokenId];
        for (uint256 i = 0; i < poaps.length; i++) {
            if (!poaps[i].active) continue;
            if (poapWhitelist[tokenId][poaps[i].eventId][buyer]) {
                totalDiscountBps += poaps[i].discountBps;
            }
        }

        // Check holder discounts (additive)
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

        // Apply additive discount (cap at 100%)
        if (totalDiscountBps >= ROYALTY_DENOMINATOR) {
            return 0;
        }
        uint256 percentOff = (basePrice * totalDiscountBps) / ROYALTY_DENOMINATOR;
        finalPrice = basePrice - percentOff;
        finalPrice = finalPrice > fixedDiscount ? finalPrice - fixedDiscount : 0;
        return finalPrice;
    }

    // ---------- Views ----------

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

    /**
     * @notice Look up which address owns a specific serial number
     * @param tokenId The variant/size token ID
     * @param serial The serial number (1-indexed, assigned at mint time)
     * @return The buyer address that owns this serial, address(0) if not minted
     */
    function getSerialOwner(uint256 tokenId, uint256 serial) external view returns (address) {
        return serialOwner[tokenId][serial];
    }

    /**
     * @notice Get metadata URI for a token (per-token or baseURI fallback)
     * @dev Returns per-token URI if set, otherwise uses baseURI
     */
    function uri(uint256 tokenId) public view override returns (string memory) {
        string memory tokenURI = _tokenURIs[tokenId];
        if (bytes(tokenURI).length > 0) {
            return tokenURI;
        }
        return super.uri(tokenId);
    }

    /**
     * @notice Get redemption status for a specific owner and tokenId
     */
    function getRedemptionStatus(uint256 tokenId, address owner) external view returns (RedemptionStatus) {
        return redemptions[tokenId][owner];
    }

    // ---------- Redemption ----------

    /**
     * @notice User requests redemption of physical swag for their NFT
     * @dev User must own at least 1 of the tokenId. Shipping info collected off-chain.
     */
    function redeem(uint256 tokenId) external {
        require(balanceOf(msg.sender, tokenId) > 0, "not owner");
        require(redemptions[tokenId][msg.sender] == RedemptionStatus.NotRedeemed, "already redeemed");

        redemptions[tokenId][msg.sender] = RedemptionStatus.PendingFulfillment;
        emit RedemptionRequested(msg.sender, tokenId);
    }

    /**
     * @notice Admin marks redemption as fulfilled after verifying shipment
     * @param tokenId The token being redeemed
     * @param owner The address that requested redemption
     */
    function markFulfilled(uint256 tokenId, address owner) external onlyRole(ADMIN_ROLE) {
        require(redemptions[tokenId][owner] == RedemptionStatus.PendingFulfillment, "not pending");

        redemptions[tokenId][owner] = RedemptionStatus.Fulfilled;
        emit RedemptionFulfilled(owner, tokenId, msg.sender);
    }

    // ---------- Purchases ----------

    function buy(uint256 tokenId, uint256 quantity) external nonReentrant {
        require(quantity > 0, "invalid quantity");
        Variant storage v = variants[tokenId];
        require(v.active, "variant inactive");
        require(v.minted + quantity <= v.maxSupply, "exceeds supply");

        uint256 unitPrice = getDiscountedPrice(tokenId, msg.sender);
        uint256 total = unitPrice * quantity;
        if (total > 0) {
            _distributePayment(tokenId, total);
        }

        v.minted += quantity;
        _mint(msg.sender, tokenId, quantity, "");

        // Assign a unique serial number to each unit purchased
        for (uint256 s = 0; s < quantity; s++) {
            uint256 serial = ++nextSerial[tokenId];
            serialOwner[tokenId][serial] = msg.sender;
            emit SerialMinted(msg.sender, tokenId, serial);
        }

        emit Purchased(msg.sender, tokenId, quantity, unitPrice, total);
        if (unitPrice < v.price) {
            emit DiscountApplied(msg.sender, tokenId, v.price, unitPrice);
        }
    }

    function buyBatch(uint256[] calldata tokenIds, uint256[] calldata quantities) external nonReentrant {
        require(tokenIds.length == quantities.length, "length mismatch");
        uint256 len = tokenIds.length;
        require(len > 0, "empty batch");

        uint256 grandTotal = 0;
        for (uint256 i = 0; i < len; i++) {
            uint256 tokenId = tokenIds[i];
            uint256 qty = quantities[i];
            require(qty > 0, "invalid quantity");
            Variant storage v = variants[tokenId];
            require(v.active, "variant inactive");
            require(v.minted + qty <= v.maxSupply, "exceeds supply");
            uint256 unitPrice = getDiscountedPrice(tokenId, msg.sender);
            uint256 itemTotal = unitPrice * qty;
            grandTotal += itemTotal;
            if (itemTotal > 0) {
                _distributePayment(tokenId, itemTotal);
            }
        }

        // Update supply and mint
        for (uint256 i = 0; i < len; i++) {
            Variant storage v2 = variants[tokenIds[i]];
            v2.minted += quantities[i];
        }
        _mintBatch(msg.sender, tokenIds, quantities, "");

        // Assign serial numbers for every unit in the batch
        for (uint256 i = 0; i < len; i++) {
            for (uint256 s = 0; s < quantities[i]; s++) {
                uint256 serial = ++nextSerial[tokenIds[i]];
                serialOwner[tokenIds[i]][serial] = msg.sender;
                emit SerialMinted(msg.sender, tokenIds[i], serial);
            }
        }

        emit PurchasedBatch(msg.sender, tokenIds, quantities, grandTotal);
    }

    /**
     * @dev Distribute payment: royalties to recipients, remainder to treasury
     */
    function _distributePayment(uint256 tokenId, uint256 total) internal {
        uint256 royaltyPaid = 0;
        RoyaltyInfo[] storage recipients = royaltyRecipients[tokenId];
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amount = (total * recipients[i].percentage) / ROYALTY_DENOMINATOR;
            if (amount > 0) {
                IERC20(usdc).transferFrom(msg.sender, recipients[i].recipient, amount);
                royaltyPaid += amount;
            }
        }
        // Remainder goes to treasury
        uint256 treasuryAmount = total - royaltyPaid;
        if (treasuryAmount > 0) {
            IERC20(usdc).transferFrom(msg.sender, treasury, treasuryAmount);
        }
    }

    // ---------- Required Overrides ----------

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
