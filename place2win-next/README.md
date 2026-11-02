# FOOTBALL AI HUB

A responsive football data and analysis site. The browser interface is in `place2win-next`; Supabase Edge Functions keep provider and AI keys on the server.

## Stage 1: run the interface

From this folder, serve `place2win-next` over HTTP:

```powershell
cd .\place2win-next
python -m http.server 3000 --bind 127.0.0.1
```

Open `http://127.0.0.1:3000`. Fixture loading requires the Supabase functions and API-Football configuration described below. The site does not fall back to sample scores.

## Stage 2: configure Supabase

This project currently targets the Supabase project configured in `place2win-next/app.js`. Keep `sb_publishable_...` in the browser; never put an API-Football, OpenAI, or Supabase service-role/secret key in browser code.

Apply migrations in order in the Supabase SQL editor:

1. `supabase/migrations/202610230001_vip_subscription_access.sql` (sets up VIP payment access and the admin-check function).
2. `supabase/migrations/202611010001_football_hub_competitions.sql` (sets up shared league visibility controls).

Add these server-side Edge Function secrets in Supabase:

- `API_FOOTBALL_KEY` — API-Football key for fixtures, events, statistics, history, injuries, and provider predictions.
- `OPENAI_API_KEY` — only needed for generated AI forecasts and reports.
- `OPENAI_MODEL` — a model enabled for that OpenAI API project, if the prediction function uses an explicit model setting.
- `SUPABASE_SERVICE_ROLE_KEY` (legacy) **or** the new Supabase server secret-key configuration used by the deployed functions.

The public browser key is publishable and is already configured in `place2win-next/app.js`. Do not rotate or replace it without also updating that constant.

## Stage 3: deploy the functions

Deploy/update each function from `supabase/functions/<function-name>/index.ts`:

- `football-fixtures` — date-specific fixtures and current scores.
- `fixture-statistics` — actual provider match events, statistics and previous results.
- `ai-match-predictions` — on-demand provider-backed forecast generation and saved prediction retrieval.
- `football-predictions` — subscription-aware access to saved predictions.
- `football-news` — BBC Sport RSS headlines with links and attribution.
- `football-admin` — administrator-only user suspension and restoration.

Use Supabase CLI deployment or paste each `index.ts` into the matching function in the Dashboard. Keep the function names exactly as listed. The functions that accept browser calls need their project CORS origin allow-list updated if the production domain changes. The administrator function additionally requires the signed-in admin to have a row in `public.admin_users`.

## Data and access behavior

- Fixtures and live scores are fetched from API-Football and refreshed by the page every 30 seconds while open. Provider coverage and update delays depend on the API-Football plan and competition.
- Statistics, events, scorers, assists, cards, HT/FT and historical meetings appear only when the provider returns them. Missing values are shown as unavailable; they are not estimated.
- Forecasts are uncertain. The AI board runs on request, has a provider/API rate limit, and only displays markets returned with usable source data. A market is not guaranteed for every match.
- The free account sees the basic forecast; active Hub Plus/admin access unlocks advanced markets and additional analysis. VIP status is checked server-side by the prediction/statistics functions.
- Payment submission records a request for administrator review; it does not automatically charge a customer or activate a subscription.
- Favourite teams, saved picks, and notification reminders are stored in the signed-in user's metadata or this browser. Browser notifications require the visitor to grant permission.
- The match information from the football provider is read-only in the admin interface. Admins can manage saved tips, payments, account suspensions, and competition visibility.
- Football news is linked to BBC Sport and credited to its source.

## Current stage and deployment status

The front end and source functions are implemented in this worktree. New migrations and Edge Functions must be applied/deployed to the connected Supabase project before all live features are available. A source commit or GitHub Pages publish does not deploy Supabase functions or run SQL migrations. Do not describe the connected production site as updated until those deployments and the Pages publication are confirmed.

