// Pure PKCE/URL helpers only — nothing here touches `$`. The actual browser-open and token-fetch
// calls live in register.tsx. `crypto`, `atob`/`btoa`, `TextEncoder` and `URL` are runtime
// globals, not the `$` API, so they're fine to use here.

// a loopback redirect URI never needs a real listener: Spotify allows it unregistered-server,
// and after it redirects (the browser shows "can't reach this page"), the code is still sitting
// right there in the address bar to copy back into /spotify login <pasted url>
export const REDIRECT_URI = 'http://127.0.0.1:8907/callback';

export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-library-modify',
].join(' ');

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function randomState(): string {
  return crypto.randomUUID();
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

// accepts either the full redirected URL (the normal case — pasted straight from the address
// bar) or a bare authorization code, so a fumbled copy still works
export function extractCode(pasted: string, expectedState: string): string {
  const trimmed = pasted.trim();
  if (!trimmed.includes('://')) {
    if (!trimmed) throw new Error('nothing pasted');
    return trimmed;
  }

  const url = new URL(trimmed);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Spotify denied the request: ${error}`);
  if (!code) throw new Error('that URL has no "code" in it — paste the one from right after you clicked Agree');
  if (state !== expectedState) throw new Error('that code is from an older /spotify login — run login again and paste the newest one');
  return code;
}
