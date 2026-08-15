// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./Swag1155.sol";

/**
 * @title SwagFactory
 * @notice Factory that deploys one Swag1155 per product item.
 *         Each item lives in its own contract; sizes/variants are tokenIds (1-indexed).
 *
 * deployCollection flow:
 *   1. Factory deploys Swag1155 with itself as initialAdmin.
 *   2. Factory calls setVariantWithURI for each size (tokenId = index + 1).
 *   3. Factory grants itemAdmin DEFAULT_ADMIN_ROLE + ADMIN_ROLE on the Swag1155.
 *   4. Factory renounces its own roles on the Swag1155 — itemAdmin has sole control.
 *   5. Factory registers the collection in its own registry and emits CollectionDeployed.
 */
contract SwagFactory is AccessControl {
    using Clones for address;

    // ── Roles ────────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ── Structs ───────────────────────────────────────────────────────────────

    /// @notice A single payment option: one token + its price in that token's base units.
    struct PaymentOption {
        address token; // ERC-20 address, or Swag1155.ETH_TOKEN (0xEeee...EEeE) for native ETH
        uint256 price; // Price in that token's base units (e.g. 25_000_000 for 25 USDC)
    }

    /// @notice Metadata stored in the factory registry per deployed collection.
    struct CollectionMeta {
        string  name;         // Human-readable product name, e.g. "ETH Cali Hoodie"
        string  sku;          // Internal SKU, e.g. "ETH-CALI-HOODIE-2025"
        address treasury;     // Where sale proceeds are sent
        address creator;      // msg.sender at deployCollection time
        uint256 deployedAt;   // block.timestamp at deploy
        uint256 variantCount; // Number of sizes (tokenIds)
        bool    active;       // Factory-level toggle (does not affect the Swag1155 itself)
    }

    /// @notice Input descriptor for one size variant supplied to deployCollection.
    struct VariantInit {
        string          metadataURI; // Full IPFS URI for this size's metadata
        uint256         maxSupply;   // Maximum inventory for this size
        bool            active;      // Whether this size is purchasable at launch
        PaymentOption[] payments;    // One entry per accepted payment token + price
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Reference implementation cloned for each new product collection.
    address public immutable implementation;

    /// @dev Ordered list of every deployed Swag1155 address.
    address[] public collections;

    /// @dev O(1) membership check.
    mapping(address => bool) public isCollection;

    /// @dev Registry metadata for each deployed collection.
    mapping(address => CollectionMeta) public collectionMeta;

    // ── Events ────────────────────────────────────────────────────────────────

    event CollectionDeployed(
        address indexed collection,
        string  name,
        string  sku,
        address treasury,
        uint256 variantCount,
        address indexed creator
    );

    event CollectionStatusChanged(address indexed collection, bool active);

    // ── Custom errors ─────────────────────────────────────────────────────────

    error InvalidAdmin();
    error InvalidTreasury();
    error InvalidItemAdmin();
    error InvalidAddress();
    error EmptyName();
    error EmptySku();
    error NoSizes();
    error NoPaymentOptions();
    error NotACollection();

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param admin           Address that receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
     * @param _implementation Address of the deployed Swag1155 reference implementation.
     *                        Each collection is an EIP-1167 minimal clone of this contract.
     */
    constructor(address admin, address _implementation) {
        if (admin == address(0)) revert InvalidAdmin();
        if (_implementation == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        implementation = _implementation;
    }

    // ── Core: Deploy a collection ─────────────────────────────────────────────

    /**
     * @notice Deploy a new Swag1155 product with all sizes and payment options configured atomically.
     *
     * @param name      Human-readable product name ("ETH Cali Hoodie").
     * @param sku       Internal SKU identifier ("ETH-CALI-HOODIE-2025").
     * @param treasury  Address that receives sale proceeds.
     * @param itemAdmin Address that will own and manage the deployed Swag1155.
     * @param sizes     Array of VariantInit structs.  tokenId = array index + 1.
     *                  Each size includes its own PaymentOption[] (token + price per token).
     * @return swagAddr Address of the newly deployed Swag1155.
     */
    function deployCollection(
        string        calldata name,
        string        calldata sku,
        address                treasury,
        address                itemAdmin,
        VariantInit[] calldata sizes
    ) external onlyRole(ADMIN_ROLE) returns (address swagAddr) {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(sku).length  == 0) revert EmptySku();
        if (treasury  == address(0)) revert InvalidTreasury();
        if (itemAdmin == address(0)) revert InvalidItemAdmin();
        if (sizes.length == 0)       revert NoSizes();

        // Validate at least one payment option across all sizes
        for (uint256 i; i < sizes.length; i++) {
            if (sizes[i].payments.length == 0) revert NoPaymentOptions();
        }

        // 1. Clone Swag1155 implementation (EIP-1167 minimal proxy) and initialize it.
        //    Factory is initialAdmin so it can configure variants, then transfers control.
        Swag1155 swag = Swag1155(implementation.clone());
        swag.initialize(
            sizes[0].metadataURI, // baseURI (each tokenId overrides with its own URI)
            treasury,
            address(this)
        );

        // 2. Configure each size as tokenId (1-indexed): variant + payment options.
        for (uint256 i; i < sizes.length; i++) {
            uint256 tokenId = i + 1;
            swag.setVariantWithURI(
                tokenId,
                sizes[i].maxSupply,
                sizes[i].active,
                sizes[i].metadataURI
            );
            for (uint256 j; j < sizes[i].payments.length; j++) {
                swag.setPaymentOption(
                    tokenId,
                    sizes[i].payments[j].token,
                    sizes[i].payments[j].price
                );
            }
        }

        // 3. Grant itemAdmin full control: DEFAULT_ADMIN_ROLE + ADMIN_ROLE.
        swag.grantRole(swag.DEFAULT_ADMIN_ROLE(), itemAdmin);
        swag.addAdmin(itemAdmin);

        // 4. Factory renounces its own roles — itemAdmin is now sole controller.
        swag.renounceRole(swag.ADMIN_ROLE(),         address(this));
        swag.renounceRole(swag.DEFAULT_ADMIN_ROLE(), address(this));

        // 5. Register in factory.
        swagAddr = address(swag);
        collections.push(swagAddr);
        isCollection[swagAddr] = true;
        collectionMeta[swagAddr] = CollectionMeta({
            name:         name,
            sku:          sku,
            treasury:     treasury,
            creator:      msg.sender,
            deployedAt:   block.timestamp,
            variantCount: sizes.length,
            active:       true
        });

        emit CollectionDeployed(swagAddr, name, sku, treasury, sizes.length, msg.sender);
    }

    // ── Collection management ─────────────────────────────────────────────────

    /**
     * @notice Toggle active status for a collection in the factory registry.
     *         This is a factory-level tag only; it does NOT affect the Swag1155 itself.
     * @param collection Swag1155 contract address.
     * @param active     New status.
     */
    function setCollectionActive(address collection, bool active) external onlyRole(ADMIN_ROLE) {
        if (!isCollection[collection]) revert NotACollection();
        collectionMeta[collection].active = active;
        emit CollectionStatusChanged(collection, active);
    }

    // ── Admin management ──────────────────────────────────────────────────────

    /**
     * @notice Grant ADMIN_ROLE to an address (factory-level admin).
     */
    function addAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(ADMIN_ROLE, admin);
    }

    /**
     * @notice Revoke ADMIN_ROLE from an address (factory-level admin).
     */
    function removeAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ADMIN_ROLE, admin);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Returns all deployed collection addresses (including inactive).
    function getCollections() external view returns (address[] memory) {
        return collections;
    }

    /// @notice Returns only collections marked active in the factory registry.
    function getActiveCollections() external view returns (address[] memory) {
        uint256 count;
        for (uint256 i; i < collections.length; i++) {
            if (collectionMeta[collections[i]].active) count++;
        }
        address[] memory active = new address[](count);
        uint256 j;
        for (uint256 i; i < collections.length; i++) {
            if (collectionMeta[collections[i]].active) active[j++] = collections[i];
        }
        return active;
    }

    /// @notice Returns the CollectionMeta struct for a specific collection.
    function getCollectionMeta(address collection) external view returns (CollectionMeta memory) {
        return collectionMeta[collection];
    }

    /// @notice Returns the total number of deployed collections.
    function getCollectionCount() external view returns (uint256) {
        return collections.length;
    }

    // ── UUPS removed — factory is not upgradeable ─────────────────────────────
    // Registry state can be reconstructed from CollectionDeployed events if a
    // new factory version is ever needed.
}
