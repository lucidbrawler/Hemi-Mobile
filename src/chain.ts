/** Public Hemi mainnet and Bitcoin tunnel constants. */

export const HEMI_CHAIN_ID = 43111;
export const HEMI_RPC = "https://rpc.hemi.network/rpc";
export const HEMI_EXPLORER = "https://explorer.hemi.xyz";
export const MEMPOOL = "https://mempool.space";

/** hemiBTC on Hemi mainnet. 8 decimals, 1 token = 1 BTC. */
export const HEMIBTC = "0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28";

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
