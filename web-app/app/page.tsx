import { CalculatorShell } from "@/components/calculator-shell";

const pillars = [
  {
    title: "Live levels first",
    text: "Keep call walls, put walls, catalysts, and trend averages at the center of the workflow.",
  },
  {
    title: "Phone-friendly path",
    text: "Start with a browser app and PWA shell now, then port the calculator internals section by section.",
  },
  {
    title: "Deployable shape",
    text: "Next.js handles the shell while FastAPI keeps the pricing and market logic intact.",
  },
];

const roadmap = [
  "Phase 1: wrapper shell, PWA metadata, Vercel-ready repo structure",
  "Phase 2: replace the iframe with native React controls and heatmap rendering",
  "Phase 3: add watchlists, saved setups, trade notes, and push-friendly alerts",
];

export default function Home() {
  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">SwingEdge Options</span>
          <h1>Browser-first shell for the calculator, built to grow into a real phone app.</h1>
          <p>
            This first draft keeps the working Python engine alive, wraps it in a cleaner mobile
            surface, and gets the project into a shape we can deploy to Vercel without losing the
            market-level logic we already trust.
          </p>
        </div>
        <div className="hero-grid">
          {pillars.map((pillar) => (
            <article className="mini-card" key={pillar.title}>
              <h2>{pillar.title}</h2>
              <p>{pillar.text}</p>
            </article>
          ))}
        </div>
      </section>

      <CalculatorShell />

      <section className="roadmap-card">
        <div>
          <span className="eyebrow">Migration Path</span>
          <h2>What this unlocks next</h2>
        </div>
        <div className="roadmap-list">
          {roadmap.map((item) => (
            <div className="roadmap-item" key={item}>
              {item}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
