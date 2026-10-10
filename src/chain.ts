/** Public Hemi mainnet, Bitcoin tunnel, and Ethereum tunnel constants. */

export const HEMI_CHAIN_ID = 43111;
export const HEMI_RPC = "https://rpc.hemi.network/rpc";
export const HEMI_EXPLORER = "https://explorer.hemi.xyz";
export const MEMPOOL = "https://mempool.space";

/** Ethereum mainnet, where the Hemi ETH bridge escrows funds. */
export const ETH_CHAIN_ID = 1;
export const ETH_RPC = "https://ethereum.publicnode.com";
export const ETH_EXPLORER = "https://etherscan.io";

/**
 * Hemi standard bridge on Ethereum.
 * SystemConfig.l1StandardBridge() on mainnet. Docs: docs.hemi.xyz contract addresses.
 */
export const L1_STANDARD_BRIDGE = "0x5eaa10F99e7e6D177eF9F74E519E319aa49f191e";

/**
 * Legacy OptimismPortal (version 2.5.0) paired with the L2 output oracle.
 * SystemConfig.optimismPortal() returns this address. The unused OptimismPortal2
 * has an empty dispute-game factory, so prove and finalize go here.
 */
export const OPTIMISM_PORTAL = "0x39a0005415256B9863aFE2d55Edcf75ECc3A4D7e";

/** Publishes Hemi output roots. FINALIZATION_PERIOD_SECONDS is 86400 on mainnet. */
export const L2_OUTPUT_ORACLE = "0x6daF3a3497D8abdFE12915aDD9829f83A79C0d51";

/** OP Stack predeploys on Hemi. */
export const L2_STANDARD_BRIDGE = "0x4200000000000000000000000000000000000010";
export const L2_MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

/** Gas bought for the relay on the other side. This is not the network fee. */
export const BRIDGE_MIN_GAS = 200_000;

/** hemiBTC on Hemi mainnet. 8 decimals, 1 token = 1 BTC. */
export const HEMIBTC = "0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28";

/** HEMI reward token on Hemi mainnet. PoP payouts are this token, 18 decimals. */
export const HEMI_TOKEN = "0x99e3dE3817F6081B2568208337ef83295b7f591D";

/** VUSD on Hemi mainnet, from the Hemi token list. 18 decimals. */
export const VUSD = "0x7A06C4AeF988e7925575C50261297a946aD204A8";

/**
 * Vetro USD on Hemi. Its symbol is VUSD, and BrownFi lists it under that ticker.
 * It is not the official VUSD above.
 */
export const VETRO_USD = "0xD3599AE62EE280709A22268a46d23164214e345B";

/** Wrapped BTC on Hemi. 8 decimals. Bridged from Ethereum WBTC. */
export const WBTC = "0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3";

/** USDT on Hemi mainnet, from the Hemi token list. 6 decimals. */
export const USDT = "0xbB0D083fb1be0A9f6157ec484b6C79E0A4e31C2e";

/**
 * SushiSwap V3 position NFT on Hemi.
 * factory() is 0xcdbcd51a5e8728e0af4895ce5771b7d17ff71959 and WETH9 is canonical WETH.
 */
export const SUSHI_POSITION_MANAGER = "0xe43ca1Dee3F0fc1e2df73A0745674545F11A59F5";

/**
 * BrownFi CLAMM position NFT (Algebra Positions NFT-V2) on Hemi.
 * factory() is 0x10253594a832f967994b44f33411940533302acb.
 */
export const BROWNFI_POSITION_MANAGER = "0xD637cbc214Bc3dD354aBb309f4fE717ffdD0B28C";

/**
 * Merkl distributor on Hemi. The same proxy is used on most chains.
 * claim(address[],address[],uint256[],bytes32[][]) pays incentive tokens.
 */
export const MERKL_DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";

/**
 * Hemi Labs veHEMI proxy. Locks HEMI into an NFT position.
 * deployments/hemi/VeHemi.json in github.com/hemilabs/veHEMI.
 */
export const VE_HEMI = "0x371d3718D5b7F75EAb050FAe6Da7DF3092031c89";

/** Epoch rewards for veHEMI positions. hemilabs/ui-monorepo ve-hemi-epoch-rewards. */
export const VE_HEMI_REWARDS = "0xC7818357DF04B8FDed091b40AE8D4a0F19295Aa8";

/** Read-only lens for claimable veHEMI rewards. */
export const VE_HEMI_LENS = "0xcf8bce2c4e666df2e527a31ba53c1dde0ec58ad6";

/** A Hemi keystone is published on this block interval (about 5 minutes). */
export const KEYSTONE_EVERY = 25;

/**
 * Bitcoin vault factory used by the Hemi portal for mainnet.
 * initiateWithdrawal and confirmDeposit are called here.
 */
export const VAULT_FACTORY = "0xEAcA824F46c000fB89403846Bb57e6b913321081";

/** Mainnet vault index the portal selects for native BTC deposits. */
export const VAULT_INDEX = 8;

export const BTC_PATH = "m/84'/0'/0'/0/0";
export const HEMI_PATH = "m/44'/60'/0'/0/0";

export const DUST_SATS = 546n;
export const PBKDF2_ITERATIONS = 210_000;
