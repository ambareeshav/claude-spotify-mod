/* @jsx h */
import type { Register } from 'claude-code';
import { formatTime, parseNowPlaying, progressBar, type NowPlaying } from './lib/applescript';
import {
  REDIRECT_URI,
  SHARED_CLIENT_ID,
  authUrl,
  callbackFilePath,
  challengeFor,
  extractCode,
  loopbackServerScript,
  randomState,
  randomVerifier,
  serverScriptFilePath,
} from './lib/spotifyAuth';
import { shuffled, tokenSetFrom, toPlaylists, toPlaylistTracks, toArtistAlbums, toSearchResults, type Playlist, type PlaylistTrack, type SearchResult, type TokenSet } from './lib/spotifyApi';

// Spotify controls above the prompt (the same band tetris and pong draw in), plus a fullscreen
// sidebar for the things AppleScript can't do at all: browsing/playing playlists. The band talks
// to the local Spotify desktop app via `osascript` — no login, macOS only.
// The sidebar talks to the real Spotify Web API — needs a one-time OAuth login (PKCE, no client
// secret), auto-completed by a short-lived local listener rather than a copy-paste.

const PANE_ID = 'spotify-full';
const TOKEN_STORE_KEY = 'spotify:tokens';
// not a real playlist id — Spotify never returns "Liked Songs" from /me/playlists at all (it's
// not a playlist resource), so this mod synthesizes one from /me/tracks (the "Your Music" saved
// tracks endpoint) to make it browsable/playable the same way as any other playlist
const LIKED_SONGS_ID = '__liked__';

// wide enough for the fullest row — close, full, prev, play/pause, next, mute, each bracketed
// (`[ X ]`) and gapped — without clipping the trailing ones out of the clickable area
const WIDTH = 52;

// the fields the AppleScript prints, joined by FIELD_SEP, in this order.
// `playerState`, not `st` — Spotify's own scripting dictionary reserves `st` and refuses to
// parse it as a plain identifier ("Expected expression but found 'st'").
const NOW_PLAYING_SCRIPT = `
set isRunning to false
tell application "System Events"
  set isRunning to (name of processes) contains "Spotify"
end tell
if isRunning then
  tell application "Spotify"
    set trackId to ""
    set trackName to ""
    set trackArtist to ""
    set trackAlbum to ""
    set trackDuration to 0
    try
      set trackId to id of current track
      set trackName to name of current track
      set trackArtist to artist of current track
      set trackAlbum to album of current track
      set trackDuration to duration of current track
    end try
    set trackPosition to player position
    set playerState to player state as string
    set playerVolume to sound volume
    set sep to ASCII character 31
    return trackId & sep & trackName & sep & trackArtist & sep & trackAlbum & sep & (trackDuration as string) & sep & (trackPosition as string) & sep & playerState & sep & (playerVolume as string)
  end tell
else
  return "not running"
end if
`;

let open = false;
let compact = false; // one line instead of three, while something's playing — see renderBand
let nowPlaying: NowPlaying = { running: false };
let lastVolume = 70;
let errorMessage: string | null = null;

let auth: TokenSet | null = null;
let pendingLogin: { verifier: string; state: string } | null = null;
let loginError: string | null = null;
let paneError: string | null = null;
let playlists: Playlist[] | null = null;
let selectedPlaylist: Playlist | null = null;
let playlistTracks: PlaylistTrack[] | null = null;
let searchQuery: string | null = null; // non-null while the sidebar shows search results
let searchResults: SearchResult[] | null = null;
// what was opened from search, innermost last: search → artist → album, or search → album/playlist.
// ‹ pops one; an empty stack is the results list itself
type BrowseFrame = { item: SearchResult; tracks: PlaylistTrack[] | null; albums: SearchResult[] | null };
let browseStack: BrowseFrame[] = [];
let myUserId: string | null = null; // cached from /me, so loadPlaylists doesn't refetch it every time

// most installs never set this — it's an optional escape hatch for someone who wants their own
// Spotify Developer app instead of this mod's shared one (its own Development Mode allow-list, a
// personal rate limit, whatever the reason). Everyone else gets SHARED_CLIENT_ID for free.
function clientIdFrom(options: any): string {
  const id = (options?.clientId ?? '').trim();
  return id || SHARED_CLIENT_ID;
}

// ---------- local desktop control (AppleScript) ----------

async function runOsa($: any, script: string): Promise<string> {
  const res = await $.process.run(['osascript', '-e', script]);
  if (res.exitCode !== 0) throw new Error(res.stderr?.trim() || 'osascript failed');
  return res.stdout as string;
}

async function refreshNowPlaying($: any): Promise<void> {
  try {
    const raw = await runOsa($, NOW_PLAYING_SCRIPT);
    nowPlaying = parseNowPlaying(raw);
    errorMessage = null;
  } catch (err: any) {
    errorMessage = err?.message ?? String(err);
  }
}

async function openSpotify($: any): Promise<void> {
  await $.process.run(['open', '-a', 'Spotify']);
}

async function playPause($: any): Promise<void> {
  await runOsa($, 'tell application "Spotify" to playpause');
}

async function nextTrack($: any): Promise<void> {
  await runOsa($, 'tell application "Spotify" to next track');
}

async function previousTrack($: any): Promise<void> {
  await runOsa($, 'tell application "Spotify" to previous track');
}

async function toggleMute($: any): Promise<void> {
  const raw = await runOsa($, 'tell application "Spotify" to sound volume');
  const vol = Number(raw) || 0;
  if (vol > 0) {
    lastVolume = vol;
    await runOsa($, 'tell application "Spotify" to set sound volume to 0');
  } else {
    await runOsa($, `tell application "Spotify" to set sound volume to ${lastVolume > 0 ? lastVolume : 70}`);
  }
}

// ---------- Spotify Web API (auth + calls) ----------

async function loadAuth($: any): Promise<void> {
  try {
    const raw = await $.store.get(TOKEN_STORE_KEY);
    if (raw && typeof raw === 'object') auth = raw as TokenSet;
  } catch {
    // no stored session is not an error — just start logged out
  }
}

async function saveAuth($: any): Promise<void> {
  if (!auth) return;
  await $.store.set(TOKEN_STORE_KEY, auth).catch((err: any) => $.ui.log(`spotify: token store write failed: ${err}`));
}

async function exchangeCode($: any, options: any, code: string): Promise<void> {
  if (!pendingLogin) throw new Error('no login in progress — press "connect Spotify" again');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientIdFrom(options),
    code_verifier: pendingLogin.verifier,
  });
  const res = await $.http.fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Spotify login failed: ${res.status} ${res.text.slice(0, 200)}`);
  auth = tokenSetFrom(JSON.parse(res.text), '');
  pendingLogin = null;
  await saveAuth($);
}

async function refreshAccessToken($: any, options: any): Promise<void> {
  if (!auth) throw new Error('not connected');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: clientIdFrom(options),
  });
  const res = await $.http.fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    auth = null; // a dead refresh token loops forever otherwise — force a real re-login instead
    await $.store.set(TOKEN_STORE_KEY, null).catch(() => {});
    throw new Error(`Spotify session expired — connect again (${res.status})`);
  }
  auth = tokenSetFrom(JSON.parse(res.text), auth.refreshToken);
  await saveAuth($);
}

async function ensureFreshToken($: any, options: any): Promise<string> {
  if (!auth) throw new Error('not connected — press "connect Spotify" first');
  if (Date.now() >= auth.expiresAt - 60_000) await refreshAccessToken($, options);
  return auth!.accessToken;
}

async function spotifyApi($: any, options: any, method: string, path: string, body?: unknown, retried = false): Promise<any> {
  const token = await ensureFreshToken($, options);
  const res = await $.http.fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 && !retried) {
    await refreshAccessToken($, options);
    return spotifyApi($, options, method, path, body, true);
  }
  if (res.status === 204 || !res.text) return null;
  // status leads, not trails — the band's dim error line truncates long text, and the status
  // code is the one part of this that must survive that; a full URL with query params easily
  // eats the whole line's width budget before ever reaching what "→ 403" used to end with
  if (!res.ok) throw new Error(`Spotify ${res.status}: ${method} ${path} ${res.text.slice(0, 200)}`);
  return JSON.parse(res.text);
}

// its own try/catch, not a generic one: a login failure belongs in `loginError`, which the
// not-connected screen renders — routing it anywhere else used to render as nothing at all
async function startLogin($: any, options: any): Promise<void> {
  try {
    const clientId = clientIdFrom(options);
    const verifier = randomVerifier();
    const state = randomState();
    const challenge = await challengeFor(verifier);
    pendingLogin = { verifier, state };
    loginError = null;
    // best-effort: writes and backgrounds the listener that lets the tick handler (below) pick
    // the code up on its own. If python3 is missing, this silently does nothing and the
    // manual-paste `Input` in the sidebar still works. `pkill` first clears out any listener
    // still bound to the port from an earlier, abandoned attempt (it can sit alive for up to
    // three minutes) — without it, a retry's new listener fails to bind at all ("address already
    // in use"), silently, since this call is backgrounded and its exit code is never checked.
    await $.fs.write(serverScriptFilePath(state), loopbackServerScript(state)).catch(() => {});
    await $.process
      .run(['/bin/sh', '-c', `pkill -f spotify-mod-server- 2>/dev/null; nohup python3 ${serverScriptFilePath(state)} > /dev/null 2>&1 & disown`])
      .catch(() => {});
    await $.process.run(['open', authUrl(clientId, challenge, state)]);
  } catch (err: any) {
    loginError = err?.message ?? String(err);
  }
}

async function submitLoginUrl($: any, options: any, pasted: string): Promise<void> {
  try {
    if (!pendingLogin) throw new Error('press "connect Spotify" first');
    const code = extractCode(pasted, pendingLogin.state);
    await exchangeCode($, options, code);
    loginError = null;
    await loadPlaylists($, options).catch((err: any) => {
      paneError = err?.message ?? String(err);
    });
  } catch (err: any) {
    loginError = err?.message ?? String(err);
  }
}

// polled once a second by the ticker's existing tick (only while a login is pending, so this
// never runs otherwise): picks up what the backgrounded listener in startLogin caught, so the
// sidebar's copy-paste `Input` is a fallback, not the only way in
async function checkLoginCallback($: any, options: any): Promise<void> {
  if (!pendingLogin) return;
  const state = pendingLogin.state;
  const path = callbackFilePath(state);
  let exists = false;
  try {
    exists = await $.fs.exists(path);
  } catch {
    return;
  }
  if (!exists) return;
  try {
    const raw = await $.fs.read(path);
    const data = JSON.parse(raw as string);
    await $.process.run(['rm', '-f', path, serverScriptFilePath(state)]).catch(() => {});
    if (data.state && data.state !== state) return; // a stale redirect from an earlier, abandoned login
    if (data.error) throw new Error(`Spotify denied the request: ${data.error}`);
    if (!data.code) throw new Error('the local callback caught a redirect with no code in it — try again');
    await exchangeCode($, options, data.code);
    loginError = null;
    await loadPlaylists($, options).catch((err: any) => {
      paneError = err?.message ?? String(err);
    });
  } catch (err: any) {
    loginError = err?.message ?? String(err);
  }
}

// clears everything a login built up, for a clean re-test of the whole flow (`/spotify logout`)
async function logout($: any): Promise<void> {
  auth = null;
  pendingLogin = null;
  loginError = null;
  paneError = null;
  playlists = null;
  selectedPlaylist = null;
  playlistTracks = null;
  searchQuery = null;
  searchResults = null;
  browseStack = [];
  myUserId = null;
  await $.store.set(TOKEN_STORE_KEY, null).catch((err: any) => $.ui.log(`spotify: token store clear failed: ${err}`));
}

async function ensureMyUserId($: any, options: any): Promise<string> {
  if (myUserId) return myUserId;
  const json = await spotifyApi($, options, 'GET', '/me');
  myUserId = json?.id;
  if (!myUserId) throw new Error('Spotify: /me returned no account id');
  return myUserId;
}

async function loadPlaylists($: any, options: any): Promise<void> {
  // Liked Songs isn't in /me/playlists at all (Spotify doesn't treat it as a playlist resource),
  // so it's synthesized here as its own entry, always listed first
  const ownerId = await ensureMyUserId($, options);
  const json = await spotifyApi($, options, 'GET', '/me/playlists?limit=50');
  playlists = [{ id: LIKED_SONGS_ID, name: 'Liked Songs' }, ...toPlaylists(json, ownerId)];
}

async function loadPlaylistTracks($: any, options: any, playlistId: string): Promise<void> {
  try {
    if (playlistId === LIKED_SONGS_ID) {
      const json = await spotifyApi($, options, 'GET', '/me/tracks?limit=50');
      playlistTracks = toPlaylistTracks(json);
      return;
    }
    // `/tracks` is Spotify's now-deprecated path for this — it started returning 403 for every
    // request after Spotify's early-2026 API migration, even for a playlist you made yourself
    // and are properly authorized for. `/items` is the replacement.
    const json = await spotifyApi($, options, 'GET', `/playlists/${playlistId}/items?limit=50`);
    playlistTracks = toPlaylistTracks(json);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (!message.includes('403')) throw err;
    // the sidebar only ever lists playlists this account owns (see loadPlaylists) — a playlist
    // you don't own always 403s here (Spotify's Feb 2026 API change) and is filtered out before
    // it can even be selected, so a 403 on something that did show up in the list means the
    // account itself isn't allow-listed for this app yet, not an ownership problem
    const needs = playlistId === LIKED_SONGS_ID ? 'Liked Songs needs user-library-read' : 'playlists need playlist-read-private';
    throw new Error(`${message}\n\nYour account isn't allow-listed for this app yet (Users and Access in the dashboard) — ${needs}.`);
  }
}

async function getActiveDeviceId($: any, options: any): Promise<string | null> {
  const json = await spotifyApi($, options, 'GET', '/me/player/devices');
  const devices = Array.isArray(json?.devices) ? json.devices : [];
  const active = devices.find((d: any) => d.is_active) ?? devices[0];
  return active?.id ?? null;
}

async function playOnDevice($: any, options: any, body: unknown): Promise<void> {
  try {
    await spotifyApi($, options, 'PUT', '/me/player/play', body);
    return;
  } catch (err: any) {
    if (!String(err?.message ?? err).includes('404')) throw err;
  }
  const deviceId = await getActiveDeviceId($, options);
  if (!deviceId) throw new Error('no active Spotify device — open Spotify and play anything once, then retry');
  await spotifyApi($, options, 'PUT', `/me/player/play?device_id=${deviceId}`, body);
}

async function playTrack($: any, options: any, uri: string): Promise<void> {
  await playOnDevice($, options, { uris: [uri] });
}

async function playPlaylist($: any, options: any, playlistId: string, shuffle: boolean): Promise<void> {
  if (playlistId === LIKED_SONGS_ID) {
    // Liked Songs has no `context_uri` of its own (it isn't a playlist resource), so this plays
    // the page of tracks already loaded for the sidebar directly, in order or shuffled here
    if (!playlistTracks || playlistTracks.length === 0) {
      throw new Error('open Liked Songs first so its tracks are loaded, then play');
    }
    const tracks = shuffle ? shuffled(playlistTracks) : playlistTracks;
    await playOnDevice($, options, { uris: tracks.map(t => t.uri) });
    return;
  }
  if (shuffle) await spotifyApi($, options, 'PUT', '/me/player/shuffle?state=true').catch(() => {});
  else await spotifyApi($, options, 'PUT', '/me/player/shuffle?state=false').catch(() => {});
  await playOnDevice($, options, { context_uri: `spotify:playlist:${playlistId}` });
}

// no extra scope — /v1/search only needs a token. Spotify caps `limit` at 10 per type (it was 50
// before the Feb 2026 API change), so this asks for the max of each rather than paging
async function runSearch($: any, options: any, query: string): Promise<void> {
  searchQuery = query;
  searchResults = null;
  browseStack = [];
  $.ui.invalidate('ui.render');
  const params = new URLSearchParams({ q: query, type: 'track,album,artist,playlist', limit: '10' });
  await ensureMyUserId($, options).catch(() => {}); // for canOpen's ownership check
  const json = await spotifyApi($, options, 'GET', `/search?${params.toString()}`);
  searchResults = toSearchResults(json);
}

async function playSearchResult($: any, options: any, r: SearchResult): Promise<void> {
  await playOnDevice($, options, r.kind === 'track' ? { uris: [r.uri] } : { context_uri: r.uri });
}

// a playlist you don't own can still be *played* (it's just a context_uri), but its tracks 403
// since Spotify's Feb 2026 change — so only an owned one opens; anything else plays on press
function canOpen(r: SearchResult): boolean {
  if (r.kind === 'album' || r.kind === 'artist') return true;
  return r.kind === 'playlist' && !!myUserId && r.ownerId === myUserId;
}

async function openSearchResult($: any, options: any, item: SearchResult): Promise<void> {
  const frame: BrowseFrame = { item, tracks: null, albums: null };
  browseStack = [...browseStack, frame];
  $.ui.invalidate('ui.render');
  try {
    await loadFrame($, options, frame);
  } catch (err) {
    // an empty list plus the error banner, rather than "loading…" forever
    if (item.kind === 'artist') frame.albums = [];
    else frame.tracks = [];
    throw err;
  }
}

async function loadFrame($: any, options: any, frame: BrowseFrame): Promise<void> {
  const item = frame.item;
  if (item.kind === 'artist') {
    const json = await spotifyApi($, options, 'GET', `/artists/${item.id}/albums?include_groups=album,single&limit=10`);
    frame.albums = toArtistAlbums(json);
  } else if (item.kind === 'album') {
    frame.tracks = toPlaylistTracks(await spotifyApi($, options, 'GET', `/albums/${item.id}/tracks?limit=50`));
  } else {
    frame.tracks = toPlaylistTracks(await spotifyApi($, options, 'GET', `/playlists/${item.id}/items?limit=50`));
  }
}

async function playContext($: any, options: any, contextUri: string, shuffle: boolean): Promise<void> {
  await spotifyApi($, options, 'PUT', `/me/player/shuffle?state=${shuffle}`).catch(() => {});
  await playOnDevice($, options, { context_uri: contextUri });
}

async function openFullscreen($: any, options: any): Promise<void> {
  if (!auth) await loadAuth($);
  if (auth && playlists === null) {
    await loadPlaylists($, options).catch((err: any) => {
      paneError = err?.message ?? String(err);
    });
  }
  await $.ui.open({ id: PANE_ID, title: 'Spotify', focus: true, closeOnEscape: true }).catch((err: any) =>
    $.ui.log(`spotify: ui.open failed: ${err}`),
  );
  $.ui.invalidate('ui.render');
}

// ---------- band (AbovePrompt) ----------

function renderBand($: any, e: any, options: any) {
  const { Box, Text, Button, Markdown, Client } = $.ui.resolve(e);

  const afterAction = (action: () => Promise<void>) => async () => {
    try {
      await action();
    } catch (err: any) {
      errorMessage = err?.message ?? String(err);
    }
    await refreshNowPlaying($);
    $.ui.invalidate('ui.render');
  };

  const close = () => {
    open = false;
    $.ui.invalidate('ui.render');
  };

  const toggleCompact = () => {
    compact = !compact;
    $.ui.invalidate('ui.render');
  };

  // close is `plain` — just a padded glyph, no bracket chrome — since it's the one button that
  // never needs the extra visual weight of a `[ X ]`; every other icon button below keeps the
  // default bracket chrome, which gives them a uniform drawn width and real spacing around each
  // (a wider row gap, 2 not 1, adds breathing room between the brackets too)
  const closeButton = <Button key="spotify:close" plain label=" ✕ " onPress={close} />;
  // ◫ reads as a sidebar layout (a pane split off from the main area), closer to what this
  // button actually opens than ⛶'s generic "fullscreen" implication
  const fullButton = (
    <Button key="spotify:full" label="◫" onPress={() => openFullscreen($, options).catch((err: any) => $.ui.log(`spotify: ${err}`))} />
  );
  // a chevron pair (not two unrelated glyphs) so the button visibly toggles between the same two
  // states — ⌄ "collapse this" while expanded, ⌃ "expand this" while compact
  const compactButton = <Button key="spotify:compact" label={compact ? '⌃' : '⌄'} onPress={toggleCompact} />;
  // a zero-size clock: its own timer posts a tick every second so the position/bar keep
  // moving without needing a button press, even though the hooks module has no timer of its own
  const ticker = <Client key="spotify:ticker" module="./boards/ticker.tsx" width={0} height={0} />;

  let content;
  if (errorMessage) {
    content = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {closeButton}
          {fullButton}
          {compactButton}
          <Button key="retry" label="↻" onPress={afterAction(async () => {})} />
        </Box>
        <Markdown text={`**Spotify mod error**\n\n${errorMessage}`} />
      </Box>
    );
  } else if (!nowPlaying.running) {
    content = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {closeButton}
          {fullButton}
          {compactButton}
          <Button key="open" label="open Spotify" onPress={afterAction(() => openSpotify($))} />
          <Button key="refresh" label="↻" onPress={afterAction(async () => {})} />
        </Box>
        <Text dimColor>Spotify isn't running</Text>
      </Box>
    );
  } else {
    const np = nowPlaying;
    // 🔈/🔇 — a plain speaker, not 🔊's three sound waves — sits closer in visual weight to the
    // thin ⏮/⏸/⏭ transport glyphs than the louder, busier icon did
    const muteButton = (
      <Button key="mute" label={np.volume > 0 ? '🔇' : '🔈'} onPress={afterAction(() => toggleMute($))} />
    );
    const trackLine = `${np.track || '(unknown track)'} — ${np.artist}`;
    const timeLine = `${formatTime(np.positionSec)}/${formatTime(np.durationMs / 1000)}`;
    content = compact ? (
      <Box flexDirection="row" columnGap={2}>
        {closeButton}
        {fullButton}
        {compactButton}
        <Button key="prev" label="⏮" onPress={afterAction(() => previousTrack($))} />
        <Button key="playpause" label={np.state === 'playing' ? '⏸' : '▶'} onPress={afterAction(() => playPause($))} />
        <Button key="next" label="⏭" onPress={afterAction(() => nextTrack($))} />
        {muteButton}
        <Text dimColor>│</Text>
        <Text wrap="truncate-end">{trackLine}</Text>
        <Text dimColor>│</Text>
        <Text dimColor>{timeLine}</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {closeButton}
          {fullButton}
          {compactButton}
          <Button key="prev" label="⏮" onPress={afterAction(() => previousTrack($))} />
          <Button key="playpause" label={np.state === 'playing' ? '⏸' : '▶'} onPress={afterAction(() => playPause($))} />
          <Button key="next" label="⏭" onPress={afterAction(() => nextTrack($))} />
          {muteButton}
        </Box>
        <Markdown text={`**${np.track || '(unknown track)'}**  ·  ${np.artist}${np.album ? ' · ' + np.album : ''}`} />
        <Text dimColor wrap="truncate-end">{`${formatTime(np.positionSec)}  ${progressBar(np.positionSec, np.durationMs, 16)}  ${formatTime(np.durationMs / 1000)}`}</Text>
      </Box>
    );
  }

  // compact mode trades the fixed narrow width for one wide row on purpose — that's the whole
  // point of asking for one line instead of three, so only the stacked layout stays capped
  return (
    <Box flexDirection="column" width={compact && nowPlaying.running && !errorMessage ? undefined : WIDTH}>
      {ticker}
      {content}
    </Box>
  );
}

// ---------- sidebar (Pane): playlists only, no player — that's the band's job ----------

function renderFullscreen($: any, e: any, options: any) {
  const { Box, Text, Button, Markdown, Input } = $.ui.resolve(e);

  const afterPaneAction = (action: () => Promise<void>) => async () => {
    try {
      await action();
    } catch (err: any) {
      paneError = err?.message ?? String(err);
    }
    $.ui.invalidate('ui.render');
  };

  if (!auth) {
    return (
      <Box flexDirection="column">
        <Markdown text="**Connect Spotify** to browse and play your playlists." />
        <Button key="pane:connect" label="connect Spotify" onPress={afterPaneAction(() => startLogin($, options))} />
        {pendingLogin && (
          <Box flexDirection="column">
            <Text dimColor>
              Approve in the browser — this connects on its own within a second or two once you do. If it doesn't
              (no python3, or something else is using the port), paste the URL it redirected to below instead;
              it'll look like the page failed to load, that's expected, the code is in the address bar.
            </Text>
            <Input
              key="pane:login-url"
              placeholder="http://127.0.0.1:8907/callback?code=..."
              onSubmit={value => {
                submitLoginUrl($, options, value).then(() => $.ui.invalidate('ui.render'));
              }}
            />
          </Box>
        )}
        {loginError && <Text color="red">{loginError}</Text>}
      </Box>
    );
  }

  // a dismissible banner, not a screen that replaces navigation — a failed load anywhere used
  // to hide the back button along with everything else, leaving no way out of a broken view
  const errorBanner = paneError ? (
    <Box flexDirection="row" columnGap={2}>
      <Text color="red" wrap="wrap">{paneError}</Text>
      <Button key="pane:dismiss-error" label="✕" onPress={afterPaneAction(async () => { paneError = null; })} />
    </Box>
  ) : null;

  if (searchQuery !== null && browseStack.length > 0) {
    const frame = browseStack[browseStack.length - 1];
    const it = frame.item;
    const back = (
      <Button key="pane:back-browse" label="‹" onPress={afterPaneAction(async () => { browseStack = browseStack.slice(0, -1); })} />
    );
    const body = it.kind === 'artist'
      ? frame.albums === null ? <Text dimColor>loading…</Text> : frame.albums.length === 0 ? <Text dimColor>no albums</Text> : (
          <Box flexDirection="column">
            {frame.albums.map(a => (
              <Button key={`browse:${a.uri}`} plain label={`◉ ${a.name}`} onPress={afterPaneAction(() => openSearchResult($, options, a))} />
            ))}
          </Box>
        )
      : frame.tracks === null ? <Text dimColor>loading…</Text> : frame.tracks.length === 0 ? <Text dimColor>no tracks</Text> : (
          <Box flexDirection="column">
            {/* played inside its album/playlist (offset), so the rest of it follows on after */}
            {frame.tracks.map(t => (
              <Button
                key={`browse:${t.uri}`}
                plain
                label={`▸ ${t.name} — ${t.artist}`}
                onPress={afterPaneAction(() => playOnDevice($, options, { context_uri: it.uri, offset: { uri: t.uri } }))}
              />
            ))}
          </Box>
        );
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {back}
          <Button key="pane:browse-play" label="▶" onPress={afterPaneAction(() => playContext($, options, it.uri, false))} />
          <Button key="pane:browse-shuffle" label="🔀" onPress={afterPaneAction(() => playContext($, options, it.uri, true))} />
          <Markdown text={`**${it.name}**  ·  ${it.detail}`} />
        </Box>
        {errorBanner}
        {body}
      </Box>
    );
  }

  if (searchQuery !== null) {
    const icon = { track: '▸', album: '◉', artist: '☺', playlist: '≡' } as const;
    const sectionTitle = { track: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists' } as const;
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Button
            key="pane:back-search"
            label="‹"
            onPress={afterPaneAction(async () => {
              searchQuery = null;
              searchResults = null;
            })}
          />
          <Markdown text={`**Search:** ${searchQuery}`} />
        </Box>
        {errorBanner}
        {searchResults === null ? (
          <Text dimColor>searching…</Text>
        ) : searchResults.length === 0 ? (
          <Text dimColor>no results</Text>
        ) : (
          <Box flexDirection="column">
            {/* a heading per kind (in toSearchResults' order), skipped when that kind came back empty */}
            {(['track', 'album', 'artist', 'playlist'] as const).map(kind => {
              const rows = searchResults!.filter(r => r.kind === kind);
              if (rows.length === 0) return null;
              return (
                <Box key={`section:${kind}`} flexDirection="column">
                  <Markdown text={`**${sectionTitle[kind]}**`} />
                  {rows.map(r => (
                    <Button
                      key={`result:${r.uri}`}
                      plain
                      label={`${icon[r.kind]} ${r.name} — ${r.detail}${canOpen(r) ? '  ›' : ''}`}
                      onPress={afterPaneAction(() => (canOpen(r) ? openSearchResult($, options, r) : playSearchResult($, options, r)))}
                    />
                  ))}
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    );
  }

  if (selectedPlaylist) {
    const playlist = selectedPlaylist;
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Button
            key="pane:back-playlists"
            label="‹"
            onPress={afterPaneAction(async () => {
              selectedPlaylist = null;
              playlistTracks = null;
            })}
          />
          <Button key="pane:play" label="▶" onPress={afterPaneAction(() => playPlaylist($, options, playlist.id, false))} />
          <Button key="pane:shuffle-play" label="🔀" onPress={afterPaneAction(() => playPlaylist($, options, playlist.id, true))} />
          <Markdown text={`**${playlist.name}**`} />
        </Box>
        {errorBanner}
        {playlistTracks === null ? (
          <Text dimColor>loading…</Text>
        ) : (
          <Box flexDirection="column">
            {playlistTracks.map(t => (
              <Button
                key={`track:${t.uri}`}
                plain
                label={`▸ ${t.name} — ${t.artist}`}
                onPress={afterPaneAction(() => playTrack($, options, t.uri))}
              />
            ))}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Input
        key="pane:search"
        placeholder="search songs, albums, artists, playlists…"
        onSubmit={value => {
          const q = value.trim();
          if (!q) return;
          runSearch($, options, q)
            .catch((err: any) => {
              searchResults = [];
              paneError = err?.message ?? String(err);
            })
            .then(() => $.ui.invalidate('ui.render'));
        }}
      />
      <Markdown text="**Playlists**" />
      {errorBanner}
      {playlists === null ? (
        <Text dimColor>loading…</Text>
      ) : playlists.length === 0 ? (
        <Text dimColor>no playlists</Text>
      ) : (
        <Box flexDirection="column">
          {playlists.map(p => (
            <Button
              key={`playlist:${p.id}`}
              plain
              label={p.name}
              onPress={afterPaneAction(async () => {
                selectedPlaylist = p;
                playlistTracks = null;
                $.ui.invalidate('ui.render');
                await loadPlaylistTracks($, options, p.id);
              })}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ---------- wiring ----------

async function handleCommandRun($: any, e: any): Promise<{ text?: string }> {
  const arg = (e.args as string).trim().toLowerCase();
  if (arg === 'stop' || arg === 'close') {
    open = false;
    $.ui.invalidate('ui.render');
    return { text: '$Spotify closed' };
  }
  if (arg === 'logout' || arg === 'disconnect') {
    await logout($);
    $.ui.invalidate('ui.render');
    return { text: '$Spotify disconnected — press "connect Spotify" in the sidebar to log in again' };
  }

  open = true;
  await refreshNowPlaying($);
  $.ui.invalidate('ui.render');
  return { text: '$Spotify · controls above the prompt, ⛶ for playlists · Esc returns to it · /spotify stop closes' };
}

async function handleAbovePromptRender($: any, e: any, next: any, options: any) {
  if (!open || e.props.hasSurvey || e.surface !== 'terminal') return next(e);
  const { Box } = $.ui.resolve(e);
  // next to whatever else draws in the band, not stacked below it — the mod is capped to WIDTH
  // precisely so this row has room for both
  return (
    <Box flexDirection="row" columnGap={2}>
      {renderBand($, e, options)}
      {await next(e)}
    </Box>
  );
}

async function handlePaneRender($: any, e: any, next: any, options: any) {
  if (e.requestId !== PANE_ID) return next(e);
  return renderFullscreen($, e, options);
}

async function handleUiMessage($: any, e: any, next: any, options: any) {
  const data = e.data as { tick?: unknown } | null;
  if (!data?.tick) return next(e);
  await refreshNowPlaying($);
  if (pendingLogin) await checkLoginCallback($, options);
  $.ui.invalidate('ui.render');
  return { props: {} };
}

async function handleSessionStart($: any, e: any, next: any) {
  const r = await next(e);
  await loadAuth($);
  await $.command
    .register({
      name: 'spotify',
      description: '$Spotify controls above the prompt (stop closes, logout resets the connection)',
      argumentHint: '[stop|logout]',
      immediate: true,
    })
    .catch((err: any) => $.ui.log(`spotify: /spotify not registered: ${err}`));
  return r;
}

export const register: Register = (on, options) => {
  on('session.start', handleSessionStart);
  on('command.run', { command: 'spotify' }, ($, e) => handleCommandRun($, e));
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => handleAbovePromptRender($, e, next, options));
  on('ui.render', { component: 'Pane' }, ($, e, next) => handlePaneRender($, e, next, options));
  on('ui.message', ($, e, next) => handleUiMessage($, e, next, options));
};
