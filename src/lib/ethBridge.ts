import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getAddress,
  hexlify,
  isAddress,
  keccak256,
  type TransactionReceipt,
} from "ethers";
import {
  BRIDGE_MIN_GAS,
  ETH_CHAIN_ID,
  ETH_EXPLORER,
  ETH_RPC,
  HEMI_CHAIN_ID,
  HEMI_RPC,
  L1_STANDARD_BRIDGE,
  L2_MESSAGE_PASSER,
  L2_OUTPUT_ORACLE,
  L2_STANDARD_BRIDGE,
  OPTIMISM_PORTAL,
} from "../chain.ts";

const coder = AbiCoder.defaultAbiCoder();

const bridgeAbi = [
  "function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable",
  "function paused() view returns (bool)",
];

const oracleAbi = [
  "function latestOutputIndex() view returns (uint256)",
  "function getL2Output(uint256) view returns (tuple(bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
  "function FINALIZATION_PERIOD_SECONDS() view returns (uint256)",
  "function SUBMISSION_INTERVAL() view returns (uint256)",
];

const portalAbi = [
  "function paused() view returns (bool)",
  "function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _l2OutputIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] _withdrawalProof)",
  "function finalizeWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx)",
  "function provenWithdrawals(bytes32) view returns (bytes32 outputRoot, uint128 timestamp, uint128 l2OutputIndex)",
  "function finalizedWithdrawals(bytes32) view returns (bool)",
];

const messagePassed = new Interface([
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
]);

export type WithdrawalFields = {
  nonce: bigint;
  sender: string;
  target: string;
  value: bigint;
  gasLimit: bigint;
  data: string;
};

export type OutputRootProof = {
  version: string;
  stateRoot: string;
  messagePasserStorageRoot: string;
  latestBlockhash: string;
};

export type OutputRef = {
  index: bigint;
  outputRoot: string;
  timestamp: number;
  l2BlockNumber: bigint;
};

export type EthBridgeInfo = {
  l1Paused: boolean;
  l2Paused: boolean;
  portalPaused: boolean;
  finalizationSeconds: number;
};

export type WithdrawalStage =
  | { kind: "waiting-output"; aboutSeconds: number | null }
  | { kind: "ready-to-prove"; output: OutputRef }
  | { kind: "waiting-finality"; readyAt: number }
  | { kind: "ready-to-finalize" }
  | { kind: "finalized" };

/** Measured from Hemi blocks 120 apart on 2026-10-08. Used only for the output countdown. */
const HEMI_BLOCK_SECONDS = 12;

/** Usual time for Hemi to derive an Ethereum deposit after that Ethereum block. */
export const ETH_DERIVE_SECONDS = 180;

type PortalWithdrawal = {
  nonce: bigint;
  sender: string;
  target: string;
  value: bigint;
  gasLimit: bigint;
  data: string;
};

export function ethProvider(): JsonRpcProvider {
  return new JsonRpcProvider(ETH_RPC, ETH_CHAIN_ID, { staticNetwork: true });
}

function l2Provider(): JsonRpcProvider {
  return new JsonRpcProvider(HEMI_RPC, HEMI_CHAIN_ID, { staticNetwork: true });
}

export function requireEthAddress(value: string): string {
  const text = value.trim();
  if (!isAddress(text)) throw new Error("Enter an Ethereum address (0x…).");
  return getAddress(text);
}

/** Send native ETH on Ethereum. The network fee is extra and stays in this wallet. */
export async function sendEthereum(privateKey: string, to: string, amount: bigint): Promise<string> {
  if (amount <= 0n) throw new Error("Enter an amount of ETH.");
  const dest = requireEthAddress(to);
  const wallet = new Wallet(privateKey, ethProvider());
  const provider = wallet.provider;
  if (!provider) throw new Error("Ethereum is unavailable.");
  const [balance, fee] = await Promise.all([provider.getBalance(wallet.address), provider.getFeeData()]);
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  if (price == null) throw new Error("Ethereum fee is unavailable.");
  let gas = 21_000n;
  try {
    gas = await wallet.estimateGas({ to: dest, value: amount });
  } catch {
    // A full-balance send cannot be estimated. The reserve below still keeps the fee.
  }
  if (amount + gas * price * 3n / 2n > balance) {
    throw new Error("Leave some ETH for the Ethereum network fee.");
  }
  const tx = await wallet.sendTransaction({ to: dest, value: amount });
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export function ethTxUrl(hash: string): string {
  return `${ETH_EXPLORER}/tx/${hash}`;
}

export function hashWithdrawal(tx: WithdrawalFields): string {
  return keccak256(coder.encode(
    ["uint256", "address", "address", "uint256", "uint256", "bytes"],
    [tx.nonce, tx.sender, tx.target, tx.value, tx.gasLimit, tx.data],
  ));
}

/** Storage slot of sentMessages[withdrawalHash]. The portal reads mapping slot 0. */
export function withdrawalStorageKey(withdrawalHash: string): string {
  return keccak256(coder.encode(["bytes32", "uint256"], [withdrawalHash, 0n]));
}

export function hashOutputRootProof(proof: OutputRootProof): string {
  return keccak256(coder.encode(
    ["bytes32", "bytes32", "bytes32", "bytes32"],
    [proof.version, proof.stateRoot, proof.messagePasserStorageRoot, proof.latestBlockhash],
  ));
}

export async function readL1Eth(address: string): Promise<bigint> {
  return ethProvider().getBalance(address);
}

export async function readEthBridge(): Promise<EthBridgeInfo> {
  const l1 = new Contract(L1_STANDARD_BRIDGE, bridgeAbi, ethProvider());
  const portal = new Contract(OPTIMISM_PORTAL, portalAbi, ethProvider());
  const oracle = new Contract(L2_OUTPUT_ORACLE, oracleAbi, ethProvider());
  const l2 = new Contract(L2_STANDARD_BRIDGE, bridgeAbi, l2Provider());
  const [l1Paused, l2Paused, portalPaused, period] = await Promise.all([
    l1.paused() as Promise<boolean>,
    l2.paused() as Promise<boolean>,
    portal.paused() as Promise<boolean>,
    oracle.FINALIZATION_PERIOD_SECONDS() as Promise<bigint>,
  ]);
  return {
    l1Paused,
    l2Paused,
    portalPaused,
    finalizationSeconds: Number(period),
  };
}

async function feePrice(provider: JsonRpcProvider): Promise<bigint> {
  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  if (price == null || price <= 0n) throw new Error("Gas price is unavailable.");
  return price;
}

/** Worst-case network fee for bridging `amount`. The bridged amount itself is separate. */
export async function estimateBridgeFee(
  kind: "deposit" | "withdraw",
  from: string,
  to: string,
  amount: bigint,
): Promise<bigint> {
  const provider = kind === "deposit" ? ethProvider() : l2Provider();
  const bridge = new Contract(kind === "deposit" ? L1_STANDARD_BRIDGE : L2_STANDARD_BRIDGE, bridgeAbi, provider);
  const [price, gas] = await Promise.all([
    feePrice(provider),
    bridge.bridgeETHTo.estimateGas(requireEthAddress(to), BRIDGE_MIN_GAS, "0x", { from, value: amount }) as Promise<bigint>,
  ]);
  return gas * price;
}

/** Largest value that still leaves a buffered network fee in `balance`. */
export async function maxBridgeAmount(
  kind: "deposit" | "withdraw",
  from: string,
  to: string,
  balance: bigint,
): Promise<bigint> {
  if (balance <= 0n) return 0n;
  const provider = kind === "deposit" ? ethProvider() : l2Provider();
  const bridge = new Contract(kind === "deposit" ? L1_STANDARD_BRIDGE : L2_STANDARD_BRIDGE, bridgeAbi, provider);
  const price = await feePrice(provider);
  let gas = kind === "deposit" ? 900_000n : 200_000n;
  try {
    gas = await bridge.bridgeETHTo.estimateGas(requireEthAddress(to), BRIDGE_MIN_GAS, "0x", {
      from,
      value: 0n,
    }) as bigint;
  } catch {
    // A zero-value quote can revert. The fallback gas cap still keeps the max under the balance.
  }
  const reserve = (gas * price * 3n) / 2n;
  return balance > reserve ? balance - reserve : 0n;
}

export async function destinationIsContract(kind: "deposit" | "withdraw", address: string): Promise<boolean> {
  const provider = kind === "deposit" ? l2Provider() : ethProvider();
  const code = await provider.getCode(requireEthAddress(address));
  return code !== "0x";
}

async function sendBridge(
  kind: "deposit" | "withdraw",
  privateKey: string,
  to: string,
  amount: bigint,
): Promise<{ hash: string; receipt: TransactionReceipt | null }> {
  const info = await readEthBridge();
  if (info.portalPaused) throw new Error("The Ethereum portal is paused.");
  if (kind === "deposit" && info.l1Paused) throw new Error("The Ethereum side of the bridge is paused.");
  if (kind === "withdraw" && info.l2Paused) throw new Error("The Hemi side of the bridge is paused.");
  if (amount <= 0n) throw new Error("Enter an amount of ETH.");
  const dest = requireEthAddress(to);
  const provider = kind === "deposit" ? ethProvider() : l2Provider();
  const wallet = new Wallet(privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  if (amount >= balance) throw new Error("Leave some ETH in this wallet for the network fee.");
  const bridge = new Contract(kind === "deposit" ? L1_STANDARD_BRIDGE : L2_STANDARD_BRIDGE, bridgeAbi, wallet);
  const tx = await bridge.bridgeETHTo(dest, BRIDGE_MIN_GAS, "0x", { value: amount });
  const receipt = await tx.wait();
  return { hash: receipt?.hash ?? tx.hash, receipt };
}

export async function depositEth(privateKey: string, to: string, amount: bigint): Promise<string> {
  const sent = await sendBridge("deposit", privateKey, to, amount);
  return sent.hash;
}

export function withdrawalFromReceipt(receipt: TransactionReceipt): { withdrawal: WithdrawalFields; hash: string; l2Block: number } {
  const rows = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== L2_MESSAGE_PASSER.toLowerCase()) return [];
    try {
      const parsed = messagePassed.parseLog(log);
      return parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (rows.length !== 1) throw new Error("The withdrawal receipt did not contain one Hemi exit message.");
  const args = rows[0].args;
  const withdrawal: WithdrawalFields = {
    nonce: args.nonce as bigint,
    sender: args.sender as string,
    target: args.target as string,
    value: args.value as bigint,
    gasLimit: args.gasLimit as bigint,
    data: hexlify(args.data as string),
  };
  const hash = hashWithdrawal(withdrawal);
  const logged = (args.withdrawalHash as string).toLowerCase();
  if (hash.toLowerCase() !== logged) throw new Error("Withdrawal hash does not match the receipt.");
  if (receipt.blockNumber == null) throw new Error("The Hemi receipt has no block number.");
  return { withdrawal, hash, l2Block: receipt.blockNumber };
}

export async function withdrawEth(
  privateKey: string,
  to: string,
  amount: bigint,
): Promise<{ hash: string; withdrawal: WithdrawalFields; withdrawalHash: string; l2Block: number }> {
  const sent = await sendBridge("withdraw", privateKey, to, amount);
  if (!sent.receipt) throw new Error("The Hemi withdrawal was not mined.");
  const parsed = withdrawalFromReceipt(sent.receipt);
  return {
    hash: sent.hash,
    withdrawal: parsed.withdrawal,
    withdrawalHash: parsed.hash,
    l2Block: parsed.l2Block,
  };
}

function asBlockNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Hemi block number is out of range.");
  return Number(value);
}

function outputFrom(index: bigint, row: { outputRoot: string; timestamp: bigint; l2BlockNumber: bigint }): OutputRef {
  return {
    index,
    outputRoot: row.outputRoot,
    timestamp: Number(row.timestamp),
    l2BlockNumber: row.l2BlockNumber,
  };
}

export type EthInclusion = "pending" | "failed" | { confirmed: true; timestamp: number };

/** Whether Ethereum has included a deposit. `pending` means no receipt yet. */
export async function readEthInclusion(hash: string): Promise<EthInclusion> {
  const provider = ethProvider();
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return "pending";
  if (receipt.status === 0) return "failed";
  const block = await provider.getBlock(receipt.blockNumber);
  return { confirmed: true, timestamp: block?.timestamp ?? Math.floor(Date.now() / 1000) };
}

/** Seconds until an output can include `l2Block`. Zero means the next proposal is due. */
async function outputWaitSeconds(l2Block: number): Promise<number | null> {
  const oracle = new Contract(L2_OUTPUT_ORACLE, oracleAbi, ethProvider());
  const [latest, interval, tip] = await Promise.all([
    oracle.latestOutputIndex() as Promise<bigint>,
    oracle.SUBMISSION_INTERVAL() as Promise<bigint>,
    l2Provider().getBlock("latest"),
  ]);
  const row = await oracle.getL2Output(latest);
  const step = Number(interval);
  if (!tip || step <= 0) return null;
  let next = Number(row.l2BlockNumber) + step;
  while (next < l2Block) next += step;
  return Math.max(0, next - tip.number) * HEMI_BLOCK_SECONDS;
}

/** Earliest published output whose Hemi block includes `l2Block`, if one exists. */
export async function findCoveringOutput(l2Block: number): Promise<OutputRef | null> {
  const oracle = new Contract(L2_OUTPUT_ORACLE, oracleAbi, ethProvider());
  const latest = (await oracle.latestOutputIndex()) as bigint;
  const tip = await oracle.getL2Output(latest);
  if ((tip.l2BlockNumber as bigint) < BigInt(l2Block)) return null;
  let lo = 0n;
  let hi = latest;
  let best: OutputRef | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    let row: { outputRoot: string; timestamp: bigint; l2BlockNumber: bigint };
    try {
      row = await oracle.getL2Output(mid);
    } catch {
      lo = mid + 1n;
      continue;
    }
    if (row.l2BlockNumber >= BigInt(l2Block)) {
      best = outputFrom(mid, row);
      if (mid === 0n) break;
      hi = mid - 1n;
    } else {
      lo = mid + 1n;
    }
  }
  return best;
}

function portalTuple(tx: WithdrawalFields): PortalWithdrawal {
  return {
    nonce: tx.nonce,
    sender: tx.sender,
    target: tx.target,
    value: tx.value,
    gasLimit: tx.gasLimit,
    data: tx.data,
  };
}

export async function readWithdrawalStage(tx: WithdrawalFields, l2Block: number): Promise<WithdrawalStage> {
  const hash = hashWithdrawal(tx);
  const portal = new Contract(OPTIMISM_PORTAL, portalAbi, ethProvider());
  const oracle = new Contract(L2_OUTPUT_ORACLE, oracleAbi, ethProvider());
  const [proven, finalized, period] = await Promise.all([
    portal.provenWithdrawals(hash) as Promise<{ outputRoot: string; timestamp: bigint; l2OutputIndex: bigint }>,
    portal.finalizedWithdrawals(hash) as Promise<boolean>,
    oracle.FINALIZATION_PERIOD_SECONDS() as Promise<bigint>,
  ]);
  if (finalized) return { kind: "finalized" };
  const wait = Number(period);
  if (proven.timestamp !== 0n) {
    const proposal = await oracle.getL2Output(proven.l2OutputIndex);
    if ((proposal.outputRoot as string).toLowerCase() !== proven.outputRoot.toLowerCase()) {
      const output = await findCoveringOutput(l2Block);
      if (output) return { kind: "ready-to-prove", output };
      const aboutSeconds = await outputWaitSeconds(l2Block).catch(() => null);
      return { kind: "waiting-output", aboutSeconds };
    }
    const proveReadyAt = Number(proven.timestamp) + wait + 1;
    const outputReadyAt = Number(proposal.timestamp) + wait + 1;
    const readyAt = Math.max(proveReadyAt, outputReadyAt);
    if (Math.floor(Date.now() / 1000) >= readyAt) return { kind: "ready-to-finalize" };
    return { kind: "waiting-finality", readyAt };
  }
  const output = await findCoveringOutput(l2Block);
  if (output) return { kind: "ready-to-prove", output };
  const aboutSeconds = await outputWaitSeconds(l2Block).catch(() => null);
  return { kind: "waiting-output", aboutSeconds };
}

type ProofArgs = {
  tx: PortalWithdrawal;
  index: bigint;
  outputRootProof: OutputRootProof;
  withdrawalProof: string[];
};

export async function prepareWithdrawalProof(tx: WithdrawalFields, output: OutputRef): Promise<ProofArgs> {
  const blockNumber = asBlockNumber(output.l2BlockNumber);
  const block = await l2Provider().getBlock(blockNumber);
  if (!block?.hash || !block.stateRoot) throw new Error("That Hemi block has no state root yet.");
  const hash = hashWithdrawal(tx);
  const slot = withdrawalStorageKey(hash);
  const proof = await l2Provider().send("eth_getProof", [
    L2_MESSAGE_PASSER,
    [slot],
    `0x${blockNumber.toString(16)}`,
  ]) as { storageHash: string; storageProof: { value: string; proof: string[] }[] };
  const stored = proof.storageProof?.[0];
  if (!stored) throw new Error("Hemi did not return a withdrawal proof.");
  if (BigInt(stored.value) === 0n) throw new Error("This withdrawal is not in the Hemi message passer at that output.");
  const outputRootProof: OutputRootProof = {
    version: ZeroHash,
    stateRoot: block.stateRoot,
    messagePasserStorageRoot: proof.storageHash,
    latestBlockhash: block.hash,
  };
  const computed = hashOutputRootProof(outputRootProof);
  if (computed.toLowerCase() !== output.outputRoot.toLowerCase()) {
    throw new Error("The output root proof does not match the oracle.");
  }
  return { tx: portalTuple(tx), index: output.index, outputRootProof, withdrawalProof: stored.proof };
}

export async function proveWithdrawal(privateKey: string, tx: WithdrawalFields, output: OutputRef): Promise<string> {
  const info = await readEthBridge();
  if (info.portalPaused) throw new Error("The Ethereum portal is paused.");
  const args = await prepareWithdrawalProof(tx, output);
  const portal = new Contract(OPTIMISM_PORTAL, portalAbi, new Wallet(privateKey, ethProvider()));
  const sent = await portal.proveWithdrawalTransaction(args.tx, args.index, args.outputRootProof, args.withdrawalProof);
  const receipt = await sent.wait();
  return receipt?.hash ?? sent.hash;
}

export async function finalizeWithdrawal(privateKey: string, tx: WithdrawalFields): Promise<string> {
  const info = await readEthBridge();
  if (info.portalPaused) throw new Error("The Ethereum portal is paused.");
  const portal = new Contract(OPTIMISM_PORTAL, portalAbi, new Wallet(privateKey, ethProvider()));
  const sent = await portal.finalizeWithdrawalTransaction(portalTuple(tx));
  const receipt = await sent.wait();
  return receipt?.hash ?? sent.hash;
}

export function stageError(stage: WithdrawalStage): string {
  if (stage.kind === "waiting-output") return "No published Hemi output includes this withdrawal yet.";
  if (stage.kind === "waiting-finality") {
    return `Finalize after ${new Date(stage.readyAt * 1000).toLocaleString()}.`;
  }
  if (stage.kind === "finalized") return "This withdrawal is already finalized.";
  if (stage.kind === "ready-to-prove") return "This withdrawal still needs a proof on Ethereum.";
  return "This withdrawal is not ready.";
}
