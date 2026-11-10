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
 *         Proofs are verified on-chain by the ZKPassport verifier contract, and the
 *         contract enforces the same policy the app requests (ZKPassport dashboard
 *         policy for `domain` + `scope`): adult, sanctions-screened (non-strict), and neither the
 *         nationality nor the issuing country on the exclusion list. A client that
 *         asks for a weaker proof still cannot mint.
 *         Stores: unique identifier (bytes32), personhood status, age 18+ flag, nationality.
 * @dev Deployed on Base and Ethereum Mainnet where the ZKPassport verifier is live.
 *      The verifier address is updatable by the owner for future network expansion.
 */
contract ZKPassportNFT is ERC721, ERC721URIStorage, Ownable {
    using Strings for uint256;

    // ── ZKPassport verifier ───────────────────────────────────────────────────

    /**
     * @notice ZKPassport's root verifier (0x1D00…c0D8 on Ethereum and Base). Fixed
     *         at deploy: an owner who could repoint it could mint to anyone, and the
     *         faucet trusts every holder. The root routes new proof versions itself.
     */
    IZKPassportVerifier public immutable zkPassportVerifier;

    /// @notice Domain used in the SDK query — must match exactly
    string public domain;

    /// @notice Scope used in the SDK query — must match exactly
    string public scope;

    /// @notice The validity window the SDK query must carry (its default, 7 days)
    uint256 public constant VALIDITY_PERIOD_SECONDS = 604800;

    /// @notice Minimum proven age
    uint8 public constant MIN_AGE = 18;

    /**
     * @notice The sanctions screen the proof must have run: non-strict matches on
     *         name + date of birth or document number + nationality, so sharing a
     *         name with a listed person is not enough to be refused (owner decision
     *         2026-10-10). The app's `.sanctions()` request must use the same mode.
     */
    bool public constant SANCTIONS_STRICT = false;

    /// @dev ISO 3166-1 alpha-3 codes refused as nationality and as issuing country.
    string[] private _excludedCountries;

    // ── Token storage ─────────────────────────────────────────────────────────

    struct TokenData {
        bytes32 uniqueIdentifier;  // Scoped nullifier returned by the verifier
        bool    personhoodVerified; // Always true for minted tokens
        bool    isOver18;           // Always true: mint requires helper.isAgeAboveOrEqual(MIN_AGE, ...)
        string  nationality;        // getDisclosedData(...).nationality; empty unless the policy discloses it
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
    event ExcludedCountriesUpdated(string[] countries);

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param name         ERC721 name
     * @param symbol       ERC721 symbol
     * @param initialOwner Contract owner (use address(0) for deployer)
     * @param _domain      Domain registered with ZKPassport SDK (e.g. "ethcali.com")
     * @param _scope       Scope used in the SDK query (e.g. "policy-1")
     * @param excludedCountries_ ISO alpha-3 codes refused as nationality and issuing country,
     *                    sorted ascending (ZKPassport requires the proof's list in that order)
     * @param verifier     ZKPassport's root verifier
     */
    constructor(
        string memory name,
        string memory symbol,
        address       initialOwner,
        string memory _domain,
        string memory _scope,
        string[] memory excludedCountries_,
        address verifier
    ) ERC721(name, symbol) Ownable(initialOwner == address(0) ? msg.sender : initialOwner) {
        require(bytes(_domain).length > 0, "ZKPassportNFT: empty domain");
        require(bytes(_scope).length > 0, "ZKPassportNFT: empty scope");
        require(verifier.code.length > 0, "ZKPassportNFT: verifier has no code");
        zkPassportVerifier = IZKPassportVerifier(verifier);
        domain             = _domain;
        scope              = _scope;
        _setExcludedCountries(excludedCountries_);
        nftDescription     = "ZKPassport Verification NFT - Cryptographic proof of identity enabling access to ETHCALI Smart Contracts.";
        useIPFSImage       = false;
    }

    // ── Admin: query config ───────────────────────────────────────────────────
    //
    // Domain, scope and the exclusion list stay settable so a mismatch with the
    // dashboard policy is fixable without a redeploy. Changing the scope opens a
    // new nullifier space (one person could mint again from another address), so
    // these are owner powers to hold in a multisig.

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
        require(bytes(_scope).length > 0, "ZKPassportNFT: empty scope");
        scope = _scope;
    }

    // ── Admin: NFT metadata ───────────────────────────────────────────────────

    /**
     * @notice Replace the exclusion list. Keep it equal to the dashboard policy's
     *         lists, or proofs the app requests will fail here (or pass a weaker check).
     */
    function setExcludedCountries(string[] calldata countries) external onlyOwner {
        _setExcludedCountries(countries);
    }

    /// @dev Upper bound so a list can never make the setter or every mint run out of gas.
    uint256 private constant MAX_EXCLUDED_COUNTRIES = 64;

    /**
     * @dev ZKPassport compares this list with the one committed in the proof: it
     *      must match exactly and be sorted alphabetically. Strictly ascending
     *      uppercase alpha-3 codes, so a mis-ordered or lowercase list is refused
     *      here instead of silently failing every real mint.
     */
    function _setExcludedCountries(string[] memory countries) private {
        require(countries.length <= MAX_EXCLUDED_COUNTRIES, "ZKPassportNFT: too many countries");
        for (uint256 i = 0; i < countries.length; i++) {
            bytes memory code = bytes(countries[i]);
            require(code.length == 3, "ZKPassportNFT: country must be ISO alpha-3");
            for (uint256 j = 0; j < 3; j++) {
                require(code[j] >= "A" && code[j] <= "Z", "ZKPassportNFT: country must be uppercase A-Z");
            }
            if (i > 0) {
                require(bytes3(code) > bytes3(bytes(countries[i - 1])), "ZKPassportNFT: countries must be sorted and unique");
            }
        }
        _excludedCountries = countries;
        emit ExcludedCountriesUpdated(countries);
    }

    /// @notice The countries refused as nationality and as issuing country
    function excludedCountries() external view returns (string[] memory) {
        return _excludedCountries;
    }

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
     *         The proof must come from the dashboard policy for `domain` + `scope`:
     *           .gte("age", 18).sanctions()   (non-strict)
     *           .out("nationality", list).out("issuing_country", list)
     *         bound to msg.sender + block.chainid, devMode off, 7-day validity.
     * @param params   Proof parameters produced by zkPassport.getSolidityVerifierParameters()
     * @param isIDCard True if the document is an ID card / residence permit; false for passport
     */
    function mint(ProofVerificationParams calldata params, bool isIDCard) external {
        require(!_hasNFT[msg.sender], "ZKPassportNFT: address already has NFT");

        // Mock proofs are accepted in dev mode; they must never mint here.
        require(!params.serviceConfig.devMode, "ZKPassportNFT: dev mode proof");
        require(
            params.serviceConfig.validityPeriodInSeconds == VALIDITY_PERIOD_SECONDS,
            "ZKPassportNFT: invalid validity period"
        );

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

        // 4. Enforce the policy
        require(helper.isAgeAboveOrEqual(MIN_AGE, params.committedInputs), "ZKPassportNFT: under minimum age");
        if (_excludedCountries.length > 0) {
            require(
                helper.isNationalityOut(_excludedCountries, params.committedInputs),
                "ZKPassportNFT: nationality not allowed"
            );
            require(
                helper.isIssuingCountryOut(_excludedCountries, params.committedInputs),
                "ZKPassportNFT: issuing country not allowed"
            );
        }
        // Reverts unless the proof screened, in this mode, against a sanctions root valid now.
        helper.enforceSanctionsRoot(block.timestamp, SANCTIONS_STRICT, params.committedInputs);

        // 5. Extract the disclosed claims (empty fields when the policy does not disclose them)
        DisclosedData memory disclosed = helper.getDisclosedData(params.committedInputs, isIDCard);

        // 6. Mint
        uint256 tokenId = _tokenIdCounter++;
        _usedIdentifiers[uniqueIdentifier] = true;
        _hasNFT[msg.sender] = true;
        _tokenData[tokenId] = TokenData({
            uniqueIdentifier:  uniqueIdentifier,
            personhoodVerified: true,
            isOver18:          true, // enforced above: under-18 proofs revert
            nationality:       disclosed.nationality
        });

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, _generateTokenURI(tokenId));

        emit NFTMinted(msg.sender, tokenId, uniqueIdentifier, true, disclosed.nationality);
    }

    // ── View functions ────────────────────────────────────────────────────────

    /**
     * @notice Whether `user` can mint at all, and why not. Mirrors the checks that
     *         need no proof; everything else is decided by the proof itself.
     */
    function canMint(address user) external view returns (bool, string memory) {
        if (_hasNFT[user]) return (false, "Address already has an NFT");
        return (true, "");
    }

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

