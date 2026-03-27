// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/SatsPilotDCA.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address keeper = vm.envAddress("KEEPER_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        SatsPilotDCA dca = new SatsPilotDCA(keeper);

        console.log("SatsPilotDCA deployed at:", address(dca));
        console.log("Owner:", dca.owner());
        console.log("Keeper:", dca.keeper());

        vm.stopBroadcast();
    }
}
