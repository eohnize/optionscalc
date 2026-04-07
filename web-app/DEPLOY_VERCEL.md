# Deploying `web-app` to Vercel

This is the safest first-time path. We leave the root desktop calculator alone and deploy only the `web-app` subfolder.

## Before you begin

You need:

- a GitHub account
- a Vercel account
- this project pushed to a GitHub repository

If the repo is not on GitHub yet, do that first. Vercel is much easier when connected to GitHub.

## What Vercel will deploy

Inside `web-app`:

- `app/`
  - Next.js browser shell
- `api/index.py`
  - FastAPI entrypoint for Vercel
- `options_calc_server.py`
  - Calculator engine reused by the deployment
- `options_calculator.html`
  - Current calculator UI served through the Python app

## First deploy: recommended dashboard path

### 1. Import the repo

1. Log in to [Vercel](https://vercel.com/)
2. Click `Add New...`
3. Click `Project`
4. Import your GitHub repository

### 2. Set the root directory

This is the most important setting.

When Vercel asks for the project settings:

- `Root Directory`
  - set this to `web-app`

Do not leave it at the repo root.

### 3. Confirm framework detection

Vercel should detect:

- Framework Preset: `Next.js`

That is correct.

### 4. Add the environment variable

In the Environment Variables section, add:

- Name: `NEXT_PUBLIC_CALCULATOR_URL`
- Value: `/api`

This tells the Next.js shell to talk to the FastAPI app inside the same Vercel project.

### 5. Deploy

Click `Deploy`.

## After the first deploy

When the deployment finishes:

1. Open the deployed URL
2. Confirm the shell loads
3. Confirm the status badge says the engine is live
4. Launch a test ticker like `NVDA` or `NFLX`
5. Click `Fetch Live`

## If the page loads but live data fails

Check these in order:

### A. Root directory

Make sure the Vercel project root is exactly:

```text
web-app
```

### B. Environment variable

Make sure this exists in the Vercel project:

```text
NEXT_PUBLIC_CALCULATOR_URL=/api
```

### C. Python function deployed

Your deployment should include:

- `api/index.py`

That file exports:

```python
from options_calc_server import app
```

### D. Requirements installed

Make sure `requirements.txt` is present in `web-app`.

## Notes for this first version

- This setup uses Vercel's Python runtime for FastAPI.
- The official Vercel docs say the Python runtime is available in `Beta` on all plans as of January 30, 2026.
- That is good enough for a first deployment and testing.
- For a heavier production rollout later, we may choose to separate the Python API onto a dedicated Python host.

## Local test path later

Once Node is installed locally, you can test the shell from inside `web-app`:

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

For local FastAPI:

```powershell
python options_calc_server.py
```

Then open:

```text
http://localhost:3000
```

## Good first test tickers

- `NVDA`
- `NFLX`
- `AMZN`

These are useful because they usually expose whether:

- quote fetch works
- catalyst fetch works
- wall detection works
- contract IV fetch works

## If you want help during the actual deploy

When you reach the Vercel import screen, send me a screenshot of:

- the project settings page
- the root directory setting
- the environment variable section

and I’ll sanity-check it before you press deploy.
