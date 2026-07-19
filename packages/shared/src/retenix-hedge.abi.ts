// GENERATED — do not edit. Source of truth: contracts/src/RetenixHedge.sol.
// Regenerate: cd contracts && forge build && node script/export-abi.mjs
export const RETENIX_HEDGE_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "agent_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "attestationMaxAgeSecs_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "admin",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "agent",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "attestationMaxAgeSecs",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "authNonces",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "createHedgePlan",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "holdingId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "maxNotionalUsd6",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "maxLeverageX10",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "direction",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "ownerSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "hedgePlanCountOf",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hedgePlans",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "holdingId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "maxNotionalUsd6",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "maxLeverageX10",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "direction",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "status",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hedgePlansOf",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextHedgePlanId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "openNotionalUsd6",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "openPairId",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pauseHedgePlan",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "recordHedgeClose",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "recordHedgeOpen",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "notionalUsd6",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "levX10",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "pairId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "attestedHoldingUsd6",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "attestedAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "resumeHedgePlan",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeAllHedges",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "ownerSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeHedgePlan",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeHedgePlanFor",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "ownerSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "HedgeClosed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "notionalUsd6",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "pairId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HedgeOpened",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "notionalUsd6",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "levX10",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "pairId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "attestedHoldingUsd6",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "attestedAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HedgePlanCreated",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "holdingId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "maxNotionalUsd6",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "maxLeverageX10",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HedgePlanPaused",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HedgePlanResumed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HedgePlanRevoked",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadNonce",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotActive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAdmin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAgent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverLeverageCap",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverNotionalCap",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleAttestation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongDirection",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroHolding",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroLeverage",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroNotional",
    "inputs": []
  }
] as const;
