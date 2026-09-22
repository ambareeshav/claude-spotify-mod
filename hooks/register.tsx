/* @jsx h */
import type { Register } from 'claude-code';
import { formatTime, parseNowPlaying, progressBar, type NowPlaying } from './lib/applescript';
import { REDIRECT_URI, authUrl, challengeFor, extractCode, randomState, randomVerifier } from './lib/spotifyAuth';
import { tokenSetFrom, toPlaylists, toPlaylistTracks, type Playlist, type PlaylistTrack, type TokenSet } from './lib/spotifyApi';

// Spotify controls above the prompt (the same band tetris and pong draw in), plus a fullscreen
// sidebar for the things AppleScript can't do at all: liking tracks and browsing/playing
// playlists. The band talks to the local Spotify desktop app via `osascript` — no login, macOS
// only. The sidebar talks to the real Spotify Web API — needs a one-time OAuth login (PKCE, no
// client secret, no locally-run server: the redirect URL's `code` is copied back by hand).

const PANE_ID = 'spotify-full';
const TOKEN_STORE_KEY = 'spotify:tokens';

// wide enough for the fullest row — close, full, prev, play/pause, next, mute, each bracketed
// and gapped — without clipping the trailing buttons out of the clickable area
const WIDTH = 64;

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
let nowPlaying: NowPlaying = { running: false };
let lastVolume = 70;
let errorMessage: string | null = null;

let auth: TokenSet | null = null;
let pendingLogin: { verifier: string; state: string } | null = null;
let loginError: string | null = null;
let paneError: string | null = null;
let saved: boolean | null = null;
let playlists: Playlist[] | null = null;
let selectedPlaylist: Playlist | null = null;
let playlistTracks: PlaylistTrack[] | null = null;

function clientIdFrom(options: any): string {
  const id = (options?.clientId ?? '').trim();
  if (!id) throw new Error('set a Spotify Client ID in this plugin\'s config first (see the README)');
  return id;
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
  if (!res.ok) throw new Error(`Spotify: ${method} ${path} → ${res.status} ${res.text.slice(0, 200)}`);
  return JSON.parse(res.text);
}

// its own try/catch, not the generic afterPaneAction one: a login failure belongs in
// `loginError`, which the not-connected screen renders — `paneError` is a different slot,
// only shown once connected, so a caught-but-misrouted error here used to render as nothing
async function startLogin($: any, options: any): Promise<void> {
  try {
    const clientId = clientIdFrom(options);
    const verifier = randomVerifier();
    const state = randomState();
    const challenge = await challengeFor(verifier);
    pendingLogin = { verifier, state };
    loginError = null;
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
    await refreshPaneData($, options);
  } catch (err: any) {
    loginError = err?.message ?? String(err);
  }
}

async function refreshSavedStatus($: any, options: any): Promise<void> {
  if (!nowPlaying.running || !nowPlaying.trackId) {
    saved = null;
    return;
  }
  const json = await spotifyApi($, options, 'GET', `/me/tracks/contains?ids=${nowPlaying.trackId}`);
  saved = Array.isArray(json) ? !!json[0] : null;
}

async function toggleLike($: any, options: any): Promise<void> {
  if (!nowPlaying.running || !nowPlaying.trackId) return;
  const id = nowPlaying.trackId;
  if (saved) {
    await spotifyApi($, options, 'DELETE', `/me/tracks?ids=${id}`);
    saved = false;
  } else {
    await spotifyApi($, options, 'PUT', `/me/tracks?ids=${id}`);
    saved = true;
  }
}

async function loadPlaylists($: any, options: any): Promise<void> {
  const json = await spotifyApi($, options, 'GET', '/me/playlists?limit=50');
  playlists = toPlaylists(json);
}

async function loadPlaylistTracks($: any, options: any, playlistId: string): Promise<void> {
  const json = await spotifyApi($, options, 'GET', `/playlists/${playlistId}/tracks?limit=50`);
  playlistTracks = toPlaylistTracks(json);
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
  if (shuffle) await spotifyApi($, options, 'PUT', '/me/player/shuffle?state=true').catch(() => {});
  await playOnDevice($, options, { context_uri: `spotify:playlist:${playlistId}` });
}

async function refreshPaneData($: any, options: any): Promise<void> {
  try {
    paneError = null;
    await Promise.all([loadPlaylists($, options), refreshSavedStatus($, options)]);
  } catch (err: any) {
    paneError = err?.message ?? String(err);
  }
}

async function openFullscreen($: any, options: any): Promise<void> {
  if (!auth) await loadAuth($);
  if (auth) await refreshPaneData($, options);
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

  const closeButton = <Button key="spotify:close" label="close" onPress={close} />;
  const fullButton = (
    <Button key="spotify:full" label="⛶ full" onPress={() => openFullscreen($, options).catch((err: any) => $.ui.log(`spotify: ${err}`))} />
  );
  // a zero-size clock: its own timer posts a tick every second so the position/bar keep
  // moving without needing a button press, even though the hooks module has no timer of its own
  const ticker = <Client key="spotify:ticker" module="./boards/ticker.tsx" width={0} height={0} />;

  let content;
  if (errorMessage) {
    content = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {closeButton}
          {fullButton}
          <Button key="retry" label="retry" onPress={afterAction(async () => {})} />
        </Box>
        <Markdown text={`**Spotify mod error**\n\n${errorMessage}`} />
      </Box>
    );
  } else if (!nowPlaying.running) {
    content = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {closeButton}
          {fullButton}
          <Button key="open" label="open Spotify" onPress={afterAction(() => openSpotify($))} />
          <Button key="refresh" label="refresh" onPress={afterAction(async () => {})} />
        </Box>
        <Text dimColor>Spotify isn't running</Text>
      </Box>
    );
  } else {
    const np = nowPlaying;
    const playLabel = np.state === 'playing' ? '⏸ pause' : '▶ play';
    const muteLabel = np.volume > 0 ? '🔇 mute' : '🔊 unmute';
    content = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {closeButton}
          {fullButton}
          <Button key="prev" label="⏮ prev" onPress={afterAction(() => previousTrack($))} />
          <Button key="playpause" label={playLabel} onPress={afterAction(() => playPause($))} />
          <Button key="next" label="⏭ next" onPress={afterAction(() => nextTrack($))} />
          <Button key="mute" label={muteLabel} onPress={afterAction(() => toggleMute($))} />
        </Box>
        <Markdown text={`**${np.track || '(unknown track)'}**  ·  ${np.artist}${np.album ? ' · ' + np.album : ''}`} />
        <Text dimColor wrap="truncate-end">{`${formatTime(np.positionSec)}  ${progressBar(np.positionSec, np.durationMs, 16)}  ${formatTime(np.durationMs / 1000)}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={WIDTH}>
      {ticker}
      {content}
    </Box>
  );
}

// ---------- sidebar (Pane) ----------

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

  const np = nowPlaying;
  const nowPlayingBlock = np.running ? (
    <Box flexDirection="column">
      <Markdown text={`**${np.track}**  ·  ${np.artist}`} />
      <Box flexDirection="row" columnGap={1}>
        <Button
          key="pane:playpause"
          label={np.state === 'playing' ? '⏸ pause' : '▶ play'}
          onPress={afterPaneAction(async () => {
            await playPause($);
            await refreshNowPlaying($);
          })}
        />
        <Button
          key="pane:prev"
          label="⏮ prev"
          onPress={afterPaneAction(async () => {
            await previousTrack($);
            await refreshNowPlaying($);
          })}
        />
        <Button
          key="pane:next"
          label="⏭ next"
          onPress={afterPaneAction(async () => {
            await nextTrack($);
            await refreshNowPlaying($);
          })}
        />
        {auth && (
          <Button key="pane:like" label={saved ? '💚 liked' : '🤍 like'} onPress={afterPaneAction(() => toggleLike($, options))} />
        )}
      </Box>
    </Box>
  ) : (
    <Text dimColor>Spotify isn't running</Text>
  );

  if (!auth) {
    return (
      <Box flexDirection="column">
        {nowPlayingBlock}
        <Markdown text="**Connect Spotify** for liking tracks and browsing/playing your playlists." />
        <Button key="pane:connect" label="connect Spotify" onPress={afterPaneAction(() => startLogin($, options))} />
        {pendingLogin && (
          <Box flexDirection="column">
            <Text dimColor>
              Approve in the browser, then paste the URL it redirects to below — it'll look like the page failed to
              load, that's expected, the code is in the address bar.
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

  if (paneError) {
    return (
      <Box flexDirection="column">
        {nowPlayingBlock}
        <Markdown text={`**error:** ${paneError}`} />
        <Button key="pane:retry" label="retry" onPress={afterPaneAction(() => refreshPaneData($, options))} />
      </Box>
    );
  }

  if (selectedPlaylist) {
    const playlist = selectedPlaylist;
    return (
      <Box flexDirection="column">
        {nowPlayingBlock}
        <Box flexDirection="row" columnGap={1}>
          <Button
            key="pane:back-playlists"
            label="‹ playlists"
            onPress={afterPaneAction(async () => {
              selectedPlaylist = null;
              playlistTracks = null;
            })}
          />
          <Button key="pane:shuffle-play" label="🔀 shuffle play" onPress={afterPaneAction(() => playPlaylist($, options, playlist.id, true))} />
        </Box>
        <Markdown text={`**${playlist.name}**`} />
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
      {nowPlayingBlock}
      <Markdown text="**Playlists**" />
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
              label={`${p.name} (${p.trackCount})`}
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

  open = true;
  await refreshNowPlaying($);
  $.ui.invalidate('ui.render');
  return { text: '$Spotify · prev/play-pause/next/mute above the prompt, ⛶ full for playlists · Esc returns to it · /spotify stop closes' };
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

async function handleUiMessage($: any, e: any, next: any) {
  const data = e.data as { tick?: unknown } | null;
  if (!data?.tick) return next(e);
  await refreshNowPlaying($);
  $.ui.invalidate('ui.render');
  return { props: {} };
}

async function handleSessionStart($: any, e: any, next: any) {
  const r = await next(e);
  await loadAuth($);
  await $.command
    .register({
      name: 'spotify',
      description: '$Spotify controls above the prompt (stop closes)',
      argumentHint: '[stop]',
      immediate: true,
    })
    .catch((err: any) => $.ui.log(`spotify: /spotify not registered: ${err}`));
  return r;
}

export const register: Register = (on, options) => {
  on('session.start', handleSessionStart);
  on('command.run', { command: 'spotify' }, handleCommandRun);
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => handleAbovePromptRender($, e, next, options));
  on('ui.render', { component: 'Pane' }, ($, e, next) => handlePaneRender($, e, next, options));
  on('ui.message', handleUiMessage);
};
