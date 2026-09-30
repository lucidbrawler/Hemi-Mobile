import { Contract, JsonRpcProvider, Wallet, getAddress, isAddress } from "ethers";
import { HEMIBTC, HEMI_CHAIN_ID, HEMI_EXPLORER, HEMI_RPC, MEMPOOL, VAULT_FACTORY, VAULT_INDEX } from "../chain";

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const factoryAbi = [
  "function vaults(uint32) view returns (address)",
  "function initiateWithdrawal(uint32 vaultIndex, string btcAddress, uint256 amount) returns (uint256)",
  "function confirmDeposit(uint32 vaultIndex, bytes32 txid, uint256 outputIndex, bytes extraInfo) returns (bool)",
];

const vaultAbi = [
  "function bitcoinCustodyAddress() view returns (string)",
  "function MINIMUM_DEPOSIT_SATS() view returns (uint256)",
  "function MINIMUM_WITHDRAWAL_SATS() view returns (uint256)",
  "function MIN_BITCOIN_CONFIRMATIONS() view returns (uint32)",
  "function isAcceptingDeposits() view returns (bool)",
  "function vaultStateChild() view returns (address)",
];

const stateAbi = [
  "function calculateDepositFee(uint256) view returns (uint256)",
  "function calculateWithdrawalFee(uint256) view returns (uint256)",
  "function depositFeeBps() view returns (uint256)",
  "function minDepositFeeSats() view returns (uint256)",
  "function withdrawalFeeBps() view returns (uint256)",
  "function minWithdrawalFeeSats() view returns (uint256)",
];

export function hemiProvider(): JsonRpcProvider {
  return new JsonRpcProvider(HEMI_RPC, HEMI_CHAIN_ID);
}

export function requireEvmAddress(value: string): string {
  const text = value.trim();
  if (!isAddress(text)) throw new Error("Enter a Hemi address (0x…).");
  return getAddress(text);
}

export async function readHemiBalances(address: string): Promise<{ hemiSats: bigint; ethWei: bigint }> {
  const provider = hemiProvider();
  const token = new Contract(HEMIBTC, erc20Abi, provider);
  const [hemiSats, ethWei] = await Promise.all([
    token.balanceOf(address) as Promise<bigint>,
    provider.getBalance(address),
  ]);
  return { hemiSats, ethWei };
}

export type VaultQuote = {
  vaultAddress: string;
  stateAddress: string;
  custodyAddress: string;
  minDepositSats: bigint;
  minWithdrawSats: bigint;
  confirmations: number;
  accepting: boolean;
  depositFeeBps: bigint;
  minDepositFeeSats: bigint;
  withdrawFeeBps: bigint;
  minWithdrawFeeSats: bigint;
};

export async function readVault(): Promise<VaultQuote> {
  const provider = hemiProvider();
  const factory = new Contract(VAULT_FACTORY, factoryAbi, provider);
  const vaultAddress = (await factory.vaults(VAULT_INDEX)) as string;
  const vault = new Contract(vaultAddress, vaultAbi, provider);
  const [custodyAddress, minDepositSats, minWithdrawSats, confirmations, accepting, stateAddress] =
    await Promise.all([
      vault.bitcoinCustodyAddress() as Promise<string>,
      vault.MINIMUM_DEPOSIT_SATS() as Promise<bigint>,
      vault.MINIMUM_WITHDRAWAL_SATS() as Promise<bigint>,
      vault.MIN_BITCOIN_CONFIRMATIONS() as Promise<bigint>,
      vault.isAcceptingDeposits() as Promise<boolean>,
      vault.vaultStateChild() as Promise<string>,
    ]);
  const state = new Contract(stateAddress, stateAbi, provider);
  const [depositFeeBps, minDepositFeeSats, withdrawFeeBps, minWithdrawFeeSats] = await Promise.all([
    state.depositFeeBps() as Promise<bigint>,
    state.minDepositFeeSats() as Promise<bigint>,
    state.withdrawalFeeBps() as Promise<bigint>,
    state.minWithdrawalFeeSats() as Promise<bigint>,
  ]);
  return {
    vaultAddress,
    stateAddress,
    custodyAddress,
    minDepositSats,
    minWithdrawSats,
    confirmations: Number(confirmations),
    accepting,
    depositFeeBps,
    minDepositFeeSats,
    withdrawFeeBps,
    minWithdrawFeeSats,
  };
}

export async function quoteVaultFee(stateAddress: string, kind: "deposit" | "withdraw", amount: bigint): Promise<bigint> {
  const state = new Contract(stateAddress, stateAbi, hemiProvider());
  if (kind === "deposit") return state.calculateDepositFee(amount) as Promise<bigint>;
  return state.calculateWithdrawalFee(amount) as Promise<bigint>;
}

export function fallbackVaultFee(amount: bigint, bps: bigint, minFee: bigint): bigint {
  const proportional = (amount * bps) / 10_000n;
  return proportional > minFee ? proportional : minFee;
}

export async function sendHemiBtc(privateKey: string, to: string, amount: bigint): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const token = new Contract(HEMIBTC, erc20Abi, wallet);
  const tx = await token.transfer(requireEvmAddress(to), amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export async function withdrawToBitcoin(privateKey: string, btcAddress: string, amount: bigint): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const factory = new Contract(VAULT_FACTORY, factoryAbi, wallet);
  const tx = await factory.initiateWithdrawal(VAULT_INDEX, btcAddress, amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export async function confirmHemiDeposit(
  privateKey: string,
  txid: string,
  outputIndex: number,
): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const factory = new Contract(VAULT_FACTORY, factoryAbi, wallet);
  const id = txid.startsWith("0x") ? txid : `0x${txid}`;
  const tx = await factory.confirmDeposit(VAULT_INDEX, id, BigInt(outputIndex), "0x");
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export function hemiAddressUrl(address: string): string {
  return `${HEMI_EXPLORER}/address/${address}`;
}

export function hemiTxUrl(hash: string): string {
  return `${HEMI_EXPLORER}/tx/${hash}`;
}

export function btcTxUrl(txid: string): string {
  return `${MEMPOOL}/tx/${txid}`;
}

export function btcAddressUrl(address: string): string {
  return `${MEMPOOL}/address/${address}`;
}

export type ChainRow = {
  id: string;
  when: number;
  title: string;
  detail: string;
  href: string;
  amount: string;
};

type MempoolTx = {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: { prevout?: { scriptpubkey_address?: string; value?: number } }[];
  vout: { scriptpubkey_address?: string; value?: number }[];
};

export async function readBtcActivity(address: string): Promise<ChainRow[]> {
  const res = await fetch(`${MEMPOOL}/api/address/${address}/txs`);
  if (!res.ok) throw new Error("Bitcoin history is unavailable.");
  const txs = (await res.json()) as MempoolTx[];
  return txs.slice(0, 12).map((tx) => {
    let incoming = 0n;
    let outgoing = 0n;
    for (const input of tx.vin) {
      if (input.prevout?.scriptpubkey_address === address) outgoing += BigInt(input.prevout.value ?? 0);
    }
    for (const output of tx.vout) {
      if (output.scriptpubkey_address === address) incoming += BigInt(output.value ?? 0);
    }
    const delta = incoming - outgoing;
    const when = (tx.status.block_time ?? Math.floor(Date.now() / 1000)) * 1000;
    return {
      id: tx.txid,
      when,
      title: delta >= 0n ? "Bitcoin received" : "Bitcoin sent",
      detail: tx.status.confirmed ? "Confirmed" : "In the mempool",
      href: btcTxUrl(tx.txid),
      amount: delta.toString(),
    };
  });
}

type ExplorerTransfer = {
  tx_hash: string;
  timestamp: string;
  from: { hash: string };
  to: { hash: string };
  total: { value: string; decimals: string };
};

export async function readHemiActivity(address: string): Promise<ChainRow[]> {
  const url = `${HEMI_EXPLORER}/api/v2/addresses/${address}/token-transfers?type=ERC-20&token=${HEMIBTC}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("hemiBTC history is unavailable.");
  const body = (await res.json()) as { items?: ExplorerTransfer[] };
  const mine = address.toLowerCase();
  return (body.items ?? []).slice(0, 12).map((row) => {
    const inbound = row.to.hash.toLowerCase() === mine;
    const sign = inbound ? 1n : -1n;
    return {
      id: row.tx_hash,
      when: Date.parse(row.timestamp),
      title: inbound ? "hemiBTC received" : "hemiBTC sent",
      detail: inbound ? `From ${row.from.hash.slice(0, 8)}…` : `To ${row.to.hash.slice(0, 8)}…`,
      href: hemiTxUrl(row.tx_hash),
      amount: (sign * BigInt(row.total.value)).toString(),
    };
  });
}

export async function readBtcConfirmations(txid: string): Promise<number> {
  const [statusRes, tipRes] = await Promise.all([
    fetch(`${MEMPOOL}/api/tx/${txid}/status`),
    fetch(`${MEMPOOL}/api/blocks/tip/height`),
  ]);
  if (!statusRes.ok || !tipRes.ok) return 0;
  const status = (await statusRes.json()) as { confirmed: boolean; block_height?: number };
  if (!status.confirmed || status.block_height == null) return 0;
  const tip = Number(await tipRes.text());
  return tip - status.block_height + 1;
}
