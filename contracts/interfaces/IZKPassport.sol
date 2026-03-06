// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// ─── Data Structures ──────────────────────────────────────────────────────────

/**
 * @notice Data bound to the proof by the user at proof-generation time
 */
struct BoundData {
    address senderAddress; // Wallet that generated the proof
    uint256 chainId;       // Chain ID the proof is bound to
    string  customData;    // Optional custom payload
}

/**
 * @notice Identity fields disclosed by the proof
 */
struct DisclosedData {
    string name;
    string issuingCountry;
    string nationality;
    string gender;
    string birthDate;
    string expiryDate;
    string documentNumber;
    string documentType;
}

/**
 * @notice Low-level proof + public inputs
 */
struct ProofVerificationData {
    bytes32   vkeyHash;
    bytes     proof;
    bytes32[] publicInputs;
}

/**
 * @notice Service configuration embedded in the proof
 */
struct ServiceConfig {
    uint256 validityPeriodInSeconds;
    string  domain;
    string  scope;
    bool    devMode;
}

/**
 * @notice Full parameter bundle passed to the on-chain verifier
 */
struct ProofVerificationParams {
    bytes32              version;
    ProofVerificationData proofVerificationData;
    bytes                committedInputs;
    ServiceConfig        serviceConfig;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * @notice Helper contract returned by the verifier; used to extract verified
 *         claims from the committed inputs after the proof is validated.
 */
interface IZKPassportHelper {
    function verifyScopes(
        bytes32[] calldata publicInputs,
        string    calldata domain,
        string    calldata scope
    ) external view returns (bool);

    function getDisclosedData(
        bytes calldata committedInputs,
        bool           isIDCard
    ) external view returns (DisclosedData memory);

    function getBoundData(
        bytes calldata committedInputs
    ) external view returns (BoundData memory);

    function isAgeAboveOrEqual(
        uint8          minAge,
        bytes calldata committedInputs
    ) external view returns (bool);
}

/**
 * @notice ZKPassport on-chain verifier.
 *         Deterministic address: 0x1D000001000EFD9a6371f4d90bB8920D5431c0D8
 *         Deployed on: Ethereum Mainnet, Base Mainnet
 */
interface IZKPassportVerifier {
    function verify(
        ProofVerificationParams calldata params
    ) external returns (
        bool              verified,
        bytes32           uniqueIdentifier,
        IZKPassportHelper helper
    );
}
