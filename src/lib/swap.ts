import { Contract, Wallet, getAddress } from "ethers";
import { HEMIBTC, HEMI_CHAIN_ID, HEMI_TOKEN, USDT, VETRO_USD, VUSD, WBTC } from "../chain";
import { hemiProvider } from "./hemi";

/** Sushi RedSnwapper on Hemi. Swap calldata is only sent here. */
const SUSHI_ROUTER = "0xac4c6e212a361c968f1725b4d055b47e63f80b75";
/** Nordstern guard on Hemi. BrownFi's site routes through this contract. */
const NORDSTERN_GUARD = "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WETH = "0x4200000000000000000000000000000000000006";

/** Half a percent. Sushi takes a fraction; Nordstern takes a percent number. */
const SLIPPAGE_BPS = 50n;

/** Left behind when selling Hemi ETH so the swap can still pay gas. */
export const ETH_GAS_RESERVE = 300_000n * 1_000_000_000n;

export type SwapAssetId = "eth" | "hemi" | "vusd" | "vetro" | "usdt" | "hemibtc" | "wbtc";
export type SwapVenue = "sushi" | "nordstern";

const ASSETS: Record<SwapAssetId, { address: string; native: boolean }> = {
  eth: { address: NATIVE, native: true },
  hemi: { address: HEMI_TOKEN, native: false },
  vusd: { address: VUSD, native: false },
  vetro: { address: VETRO_USD, native: false },
  usdt: { address: USDT, native: false },
  hemibtc: { address: HEMIBTC, native: false },
  wbtc: { address: WBTC, native: false },
};

const NAMES: Record<string, string> = {
  [NATIVE.toLowerCase()]: "ETH",
  [WETH.toLowerCase()]: "WETH",
  [HEMI_TOKEN.toLowerCase()]: "HEMI",
  [VUSD.toLowerCase()]: "VUSD",
  [VETRO_USD.toLowerCase()]: "Vetro",
  [USDT.toLowerCase()]: "USDT",
  [HEMIBTC.toLowerCase()]: "hemiBTC",
  [WBTC.toLowerCase()]: "WBTC",
};

const allowanceAbi = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export type SwapQuote = {
  venue: SwapVenue;
  label: string;
  amountOut: bigint;
  minOut: bigint;
  impact: number | null;
  path: string;
  via: string;
  /** Gas units the quoter reported, when it reported any. */
  gasUnits: bigint | null;
};

export type SwapRow = SwapQuote | { venue: SwapVenue; label: string; error: string };

export type SwapOrder = {
  sell: SwapAssetId;
  buy: SwapAssetId;
  amountIn: bigint;
  venue: SwapVenue;
  minOut: bigint;
};

type SushiBody = {
  status?: string;
  assumedAmountOut?: string;
  priceImpact?: number;
  gasSpent?: number | string;
  visualization?: { liquidityProviders?: string[]; nodes?: { symbol?: string }[] };
  tx?: { to?: string; data?: string; value?: string };
};

type NordHop = { tokenIn?: string; tokenOut?: string; type?: string };
type NordBody = {
  toAmount?: string;
  minToAmount?: string;
  gasEstimate?: number | string;
  swaps?: { route?: NordHop[] }[];
  tx?: { to?: string; data?: string; value?: string };
};

export function quoteSwaps(sell: SwapAssetId, buy: SwapAssetId, amountIn: bigint, from: string): Promise<SwapRow[]> {
  return Promise.all([
    quoteSushi(sell, buy, amountIn).catch((err) => fail("sushi", "Sushi", err)),
    quoteNordstern(sell, buy, amountIn, from).catch((err) => fail("nordstern", "BrownFi", err)),
  ]);
}

export async function routerNeedsApproval(owner: string, sell: SwapAssetId, venue: SwapVenue, amountIn: bigint): Promise<boolean> {
  const asset = ASSETS[sell];
  if (asset.native || amountIn <= 0n) return false;
  const token = new Contract(asset.address, allowanceAbi, hemiProvider());
  const allowed = await token.allowance(owner, routerFor(venue)) as bigint;
  return allowed < amountIn;
}

export async function executeSwap(
  privateKey: string,
  from: string,
  order: SwapOrder,
  onPhase?: (phase: "approve" | "swap") => void,
): Promise<string> {
  if (order.sell === order.buy) throw new Error("Choose two different tokens.");
  if (order.amountIn <= 0n) throw new Error("Enter an amount to swap.");
  const fresh = order.venue === "sushi"
    ? await freshSushi(order, from)
    : await freshNordstern(order, from);
  if (fresh.minOut < order.minOut) throw new Error("The price moved. Check the new quote before swapping.");

  const wallet = new Wallet(privateKey, hemiProvider());
  const sell = ASSETS[order.sell];
  if (!sell.native) {
    const token = new Contract(sell.address, allowanceAbi, wallet);
    const allowed = await token.allowance(from, fresh.to) as bigint;
    if (allowed < order.amountIn) {
      onPhase?.("approve");
      const approveTx = await token.approve(fresh.to, order.amountIn);
      await approveTx.wait();
    }
  }
  onPhase?.("swap");
  const tx = await wallet.sendTransaction({ to: fresh.to, data: fresh.data, value: fresh.value });
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

async function quoteSushi(sell: SwapAssetId, buy: SwapAssetId, amountIn: bigint): Promise<SwapQuote> {
  const body = await getJson<SushiBody>(sushiUrl("quote", sell, buy, amountIn));
  return readSushi(body, sell, buy);
}

async function quoteNordstern(sell: SwapAssetId, buy: SwapAssetId, amountIn: bigint, from: string): Promise<SwapQuote> {
  const body = await getJson<NordBody>(nordUrl(sell, buy, amountIn, from));
  return readNordstern(body, sell, buy);
}

async function freshSushi(order: SwapOrder, from: string): Promise<{ to: string; data: string; value: bigint; minOut: bigint }> {
  const url = new URL(sushiUrl("swap", order.sell, order.buy, order.amountIn));
  url.searchParams.set("sender", from);
  const body = await getJson<SushiBody>(url);
  const quote = readSushi(body, order.sell, order.buy);
  const tx = readTx(body.tx, "sushi", order);
  return { ...tx, minOut: quote.minOut };
}

async function freshNordstern(order: SwapOrder, from: string): Promise<{ to: string; data: string; value: bigint; minOut: bigint }> {
  const body = await getJson<NordBody>(nordUrl(order.sell, order.buy, order.amountIn, from));
  const quote = readNordstern(body, order.sell, order.buy);
  const tx = readTx(body.tx, "nordstern", order);
  return { ...tx, minOut: quote.minOut };
}

function readSushi(body: SushiBody, sell: SwapAssetId, buy: SwapAssetId): SwapQuote {
  if (body.status !== "Success" || !body.assumedAmountOut) throw new Error("No Sushi route for this pair.");
  const amountOut = asAmount(body.assumedAmountOut);
  const nodes = body.visualization?.nodes?.map((node) => node.symbol).filter((symbol): symbol is string => Boolean(symbol));
  const providers = body.visualization?.liquidityProviders ?? [];
  return {
    venue: "sushi",
    label: "Sushi",
    amountOut,
    minOut: withSlippage(amountOut),
    impact: typeof body.priceImpact === "number" ? body.priceImpact : null,
    path: nodes && nodes.length > 1 ? nodes.join(" → ") : `${nameOf(ASSETS[sell].address)} → ${nameOf(ASSETS[buy].address)}`,
    via: providers.length ? providers.map(providerName).join(", ") : "Sushi",
    gasUnits: asGas(body.gasSpent),
  };
}

function readNordstern(body: NordBody, sell: SwapAssetId, buy: SwapAssetId): SwapQuote {
  const amountOut = asAmount(body.toAmount);
  const minOut = asAmount(body.minToAmount);
  if (amountOut <= 0n || minOut <= 0n) throw new Error("No BrownFi route for this pair.");
  const hops = (body.swaps ?? []).flatMap((swap) => swap.route ?? []);
  const symbols = [nameOf(ASSETS[sell].address)];
  for (const hop of hops) {
    if (hop.tokenOut) symbols.push(nameOf(hop.tokenOut));
  }
  if (symbols.length < 2) symbols.push(nameOf(ASSETS[buy].address));
  const vias = [...new Set(hops.map((hop) => hopName(hop.type ?? "")))].filter(Boolean);
  return {
    venue: "nordstern",
    label: "BrownFi",
    amountOut,
    minOut,
    impact: null,
    path: symbols.join(" → "),
    via: vias.length ? vias.join(", ") : "Nordstern",
    gasUnits: asGas(body.gasEstimate),
  };
}

function readTx(tx: { to?: string; data?: string; value?: string } | undefined, venue: SwapVenue, order: SwapOrder) {
  if (!tx?.to || !tx.data) throw new Error("The router returned an unusable swap.");
  const to = getAddress(tx.to);
  if (to !== getAddress(routerFor(venue))) throw new Error("The swap was not aimed at the expected router.");
  if (!/^0x[0-9a-fA-F]+$/.test(tx.data) || tx.data.length < 10) throw new Error("The router returned an unusable swap.");
  const value = tx.value ? BigInt(tx.value) : 0n;
  const native = ASSETS[order.sell].native;
  if (native && value !== order.amountIn) throw new Error("The router asked for a different ETH amount.");
  if (!native && value !== 0n) throw new Error("The router asked for ETH on a token swap.");
  return { to, data: tx.data, value };
}

function sushiUrl(kind: "quote" | "swap", sell: SwapAssetId, buy: SwapAssetId, amountIn: bigint): URL {
  const url = new URL(`https://api.sushi.com/${kind}/v7/${HEMI_CHAIN_ID}`);
  url.searchParams.set("tokenIn", ASSETS[sell].address);
  url.searchParams.set("tokenOut", ASSETS[buy].address);
  url.searchParams.set("amount", amountIn.toString());
  url.searchParams.set("maxSlippage", "0.005");
  if (kind === "quote") url.searchParams.set("visualize", "true");
  return url;
}

function nordUrl(sell: SwapAssetId, buy: SwapAssetId, amountIn: bigint, from: string): URL {
  const url = new URL(`https://api.nordstern.finance/aggregator/${HEMI_CHAIN_ID}`);
  url.searchParams.set("src", ASSETS[sell].address);
  url.searchParams.set("dst", ASSETS[buy].address);
  url.searchParams.set("amount", amountIn.toString());
  url.searchParams.set("from", from);
  url.searchParams.set("slippage", "0.5");
  return url;
}

function routerFor(venue: SwapVenue): string {
  return venue === "sushi" ? SUSHI_ROUTER : NORDSTERN_GUARD;
}

function withSlippage(amount: bigint): bigint {
  return amount * (10_000n - SLIPPAGE_BPS) / 10_000n;
}

function asGas(value: number | string | undefined): bigint | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return BigInt(Math.round(value));
  if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") return BigInt(value);
  return null;
}

function asAmount(value: string | undefined): bigint {
  if (!value || !/^\d+$/.test(value)) return 0n;
  return BigInt(value);
}

function nameOf(address: string): string {
  return NAMES[address.toLowerCase()] ?? `${address.slice(0, 6)}…`;
}

function providerName(value: string): string {
  if (value === "SushiSwapV3") return "Sushi v3";
  if (value === "SushiSwapV2") return "Sushi v2";
  return value;
}

function hopName(type: string): string {
  const text = type.toLowerCase();
  if (text.includes("brown") || text.includes("algebra") || text.includes("integral")) return "BrownFi";
  if (text.includes("sushi")) return "Sushi";
  if (text.includes("uniswap_v3") || text.includes("uniswapv3")) return "Uniswap v3";
  if (text.includes("uniswap")) return "Uniswap";
  return type.replaceAll("_", " ");
}

function fail(venue: SwapVenue, label: string, err: unknown): SwapRow {
  const message = err instanceof Error && err.message ? err.message : "Quote unavailable.";
  return { venue, label, error: message };
}

async function getJson<T>(url: URL): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Quote failed (${response.status}).`);
  return response.json() as Promise<T>;
}
