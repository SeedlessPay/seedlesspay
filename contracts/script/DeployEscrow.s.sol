// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "../test/utils/TestBase.sol";
import {SeedlessEscrow, IERC20Escrow} from "../src/SeedlessEscrow.sol";

/// @notice Deploys SeedlessEscrow against Circle's native USDC on Avalanche.
contract DeployEscrow {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant USDC_FUJI = 0x5425890298aed601595a70AB815c96711a31Bc65;
    address internal constant USDC_AVALANCHE = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;

    function run() external returns (SeedlessEscrow escrow) {
        address usdc;
        if (block.chainid == 43113) usdc = USDC_FUJI;
        else if (block.chainid == 43114) usdc = USDC_AVALANCHE;
        else revert("DeployEscrow: unsupported chain");

        vm.startBroadcast();
        escrow = new SeedlessEscrow(IERC20Escrow(usdc));
        vm.stopBroadcast();
    }
}
