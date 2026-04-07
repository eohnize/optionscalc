# SwingEdge Options Web App Draft

This folder is the deployment sandbox for the browser and phone-friendly version of the Options Calculator.
The original desktop calculator at the repo root stays untouched for PC use.

## What is here

- `options_calc_server.py`
  - The current FastAPI pricing and market-level engine
- `options_calculator.html`
  - The working legacy calculator UI
- `api/index.py`
  - Vercel Python entrypoint that reuses the FastAPI app
- `app/` and `components/`
  - The new Next.js shell for browser and phone-friendly access

## Local development

1. Start the Python backend:

```powershell
python options_calc_server.py
```

2. Create a local env file from `.env.example`:

```powershell
Copy-Item .env.example .env.local
```

3. Install the frontend dependencies:

```powershell
npm install
```

4. Start the Next.js shell:

```powershell
npm run dev
```

5. Open `http://localhost:3000`

The shell embeds the current calculator and points at `NEXT_PUBLIC_CALCULATOR_URL`.

## Vercel shape

- Frontend: Next.js
- Backend: FastAPI exposed through `api/index.py`
- For a same-project deploy, set:

```text
NEXT_PUBLIC_CALCULATOR_URL=/api
```

## First-time deployment

Use the hand-holding guide in:

- `DEPLOY_VERCEL.md`

Important:

- when importing into Vercel, set `Root Directory` to `web-app`

## Suggested next migration steps

1. Port the sidebar controls into React.
2. Port the market read strip and top-level cards into native components.
3. Replace the embedded legacy heatmap with a React heatmap fed by the same API.
