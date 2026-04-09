"use client";

import { useEffect, useMemo, useState } from "react";

const FALLBACK_URL = "http://127.0.0.1:8765";
const MA_ORDER = [
  ["ema_21", "EMA 21"],
  ["sma_50", "SMA 50"],
  ["sma_200", "SMA 200"],
  ["ema_8", "EMA 8"],
  ["sma_20", "SMA 20"],
] as const;

type HealthState =
  | { status: "checking"; text: string }
  | { status: "live"; text: string }
  | { status: "offline"; text: string };

type QuoteData = {
  ticker: string;
  price: number;
  iv_pct?: number | null;
  iv_source?: string | null;
  company?: string | null;
  sector?: string | null;
  hv30?: number | null;
  "52w_high"?: number | null;
  "52w_low"?: number | null;
};

type CatalystData = {
  earnings_date?: string | null;
  days_to_earnings?: number | null;
  implied_move_pct?: number | null;
  straddle_expiry?: string | null;
};

type Wall = {
  strike: number;
  open_interest?: number;
  volume?: number;
  pct_from_spot?: number;
  expiry_count?: number;
};

type LevelsData = {
  price: number;
  reference_expiry?: string | null;
  reference_dte?: number | null;
  source_expiries?: string[];
  call_walls?: Wall[];
  put_walls?: Wall[];
  moving_averages?: Record<string, number>;
  previous_session?: {
    high?: number | null;
    low?: number | null;
    close?: number | null;
  };
};

type SnapshotState = {
  quote: QuoteData | null;
  catalyst: CatalystData | null;
  levels: LevelsData | null;
  loading: boolean;
  error: string | null;
};

type SetupState = {
  spot: string;
  strike: string;
  dte: string;
  iv: string;
};

type ReadLevel = {
  price: number;
  label: string;
  kind: "call" | "put" | "ma";
  source: string;
  priority: number;
  open_interest?: number;
  volume?: number;
  deltaPct: number;
  distancePct: number;
  side: "support" | "resistance" | "pivot";
  score: number;
};

type LevelCluster = {
  anchor: ReadLevel;
  cluster: ReadLevel[];
  band: string;
  score: number;
  wallLed: boolean;
  confluence: boolean;
  distancePct: number;
};

type MarketRead = {
  tone: string;
  toneClass: "bull" | "bear" | "neutral";
  note: string;
  support: LevelCluster | null;
  resistance: LevelCluster | null;
};

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function fmtDollar(value: number | null | undefined, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return `$${Number(value).toFixed(digits)}`;
}

function fmtPctDist(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return `${Number(value).toFixed(Number(value) < 1 ? 2 : 1)}%`;
}

function ivSourceLabel(source: string | null | undefined) {
  if (!source) return "IV";
  return (
    {
      bs_inversion: "Contract IV",
      yf_chain: "Chain IV",
      options_chain: "ATM IV",
      hv30_fallback: "HV30",
      atm_fallback: "ATM IV",
      prefill: "Prefill IV",
    }[source] ?? "IV"
  );
}

function wallMetric(wall: Wall) {
  const oi = Number(wall.open_interest) || 0;
  const volume = Number(wall.volume) || 0;
  if (oi > 0) return `${Intl.NumberFormat("en-US", { notation: "compact" }).format(oi)} OI`;
  if (volume > 0) return `${Intl.NumberFormat("en-US", { notation: "compact" }).format(volume)} vol`;
  return "activity";
}

function levelName(level: ReadLevel) {
  if (level.kind === "call") return `Call wall $${level.price.toFixed(2)}`;
  if (level.kind === "put") return `Put wall $${level.price.toFixed(2)}`;
  if (level.source === "prev_high") return `Prev High $${level.price.toFixed(2)}`;
  if (level.source === "prev_low") return `Prev Low $${level.price.toFixed(2)}`;
  return `${level.label} $${level.price.toFixed(2)}`;
}

function overlayLevels(levelsData: LevelsData | null): Omit<ReadLevel, "deltaPct" | "distancePct" | "side" | "score">[] {
  if (!levelsData) return [];

  const levels: Omit<ReadLevel, "deltaPct" | "distancePct" | "side" | "score">[] = [];
  const ma = levelsData.moving_averages ?? {};
  const prev = levelsData.previous_session ?? {};

  (levelsData.call_walls ?? []).slice(0, 3).forEach((wall, idx) =>
    levels.push({
      price: wall.strike,
      label: `Call wall ${wallMetric(wall)}`,
      kind: "call",
      source: "call_wall",
      priority: 30 - idx,
      open_interest: wall.open_interest,
      volume: wall.volume,
    }),
  );

  (levelsData.put_walls ?? []).slice(0, 3).forEach((wall, idx) =>
    levels.push({
      price: wall.strike,
      label: `Put wall ${wallMetric(wall)}`,
      kind: "put",
      source: "put_wall",
      priority: 25 - idx,
      open_interest: wall.open_interest,
      volume: wall.volume,
    }),
  );

  MA_ORDER.forEach(([key, label], idx) => {
    const price = ma[key];
    if (Number.isFinite(price)) {
      levels.push({
        price,
        label,
        kind: "ma",
        source: key,
        priority: 20 - idx,
      });
    }
  });

  if (Number.isFinite(prev.high)) {
    levels.push({ price: Number(prev.high), label: "Prev High", kind: "ma", source: "prev_high", priority: 15 });
  }
  if (Number.isFinite(prev.low)) {
    levels.push({ price: Number(prev.low), label: "Prev Low", kind: "ma", source: "prev_low", priority: 14 });
  }

  return levels;
}

function classifyLevelForRead(
  level: Omit<ReadLevel, "deltaPct" | "distancePct" | "side" | "score">,
  spot: number,
): ReadLevel {
  const deltaPct = ((level.price / spot) - 1) * 100;
  const distancePct = Math.abs(deltaPct);

  let side: ReadLevel["side"] = "pivot";
  if (level.kind === "call") side = "resistance";
  else if (level.kind === "put") side = "support";
  else if (deltaPct >= 0.25) side = "resistance";
  else if (deltaPct <= -0.25) side = "support";

  const baseScore =
    level.kind === "call"
      ? 98
      : level.kind === "put"
        ? 96
        : {
            sma_200: 80,
            sma_50: 75,
            ema_21: 73,
            sma_20: 70,
            ema_8: 67,
            prev_high: 72,
            prev_low: 72,
          }[level.source] ?? 68;

  const flowMetric = Math.max(Number(level.open_interest) || 0, Number(level.volume) || 0, 0);
  const flowBoost = level.kind === "call" || level.kind === "put" ? Math.min(16, Math.log10(flowMetric + 1) * 6) : 0;
  const proximityBoost = Math.max(0, 16 - distancePct * 8);

  return {
    ...level,
    deltaPct,
    distancePct,
    side,
    score: baseScore + flowBoost + proximityBoost,
  };
}

function pickLevelCluster(levels: ReadLevel[]): LevelCluster | null {
  if (!levels.length) return null;

  const sorted = [...levels].sort((a, b) => a.distancePct - b.distancePct || b.score - a.score);
  const anchor = sorted[0];
  const cluster = sorted
    .filter(
      (level) =>
        Math.abs(((level.price / anchor.price) - 1) * 100) <= 0.85 ||
        Math.abs(level.distancePct - anchor.distancePct) <= 0.45,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const kindCount = new Set(cluster.map((level) => level.kind)).size;
  const wallLed = cluster.some((level) => level.kind === "call" || level.kind === "put");
  const prices = cluster.map((level) => level.price).sort((a, b) => a - b);
  const band =
    prices.length > 1 && Math.abs(prices[prices.length - 1] - prices[0]) > 0.11
      ? `$${prices[0].toFixed(2)}-$${prices[prices.length - 1].toFixed(2)}`
      : `$${anchor.price.toFixed(2)}`;
  const score = cluster.reduce((sum, level, idx) => sum + level.score - idx * 4, 0);

  return {
    anchor,
    cluster,
    band,
    score,
    wallLed,
    confluence: kindCount > 1 || cluster.length > 1,
    distancePct: anchor.distancePct,
  };
}

function clusterNote(cluster: LevelCluster | null, side: "support" | "resistance") {
  if (!cluster) {
    return side === "support"
      ? "No nearby support cluster is mapped yet."
      : "No nearby resistance cluster is mapped yet.";
  }
  const lead = cluster.wallLed ? "wall-led" : "trend-led";
  const dist =
    cluster.distancePct < 0.12
      ? "right on spot"
      : `${fmtPctDist(cluster.distancePct)} ${side === "support" ? "below" : "above"} spot`;
  const confluence = cluster.confluence ? "Confluence" : "Single level";
  return `${confluence} around ${cluster.band} | ${lead} | ${dist}`;
}

function marketReadSummary(levelsData: LevelsData | null, spot: number): MarketRead | null {
  if (!levelsData || !Number.isFinite(spot) || spot <= 0) return null;

  const levels = overlayLevels(levelsData).map((level) => classifyLevelForRead(level, spot));
  const support = pickLevelCluster(levels.filter((level) => level.side === "support"));
  const resistance = pickLevelCluster(levels.filter((level) => level.side === "resistance"));
  const pivots = levels
    .filter((level) => level.side === "pivot")
    .sort((a, b) => a.distancePct - b.distancePct || b.score - a.score);

  let tone = "Balanced map";
  let toneClass: MarketRead["toneClass"] = "neutral";
  let note =
    "Walls usually matter most for the first reaction. EMAs and SMAs matter more when they stack in the same band.";

  if (support && resistance) {
    const bothTight = Math.max(support.distancePct, resistance.distancePct) <= 1.2;
    const scoreGap = Math.abs(support.score - resistance.score);
    if (bothTight && Math.abs(support.distancePct - resistance.distancePct) <= 0.4 && scoreGap <= 10) {
      tone = "Compression zone";
      note = "Support and resistance are both nearby, so price may chop between them until one side breaks with conviction.";
    } else if (
      (support.distancePct <= 0.9 && support.score >= resistance.score - 4) ||
      support.score >= resistance.score + 10
    ) {
      tone = "Support-led";
      toneClass = "bull";
      note = support.confluence
        ? "Put wall and trend support are stacked close together. Pullbacks into that band are the cleaner risk-defined buy zone."
        : "Nearest support is doing more work than overhead resistance right now. Dips into that level are the better spot to lean on.";
    } else if (
      (resistance.distancePct <= 0.9 && resistance.score >= support.score - 4) ||
      resistance.score >= support.score + 10
    ) {
      tone = "Resistance-led";
      toneClass = "bear";
      note = resistance.confluence
        ? "Call wall and trend resistance are clustered overhead. For longs, respect that supply band first."
        : "Overhead supply is closer than support, so the first reaction is more likely to stall there.";
    } else {
      tone = "Two-sided";
      note = "Neither side has a clean edge yet. Let the closer wall or MA cluster win before leaning too hard.";
    }
  } else if (support) {
    tone = "Support in focus";
    toneClass = "bull";
    note = "No nearby overhead cluster is stronger than the floor underneath price.";
  } else if (resistance) {
    tone = "Resistance in focus";
    toneClass = "bear";
    note = "Overhead supply is the clearest nearby reference, so chasing into it deserves extra caution.";
  }

  if (pivots[0] && pivots[0].distancePct <= 0.3) {
    note += ` Spot is also sitting almost directly on ${levelName(pivots[0])}, so expect quicker whipsaws until it resolves.`;
  }

  return { tone, toneClass, note, support, resistance };
}

function nearestWall(walls: Wall[] | undefined, spot: number) {
  if (!walls?.length || !Number.isFinite(spot)) return -1;
  return walls.reduce((best, wall, idx, arr) => {
    return Math.abs(wall.strike - spot) < Math.abs(arr[best].strike - spot) ? idx : best;
  }, 0);
}

export function CalculatorShell() {
  const [tickerInput, setTickerInput] = useState("NVDA");
  const [activeTicker, setActiveTicker] = useState("NVDA");
  const [launchKey, setLaunchKey] = useState(0);
  const [setup, setSetup] = useState<SetupState>({
    spot: "",
    strike: "",
    dte: "180",
    iv: "",
  });
  const [setupDirty, setSetupDirty] = useState(false);
  const [health, setHealth] = useState<HealthState>({
    status: "checking",
    text: "Checking calculator engine...",
  });
  const [snapshot, setSnapshot] = useState<SnapshotState>({
    quote: null,
    catalyst: null,
    levels: null,
    loading: true,
    error: null,
  });

  const calculatorBaseUrl = useMemo(() => {
    return trimTrailingSlash(process.env.NEXT_PUBLIC_CALCULATOR_URL ?? FALLBACK_URL);
  }, []);

  const iframeSrc = useMemo(() => {
    const params = new URLSearchParams();
    params.set("apiBase", calculatorBaseUrl);
    if (activeTicker.trim()) params.set("ticker", activeTicker.trim().toUpperCase());
    if (setup.spot.trim()) params.set("price", setup.spot.trim());
    if (setup.strike.trim()) params.set("strike", setup.strike.trim());
    if (setup.dte.trim()) params.set("dte", setup.dte.trim());
    if (setup.iv.trim()) params.set("iv", setup.iv.trim());
    const query = params.toString();
    return `/options_calculator.html${query ? `?${query}` : ""}`;
  }, [activeTicker, calculatorBaseUrl, setup.dte, setup.iv, setup.spot, setup.strike]);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const response = await fetch(`${calculatorBaseUrl}/health`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { version?: string };
        if (!cancelled) {
          setHealth({
            status: "live",
            text: payload.version ? `Engine live v${payload.version}` : "Engine live",
          });
        }
      } catch {
        if (!cancelled) {
          setHealth({
            status: "offline",
            text: "Backend not reachable yet. Start FastAPI locally or point the shell at your deployed API.",
          });
        }
      }
    }

    void checkHealth();
    return () => {
      cancelled = true;
    };
  }, [calculatorBaseUrl]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadSnapshot() {
      setSnapshot((current) => ({ ...current, loading: true, error: null }));
      try {
        const [quoteRes, catalystRes, levelsRes] = await Promise.all([
          fetch(`${calculatorBaseUrl}/quote/${activeTicker}`, { cache: "no-store", signal: controller.signal }),
          fetch(`${calculatorBaseUrl}/catalyst/${activeTicker}`, { cache: "no-store", signal: controller.signal }),
          fetch(`${calculatorBaseUrl}/levels/${activeTicker}`, { cache: "no-store", signal: controller.signal }),
        ]);

        if (!quoteRes.ok) throw new Error(`Quote request failed (${quoteRes.status})`);

        const quote = (await quoteRes.json()) as QuoteData & { error?: string };
        const catalyst = catalystRes.ok ? ((await catalystRes.json()) as CatalystData & { error?: string }) : null;
        const levels = levelsRes.ok ? ((await levelsRes.json()) as LevelsData & { error?: string }) : null;
        if (quote.error) throw new Error(quote.error);

        if (!cancelled) {
          setSnapshot({
            quote,
            catalyst: catalyst && !("error" in catalyst && catalyst.error) ? catalyst : null,
            levels: levels && !("error" in levels && levels.error) ? levels : null,
            loading: false,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSnapshot({
            quote: null,
            catalyst: null,
            levels: null,
            loading: false,
            error: error instanceof Error ? error.message : "Live snapshot failed.",
          });
        }
      }
    }

    void loadSnapshot();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTicker, calculatorBaseUrl, launchKey]);

  useEffect(() => {
    if (!snapshot.quote || setupDirty) return;

    const nextSpot = snapshot.quote.price.toFixed(2);
    const nextStrike = Math.round(snapshot.quote.price).toFixed(2);
    const nextIv =
      snapshot.quote.iv_pct != null && Number.isFinite(snapshot.quote.iv_pct)
        ? snapshot.quote.iv_pct.toFixed(1)
        : "30.0";

    setSetup((current) => ({
      spot: nextSpot,
      strike: nextStrike,
      dte: current.dte || "180",
      iv: nextIv,
    }));
  }, [setupDirty, snapshot.quote]);

  const spot = snapshot.quote?.price ?? snapshot.levels?.price ?? 0;
  const read = useMemo(() => marketReadSummary(snapshot.levels, spot), [snapshot.levels, spot]);
  const nearestCallIdx = useMemo(() => nearestWall(snapshot.levels?.call_walls, spot), [snapshot.levels?.call_walls, spot]);
  const nearestPutIdx = useMemo(() => nearestWall(snapshot.levels?.put_walls, spot), [snapshot.levels?.put_walls, spot]);

  const movingAverageEntries = useMemo(() => {
    const ma = snapshot.levels?.moving_averages ?? {};
    return MA_ORDER.filter(([key]) => Number.isFinite(ma[key])).map(([key, label]) => ({
      key,
      label,
      price: Number(ma[key]),
    }));
  }, [snapshot.levels?.moving_averages]);

  const nearestMaKey = useMemo(() => {
    if (!movingAverageEntries.length || !Number.isFinite(spot)) return "";
    return movingAverageEntries.reduce((best, item) => {
      if (!best) return item.key;
      const bestPrice = movingAverageEntries.find((entry) => entry.key === best)?.price ?? 0;
      return Math.abs(item.price - spot) < Math.abs(bestPrice - spot) ? item.key : best;
    }, "");
  }, [movingAverageEntries, spot]);

  const primarySupport = read?.support ?? null;
  const primaryResistance = read?.resistance ?? null;
  const topSupport = (snapshot.levels?.put_walls ?? []).slice(0, 2);
  const topResistance = (snapshot.levels?.call_walls ?? []).slice(0, 2);
  const topTrend = movingAverageEntries.slice(0, 3);

  function updateSetup<K extends keyof SetupState>(key: K, value: SetupState[K]) {
    setSetupDirty(true);
    setSetup((current) => ({ ...current, [key]: value }));
  }

  function refreshTicker() {
    const nextTicker = tickerInput.trim().toUpperCase() || "NVDA";
    if (nextTicker !== activeTicker) {
      setSetupDirty(false);
      setSetup((current) => ({
        spot: "",
        strike: "",
        dte: current.dte || "180",
        iv: "",
      }));
    }
    setActiveTicker(nextTicker);
    setTickerInput(nextTicker);
    setLaunchKey((value) => value + 1);
  }

  return (
    <section className="shell-card trading-shell">
      <div className="trade-toolbar">
        <div className="trade-toolbar-main">
          <span className="eyebrow">Trading Mode</span>
          <div className="trade-control-row">
            <input
              className="ticker-input"
              aria-label="Ticker"
              value={tickerInput}
              onChange={(event) => setTickerInput(event.target.value.toUpperCase())}
              placeholder="NVDA"
            />
            <button className="primary-btn" onClick={refreshTicker}>
              Fetch Live
            </button>
            <a className="secondary-btn" href={iframeSrc} target="_blank" rel="noreferrer">
              Open Full Screen
            </a>
          </div>
          <div className="trade-meta-row">
            <strong>{snapshot.quote?.company ?? activeTicker}</strong>
            <span>{snapshot.quote?.sector ?? "Live snapshot"}</span>
            {snapshot.levels?.reference_expiry ? <span>Walls {snapshot.levels.reference_expiry}</span> : null}
          </div>
        </div>
        <div className={`status-badge ${health.status}`}>
          <span className="status-dot" />
          <span>{health.text}</span>
        </div>
      </div>

      <div className="insight-strip">
        <article className="insight-card">
          <span className="level-kicker">Spot</span>
          <strong>{fmtDollar(spot)}</strong>
          <p>
            {snapshot.quote?.iv_pct != null ? `${snapshot.quote.iv_pct.toFixed(1)}% ${ivSourceLabel(snapshot.quote.iv_source)}` : "IV --"} |{" "}
            {snapshot.quote?.hv30 != null ? `${snapshot.quote.hv30.toFixed(1)}% HV30` : "HV30 --"}
          </p>
        </article>

        <article className="insight-card catalyst">
          <span className="level-kicker">Catalyst</span>
          <strong>
            {snapshot.catalyst?.earnings_date ? `Earnings ${snapshot.catalyst.earnings_date}` : "No event mapped"}
          </strong>
          <p>
            {snapshot.catalyst?.implied_move_pct != null
              ? `+/-${snapshot.catalyst.implied_move_pct}% implied move`
              : "Catalyst timing unavailable"}
          </p>
        </article>

        <article className="insight-card support">
          <span className="level-kicker">Primary support</span>
          <strong>{primarySupport?.band ?? "--"}</strong>
          <p>{clusterNote(primarySupport, "support")}</p>
        </article>

        <article className="insight-card resistance">
          <span className="level-kicker">Primary resistance</span>
          <strong>{primaryResistance?.band ?? "--"}</strong>
          <p>{clusterNote(primaryResistance, "resistance")}</p>
        </article>

        <article className={`insight-card bias ${read?.toneClass ?? "neutral"}`}>
          <span className="level-kicker">Read</span>
          <strong>{read?.tone ?? "Waiting for levels"}</strong>
          <p>{read?.note ?? "Fetch a live ticker to rank support and resistance."}</p>
        </article>
      </div>

      {snapshot.error ? <div className="native-error">{snapshot.error}</div> : null}

      <div className="shell-grid">
        <div className="launch-grid">
          <div className="stack-card compact-card">
            <h3>Setup</h3>
            <div className="mini-field-grid">
              <div className="field-row">
                <label htmlFor="setup-spot">Spot ($)</label>
                <input
                  id="setup-spot"
                  inputMode="decimal"
                  value={setup.spot}
                  onChange={(event) => updateSetup("spot", event.target.value)}
                  placeholder="182.08"
                />
              </div>
              <div className="field-row">
                <label htmlFor="setup-strike">Strike ($)</label>
                <input
                  id="setup-strike"
                  inputMode="decimal"
                  value={setup.strike}
                  onChange={(event) => updateSetup("strike", event.target.value)}
                  placeholder="182.00"
                />
              </div>
              <div className="field-row">
                <label htmlFor="setup-dte">Days to expiry</label>
                <input
                  id="setup-dte"
                  inputMode="numeric"
                  value={setup.dte}
                  onChange={(event) => updateSetup("dte", event.target.value)}
                  placeholder="180"
                />
              </div>
              <div className="field-row">
                <label htmlFor="setup-iv">Implied vol (%)</label>
                <input
                  id="setup-iv"
                  inputMode="decimal"
                  value={setup.iv}
                  onChange={(event) => updateSetup("iv", event.target.value)}
                  placeholder="40.2"
                />
              </div>
            </div>
            <p className="support-note">
              Live quote data seeds these first. Tweak them here, then use the full surface for the
              heatmap and chain.
            </p>
          </div>

          <div className="status-card compact-card">
            <h3>Level Stack</h3>

            <div className="level-section">
              <span className="level-kicker">Resistance</span>
              <div className="pill-row compact">
                {topResistance.length ? (
                  topResistance.map((wall, idx) => (
                    <span className={`lvl-pill call ${idx === nearestCallIdx ? "focus" : ""}`} key={`res-${wall.strike}`}>
                      {`C ${wall.strike.toFixed(2)} | ${wallMetric(wall)}`}
                    </span>
                  ))
                ) : (
                  <span className="lvl-pill ref">No call wall</span>
                )}
              </div>
            </div>

            <div className="level-section">
              <span className="level-kicker">Support</span>
              <div className="pill-row compact">
                {topSupport.length ? (
                  topSupport.map((wall, idx) => (
                    <span className={`lvl-pill put ${idx === nearestPutIdx ? "focus" : ""}`} key={`sup-${wall.strike}`}>
                      {`P ${wall.strike.toFixed(2)} | ${wallMetric(wall)}`}
                    </span>
                  ))
                ) : (
                  <span className="lvl-pill ref">No put wall</span>
                )}
              </div>
            </div>

            <div className="level-section">
              <span className="level-kicker">Trend</span>
              <div className="pill-row compact">
                {topTrend.length ? (
                  topTrend.map((entry) => (
                    <span className={`lvl-pill ma ${entry.key === nearestMaKey ? "focus" : ""}`} key={entry.key}>
                      {`${entry.label} $${entry.price.toFixed(2)}`}
                    </span>
                  ))
                ) : (
                  <span className="lvl-pill ref">No trend markers</span>
                )}
              </div>
            </div>

            <div className="pill-row compact">
              {snapshot.levels?.reference_expiry ? <span className="lvl-pill ref">{snapshot.levels.reference_expiry}</span> : null}
              {snapshot.levels?.reference_dte != null ? <span className="lvl-pill ref">{snapshot.levels.reference_dte}d</span> : null}
              {snapshot.levels?.source_expiries?.length ? (
                <span className="lvl-pill ref">{snapshot.levels.source_expiries.length} exps</span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="surface-wrap">
          <div className="surface-head">
            <div>
              <div className="surface-title">Calculator Surface</div>
              <div className="surface-note">
                Heatmap and chain stay center stage while the shell carries the live read.
              </div>
            </div>
            <div className="surface-note">{calculatorBaseUrl}</div>
          </div>
          <div className="iframe-wrap">
            <iframe key={`${iframeSrc}:${launchKey}`} src={iframeSrc} title="SwingEdge Options Calculator" />
          </div>
        </div>
      </div>
    </section>
  );
}
