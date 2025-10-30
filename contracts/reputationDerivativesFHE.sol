pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ReputationDerivativesFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;
    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    mapping(uint256 => euint32) public encryptedReputationScores;
    mapping(uint256 => euint32) public encryptedDerivativePrices;
    mapping(uint256 => ebool) public encryptedDerivativeExercisableFlags;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsUpdated(uint256 indexed oldCooldown, uint256 indexed newCooldown);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ReputationScoreSubmitted(address indexed provider, uint256 indexed batchId, bytes32 indexed encryptedScore);
    event DerivativeParametersSet(uint256 indexed batchId, bytes32 indexed encryptedPrice, bytes32 indexed encryptedExercisable);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 reputationScore, uint256 derivativePrice, bool exercisable);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error ReplayDetected();
    error StateMismatch();
    error InvalidBatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; 
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsUpdated(oldCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function _initIfNeeded(euint32 storage cipher) internal {
        if (!cipher.isInitialized()) {
            cipher.asEuint32(0);
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function submitReputationScore(euint32 memory encryptedScore) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        lastSubmissionTime[msg.sender] = block.timestamp;

        _initIfNeeded(encryptedReputationScores[currentBatchId]);
        encryptedReputationScores[currentBatchId] = encryptedReputationScores[currentBatchId].add(encryptedScore);

        emit ReputationScoreSubmitted(msg.sender, currentBatchId, encryptedScore.toBytes32());
    }

    function setDerivativeParameters(euint32 memory encryptedPrice, ebool memory encryptedExercisable) external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();

        encryptedDerivativePrices[currentBatchId] = encryptedPrice;
        encryptedDerivativeExercisableFlags[currentBatchId] = encryptedExercisable;

        emit DerivativeParametersSet(currentBatchId, encryptedPrice.toBytes32(), encryptedExercisable.toBytes32());
    }

    function requestBatchDecryption() external whenNotPaused checkDecryptionCooldown {
        if (currentBatchId == 0) revert InvalidBatch();
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 memory finalScore = encryptedReputationScores[currentBatchId];
        euint32 memory finalPrice = encryptedDerivativePrices[currentBatchId];
        ebool memory finalExercisable = encryptedDerivativeExercisableFlags[currentBatchId];

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = finalScore.toBytes32();
        cts[1] = finalPrice.toBytes32();
        cts[2] = finalExercisable.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        if (decryptionContexts[requestId].batchId == 0) revert InvalidBatch();

        euint32 memory finalScore = encryptedReputationScores[decryptionContexts[requestId].batchId];
        euint32 memory finalPrice = encryptedDerivativePrices[decryptionContexts[requestId].batchId];
        ebool memory finalExercisable = encryptedDerivativeExercisableFlags[decryptionContexts[requestId].batchId];

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = finalScore.toBytes32();
        cts[1] = finalPrice.toBytes32();
        cts[2] = finalExercisable.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 reputationScore = abi.decode(cleartexts[0:32], (uint256));
        uint256 derivativePrice = abi.decode(cleartexts[32:64], (uint256));
        bool exercisable = abi.decode(cleartexts[64:96], (bool));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, reputationScore, derivativePrice, exercisable);
    }
}