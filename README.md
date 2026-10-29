# Sirikh

A small expense tracker for V and K. It runs from the phone's home screen and saves to a private Google Sheet.

Open the app: https://vedsirimalla.github.io/SIRIKH/

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `sw.js`, `manifest.webmanifest`, icons | Offline support and home screen install |
| `Code.gs` | Backend, pasted into the sheet's Apps Script (it does not run on GitHub) |

The repo holds code only. No sheet ID, link, key or data is stored here.

## Setup

1. Open the Google Sheet, then Extensions > Apps Script. Replace `Code.gs` with this repo's `Code.gs` and save.
2. Project Settings > Script properties: add `SIRIKH_KEY` with a long random passphrase (20 or more characters).
3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Approve the permissions.
4. Copy the web app link. Keep it private: never post it or commit it.
5. Open the site in Safari, Share > Add to Home Screen. Open it from the home screen, tap the gear, and enter the link and passphrase.

## Updating

- App files: upload the new versions here.
- `Code.gs`: paste the new code, then Deploy > Manage deployments > Edit > Version: New version > Deploy. The link stays the same.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Wrong key" | The passphrase in the app must match `SIRIKH_KEY` exactly. |
| Entries stay on the phone with an hourglass | The script is out of date. Paste the latest `Code.gs` and deploy a new version. |
| No emails | In Apps Script, run `weeklyRecap` once and approve the permissions, then send a test from the app. Check spam. |
| Link may have leaked | Create a new deployment, archive the old one, and enter the new link on each phone. Change the passphrase too. |
