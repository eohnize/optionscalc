"use client";

import { useEffect, useMemo, useState } from "react";

const FALLBACK_URL = "http://127.0.0.1:8765";

type HealthState =
  | { status: "checking"; text: string }
  | { status: "live"; text: string }
  | { status: "offline"; text: string };

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function CalculatorShell() {
  const [ticker, setTicker] = useState("NVDA");
  const [launchKey, setLaunchKey] = useState(0);
  const [health, setHealth] = useState<HealthState>({
    status: "checking",
    text: "Checking calculator engine...",
  });

  const calculatorBaseUrl = useMemo(() => {
    return trimTrailingSlash(process.env.NEXT_PUBLIC_CALCULATOR_URL ?? FALLBACK_URL);
  }, []);

  const iframeSrc = useMemo(() => {
    const params = new URLSearchParams();
    if (ticker.trim()) {
      params.set("ticker", ticker.trim().toUpperCase());
    }

    const query = params.toString();
    return `${calculatorBaseUrl}${query ? `?${query}` : ""}`;
  }, [calculatorBaseUrl, ticker]);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const response = await fetch(`${calculatorBaseUrl}/health`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as { version?: string };
        if (!cancelled) {
          setHealth({
            status: "live",
            text: payload.version ? `Engine live · v${payload.version}` : "Engine live",
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

  return (
    <section className="shell-card">
      <div className="shell-top">
        <div>
          <span className="eyebrow">App Shell</span>
          <h2>Launch the live calculator from a cleaner browser surface.</h2>
          <p>
            This keeps the current engine working while we migrate the controls, heatmap, and chain
            into native React screens. It is the fastest path to Vercel and an installable phone
            experience.
          </p>
        </div>
        <div className={`status-badge ${health.status}`}>
          <span className="status-dot" />
          <span>{health.text}</span>
        </div>
      </div>

      <div className="shell-grid">
        <div className="launch-grid">
          <div className="stack-card">
            <h3>Launch Controls</h3>
            <div className="field-row">
              <label htmlFor="ticker">Ticker</label>
              <input
                id="ticker"
                value={ticker}
                onChange={(event) => setTicker(event.target.value.toUpperCase())}
                placeholder="NFLX"
              />
            </div>
            <div className="button-row">
              <button className="primary-btn" onClick={() => setLaunchKey((value) => value + 1)}>
                Refresh Calculator
              </button>
              <a className="secondary-btn" href={iframeSrc} target="_blank" rel="noreferrer">
                Open Full Screen
              </a>
            </div>
            <p className="support-note">
              For phone use, the full-screen launch is the friendliest move right now. Once we port
              the internals into React, this same shell becomes the actual app.
            </p>
          </div>

          <div className="status-card">
            <h3>Deployment Shape</h3>
            <ul className="stack-list">
              <li>Next.js handles the landing page, mobile layout, and future PWA behavior.</li>
              <li>FastAPI keeps the pricing engine, catalyst logic, IV lookup, and market levels.</li>
              <li>The Vercel Python entrypoint sits in <code>api/index.py</code> for deployment.</li>
            </ul>
          </div>

          <div className="status-card">
            <h3>Recommended Rollout</h3>
            <ul className="stack-list">
              <li>Ship this shell first so the project is reachable from any browser.</li>
              <li>Port the parameter sidebar and market read into native React next.</li>
              <li>Then replace the legacy iframe with a React heatmap and chain view.</li>
            </ul>
          </div>
        </div>

        <div className="surface-wrap">
          <div className="surface-head">
            <div>
              <div className="surface-title">Live Engine Preview</div>
              <div className="surface-note">
                The current calculator is embedded as a migration bridge, not the final UI.
              </div>
            </div>
            <div className="surface-note">{calculatorBaseUrl}</div>
          </div>
          <div className="iframe-wrap">
            <iframe
              key={`${iframeSrc}:${launchKey}`}
              src={iframeSrc}
              title="SwingEdge Options Calculator"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
