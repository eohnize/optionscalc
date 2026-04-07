# SwingEdge Options API

This folder is the backend-only Vercel deployment package for the SwingEdge Options Calculator.

## What it contains

- `index.py`
  - Vercel FastAPI entrypoint
- `options_calc_server.py`
  - Pricing, catalyst, IV, and market-level engine
- `requirements.txt`
  - Python dependencies for the backend deployment
- `.python-version`
  - Pins the Python runtime on Vercel

## Why this exists

The frontend shell in `web-app` deploys cleanly on Vercel, but mixing the Next.js app and FastAPI app in one first-time deployment created routing issues for `/api/*`.

This backend-only package avoids that complexity.

## Expected deployment result

Once deployed, these should work:

- `/health`
- `/quote/NVDA`
- `/catalyst/NVDA`
- `/levels/NVDA`
- `/option_iv/NVDA?...`

## After backend deployment

Update the frontend Vercel environment variable:

```text
NEXT_PUBLIC_CALCULATOR_URL=https://YOUR-BACKEND-PROJECT.vercel.app
```
