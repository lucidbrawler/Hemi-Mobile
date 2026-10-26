/**
 * Build, sign, and broadcast an EVM transaction.
 * The signature comes from the session. This module never sees the phrase.
 */
import {
  Interface,
  JsonRpcProvider,
  Transaction,
  type InterfaceAbi,
  type TransactionReceipt,
} from "ethers";
import { requirePublic, signEvm } from "./sessionVault.ts";

export type EvmRequest = {
  to: string;
  data?: string;
  value?: bigint;
};

export async function broadcastEvm(
  client: JsonRpcProvider,
  chainId: number,
  request: EvmRequest,
): Promise<{ hash: string; receipt: TransactionReceipt | null }> {
  const from = requirePublic().hemiAddress;
  const value = request.value ?? 0n;
  const data = request.data && request.data !== "0x" ? request.data : "0x";
  const fees = await client.getFeeData();
  const gasLimit = await client.estimateGas({ from, to: request.to, value, data });
  const nonce = await client.getTransactionCount(from, "pending");
  const shared = {
    chainId,
    nonce,
    gasLimit,
    to: request.to,
    value,
    data,
  };
  const unsigned = fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
    ? Transaction.from({
      ...shared,
      type: 2,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    : Transaction.from({
      ...shared,
      type: 0,
      gasPrice: fees.gasPrice ?? 1n,
    });
  unsigned.signature = signEvm(unsigned.unsignedSerialized);
  if ((unsigned.from ?? "").toLowerCase() !== from.toLowerCase()) {
    throw new Error("The signing key does not match this address.");
  }
  const tx = await client.broadcastTransaction(unsigned.serialized);
  const receipt = await tx.wait();
  return { hash: receipt?.hash ?? tx.hash, receipt };
}

export async function sendCall(
  client: JsonRpcProvider,
  chainId: number,
  address: string,
  abi: InterfaceAbi,
  method: string,
  args: readonly unknown[],
  value = 0n,
): Promise<{ hash: string; receipt: TransactionReceipt | null }> {
  const data = new Interface(abi).encodeFunctionData(method, args as unknown[]);
  return broadcastEvm(client, chainId, { to: address, data, value });
}
