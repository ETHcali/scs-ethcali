// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "./interfaces/IZKPassport.sol";

/**
 * @title ZKPassportNFT
 * @notice Soulbound ERC721 representing a cryptographically verified ZKPassport identity.
 *         Proofs are verified on-chain by the ZKPassport verifier contract.
 *         Stores: unique identifier (bytes32), personhood status, age 18+ flag, nationality.
 * @dev Deployed on Base and Ethereum Mainnet where the ZKPassport verifier is live.
 *      The verifier address is updatable by the owner for future network expansion.
 */
contract ZKPassportNFT is ERC721, ERC721URIStorage, Ownable {
    using Strings for uint256;

    // ── ZKPassport verifier ───────────────────────────────────────────────────

    /// @notice Deterministic ZKPassport verifier address (Base + Ethereum Mainnet)
    address public constant ZKPASSPORT_VERIFIER_ADDRESS =
        0x1D000001000EFD9a6371f4d90bB8920D5431c0D8;

    /// @notice Active verifier instance (owner-updatable for future chain support)
    IZKPassportVerifier public zkPassportVerifier;

    /// @notice Domain used in the SDK query — must match exactly
    string public domain;

    /// @notice Scope used in the SDK query — must match exactly
    string public scope;

    // ── Token storage ─────────────────────────────────────────────────────────

    struct TokenData {
        bytes32 uniqueIdentifier;  // Scoped nullifier returned by the verifier
        bool    personhoodVerified; // Always true for minted tokens
        bool    isOver18;           // From helper.isAgeAboveOrEqual(18, ...)
        string  nationality;        // From helper.getDisclosedData(...).nationality
    }

    mapping(bytes32 => bool)    private _usedIdentifiers;
    mapping(address => bool)    private _hasNFT;
    mapping(uint256 => TokenData) private _tokenData;
    uint256 private _tokenIdCounter;

    // ── NFT metadata (admin-settable) ─────────────────────────────────────────

    string public nftImageURI;
    string public nftDescription;
    string public nftExternalURL;
    bool   public useIPFSImage;

    // ── Events ────────────────────────────────────────────────────────────────

    event NFTMinted(
        address indexed to,
        uint256 indexed tokenId,
        bytes32         uniqueIdentifier,
        bool            isOver18,
        string          nationality
    );
    event MetadataUpdated(string imageURI, string description, string externalURL, bool useIPFS);
    event VerifierUpdated(address indexed newVerifier);

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param name         ERC721 name
     * @param symbol       ERC721 symbol
     * @param initialOwner Contract owner (use address(0) for deployer)
     * @param _domain      Domain registered with ZKPassport SDK (e.g. "ethcali.com")
     * @param _scope       Scope used in the SDK query (e.g. "ethcali-verification")
     */
    constructor(
        string memory name,
        string memory symbol,
        address       initialOwner,
        string memory _domain,
        string memory _scope
    ) ERC721(name, symbol) Ownable(initialOwner == address(0) ? msg.sender : initialOwner) {
        zkPassportVerifier = IZKPassportVerifier(ZKPASSPORT_VERIFIER_ADDRESS);
        domain             = _domain;
        scope              = _scope;
        nftDescription     = "ZKPassport Verification NFT - Cryptographic proof of identity enabling access to ETHCALI Smart Contracts.";
        useIPFSImage       = false;
    }

    // ── Admin: verifier & query config ────────────────────────────────────────

    /**
     * @notice Update the ZKPassport verifier address (e.g. after a new deployment)
     * @param verifierAddress New verifier contract address
     */
    function setVerifier(address verifierAddress) external onlyOwner {
        require(verifierAddress != address(0), "ZKPassportNFT: invalid verifier address");
        zkPassportVerifier = IZKPassportVerifier(verifierAddress);
        emit VerifierUpdated(verifierAddress);
    }

    /**
     * @notice Update the SDK domain (must match the domain used to build the query)
     */
    function setDomain(string memory _domain) external onlyOwner {
        require(bytes(_domain).length > 0, "ZKPassportNFT: empty domain");
        domain = _domain;
    }

    /**
     * @notice Update the SDK scope (must match the scope used to build the query)
     */
    function setScope(string memory _scope) external onlyOwner {
        scope = _scope;
    }

    // ── Admin: NFT metadata ───────────────────────────────────────────────────

    function setImageURI(string memory imageURI) external onlyOwner {
        nftImageURI = imageURI;
        emit MetadataUpdated(imageURI, nftDescription, nftExternalURL, useIPFSImage);
    }

    function setDescription(string memory description) external onlyOwner {
        require(bytes(description).length > 0, "ZKPassportNFT: empty description");
        nftDescription = description;
        emit MetadataUpdated(nftImageURI, description, nftExternalURL, useIPFSImage);
    }

    function setExternalURL(string memory externalURL) external onlyOwner {
        nftExternalURL = externalURL;
        emit MetadataUpdated(nftImageURI, nftDescription, externalURL, useIPFSImage);
    }

    function setUseIPFSImage(bool useIPFS) external onlyOwner {
        if (useIPFS) {
            require(bytes(nftImageURI).length > 0, "ZKPassportNFT: set image URI first");
        }
        useIPFSImage = useIPFS;
        emit MetadataUpdated(nftImageURI, nftDescription, nftExternalURL, useIPFS);
    }

    function setMetadata(
        string memory imageURI,
        string memory description,
        string memory externalURL,
        bool          useIPFS
    ) external onlyOwner {
        require(bytes(description).length > 0, "ZKPassportNFT: empty description");
        if (useIPFS) {
            require(bytes(imageURI).length > 0, "ZKPassportNFT: empty image URI");
        }
        nftImageURI    = imageURI;
        nftDescription = description;
        nftExternalURL = externalURL;
        useIPFSImage   = useIPFS;
        emit MetadataUpdated(imageURI, description, externalURL, useIPFS);
    }

    // ── Mint ──────────────────────────────────────────────────────────────────

    /**
     * @notice Mint a ZKPassport NFT by submitting a ZK proof verified on-chain.
     *         The proof must be generated by the ZKPassport SDK with:
     *           .gte("age", 18).disclose("nationality").done()
     *         and bound to msg.sender + block.chainid.
     * @param params   Proof parameters produced by zkPassport.getSolidityVerifierParameters()
     * @param isIDCard True if the document is an ID card / residence permit; false for passport
     */
    function mint(ProofVerificationParams calldata params, bool isIDCard) external {
        require(!_hasNFT[msg.sender], "ZKPassportNFT: address already has NFT");

        // 1. Verify the ZK proof on-chain
        (bool verified, bytes32 uniqueIdentifier, IZKPassportHelper helper) =
            zkPassportVerifier.verify(params);
        require(verified, "ZKPassportNFT: proof verification failed");
        require(!_usedIdentifiers[uniqueIdentifier], "ZKPassportNFT: identifier already used");

        // 2. Verify domain + scope match this deployment
        require(
            helper.verifyScopes(params.proofVerificationData.publicInputs, domain, scope),
            "ZKPassportNFT: invalid domain or scope"
        );

        // 3. Verify the proof is bound to the caller and this chain
        BoundData memory boundData = helper.getBoundData(params.committedInputs);
        require(boundData.senderAddress == msg.sender, "ZKPassportNFT: sender address mismatch");
        require(boundData.chainId == block.chainid,    "ZKPassportNFT: chain id mismatch");

        // 4. Extract verified claims
        bool isOver18 = helper.isAgeAboveOrEqual(18, params.committedInputs);
        DisclosedData memory disclosed = helper.getDisclosedData(params.committedInputs, isIDCard);

        // 5. Mint
        uint256 tokenId = _tokenIdCounter++;
        _usedIdentifiers[uniqueIdentifier] = true;
        _hasNFT[msg.sender] = true;
        _tokenData[tokenId] = TokenData({
            uniqueIdentifier:  uniqueIdentifier,
            personhoodVerified: true,
            isOver18:          isOver18,
            nationality:       disclosed.nationality
        });

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, _generateTokenURI(tokenId));

        emit NFTMinted(msg.sender, tokenId, uniqueIdentifier, isOver18, disclosed.nationality);
    }

    // ── View functions ────────────────────────────────────────────────────────

    /**
     * @notice Check whether a ZKPassport scoped nullifier has already been used
     * @param uniqueIdentifier bytes32 identifier returned by the verifier
     */
    function hasNFTByIdentifier(bytes32 uniqueIdentifier) external view returns (bool) {
        return _usedIdentifiers[uniqueIdentifier];
    }

    /**
     * @notice Check whether an address already holds an NFT
     */
    function hasNFTByAddress(address user) external view returns (bool) {
        return _hasNFT[user];
    }

    /**
     * @notice Return the verified data stored for a token
     */
    function getTokenData(uint256 tokenId) external view returns (TokenData memory) {
        require(_ownerOf(tokenId) != address(0), "ZKPassportNFT: token does not exist");
        return _tokenData[tokenId];
    }

    // ── Soulbound ─────────────────────────────────────────────────────────────

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721)
        returns (address)
    {
        if (auth == address(0)) {
            return super._update(to, tokenId, auth); // minting is allowed
        }
        revert("ZKPassportNFT: soulbound token - transfers not allowed");
    }

    // ── Metadata generation ───────────────────────────────────────────────────

    function _generateTokenURI(uint256 tokenId) private view returns (string memory) {
        TokenData memory data = _tokenData[tokenId];

        string memory imageData;
        if (useIPFSImage && bytes(nftImageURI).length > 0) {
            imageData = string(abi.encodePacked('"image":"', nftImageURI, '"'));
        } else {
            string memory svg = _generateSVG(tokenId, data);
            imageData = string(abi.encodePacked(
                '"image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(svg)),
                '"'
            ));
        }

        string memory externalUrlData = "";
        if (bytes(nftExternalURL).length > 0) {
            externalUrlData = string(abi.encodePacked(',"external_url":"', nftExternalURL, '"'));
        }

        string memory json = Base64.encode(
            bytes(
                string(
                    abi.encodePacked(
                        '{"name":"ZKPassport Verification #',
                        tokenId.toString(),
                        '","description":"',
                        nftDescription,
                        '",',
                        imageData,
                        externalUrlData,
                        ',"attributes":[',
                        '{"trait_type":"Personhood","value":"',
                        data.personhoodVerified ? "Verified" : "Not Verified",
                        '"},',
                        '{"trait_type":"Age 18+","value":"',
                        data.isOver18 ? "Yes" : "No",
                        '"},',
                        '{"trait_type":"Nationality","value":"',
                        data.nationality,
                        '"},',
                        '{"trait_type":"Verification Status","value":"',
                        (data.personhoodVerified && data.isOver18) ? "Fully Verified" : "Verified",
                        '"},',
                        '{"trait_type":"Token ID","value":"',
                        tokenId.toString(),
                        '"}',
                        ']}'
                    )
                )
            )
        );

        return string(abi.encodePacked("data:application/json;base64,", json));
    }

    function _generateSVG(uint256 tokenId, TokenData memory data) private pure returns (string memory) {
        string memory ageColor        = data.isOver18 ? "#10b981" : "#ef4444";
        string memory personhoodColor = data.personhoodVerified ? "#10b981" : "#ef4444";
        string memory ageText         = data.isOver18 ? "Yes" : "No";
        string memory personhoodText  = data.personhoodVerified ? "Verified" : "Not Verified";

        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">',
                '<rect width="400" height="400" fill="#1a1a1a"/>',
                '<text x="200" y="80" font-family="Arial, sans-serif" font-size="24" fill="#ffffff" text-anchor="middle" font-weight="bold">ZKPassport</text>',
                '<text x="200" y="110" font-family="Arial, sans-serif" font-size="16" fill="#9ca3af" text-anchor="middle">Verification #',
                tokenId.toString(),
                '</text>',
                '<circle cx="200" cy="180" r="50" fill="#3b82f6" opacity="0.3"/>',
                '<text x="200" y="190" font-family="Arial, sans-serif" font-size="32" fill="#3b82f6" text-anchor="middle">ZK</text>',
                '<text x="200" y="260" font-family="Arial, sans-serif" font-size="18" fill="',
                personhoodColor,
                '" text-anchor="middle">Personhood: ',
                personhoodText,
                '</text>',
                '<text x="200" y="290" font-family="Arial, sans-serif" font-size="18" fill="',
                ageColor,
                '" text-anchor="middle">Age 18+: ',
                ageText,
                '</text>',
                '<text x="200" y="320" font-family="Arial, sans-serif" font-size="14" fill="#9ca3af" text-anchor="middle">',
                data.nationality,
                '</text>',
                '<text x="200" y="370" font-family="Arial, sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">ETHCALI</text>',
                '</svg>'
            )
        );
    }

    // ── Overrides ─────────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

