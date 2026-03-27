#!/bin/bash
# Deploy SatsPilotDCA to RSK Testnet

set -e

DEPLOYER_PRIVATE_KEY=0x30e470c8e4d4e8d0614d5cf3718588fa2c3c0b71bf01d60ec27e008d269d19d7 \
KEEPER_ADDRESS=0x36cA46C6b7E93282F89A29b593e593dF0Dc3b3D1 \
DOC_ADDRESS=0xCB46c0ddc60D18eFEB0E586C17Af6ea36452Dae0 \
MOC_ADDRESS=0x2820f6d4D199B8D8838A4B26F9917754B86a0c1F \
KDOC_ADDRESS=0x71e6B108d823C2786f8EF63A3E0589576B4F3914 \
KRBTC_ADDRESS=0x5b35072cd6110606c8421e013304110fa04a32a3 \
forge script script/Deploy.s.sol \
  --rpc-url https://public-node.testnet.rsk.co \
  --broadcast \
  --legacy \
  -vvv

echo ""
echo "Done! Check the output above for the deployed contract address."
echo "Update your backend config with the contract address."
