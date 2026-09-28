# AZB-Glossar for Microsoft Teams

A small shared glossary for a Teams group chat. It is one plain, dark page: an
alphabetical overview of all terms, laid out in columns to use the full width
of a desktop tab. Click a term to read its explanation. Anyone in the chat can
add and edit terms; deleting needs an admin key.

- One container, no npm dependencies, no database (a JSON file plus daily backups).
- Built to run as a tab inside a Teams chat: it can be framed by Teams, tells
  Teams when it has loaded, sets no cookies, uses no popups and loads nothing
  from other websites. Teams needs a small app package for that; see
  [Show it inside Teams](#show-it-inside-teams).
- Design: [docs/superpowers/specs/2026-09-28-glossary-design.md](docs/superpowers/specs/2026-09-28-glossary-design.md)

## Deploy (Docker)

On the Docker host:

```bash
git clone https://github.com/aarondolenec/azbGlossar.git
cd azbGlossar
cp .env.example .env
# edit .env and set ADMIN_KEY to a long random value, e.g. from: openssl rand -hex 24
docker compose up -d --build
curl http://localhost:8080/healthz      # -> ok
```

Terms live in the `glossary-data` volume (`/data/glossary.json`). The first
write of each day also copies the previous file to `/data/backups/`; the last
14 are kept. To update: `git pull && docker compose up -d --build`. The data
volume is kept.

If you bind-mount a host folder instead of the named volume, make it writable
for uid 1000 (the `node` user in the image).

## Expose it with Pangolin

Create a **public** resource that points at the container:

- Target: `http://<docker-host>:8080` (or `http://glossary:8080` if Newt shares
  a Docker network with the container; then drop the `ports:` mapping).
- Authentication: **off** (no SSO, no PIN, no password). Teams cannot complete
  a login inside its tab.
- Don't add response headers that block framing (`X-Frame-Options`, a
  `frame-ancestors` CSP of your own). The app already sends the right ones.

Check what the outside world sees:

```bash
curl -sI https://glossary.example.com/ | grep -iE "x-frame-options|content-security-policy"
```

Expected: a `Content-Security-Policy` containing `frame-ancestors 'self'
https://teams.microsoft.com ...` and **no** `X-Frame-Options` line. If you see
`X-Frame-Options`, something in front of the app is adding it and Teams will
refuse to show the page.

Tip: with no login, the URL is the only barrier. Use a random, hard-to-guess
subdomain, and share the link only in the chat.

## Show it inside Teams

**Do not use Teams' built-in "Website" tab.** Since July 2024 the new Teams
(desktop and web) opens a Website tab's URL in a new browser tab instead of
showing it in Teams, whatever the site's headers say. Only a Teams app can show
the page inside the chat.

This repo builds that app package for you (a small `.zip` with a manifest and
two icons; the manifest just points the tab at your URL):

```bash
node scripts/build-teams-app.js https://your-public-url
# writes dist/azb-glossar-teams.zip
```

Then, in Teams:

1. **Apps** (left bar) → **Manage your apps** → **Upload an app** →
   **Upload a custom app**, and pick `dist/azb-glossar-teams.zip`.
2. Open the uploaded app → the arrow next to **Add** → **Add to a chat**, and
   choose the group chat. The **AZB-Glossar** tab appears in the chat's tab
   bar, for everyone in that chat.
3. Remove the old Website tab, if there is one.

If you don't see **Upload a custom app**, your organisation has switched off
custom apps. Ask your Teams admin to either allow custom app upload for you, or
upload the same `.zip` in the Teams admin center (**Teams apps → Manage apps →
Upload new app**). People in the chat may also need permission to use the app.

To change the URL or the app text later, rebuild with a higher version and
upload it again as an update: `node scripts/build-teams-app.js <url> --version 1.0.1`.
The app id in the manifest stays the same, so Teams treats it as the same app.

Inside Teams the page loads Microsoft's Teams JavaScript SDK, which is stored
in `public/vendor/` and served from your own server (so the Content Security
Policy can stay strict). To update it, replace the file with the `dist/umd/
MicrosoftTeams.min.js` from the `@microsoft/teams-js` npm package, keep the
version in the file name, and change the file name in `public/index.html`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_KEY` | *(none)* | Secret needed to delete terms. Without it, deleting is disabled. |
| `PORT` | `8080` | Listen port inside the container |
| `DATA_DIR` | `/data` | Where the data and backups live |
| `FRAME_ANCESTORS` | Teams hosts | Space-separated origins allowed to embed the page. The default covers Teams, Microsoft 365 and Outlook, including `*.cloud.microsoft`. |

## Limits

Terms up to 100 characters, explanations up to 5000, at most 5000 terms, 30
changes per minute per client. Explanations are plain text (line breaks are kept).

## Restore a backup

Stop the container, copy a file from `/data/backups/glossary-YYYY-MM-DD.json`
over `/data/glossary.json`, start it again. If `glossary.json` is ever
unreadable the server refuses to start and leaves the file untouched.

## Develop

Needs Node 22.2 or newer.

```bash
DATA_DIR=./data ADMIN_KEY=dev-key-please-change node server.js   # http://localhost:8080
npm test
```

`npm test` runs API and storage tests. The browser tests in `test/e2e.test.js`
drive the real page in headless Chrome or Edge (set `BROWSER_PATH` if yours
isn't found; they are skipped when there is no browser).
