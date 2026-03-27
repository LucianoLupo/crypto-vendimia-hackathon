// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console} from "forge-std/Script.sol";
import {SatsPilotDCA} from "../src/SatsPilotDCA.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address doc = vm.envAddress("DOC_ADDRESS");
        address moc = vm.envAddress("MOC_ADDRESS");
        address kdoc = vm.envAddress("KDOC_ADDRESS");
        address krbtc = vm.envAddress("KRBTC_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        SatsPilotDCA dca = new SatsPilotDCA(keeper, doc, moc, kdoc, krbtc);

        console.log("SatsPilotDCA deployed at:", address(dca));
        console.log("Owner:", dca.owner());
        console.log("Keeper:", dca.keeper());
        console.log("DOC:", address(dca.DOC()));
        console.log("MoC:", address(dca.MOC()));
        console.log("kDOC:", address(dca.KDOC()));
        console.log("kRBTC:", address(dca.KRBTC()));

        vm.stopBroadcast();
    }
}
