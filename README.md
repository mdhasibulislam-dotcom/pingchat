# PingChat v2

A fresh rebuild of PingChat — fast, private real-time messaging with **audio and video calls** as the main feature.

Same features as the original PingChat, rebuilt from scratch as a single-page app with a different design (light theme, emerald primary) and a different architecture (ES modules + hash routing, no build step).

## Features

- **Auth** — email + password login / register, unique usernames (3–20 chars, live availability check), forgot / reset password, email confirmation flow.
- **Chats** — conversation list with unread badges and last-message preview, realtime messages, typing indicator, read ticks (sent / read), 200-message history. Message bubbles shrink to fit their text. Every message has a three-dot menu: React (emoji picker), Reply (with a quoted preview above the composer and a tappable quote that jumps to the original), Delete for me and Delete for everyone (own messages). Reactions show as small chips under the bubble and update live for both sides.
- **Voice messages (view-once)** — tap the mic button in the composer to record (up to 2 minutes), preview it, then send. The voice uploads to Supabase Storage (bucket `voice-messages`, 5 MB, audio only) and arrives as a playable bubble with a progress bar. When the **recipient** listens to it all the way to the end, the message is completely deleted from the database (and the audio file removed) — pausing or stopping early does not count, and playing your own sent voice never deletes it.
- **Audio & video calls** — WebRTC peer-to-peer calls with Supabase Realtime Broadcast signaling. Incoming-call modal with ringtone, mute / camera toggles, live timer, call history with call-back buttons, 30-second no-answer → missed. Calls to or from a blocked user are refused (incoming calls from someone you blocked auto-decline).
- **Friends** — everyone is listed in People, but nobody can message or call anyone until a friend request is sent and accepted. People rows and the profile preview show state-aware actions: Add Friend, Request sent + Cancel, Accept + Decline, or (for friends) Message + audio/video call buttons. A Requests tab lists incoming requests (Accept / Decline + View profile) and outgoing requests (Cancel), with a badge count of incoming requests.
- **Profile** — redesigned hero: large avatar with a photo-upload button, full name, @username, bio, member-since date, friends + chats stats, and an Edit button that toggles the edit form. Real photo upload to Supabase Storage (bucket `avatars`, free) — no photo-URL field. A prominent Settings button sits at the bottom.
- **Settings** (`#/settings`) — Appearance (light/dark theme, also in the top bar), Privacy (profile visibility Public / Private), Sound (incoming-call ringtone on/off), Security (change password), and Log out. **Log out lives only here** — there is no logout button anywhere else.
- **Privacy** — public profiles show full info (bio, member-since, friend status) to everyone. Private profiles show full info only to friends, or while a friend request is pending either way — so a request recipient can inspect the sender before accepting. Otherwise only avatar, name and username are shown, with a "This profile is private" note. The directory list itself always shows avatar + name + username so people can be identified.
- **Profile preview** — tap any avatar or name to open it. Order: big avatar, full name, @username, Online/Offline status, then Message / Audio call / Video call (friends only), then the profile info (bio, member since, friend status), then Clear chat (clears the whole chat for you, after a confirm), Block / Unblock, and Report (reason + optional details). Blocked people show "Blocked" with an Unblock button instead of Message/Call buttons, and no contact is possible either way while a block exists.
- **Calls** — two sections: "Call friends" (accepted friends plus people you already have a conversation with, each with audio + video call buttons) and "Recent calls" (call history with call-back buttons).
- **Presence** — online dots via Supabase Presence.

## Tech

- No build step. One `index.html` shell, ES modules, hash routing (`#/login`, `#/chats`, `#/chat/<id>`, `#/calls`, `#/people`, `#/profile`, `#/settings`).
- **Supabase Auth** (free) — email/password.
- **Supabase Postgres + Realtime** (free) — messages, conversations, calls, friendships, presence, broadcast signaling.
- **Supabase Storage** (free) — profile photos in the public `avatars` bucket (2 MB limit, images only).
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
js/chats.js           Conversations, messages, typing, read ticks, reactions, replies, deletes, view-once voice
js/calls.js           WebRTC call engine + call UI + call history
js/people.js          People directory + friend requests (tabs, actions)
js/friends.js         Friend system: requests, state, privacy, profile preview, blocks, reports
js/profile.js         Own profile editor + photo upload
js/settings.js        Settings view (appearance, privacy, sound, password, logout)
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
> `conversation_participants`, `messages`, `calls`, `friendships`,
> `message_reactions`, `blocks`, `reports`), RLS
> policies, the `get_or_create_conversation`, `is_username_available`,
> `send_friend_request`, `respond_friend_request` and `friendship_status`
> functions, the `delete_message_for_me`, `delete_message_for_everyone`,
> `clear_chat_for_me` and `consume_voice_message` functions, the triggers,
> the public `avatars` Storage bucket (2 MB, images
> only) and the public `voice-messages` Storage bucket (5 MB, audio only)
> with their storage policies, and enables Realtime for `messages`,
> `calls`, `conversation_participants`, `friendships` and `message_reactions`.

The app is already pointed at the existing project
`https://fonkaiopgphesajcweej.supabase.co` (see `js/config.js`), so existing
users keep working. Only the publishable (anon) key is used — never put a
service_role / secret key in this project.

Re-running the SQL after the friend-system update also **auto-creates
accepted friendships for every pair that already shares a conversation**, so
old chats keep working even though new chats now require a friend request.
It does not delete or change any existing data.

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
