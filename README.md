# Sirikh

A tiny expense logger for V and K. It runs from the iPhone home screen and adds each expense as a row in the **Sirikh** tab of our expense Google Sheet.

Each row has these columns: Date · Category · Amount ($) · Paid By · Notes

## How it works

- **The app** (`index.html`, `app.js`, `styles.css`) is hosted on GitHub Pages. It has no data and no secrets in it.
- **The backend** (`apps-script/Code.gs`) is a Google Apps Script attached to the spreadsheet. It checks a shared key and appends the row. It creates the `Sirikh` tab the first time it runs.
- **Offline saves:** if you have no signal, the entry stays on the phone and syncs the next time the app is open and online.

## One-time setup

### 1. Add the backend to the sheet
1. Open the spreadsheet → **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with the contents of [`apps-script/Code.gs`](apps-script/Code.gs), then click **Save**.
3. **Project Settings** (gear icon) → **Script properties** → **Add script property**:
   - Property: `SIRIKH_KEY`
   - Value: a passphrase of your choice. You and K will each type it into the app once.
4. **Deploy → New deployment** → type **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**, approve the permissions prompt, and copy the **Web app URL** (it ends in `/exec`).

> If you change `Code.gs` later, go to **Deploy → Manage deployments → Edit → Version: New version** so the same URL keeps working.

### 2. Install on each iPhone
1. Open the GitHub Pages link in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Sirikh** from the home screen. Paste the Web app URL and the key into Settings and tap **Save**.
   (The home-screen app keeps its own storage, separate from Safari, so do this step inside the installed app.)

## Notes
- Amounts can be negative, for refunds.
- The Category box suggests stores you've typed before.
- Paid By stays on whoever you picked last on that phone.
