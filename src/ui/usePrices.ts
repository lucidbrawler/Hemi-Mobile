import { useEffect, useState } from "react";
import { fetchTokenPrices, tokenPrice, withPrices, type PriceBook } from "../lib/prices";
import { useWallet } from "../state";

/** Wallet price book, plus any reward token the first fetch did not include. */
export function usePrices(extra: readonly string[]): PriceBook | null {
  const base = useWallet().prices;
  const [added, setAdded] = useState<Record<string, number>>({});
  const want = [...new Set(extra.map((item) => item.toLowerCase()))].filter(Boolean).sort().join(",");

  useEffect(() => {
    if (!base || want.length === 0) return;
    const book = withPrices(base, added);
    const missing = want.split(",").filter((addr) => tokenPrice(book, addr) == null);
    if (missing.length === 0) return;
    let cancel = false;
    void fetchTokenPrices(missing).then((found) => {
      if (cancel || found == null || Object.keys(found).length === 0) return;
      setAdded((prev) => ({ ...prev, ...found }));
    });
    return () => {
      cancel = true;
    };
  }, [base, want, added]);

  if (!base) return null;
  return withPrices(base, added);
}
