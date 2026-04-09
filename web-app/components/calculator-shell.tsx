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

type ContractCandidate = {
  expiry: string;
  dte: number;
  strike: number;
  otm_pct: number;
  iv_pct?: number | null;
  iv_source?: string | null;
  chain_iv_pct?: number | null;
  previous_contract_iv_pct?: number | null;
  iv_change_pct_pts?: number | null;
  mark_price?: number | null;
  mark_source?: string | null;
  spread_pct?: number | null;
  previous_contract_close?: number | null;
  previous_close_source?: string | null;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  contract_change?: number | null;
  contract_change_pct?: number | null;
  open_interest?: number | null;
  volume?: number | null;
  liquidity_score?: number | null;
};

type ContractAssistantData = {
  ticker: string;
  option_type: string;
  spot_price: number;
  previous_spot_close?: number | null;
  min_dte: number;
  max_dte: number;
  max_otm_pct: number;
  candidates?: ContractCandidate[];
  best_candidate?: ContractCandidate | null;
  note?: string | null;
};

type AssistantState = {
  data: ContractAssistantData | null;
  loading: boolean;
  error: string | null;
};

type AssistantPrefs = {
  minDte: string;
  maxDte: string;
  maxOtmPct: string;
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
  bandPct: number;
  bandLabel: "Single" | "Tight" | "Moderate" | "Wide";
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

function compact(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
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
      yf_chain: "Yahoo chain IV",
      options_chain: "ATM proxy",
      hv30_fallback: "HV30",
      atm_fallback: "ATM proxy",
      prefill: "Prefill IV",
    }[source] ?? "IV"
  );
}

function wallMetric(wall: Wall) {
  const oi = Number(wall.open_interest) || 0;
  const volume = Number(wall.volume) || 0;
  if (oi > 0) return `Yahoo OI ${compact(oi)}`;
  if (volume > 0) return `Yahoo vol ${compact(volume)}`;
  return "Yahoo activity";
}

function levelName(level: ReadLevel) {
  if (level.kind === "call") return `Call wall $${level.price.toFixed(2)}`;
  if (level.kind === "put") return `Put wall $${level.price.toFixed(2)}`;
  if (level.source === "prev_high") return `Prev High $${level.price.toFixed(2)}`;
  if (level.source === "prev_low") return `Prev Low $${level.price.toFixed(2)}`;
  return `${level.label} $${level.price.toFixed(2)}`;
}

function contractKey(candidate: ContractCandidate | null | undefined) {
  if (!candidate) return "";
  return `${candidate.expiry}|${candidate.strike.toFixed(2)}`;
}

function closenessBadge(distancePct: number | null | undefined) {
  if (!Number.isFinite(distancePct)) return { label: "--", tone: "far" as const };
  if (Number(distancePct) <= 0.35) return { label: "Close", tone: "close" as const };
  if (Number(distancePct) <= 1.0) return { label: "Near", tone: "near" as const };
  return { label: "Stretch", tone: "far" as const };
}

function bandMeaning(label: LevelCluster["bandLabel"] | null | undefined) {
  if (label === "Tight") return "Tighter bands usually mean cleaner reactions and easier risk definition.";
  if (label === "Moderate") return "Moderate bands still matter, but expect a bit more give around the zone.";
  if (label === "Wide") return "Wider bands usually mean looser structure and more chop before price commits.";
  return "Single levels can react quickly, but they carry less confluence than stacked bands.";
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

function pickLevelCluster(levels: ReadLevel[], spot: number): LevelCluster | null {
  if (!levels.length || !Number.isFinite(spot) || spot <= 0) return null;

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
  const range = prices.length > 1 ? Math.abs(prices[prices.length - 1] - prices[0]) : 0;
  const bandPct = range > 0 ? (range / spot) * 100 : 0;
  const band =
    range > 0.11 ? `$${prices[0].toFixed(2)}-$${prices[prices.length - 1].toFixed(2)}` : `$${anchor.price.toFixed(2)}`;
  const score = cluster.reduce((sum, level, idx) => sum + level.score - idx * 4, 0);
  const bandLabel: LevelCluster["bandLabel"] =
    cluster.length <= 1 ? "Single" : bandPct <= 0.4 ? "Tight" : bandPct <= 1.1 ? "Moderate" : "Wide";

  return {
    anchor,
    cluster,
    band,
    bandPct,
    bandLabel,
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
  const dist = closenessBadge(cluster.distancePct).label;
  return `${cluster.bandLabel} band around ${cluster.band} | ${lead} | ${dist}`;
}

function marketReadSummary(levelsData: LevelsData | null, spot: number): MarketRead | null {
  if (!levelsData || !Number.isFinite(spot) || spot <= 0) return null;

  const levels = overlayLevels(levelsData).map((level) => classifyLevelForRead(level, spot));
  const support = pickLevelCluster(levels.filter((level) => level.side === "support"), spot);
  const resistance = pickLevelCluster(levels.filter((level) => level.side === "resistance"), spot);
  const pivots = levels
    .filter((level) => level.side === "pivot")
    .sort((a, b) => a.distancePct - b.distancePct || b.score - a.score);

  let tone = "Balanced map";
  let toneClass: MarketRead["toneClass"] = "neutral";
  let note =
    "Walls usually matter first. EMAs and SMAs matter more when they stack into the same reaction band.";

  if (support && resistance) {
    const bothTight = Math.max(support.distancePct, resistance.distancePct) <= 1.2;
    const scoreGap = Math.abs(support.score - resistance.score);
    if (bothTight && Math.abs(support.distancePct - resistance.distancePct) <= 0.4 && scoreGap <= 10) {
      tone = "Compression zone";
      note = "Support and resistance are both nearby, so price may churn between them until one side wins decisively.";
    } else if (
      (support.distancePct <= 0.9 && support.score >= resistance.score - 4) ||
      support.score >= resistance.score + 10
    ) {
      tone = "Support-led";
      toneClass = "bull";
      note = support.confluence
        ? "Put wall and trend support are stacked together. Pullbacks into that band are the cleaner risk-defined buy zone."
        : "Nearest support is doing more work than overhead resistance right now, so dips into it deserve more attention.";
    } else if (
      (resistance.distancePct <= 0.9 && resistance.score >= support.score - 4) ||
      resistance.score >= support.score + 10
    ) {
      tone = "Resistance-led";
      toneClass = "bear";
      note = resistance.confluence
        ? "Call wall and trend resistance are clustered overhead. Respect that supply band before pressing fresh longs."
        : "Overhead supply is closer than support, so the first reaction is more likely to stall there.";
    } else {
      tone = "Two-sided";
      note = "Neither side has a clean edge yet. Let the closer wall or MA cluster show who is in control first.";
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

function buildLevelRows(levelsData: LevelsData | null, spot: number) {
  return overlayLevels(levelsData)
    .map((level) => classifyLevelForRead(level, spot))
    .filter((level) => level.distancePct <= 8 || level.side !== "pivot")
    .sort((a, b) => b.price - a.price)
    .slice(0, 10);
}

function sameSetup(a: SetupState, b: SetupState) {
  return a.spot === b.spot && a.strike === b.strike && a.dte === b.dte && a.iv === b.iv;
}

export function CalculatorShell() {
  const [tickerInput, setTickerInput] = useState("NVDA");
  const [activeTicker, setActiveTicker] = useState("NVDA");
  const [launchKey, setLaunchKey] = useState(0);
  const [selectedContractKey, setSelectedContractKey] = useState("");
  const [assistantPrefs, setAssistantPrefs] = useState<AssistantPrefs>({
    minDte: "180",
    maxDte: "270",
    maxOtmPct: "10",
  });
  const [setup, setSetup] = useState<SetupState>({
    spot: "",
    strike: "",
    dte: "180",
    iv: "",
  });
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
  const [assistant, setAssistant] = useState<AssistantState>({
    data: null,
    loading: true,
    error: null,
  });

  const calculatorBaseUrl = useMemo(() => trimTrailingSlash(process.env.NEXT_PUBLIC_CALCULATOR_URL ?? FALLBACK_URL), []);

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
    let cancelled = false;
    const controller = new AbortController();

    async function loadAssistant() {
      setAssistant({ data: null, loading: true, error: null });
      try {
        const params = new URLSearchParams({
          min_dte: assistantPrefs.minDte || "180",
          max_dte: assistantPrefs.maxDte || "270",
          max_otm_pct: assistantPrefs.maxOtmPct || "10",
          option_type: "call",
          max_results: "3",
        });

        const response = await fetch(`${calculatorBaseUrl}/contract_assistant/${activeTicker}?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Contract assistant failed (${response.status})`);
        const payload = (await response.json()) as ContractAssistantData & { error?: string };
        if (payload.error) throw new Error(payload.error);

        if (!cancelled) {
          setAssistant({
            data: payload,
            loading: false,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setAssistant({
            data: null,
            loading: false,
            error: error instanceof Error ? error.message : "Contract assistant failed.",
          });
        }
      }
    }

    void loadAssistant();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTicker, assistantPrefs.maxDte, assistantPrefs.maxOtmPct, assistantPrefs.minDte, calculatorBaseUrl, launchKey]);

  useEffect(() => {
    const spotText = snapshot.quote?.price != null ? snapshot.quote.price.toFixed(2) : setup.spot;
    const candidates = assistant.data?.candidates ?? [];
    const best = assistant.data?.best_candidate ?? candidates[0] ?? null;
    const selected = candidates.find((candidate) => contractKey(candidate) === selectedContractKey) ?? best;

    if (!selected) {
      if (spotText && spotText !== setup.spot) {
        setSetup((current) => ({ ...current, spot: spotText }));
      }
      return;
    }

    const nextSetup: SetupState = {
      spot: spotText,
      strike: selected.strike.toFixed(2),
      dte: String(selected.dte),
      iv: Number.isFinite(Number(selected.iv_pct)) ? Number(selected.iv_pct).toFixed(1) : setup.iv,
    };

    if (contractKey(selected) !== selectedContractKey) {
      setSelectedContractKey(contractKey(selected));
    }

    if (!sameSetup(setup, nextSetup)) {
      setSetup(nextSetup);
    }
  }, [assistant.data, selectedContractKey, setup, snapshot.quote?.price]);

  const spot = snapshot.quote?.price ?? snapshot.levels?.price ?? (Number(setup.spot) || 0);
  const read = useMemo(() => marketReadSummary(snapshot.levels, spot), [snapshot.levels, spot]);
  const levelRows = useMemo(() => buildLevelRows(snapshot.levels, spot), [snapshot.levels, spot]);

  const currentContract = useMemo(() => {
    const candidates = assistant.data?.candidates ?? [];
    return candidates.find((candidate) => contractKey(candidate) === selectedContractKey) ?? assistant.data?.best_candidate ?? null;
  }, [assistant.data, selectedContractKey]);

  function updateAssistantPrefs<K extends keyof AssistantPrefs>(key: K, value: AssistantPrefs[K]) {
    setSelectedContractKey("");
    setAssistantPrefs((current) => ({ ...current, [key]: value }));
  }

  function applyCandidate(candidate: ContractCandidate) {
    setSelectedContractKey(contractKey(candidate));
    setSetup({
      spot: snapshot.quote?.price != null ? snapshot.quote.price.toFixed(2) : setup.spot,
      strike: candidate.strike.toFixed(2),
      dte: String(candidate.dte),
      iv: Number.isFinite(Number(candidate.iv_pct)) ? Number(candidate.iv_pct).toFixed(1) : setup.iv,
    });
  }

  function refreshTicker() {
    const nextTicker = tickerInput.trim().toUpperCase() || "NVDA";
    setActiveTicker(nextTicker);
    setTickerInput(nextTicker);
    setSelectedContractKey("");
    setLaunchKey((value) => value + 1);
  }

  const primarySupport = read?.support ?? null;
  const primaryResistance = read?.resistance ?? null;

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
          <span className="level-kicker">Spot + IV</span>
          <strong>{fmtDollar(spot)}</strong>
          <p>
            {currentContract?.iv_pct != null
              ? `${Number(currentContract.iv_pct).toFixed(1)}% Contract IV`
              : snapshot.quote?.iv_pct != null
                ? `${snapshot.quote.iv_pct.toFixed(1)}% ${ivSourceLabel(snapshot.quote.iv_source)}`
                : "IV --"}
            {" | "}
            {currentContract?.previous_contract_iv_pct != null
              ? `Yday ${Number(currentContract.previous_contract_iv_pct).toFixed(1)}%`
              : "Yday IV --"}
          </p>
          <p>
            {snapshot.quote?.iv_pct != null ? `ATM proxy ${snapshot.quote.iv_pct.toFixed(1)}%` : "ATM proxy --"}
            {" | "}
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
          <div className="stack-card compact-card scout-card">
            <div className="card-head-inline">
              <div>
                <h3>Contract Assistant</h3>
                <p className="support-note">Lowest-IV call candidate inside your 180-270 DTE swing window.</p>
              </div>
            </div>

            <div className="assistant-filter-grid">
              <div className="field-row compact-input">
                <label htmlFor="assistant-min-dte">Min DTE</label>
                <input
                  id="assistant-min-dte"
                  inputMode="numeric"
                  value={assistantPrefs.minDte}
                  onChange={(event) => updateAssistantPrefs("minDte", event.target.value)}
                />
              </div>
              <div className="field-row compact-input">
                <label htmlFor="assistant-max-dte">Max DTE</label>
                <input
                  id="assistant-max-dte"
                  inputMode="numeric"
                  value={assistantPrefs.maxDte}
                  onChange={(event) => updateAssistantPrefs("maxDte", event.target.value)}
                />
              </div>
              <div className="field-row compact-input">
                <label htmlFor="assistant-max-otm">Max OTM %</label>
                <input
                  id="assistant-max-otm"
                  inputMode="decimal"
                  value={assistantPrefs.maxOtmPct}
                  onChange={(event) => updateAssistantPrefs("maxOtmPct", event.target.value)}
                />
              </div>
            </div>

            {assistant.error ? <div className="native-error">{assistant.error}</div> : null}

            {assistant.loading ? (
              <p className="support-note">Scanning long-call contracts for cleaner IV inside your chosen swing window...</p>
            ) : currentContract ? (
              <>
                <div className="assistant-highlight">
                  <div>
                    <span className="level-kicker">Best fit</span>
                    <strong>
                      ${currentContract.strike.toFixed(2)} call | {currentContract.expiry}
                    </strong>
                    <p>
                      {currentContract.dte}d | {currentContract.otm_pct.toFixed(1)}% OTM |{" "}
                      {fmtDollar(currentContract.mark_price ?? currentContract.last)} {currentContract.mark_source ?? "last"}
                    </p>
                  </div>
                  <button className="secondary-btn" onClick={() => applyCandidate(currentContract)}>
                    Use
                  </button>
                </div>

                <div className="assistant-stat-grid">
                  <article className="mini-stat">
                    <span className="level-kicker">Contract IV</span>
                    <strong>
                      {currentContract.iv_pct != null ? `${Number(currentContract.iv_pct).toFixed(1)}%` : "--"}
                    </strong>
                    <p>{ivSourceLabel(currentContract.iv_source)}</p>
                  </article>
                  <article className="mini-stat">
                    <span className="level-kicker">Yesterday</span>
                    <strong>
                      {currentContract.previous_contract_iv_pct != null
                        ? `${Number(currentContract.previous_contract_iv_pct).toFixed(1)}%`
                        : "--"}
                    </strong>
                    <p>
                      {currentContract.previous_contract_close != null
                        ? `close ${fmtDollar(currentContract.previous_contract_close)}`
                        : "prior close unavailable"}
                    </p>
                  </article>
                  <article className="mini-stat">
                    <span className="level-kicker">Yahoo chain</span>
                    <strong>
                      {currentContract.chain_iv_pct != null ? `${Number(currentContract.chain_iv_pct).toFixed(1)}%` : "--"}
                    </strong>
                    <p>
                      {currentContract.spread_pct != null
                        ? `${currentContract.spread_pct.toFixed(1)}% spread`
                        : "spread unavailable"}
                    </p>
                  </article>
                  <article className="mini-stat">
                    <span className="level-kicker">Liquidity</span>
                    <strong>
                      {(Number(currentContract.open_interest) || 0) > 0
                        ? `OI ${compact(currentContract.open_interest)}`
                        : `Vol ${compact(currentContract.volume)}`}
                    </strong>
                    <p>{assistant.data?.note ?? "Liquidity helps break ties, but IV still ranks first."}</p>
                  </article>
                </div>

                <div className="candidate-list">
                  {(assistant.data?.candidates ?? []).map((candidate) => {
                    const selected = contractKey(candidate) === contractKey(currentContract);
                    return (
                      <button
                        type="button"
                        className={`candidate-row ${selected ? "selected" : ""}`}
                        key={contractKey(candidate)}
                        onClick={() => applyCandidate(candidate)}
                      >
                        <div className="candidate-main">
                          <strong>
                            ${candidate.strike.toFixed(2)} | {candidate.expiry}
                          </strong>
                          <span>
                            {candidate.dte}d | {candidate.otm_pct.toFixed(1)}% OTM |{" "}
                            {candidate.iv_pct != null ? `${Number(candidate.iv_pct).toFixed(1)}% IV` : "IV --"}
                          </span>
                        </div>
                        <div className="candidate-side">
                          <span>{fmtDollar(candidate.mark_price ?? candidate.last)}</span>
                          <span>
                            {candidate.previous_contract_iv_pct != null
                              ? `Yday ${candidate.previous_contract_iv_pct.toFixed(1)}%`
                              : "Yday --"}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <p className="support-note">
                  Contract IV uses Black-Scholes inversion on the live mark when possible. The yesterday comparison uses the
                  prior contract close inferred from Yahoo&apos;s daily option change.
                </p>
              </>
            ) : (
              <p className="support-note">
                No call candidates were found inside this DTE / OTM window. Tighten or widen the scout filters and fetch again.
              </p>
            )}
          </div>

          <div className="status-card compact-card structure-card">
            <div className="card-head-inline">
              <div>
                <h3>Structure Map</h3>
                <p className="support-note">
                  Tighter bands usually mean cleaner reactions. Wider bands usually mean looser structure and more chop.
                </p>
              </div>
            </div>

            <div className="band-chip-row">
              <div className={`band-chip ${primarySupport ? primarySupport.bandLabel.toLowerCase() : "single"}`}>
                <span className="level-kicker">Support band</span>
                <strong>{primarySupport ? `${primarySupport.bandLabel} | ${closenessBadge(primarySupport.distancePct).label}` : "--"}</strong>
                <p>{primarySupport ? bandMeaning(primarySupport.bandLabel) : "No nearby support band yet."}</p>
              </div>
              <div className={`band-chip ${primaryResistance ? primaryResistance.bandLabel.toLowerCase() : "single"}`}>
                <span className="level-kicker">Resistance band</span>
                <strong>
                  {primaryResistance ? `${primaryResistance.bandLabel} | ${closenessBadge(primaryResistance.distancePct).label}` : "--"}
                </strong>
                <p>{primaryResistance ? bandMeaning(primaryResistance.bandLabel) : "No nearby resistance band yet."}</p>
              </div>
            </div>

            <div className="structure-ladder">
              {levelRows.length ? (
                levelRows.map((level) => {
                  const badge = closenessBadge(level.distancePct);
                  return (
                    <div className={`structure-row ${level.kind}`} key={`${level.source}-${level.price}`}>
                      <div className="structure-rail">
                        <span className="structure-dot" />
                      </div>
                      <div className="structure-body">
                        <div className="structure-main">
                          <span className={`lvl-pill ${level.kind === "call" ? "call" : level.kind === "put" ? "put" : "ma"}`}>
                            {level.kind === "call" ? "Call wall" : level.kind === "put" ? "Put wall" : level.label}
                          </span>
                          <strong>{fmtDollar(level.price)}</strong>
                          <span className={`distance-badge ${badge.tone}`}>{badge.label}</span>
                        </div>
                        <div className="structure-sub">
                          <span>{fmtPctDist(level.distancePct)} from spot</span>
                          {(level.kind === "call" || level.kind === "put") && (Number(level.open_interest) > 0 || Number(level.volume) > 0) ? (
                            <span>{wallMetric({ open_interest: level.open_interest, volume: level.volume, strike: level.price })}</span>
                          ) : (
                            <span>{level.side === "support" ? "Support marker" : level.side === "resistance" ? "Resistance marker" : "Pivot marker"}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="support-note">No nearby walls or moving averages are mapped yet for this ticker.</p>
              )}
            </div>

            <div className="data-note">
              <strong>Yahoo OI / vol</strong>
              <p>
                This is raw option-chain open interest or same-day volume by strike, aggregated across{" "}
                {snapshot.levels?.source_expiries?.length ?? 0} nearby expiries. It is not net premium, net OI, or GEX, so it can
                differ sharply from Cheddar-style flow data.
              </p>
            </div>
          </div>
        </div>

        <div className="surface-wrap">
          <div className="surface-head">
            <div>
              <div className="surface-title">Calculator Surface</div>
              <div className="surface-note">
                The browser shell scouts the cleaner contract and structure first. The full calculator still handles heatmap and chain work.
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
