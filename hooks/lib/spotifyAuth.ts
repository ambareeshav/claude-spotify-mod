// Pure PKCE/URL helpers only — nothing here touches `$`. The actual browser-open and token-fetch
// calls live in register.tsx. `crypto`, `atob`/`btoa`, `TextEncoder` and `URL` are runtime
// globals, not the `$` API, so they're fine to use here.

// a loopback redirect URI never needs a real listener for Spotify's side of things (it allows an
// unregistered one, and the code lands in the address bar regardless) — but catching it
// automatically instead of asking for a copy-paste does need something briefly listening there
export const CALLBACK_PORT = 8907;
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

// a Client ID is not a secret in PKCE (there's no client secret at all) — Spotify's own docs
// treat it as public, safe to ship in open source. This is the mod's own shared app, reused by
// every install so nobody has to create their own Spotify Developer app just to log in. Its one
// real limitation: while the app stays in Spotify's "Development Mode", only accounts the app's
// owner has explicitly allow-listed can connect (capped at 25) — see the README.
export const SHARED_CLIENT_ID = 'a8a86a5c3bc544d893103a3c503bd9ce';

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

// where the one-shot local listener (below) drops what it caught, and the script that runs it —
// state-scoped so a stale file from an earlier, abandoned login is never mistaken for this one
export function callbackFilePath(state: string): string {
  return `/tmp/spotify-mod-callback-${state}.json`;
}

export function serverScriptFilePath(state: string): string {
  return `/tmp/spotify-mod-server-${state}.py`;
}

// a one-shot HTTP server: takes the one redirect Spotify sends, writes its code/state/error to
// CALLBACK_FILE as JSON, answers the browser with a page saying to come back, and shuts itself
// down — python3 is reliably preinstalled on macOS, so this needs no compiled helper. `$` has no
// long-lived-process primitive (`process.run` is one-shot, resolves only once its child exits),
// so this is spawned backgrounded (`nohup ... & disown`) from a shell that itself exits right
// away, and the hooks module polls for the file it wrote on the ticker's existing once-a-second
// tick instead of waiting on the listener directly.
export function loopbackServerScript(state: string): string {
  const filePath = callbackFilePath(state);
  return [
    'import http.server, json, threading, urllib.parse',
    `PATH = ${JSON.stringify(filePath)}`,
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    '        q = urllib.parse.urlparse(self.path)',
    '        p = urllib.parse.parse_qs(q.query)',
    "        data = {'code': p.get('code', [''])[0], 'state': p.get('state', [''])[0], 'error': p.get('error', [''])[0]}",
    "        open(PATH, 'w').write(json.dumps(data))",
    '        self.send_response(200)',
    "        self.send_header('Content-Type', 'text/html')",
    '        self.end_headers()',
    "        self.wfile.write(b'<html><body>Connected. You can close this tab and go back to Claude Code.</body></html>')",
    '        threading.Thread(target=self.server.shutdown).start()',
    '    def log_message(self, *a):',
    '        pass',
    `srv = http.server.HTTPServer(('127.0.0.1', ${CALLBACK_PORT}), H)`,
    'srv.timeout = 180',
    'srv.handle_request()',
  ].join('\n');
}
