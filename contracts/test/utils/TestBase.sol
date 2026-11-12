// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The Foundry cheatcodes this repo uses. Declared locally so the contracts have
///         zero external dependencies.
interface Vm {
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter)
        external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function label(address account, string calldata newLabel) external;
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Minimal test helpers (a small subset of forge-std's Test).
abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function makeAddr(string memory name) internal returns (address account) {
        (account,) = makeAddrAndKey(name);
    }

    function makeAddrAndKey(string memory name) internal returns (address account, uint256 key) {
        key = uint256(keccak256(bytes(name)));
        account = vm.addr(key);
        vm.label(account, name);
    }

    function bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        require(min <= max, "bound: min > max");
        if (min == 0 && max == type(uint256).max) return x;
        return min + (x % (max - min + 1));
    }

    function assertTrue(bool condition) internal pure {
        require(condition, "assertTrue failed");
    }

    function assertTrue(bool condition, string memory message) internal pure {
        require(condition, message);
    }

    function assertFalse(bool condition) internal pure {
        require(!condition, "assertFalse failed");
    }

    function assertFalse(bool condition, string memory message) internal pure {
        require(!condition, message);
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint256) failed");
    }

    function assertEq(uint256 a, uint256 b, string memory message) internal pure {
        require(a == b, message);
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq(address) failed");
    }
}
