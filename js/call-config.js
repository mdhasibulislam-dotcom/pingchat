/* PingChat v2 — WebRTC ICE server configuration.
 *
 * STUN (free, public, no account needed): Google's public STUN servers.
 * These are enough for most calls — same Wi-Fi, same network, or direct
 * internet. They do NOT relay media; they only help two devices find each
 * other.
 *
 * TURN (relay) is enabled below via the Open Relay Project
 * (https://www.metered.ca/tools/openrelay/) — free, shared TURN
 * credentials, no card required. It relays media when both sides are
 * behind strict NATs or firewalls (e.g. mobile data / carrier NAT),
 * where STUN alone cannot connect the two devices. It is a shared
 * free service, so it is best-effort and may be slow at peak times.
 * The user can later replace it with his own TURN credentials from:
 *   - Metered.ca free tier — TURN + STUN with a free monthly allowance.
 *   - Twilio STUN/TURN — free trial credit, needs an account.
 *   - Cloudflare Calls — free tier, needs a Cloudflare account.
 *   - Or self-host coturn on any cheap VPS.
 *
 * Format for an entry:
 *   { urls: 'turn:turn.example.com:3478', username: 'your-user', credential: 'your-pass' }
 * NEVER paste real TURN credentials into a public repo without thinking:
 * TURN credentials can be abused to relay traffic on your quota, so keep
 * them short-lived and rotate them if they ever leak.
 */
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

export const CALL_TIMEOUT_MS = 30000; // ring for 30s, then mark as missed
