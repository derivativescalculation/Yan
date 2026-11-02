// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VRFV2PlusClient} from "../interfaces/IVRFCoordinatorV2Plus.sol";

interface IVRFConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @notice Stand-in for the Chainlink VRF v2.5 coordinator in tests and on local chains. Anyone can
///         fulfill a request with any word, so it must never be used on a public network.
contract MockVRFCoordinator {
    struct Request {
        address consumer;
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    mapping(uint256 id => Request) public requests;
    uint256 public lastRequestId;

    event Requested(uint256 indexed id, address indexed consumer);

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata r) external returns (uint256 id) {
        id = ++lastRequestId;
        requests[id] = Request(msg.sender, r.keyHash, r.subId, r.requestConfirmations, r.callbackGasLimit, r.numWords, r.extraArgs);
        emit Requested(id, msg.sender);
    }

    function fulfill(uint256 id, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IVRFConsumer(requests[id].consumer).rawFulfillRandomWords(id, words);
    }

    function createSubscription() external pure returns (uint256) {
        return 1;
    }

    function addConsumer(uint256, address) external {}

    function fundSubscriptionWithNative(uint256) external payable {}
}
