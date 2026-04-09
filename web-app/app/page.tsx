import { CalculatorShell } from "@/components/calculator-shell";

export default function Home() {
  return (
    <main className="app-shell">
      <section className="trade-intro">
        <div>
          <span className="eyebrow">SwingEdge Options</span>
          <h1>Trading mode</h1>
          <p>
            Browser-first layout focused on live levels, event risk, and fast scenario work.
          </p>
        </div>
      </section>

      <CalculatorShell />
    </main>
  );
}
