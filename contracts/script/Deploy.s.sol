// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "../test/utils/TestBase.sol";
import {SeedlessPay, IERC20} from "../src/SeedlessPay.sol";

/// @notice Deploys SeedlessPay against Circle's native USDC on Avalanche.
/// @dev The deployed address is printed by `forge script` as the return value.
contract Deploy {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant USDC_FUJI = 0x5425890298aed601595a70AB815c96711a31Bc65;
    address internal constant USDC_AVALANCHE = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;

    function run() external returns (SeedlessPay pay) {
        address usdc;
        if (block.chainid == 43113) usdc = USDC_FUJI;
        else if (block.chainid == 43114) usdc = USDC_AVALANCHE;
        else revert("Deploy: unsupported chain");

        vm.startBroadcast();
        pay = new SeedlessPay(IERC20(usdc));
        vm.stopBroadcast();
    }
}
