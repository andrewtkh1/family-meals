# Family Meals

A small self-hosted site where up to 10 family members post a photo (optional) and calories for each meal, see everyone's calories for today, browse the latest meals, and like each other's meals. Only the uploader can delete a meal.

## Run

```powershell
npm install
$env:APP_TIMEZONE = "Asia/Singapore"   # set YOUR timezone (IANA name); default is UTC
npm start                               # http://localhost:3000
```

Settings (environment variables): `PORT` (3000), `APP_TIMEZONE` (UTC), `DATA_DIR` (./data), `SECURE_COOKIE=1` (set once served over HTTPS).

## Notes

- Data lives in `data/` (SQLite `app.db` + `photos/`). **Back this folder up.**
- Sign-up is open but capped at 10 accounts. Anyone who finds the URL can take a slot.
- Forgotten password: `node reset-password.js <username> <newPassword>`
- Photos are shrunk to 1280px JPEG on upload; originals are discarded. They're only served to signed-in users.
- Day totals reset at midnight in `APP_TIMEZONE`.
- Not decided yet: how relatives reach the site from outside your home network (see below).
- The site is down whenever this PC is off or asleep.

## Remote access (still to decide)
Cloudflare Tunnel is the usual choice (public HTTPS URL, no router ports opened). Set `SECURE_COOKIE=1` once you're on HTTPS.
