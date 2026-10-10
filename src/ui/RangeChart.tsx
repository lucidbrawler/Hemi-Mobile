import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { loadPoolPriceSeries, type PriceCandle } from "../lib/poolChart";

/**
 * Candles, volume, and the range levels use TradingView's open chart library.
 * The licensed TradingView widget is a different product.
 */
export function RangeChart({
  pool,
  token0,
  token1,
  full,
  low,
  high,
  current,
  lowText,
  highText,
  nowText,
  unit,
  custom,
  onChange,
}: {
  pool: string;
  token0: string;
  token1: string;
  full: boolean;
  low: number;
  high: number;
  current: number;
  lowText: string;
  highText: string;
  nowText: string;
  unit: string;
  custom: boolean;
  onChange: (side: "low" | "high", price: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const linesRef = useRef<Partial<Record<"now" | "high" | "low", IPriceLine>>>({});
  const drag = useRef<"low" | "high" | null>(null);
  const syncRef = useRef<() => void>(() => {});
  const [series, setSeries] = useState<PriceCandle[] | null>(null);
  const [history, setHistory] = useState<"loading" | "ready" | "missing">("loading");
  const [marks, setMarks] = useState<{ top: number | null; bottom: number | null; now: number | null; scale: number }>({
    top: null,
    bottom: null,
    now: null,
    scale: 48,
  });
  const showHandles = !full && low > 0 && high > low && current > 0;

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const chart = createChart(plot, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#101012" },
        textColor: "#a1a1aa",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      rightPriceScale: {
        borderVisible: false,
        mode: PriceScaleMode.Logarithmic,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        // Pinning both edges forces two bars to span the pane, so they draw as blocks.
        fixLeftEdge: false,
        fixRightEdge: true,
        maxBarSpacing: 6,
      },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: false,
      handleScale: false,
      localization: { priceFormatter: axisPrice },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#fb7185",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#fb7185",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });
    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    const observer = new ResizeObserver(() => syncRef.current());
    observer.observe(plot);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      linesRef.current = {};
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    setSeries(null);
    setHistory("loading");
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const candles = await loadPoolPriceSeries(pool, token0, token1);
        if (cancel) return;
        if (candles) {
          setSeries(candles);
          setHistory("ready");
          return;
        }
        if (attempt < 2) await wait(8_000);
        if (cancel) return;
      }
      if (!cancel) setHistory("missing");
    })();
    return () => { cancel = true; };
  }, [pool, token0, token1]);

  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!candles || !volume || !chart) return;
    const rows = uniqueBars(series ?? []);
    const plot = plotRef.current;
    try {
      candles.setData(rows.map((point) => ({
        time: point.time as UTCTimestamp,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
      })));
      volume.setData(rows.map((point) => ({
        time: point.time as UTCTimestamp,
        value: point.volume,
        color: point.close >= point.open ? "rgba(52, 211, 153, 0.55)" : "rgba(251, 113, 133, 0.5)",
      })));
      if (plot) {
        plot.dataset.error = "";
        plot.dataset.candles = String(rows.length);
      }
    } catch (error) {
      if (plot) plot.dataset.error = error instanceof Error ? error.message : String(error);
      return;
    }
    const sample = rows[rows.length - 1]?.close ?? current;
    if (sample > 0) candles.applyOptions({ priceFormat: priceFormat(sample) });
    if (rows.length > 0) chart.timeScale().fitContent();
    const frame = requestAnimationFrame(() => syncRef.current());
    const timer = window.setTimeout(() => syncRef.current(), 60);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [series, current]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles || !(current > 0)) return;
    if (!drag.current) {
      candles.applyOptions({
        autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => fitScale(original(), full, low, high, current),
      });
    }
    upsert("now", {
      price: current,
      color: "#ff6b33",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: "Now",
      axisLabelVisible: true,
      axisLabelColor: "#ff6b33",
      axisLabelTextColor: "#18181b",
    });
    if (showHandles) {
      upsert("high", {
        price: high,
        color: "#ff4600",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        title: "Max",
        axisLabelVisible: true,
        axisLabelColor: "#ff4600",
        axisLabelTextColor: "#18181b",
      });
      upsert("low", {
        price: low,
        color: "#ff4600",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        title: "Min",
        axisLabelVisible: true,
        axisLabelColor: "#ff4600",
        axisLabelTextColor: "#18181b",
      });
    } else {
      drop("high");
      drop("low");
    }
    const frame = requestAnimationFrame(() => syncRef.current());
    const timer = window.setTimeout(() => syncRef.current(), 60);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [full, low, high, current, showHandles, series]);

  syncRef.current = syncMarks;

  function syncMarks() {
    const candles = candleRef.current;
    const chart = chartRef.current;
    if (!candles || !chart) return;
    const scale = chart.priceScale("right").width() || 48;
    const height = plotRef.current?.clientHeight ?? 268;
    const next = {
      top: showHandles ? place(high, candles, chart) ?? fallbackY(high, low, high, current, height) : null,
      bottom: showHandles ? place(low, candles, chart) ?? fallbackY(low, low, high, current, height) : null,
      now: place(current, candles, chart) ?? (history === "loading" ? null : fallbackY(current, full ? 0 : low, full ? 0 : high, current, height)),
      scale,
    };
    setMarks((prev) => (
      prev.top === next.top && prev.bottom === next.bottom && prev.now === next.now && prev.scale === next.scale ? prev : next
    ));
  }

  function place(price: number, candles: ISeriesApi<"Candlestick">, chart: IChartApi): number | null {
    const direct = candles.priceToCoordinate(price);
    if (direct != null) return direct;
    const visible = chart.priceScale("right").getVisibleRange();
    if (!visible) return null;
    if (price >= visible.to) return candles.priceToCoordinate(visible.to);
    if (price <= visible.from) return candles.priceToCoordinate(visible.from);
    return null;
  }

  function upsert(key: "now" | "high" | "low", options: Parameters<ISeriesApi<"Candlestick">["createPriceLine"]>[0]) {
    const candles = candleRef.current;
    if (!candles) return;
    const existing = linesRef.current[key];
    if (existing) existing.applyOptions(options);
    else linesRef.current[key] = candles.createPriceLine(options);
  }

  function drop(key: "high" | "low") {
    const candles = candleRef.current;
    const existing = linesRef.current[key];
    if (candles && existing) candles.removePriceLine(existing);
    delete linesRef.current[key];
  }

  function begin(side: "low" | "high", event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const candles = candleRef.current;
    const visible = chartRef.current?.priceScale("right").getVisibleRange();
    // Keep the scale still under the finger. setVisibleRange writes raw prices into a log scale.
    if (candles && visible && visible.to > visible.from) {
      candles.applyOptions({
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: visible.from, maxValue: visible.to },
        }),
      });
    }
    drag.current = side;
    boxRef.current?.setPointerCapture(event.pointerId);
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    const side = drag.current;
    const candles = candleRef.current;
    const plot = plotRef.current;
    if (!side || !candles || !plot) return;
    const rect = plot.getBoundingClientRect();
    const price = candles.coordinateToPrice(event.clientY - rect.top);
    if (price == null || !(price > 0) || !Number.isFinite(price)) return;
    const next = side === "low" ? Math.min(price, high * 0.98) : Math.max(price, low * 1.02);
    onChange(side, next);
  }

  function end() {
    if (!drag.current) return;
    drag.current = null;
    candleRef.current?.applyOptions({
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => fitScale(original(), full, low, high, current),
    });
    chartRef.current?.priceScale("right").setAutoScale(true);
    requestAnimationFrame(() => requestAnimationFrame(() => syncRef.current()));
  }

  function grab(event: React.PointerEvent<HTMLDivElement>) {
    if (!showHandles || drag.current) return;
    const side = (event.target as HTMLElement).dataset.side;
    if (side === "low" || side === "high") {
      begin(side, event);
      return;
    }
    const plot = plotRef.current;
    if (!plot || marks.top == null || marks.bottom == null) return;
    const y = event.clientY - plot.getBoundingClientRect().top;
    const distTop = Math.abs(y - marks.top);
    const distBottom = Math.abs(y - marks.bottom);
    if (Math.min(distTop, distBottom) > 18) return;
    begin(distBottom <= distTop ? "low" : "high", event);
  }

  const shadeTop = marks.top != null && marks.bottom != null ? Math.min(marks.top, marks.bottom) : null;
  const shadeHeight = marks.top != null && marks.bottom != null ? Math.max(2, Math.abs(marks.bottom - marks.top)) : 0;

  return (
    <div
      className="range-chart"
      ref={boxRef}
      onPointerDown={grab}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        className="range-plot"
        ref={plotRef}
        data-candles={series?.length ?? 0}
        data-history={history}
        data-top={marks.top ?? ""}
        data-bottom={marks.bottom ?? ""}
        role="img"
        aria-label={full ? "Full range over the price chart" : `Range from ${lowText} to ${highText} ${unit}`}
      />
      {shadeTop != null && (
        <div
          className="range-shade"
          style={{ top: shadeTop, height: shadeHeight, right: marks.scale }}
        />
      )}
      {marks.now != null && !series?.length && history !== "loading" && (
        <div className="range-now" style={{ top: marks.now, right: marks.scale }} />
      )}
      {marks.top != null && (
        <button
          type="button"
          className="range-handle"
          data-side="high"
          aria-label="Maximum price"
          style={{ top: marks.top, right: marks.scale - 8 }}
          onPointerDown={(event) => begin("high", event)}
        />
      )}
      {marks.bottom != null && (
        <button
          type="button"
          className="range-handle"
          data-side="low"
          aria-label="Minimum price"
          style={{ top: marks.bottom, right: marks.scale - 8 }}
          onPointerDown={(event) => begin("low", event)}
        />
      )}
      <div className="range-scale range-percents">
        <span>{full ? "Every price" : signedPercent(low, current)}</span>
        <span>{nowText}</span>
        <span>{full ? "" : signedPercent(high, current)}</span>
      </div>
      {!full && (
        <div className="range-scale">
          <span>{lowText}</span>
          <span />
          <span>{highText}</span>
        </div>
      )}
      <p className="fine">{chartCaption(full, custom, unit, history, series?.length ?? 0)}</p>
    </div>
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Drop repeated hours before the chart sees them. A duplicate time rejects the whole series.
function uniqueBars(rows: PriceCandle[]): PriceCandle[] {
  const sorted = rows.slice().sort((a, b) => a.time - b.time);
  const unique: PriceCandle[] = [];
  for (const row of sorted) {
    const time = Math.floor(row.time);
    const previous = unique.at(-1);
    if (!Number.isFinite(time) || (previous && previous.time >= time)) continue;
    unique.push(time === row.time ? row : { ...row, time });
  }
  return unique;
}

/** Places a level when the candle series has no scale yet. Full-range extremes are not used. */
function fallbackY(price: number, low: number, high: number, current: number, height: number): number | null {
  if (!(price > 0) || !(current > 0)) return null;
  const floor = low > 0 && high > low ? Math.min(low, current) : current / 2;
  const ceil = low > 0 && high > low ? Math.max(high, current) : current * 2;
  if (!(ceil > floor)) return null;
  const pane = Math.max(40, height - 26);
  const pad = 18;
  const span = Math.log(ceil) - Math.log(floor);
  if (!(span > 0)) return null;
  const t = (Math.log(Math.min(ceil, Math.max(floor, price))) - Math.log(floor)) / span;
  return pad + (1 - t) * (pane - pad * 2);
}

function fitScale(base: AutoscaleInfo | null, full: boolean, low: number, high: number, current: number): AutoscaleInfo | null {
  if (!base?.priceRange) return base;
  let minValue = base.priceRange.minValue;
  let maxValue = base.priceRange.maxValue;
  if (current > 0) {
    minValue = Math.min(minValue, current);
    maxValue = Math.max(maxValue, current);
  }
  const ranged = !full && low > 0 && high > low;
  if (ranged) {
    minValue = Math.min(minValue, low);
    maxValue = Math.max(maxValue, high);
  }
  if (!ranged && minValue === base.priceRange.minValue && maxValue === base.priceRange.maxValue) return base;
  return {
    priceRange: { minValue, maxValue },
    margins: ranged ? { above: 16, below: 18 } : (base.margins ?? { above: 12, below: 12 }),
  };
}

function priceFormat(price: number): { type: "price"; precision: number; minMove: number } {
  if (price >= 1000) return { type: "price", precision: 1, minMove: 0.1 };
  if (price >= 100) return { type: "price", precision: 2, minMove: 0.01 };
  if (price >= 1) return { type: "price", precision: 4, minMove: 0.0001 };
  const precision = Math.min(price >= 0.00001 ? 8 : 12, Math.max(4, Math.ceil(-Math.log10(price)) + 2));
  return { type: "price", precision, minMove: 10 ** -precision };
}

function axisPrice(price: number): string {
  if (!(price > 0) || !Number.isFinite(price)) return "";
  if (price >= 1000) return price.toFixed(1);
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  const places = Math.min(12, Math.max(2, Math.ceil(-Math.log10(price)) + 2));
  // Prices around 0.000018 stay at 6 places. Smaller prices need the extra digits or the axis prints 0.
  return price.toFixed(price >= 0.00001 ? Math.min(6, places) : places);
}

function chartCaption(full: boolean, custom: boolean, unit: string, history: "loading" | "ready" | "missing", bars: number): string {
  if (history === "loading") return "Loading this pool's price history.";
  const base = full
    ? "Candles are this pool's price. Volume is along the bottom. The mark is the current price."
    : custom
      ? `${unit}. Max and Min are this range. Drag either level. The percentages are from the current price.`
      : `${unit}. Max and Min are this range. The percentages are from the current price.`;
  const thin = history === "ready" && bars > 0 && bars < 24 ? " Only a few trades are on record." : "";
  const missing = history === "missing" ? " Price history did not load." : "";
  return base + thin + missing;
}

function signedPercent(price: number, current: number): string {
  if (!(price > 0) || !(current > 0)) return "";
  const pct = (price / current - 1) * 100;
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const body = abs.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  if (pct > 0) return `+${body}%`;
  if (pct < 0) return `−${body}%`;
  return "0%";
}
