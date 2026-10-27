# Ringline

Voice calls in the browser. Create an account, pick someone from the list, press Call. The other person's screen rings. When they answer, you talk.

## What you need

- Node.js 20, 22 or 24 (LTS recommended)
- A host that runs Node and serves **https**. Browsers only allow microphone access on https (localhost is the one exception).
- A disk that survives restarts, for the SQLite file.

## Run it on your computer

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000 in two different browsers (or one normal window and one private window), create two accounts, and call one from the other. Use headphones, or the two tabs will echo.

## Put it online

1. Upload the project (without `node_modules`) to your host.
2. Set these environment variables:
   - `NODE_ENV=production`
   - `JWT_SECRET` = 32 or more random characters. Make one with:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `TRUST_PROXY=1`
   - `DB_PATH` = a path on a persistent disk, for example `/var/data/ringline.db`
3. Build command: `npm install`. Start command: `npm start`.
4. Open your https address on two devices and test a call.

The server needs to keep running (not "serverless"), because it holds the live WebSocket connections.

## If calls ring but there is no sound

Most calls connect directly with the free STUN server. Some phone networks and office Wi-Fi block that, and then you need a TURN relay.

- Easiest: a hosted TURN service. Put its URLs in `TURN_URLS` and its login in `TURN_USERNAME` and `TURN_CREDENTIAL`.
- Self-hosted: run coturn with `use-auth-secret` and `static-auth-secret=<secret>`, then set `TURN_URLS` and `TURN_SECRET` to the same secret. Ringline hands each signed-in user short-lived credentials.

## Files

| File | What it does |
| --- | --- |
| `server.js` | Accounts, user list, call signaling over WebSocket |
| `public/index.html` | The page |
| `public/styles.css` | The look |
| `public/app.js` | Sign in, user list, ringing, microphone, WebRTC |
| `.env.example` | All settings, with notes |

## Limits of this version

- One device per account at a time. Signing in somewhere else moves the session there.
- A person only hears an incoming call while Ringline is open in their browser. It does not ring when the tab is closed.
- One-to-one calls only. No password reset: keep the SQLite file backed up, and delete a row from `users` if someone is locked out.
