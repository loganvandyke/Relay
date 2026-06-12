# Deployment Guide

This wiki covers everything needed to deploy Relay from scratch — for a new event, a new environment, or a full migration.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Planning Center Setup](#planning-center-setup)
- [Azure Setup](#azure-setup)
- [Local Development](#local-development)
- [Production Deployment (Azure)](#production-deployment-azure)
- [Domain & SSL (Cloudflare)](#domain--ssl-cloudflare)
- [Environment Variables Reference](#environment-variables-reference)
- [Per-Event Configuration](#per-event-configuration)
- [Post-Event Checklist](#post-event-checklist)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

You'll need the following installed and configured:

| Tool | Version | Install |
|---|---|---|
| Node.js | 22+ | [nodejs.org](https://nodejs.org) |
| Azure CLI | latest | `brew install azure-cli` |
| Git | any | pre-installed on macOS |

You'll also need accounts for:
- **Azure** — for App Service and Table Storage
- **Planning Center Online** — with admin access to your organization
- **Cloudflare** — if using a custom domain with SSL

---

## Planning Center Setup

### 1. Create a Personal Access Token

1. Go to [api.planningcenteronline.com/oauth/applications](https://api.planningcenteronline.com/oauth/applications)
2. Click **New Personal Access Token**
3. Name it something like `Freedom Crusade Scanner 2026`
4. Copy the **Application ID** and **Secret** — you'll need these as `PCO_APP_ID` and `PCO_SECRET`

> ⚠️ Rotate this token after each event. Personal access tokens have full API access to your PCO org.

### 2. Create an Event Form

1. In Planning Center People, go to **Forms**
2. Create a new form for your event (e.g. "Jesus is Lord Freedom Crusade 2026")
3. After saving, note the form ID from the URL: `https://people.planningcenteronline.com/forms/`**`1234567`**
4. Set this as `PCO_FORM_ID`

### 3. Create a Note Category

1. In Planning Center People, go to **Settings → Note Categories**
2. Create a category for your event (e.g. "Freedom Crusade June 2026")
3. Find the category ID via the API:
   ```bash
   curl -u "YOUR_APP_ID:YOUR_SECRET" \
     "https://api.planningcenteronline.com/people/v2/note_categories"
   ```
4. Find your category in the response and note its `id`
5. Set this as `PCO_NOTE_CATEGORY_ID`

### 4. Verify Campuses (Optional)

The app pulls your campus list directly from PCO. Verify they're set up:

```bash
curl -u "YOUR_APP_ID:YOUR_SECRET" \
  "https://api.planningcenteronline.com/people/v2/campuses"
```

---

## Azure Setup

### 1. Login to Azure CLI

```bash
az login
```

### 2. Create a Resource Group

```bash
az group create \
  --name freedom-crusade-rg \
  --location eastus
```

### 3. Create an App Service Plan

```bash
az appservice plan create \
  --name freedom-crusade-plan \
  --resource-group freedom-crusade-rg \
  --sku B1 \
  --is-linux
```

### 4. Create the Web App

```bash
az webapp create \
  --name your-app-name \
  --resource-group freedom-crusade-rg \
  --plan freedom-crusade-plan \
  --runtime "NODE:22-lts"
```

### 5. Create Azure Table Storage

```bash
az storage account create \
  --name yourstoragename \
  --resource-group freedom-crusade-rg \
  --location eastus \
  --sku Standard_LRS \
  --kind StorageV2
```

Get the connection string:

```bash
az storage account show-connection-string \
  --name yourstoragename \
  --resource-group freedom-crusade-rg \
  --query connectionString \
  --output tsv
```

Copy the full connection string — you'll need it as `AZURE_STORAGE_CONNECTION_STRING`.

### 6. Configure App Settings

Set all environment variables in Azure (never in code):

```bash
az webapp config appsettings set \
  --name your-app-name \
  --resource-group freedom-crusade-rg \
  --settings \
    PCO_APP_ID="your_pco_app_id" \
    PCO_SECRET="your_pco_secret" \
    PCO_FORM_ID="your_form_id" \
    PCO_NOTE_CATEGORY_ID="your_note_category_id" \
    APP_PASSWORD="your_event_password" \
    SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
    AZURE_STORAGE_CONNECTION_STRING="your_connection_string" \
    SCM_DO_BUILD_DURING_DEPLOYMENT=true \
    WEBSITE_NODE_DEFAULT_VERSION="~22"
```

> 💡 Generate a strong `SESSION_SECRET` with:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Local Development

### 1. Clone the repo

```bash
git clone https://github.com/yourusername/freedom-crusade-scanner.git
cd freedom-crusade-scanner
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in your values. For local dev you can use the same PCO credentials as production — just use a test form.

### 4. Start the server

```bash
node server.js
```

The app will be available at [http://localhost:3000](http://localhost:3000).

> The root `/` redirects to `/guide.html`. The scanner app is at `/scanner`.

---

## Production Deployment (Azure)

### First Deploy

```bash
cd your-project-folder
npm install
zip -r deploy.zip . \
  --exclude "*.git*" \
  --exclude "node_modules/*" \
  --exclude ".env"

az webapp deploy \
  --name your-app-name \
  --resource-group freedom-crusade-rg \
  --src-path deploy.zip \
  --type zip \
  --async true
```

### Subsequent Deploys

Same command — Azure handles the update in place. The `SCM_DO_BUILD_DURING_DEPLOYMENT=true` setting means Azure runs `npm install` automatically.

> ⚠️ **Never deploy during a live event.** Deployment recycles the container. Schedule deploys before or after event hours.

### Verify Deploy

```bash
# Check app is running
curl https://your-app.azurewebsites.net/api/health

# Tail logs
az webapp log tail \
  --name your-app-name \
  --resource-group freedom-crusade-rg
```

A successful startup shows:
```
✓ Azure Table Storage connected
✓ Follow-up tables ready
✓ Locked to form ID: XXXXXXX
✓ Note category ID: XXXXXXX
Conference scanner running at http://localhost:8080
```

---

## Domain & SSL (Cloudflare)

### 1. Add a CNAME record

In your Cloudflare DNS dashboard, add:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `fcstaff` | `your-app.azurewebsites.net` | ✅ Proxied |

### 2. Add custom domain in Azure

```bash
az webapp config hostname add \
  --webapp-name your-app-name \
  --resource-group freedom-crusade-rg \
  --hostname fcstaff.yourdomain.org
```

### 3. Set SSL mode in Cloudflare

In Cloudflare → SSL/TLS → Overview, set to **Full** (not Full Strict).

### 4. Verify

```bash
curl https://fcstaff.yourdomain.org/api/health
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `PCO_APP_ID` | ✅ | Planning Center Personal Access Token App ID |
| `PCO_SECRET` | ✅ | Planning Center Personal Access Token Secret |
| `PCO_FORM_ID` | ✅ | ID of the event registration form in PCO |
| `PCO_NOTE_CATEGORY_ID` | ✅ | ID of the PCO note category for milestone notes |
| `APP_PASSWORD` | ✅ | Shared password for staff login |
| `SESSION_SECRET` | ✅ | Secret for signing session cookies (min 32 chars) |
| `AZURE_STORAGE_CONNECTION_STRING` | ✅ | Full Azure Table Storage connection string |
| `PCO_BADGE_FIELD_ID` | ⬜ | Optional: PCO custom field ID for storing badge numbers |
| `PORT` | ⬜ | Server port — Azure sets this automatically (default: 3000) |

---

## Per-Event Configuration

To run the app for a new event:

### 1. Update PCO configuration

In Planning Center:
1. Create a new event form
2. Create a new note category
3. Note both IDs

### 2. Update Azure App Settings

```bash
az webapp config appsettings set \
  --name your-app-name \
  --resource-group freedom-crusade-rg \
  --settings \
    PCO_FORM_ID="new_form_id" \
    PCO_NOTE_CATEGORY_ID="new_category_id" \
    APP_PASSWORD="new_event_password"
```

### 3. Clear event data from Azure Table Storage

The badge map and follow-up data from the previous event will still be in storage. For a clean start:

```bash
# Delete and recreate the tables
az storage table delete \
  --name badges \
  --connection-string "your_connection_string"

az storage table delete \
  --name followups \
  --connection-string "your_connection_string"

# The app recreates tables automatically on next startup
```

> ⚠️ Only do this after you've confirmed all follow-up from the previous event is complete. The audit log and contact log are worth keeping.

### 4. Update event details in the front-end

In `public/index.html` and `public/guide.html`, update:
- Event name
- Event dates
- Event location
- Schedule

### 5. Rotate the PCO Personal Access Token

```bash
# Revoke old token at:
# https://api.planningcenteronline.com/oauth/applications

# Create new token, then update in Azure:
az webapp config appsettings set \
  --name your-app-name \
  --resource-group freedom-crusade-rg \
  --settings \
    PCO_APP_ID="new_app_id" \
    PCO_SECRET="new_secret"
```

---

## Post-Event Checklist

Run through this after every event:

```
[ ] Export follow-up data to CSV before clearing tables
[ ] Confirm all Pending PCO Sync items are pushed
[ ] Rotate PCO Personal Access Token
[ ] Change APP_PASSWORD for next event
[ ] Back up Azure Table Storage data if needed
[ ] Update event results in README.md
[ ] Add screenshots to /screenshots folder
```

---

## Troubleshooting

### `Cannot GET /api/...`
The route doesn't exist in the running server. The deployed code may be stale. Redeploy and check the startup logs.

### PCO API returns 404 on search
The search parameter may be wrong. The correct parameter is `where[search_name_or_email]`. Test directly:
```bash
curl -u "APP_ID:SECRET" \
  "https://api.planningcenteronline.com/people/v2/people?where%5Bsearch_name_or_email%5D=John"
```

### Campuses dropdown is empty
The `/api/campuses` endpoint requires authentication. Make sure the user is logged in before the Follow-up tab loads. Check the browser console for a `Campuses loaded: N` log line.

### Azure Table Storage not connecting
Check the connection string is set correctly:
```bash
az webapp config appsettings list \
  --name your-app-name \
  --resource-group freedom-crusade-rg \
  --query "[?name=='AZURE_STORAGE_CONNECTION_STRING']"
```
The startup log should show `✓ Azure Table Storage connected`.

### Site takes 3–5 minutes to start after deploy
Normal behavior on Azure App Service B1 — the container needs to warm up. The deploy command returns before the site is ready. Wait for the startup log to show `Conference scanner running`.

### Badge camera not working on iOS
The camera requires HTTPS and `playsinline`, `autoplay`, and `muted` attributes on the video element — all present in the current build. If it still doesn't work, ensure the site is being accessed over HTTPS (not HTTP) and that camera permissions are granted in iOS Settings → Safari.

### Session resets unexpectedly
Azure B1 can recycle containers. Sessions are in-memory — they won't survive a container restart. This is expected behavior. Users simply log in again. Badge data and follow-up data in Azure Table Storage are unaffected.

---

## Architecture Notes

The app uses `app.set('trust proxy', 1)` which is required for:
- The rate limiter to work correctly behind Azure's load balancer
- Cloudflare's real IP to be readable via `CF-Connecting-IP`

All routes that require authentication use the `requireAuth` middleware, which also calls `trackSession()` to update the active session map used by the status page.

Specific routes must be defined **before** wildcard parameter routes in Express. For example, `GET /api/people/search` must come before `GET /api/people/:personId` — otherwise Express matches `search` as a person ID and returns a 404 from PCO.

---

*Relay — [logvan.com](https://logvan.com)*
