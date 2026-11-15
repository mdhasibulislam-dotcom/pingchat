# PingChat v2

A fresh rebuild of PingChat — fast, private real-time messaging with **audio and video calls** as the main feature.

Same features as the original PingChat, rebuilt from scratch as a single-page app with a different design (light theme, emerald primary) and a different architecture (ES modules + hash routing, no build step).

## Features

- **Auth** — email + password login / register, unique usernames (3–20 chars, live availability check), forgot / reset password, email confirmation flow.
- **Chats** — conversation list with unread badges and last-message preview, realtime messages, typing indicator, read ticks (sent / read), 200-message history.
- **Audio & video calls** — WebRTC peer-to-peer calls with Supabase Realtime Broadcast signaling. Incoming-call modal with ringtone, mute / camera toggles, live timer, call history with call-back buttons, 30-second no-answer → missed.
- **People** — directory of all registered users with search, online status, Message / audio-call / video-call buttons.
- **Profile** — edit full name, username, bio and photo URL; light/dark theme toggle; log out.
- **Presence** — online dots via Supabase Presence.

## Tech

- No build step. One `index.html` shell, ES modules, hash routing (`#/login`, `#/chats`, `#/chat/<id>`, `#/calls`, `#/people`, `#/profile`).
- **Supabase Auth** (free) — email/password.
- **Supabase Postgres + Realtime** (free) — messages, conversations, calls, presence, broadcast signaling.
- **WebRTC** — peer-to-peer media, Google free public STUN servers.
- Works from GitHub Pages over plain HTTP(S).

## Project structure

```
index.html            SPA shell (all views)
css/app.css           Design system (light/dark via CSS variables)
js/config.js          Supabase client + helpers (toast, avatar, icons, time)
js/call-config.js     STUN list + TURN placeholder
js/app.js             Bootstrap + hash router + auth guard + presence
js/auth.js            Login / register / forgot / reset / logout
js/chats.js           Conversations, messages, typing, read ticks
js/calls.js           WebRTC call engine + call UI + call history
js/people.js          People directory
js/profile.js         Own profile editor
js/ui.js              Small shared helpers (escape, debounce, duration)
database/schema.sql   Complete idempotent SQL schema
assets/icons/         Logo + favicon (emerald)
```

## Setup

### 1. Run the SQL (required)

In the Supabase Dashboard, open **SQL Editor → New query**, paste the whole
`database/schema.sql` file and run it. It is **idempotent** — safe to run again
on the same project; existing users, conversations and messages are kept.

> **SQL files you need to run:** `database/schema.sql` — that is the only SQL
> file. It creates the tables (`profiles`, `conversations`,
> `conversation_participants`, `messages`, `calls`), RLS policies, the
> `get_or_create_conversation` and `is_username_available` functions, the
> triggers, and enables Realtime for `messages`, `calls` and
> `conversation_participants`.

The app is already pointed at the existing project
`https://fonkaiopgphesajcweej.supabase.co` (see `js/config.js`), so existing
users keep working. Only the publishable (anon) key is used — never put a
service_role / secret key in this project.

### 2. Auth URLs (required for email links)

In Supabase Dashboard → **Authentication → URL Configuration**, set:

- **Site URL:** `https://<your-username>.github.io/pingchat/` (your Pages URL)
- **Redirect URLs:** add the same Pages URL (and `http://localhost:8000/` for local testing)

Otherwise confirmation / password-reset emails link back to the wrong place.

### 3. TURN (optional, only for strict networks)

Calls work without TURN on most networks (same Wi-Fi, home internet, mobile
data) thanks to the free Google STUN servers. If both callers are behind
strict NATs / firewalls (some offices, universities, mobile carriers), calls
may fail to connect — that is when a TURN relay is needed.

To add one, edit `js/call-config.js` and add your own free TURN server to
`ICE_SERVERS`. Free options (check current terms): Open Relay Project, the
Metered.ca free tier, Twilio trial credit, Cloudflare Calls free tier, or a
self-hosted coturn. Never commit real TURN credentials to a public repo
without rotating them if they leak.

### 4. Deploy to GitHub Pages

Upload the whole `pingchat-v2` folder contents to the repository (repo root),
then **Settings → Pages → Build and deployment → Deploy from a branch →
branch `main`, folder `/ (root)`**. The live site is then
`https://<your-username>.github.io/pingchat/`.

Root URL opens the login page when signed out (there is no landing page) and
the chat list when signed in.

### 5. Local test

```bash
cd pingchat-v2
python3 -m http.server 8000
# open http://localhost:8000/
```

## Notes

- Calls need microphone / camera permission and work best on HTTPS (or
  localhost). Browsers block `getUserMedia` on plain `http://` sites other
  than localhost.
- The ringtone is generated with WebAudio — no audio file needed.
- If a call cannot connect at all, the app shows a clear error toast instead
  of getting stuck.
