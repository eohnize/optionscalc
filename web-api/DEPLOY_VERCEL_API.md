# Deploying the Backend on Vercel

This is the second Vercel project. It is backend-only.

## Project shape

Deploy this folder:

- `web-api`

Important:

- this is not a Next.js project
- this is a FastAPI project

## Files that matter

- `index.py`
- `options_calc_server.py`
- `requirements.txt`
- `.python-version`

## Vercel setup

When importing into Vercel:

1. Choose the same GitHub repository
2. Set `Root Directory` to:

```text
web-api
```

3. For the framework preset:

- if Vercel auto-detects Python or FastAPI, keep it
- if it does not, that is okay, as long as it sees `index.py` and `requirements.txt`

4. Do not add the frontend env var here

## After deploy

Test these URLs:

```text
https://YOUR-BACKEND-URL.vercel.app/health
https://YOUR-BACKEND-URL.vercel.app/quote/NVDA
```

If those return JSON, the backend is good.

## Then update the frontend

In your existing `optionscalc` frontend Vercel project:

1. Open `Settings`
2. Open `Environment Variables`
3. Change:

```text
NEXT_PUBLIC_CALCULATOR_URL=/api
```

to:

```text
NEXT_PUBLIC_CALCULATOR_URL=https://YOUR-BACKEND-URL.vercel.app
```

4. Redeploy the frontend
