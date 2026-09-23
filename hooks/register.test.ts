import { test, expect } from 'claude-code/testing';
import { register } from './register';
import { callbackFilePath, loopbackServerScript, serverScriptFilePath } from './lib/spotifyAuth';

const SEP = '\x1f';
const TRACK_ID = '3E7dfMvvCLjXCzDXf1a4ma';
const PLAYING_OUTPUT = [TRACK_ID, 'Midnight City', 'M83', 'Hurry Up, We\'re Dreaming', '243000', '61', 'playing', '55'].join(SEP);

function installMocks(on: any, opts: { running?: boolean; playCalls?: string[]; positions?: string[] } = {}) {
  const running = opts.running ?? true;
  const calls = opts.playCalls ?? [];
  const positions = opts.positions;
  let statusCalls = 0;

  on('process.run', async ($: any, e: any) => {
    const [cmd, ...rest] = e.argv as string[];
    if (cmd === 'osascript') {
      const script = rest[rest.length - 1] as string;
      calls.push(script);
      if (script.includes('isRunning')) {
        if (!running) return { value: { exitCode: 0, stdout: 'not running', stderr: '' } };
        const pos = positions ? positions[Math.min(statusCalls, positions.length - 1)] : '61';
        statusCalls++;
        const fields = [TRACK_ID, 'Midnight City', 'M83', "Hurry Up, We're Dreaming", '243000', pos, 'playing', '55'];
        return { value: { exitCode: 0, stdout: fields.join(SEP), stderr: '' } };
      }
      if (script.includes('sound volume') && !script.includes('set sound volume')) {
        return { value: { exitCode: 0, stdout: '55', stderr: '' } };
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    if (cmd === 'open') {
      calls.push(e.argv.join(' '));
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    if (cmd === '/bin/sh' || cmd === 'rm') {
      calls.push(e.argv.join(' '));
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    return { value: { exitCode: 1, stdout: '', stderr: `unmocked argv: ${e.argv.join(' ')}` } };
  });

  // stands in for the engine's own AbovePrompt content: the band composes in a row with
  // whatever else draws there, so its render hook always calls next(e)
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Text', props: {}, children: [] }));
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 60,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
};

const PANE_PROPS = {
  title: 'Spotify',
  isFocused: true,
  bodyColumns: 60,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
};

function installStoreMocks(on: any, opts: { initialToken?: unknown } = {}) {
  let token = opts.initialToken ?? undefined;
  on('store.get', async ($: any, e: any) => ({ value: e.key === 'spotify:tokens' ? token : undefined }));
  on('store.set', async ($: any, e: any) => {
    if (e.key === 'spotify:tokens') token = e.value;
    return { value: undefined };
  });
  on('ui.open', async () => ({ value: undefined }));
}

function installWebApiMocks(on: any, opts: { apiCalls?: string[]; bodies?: string[] } = {}) {
  const calls = opts.apiCalls ?? [];
  on('http.fetch', async ($: any, e: any) => {
    const url = e.url as string;
    calls.push(`${e.init?.method ?? 'GET'} ${url}`);
    opts.bodies?.push(e.init?.body ?? '');

    if (url.startsWith('https://accounts.spotify.com/api/token')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
        },
      };
    }
    if (url.endsWith('/v1/me')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ id: 'my-id' }) } };
    }
    if (url.includes('/me/playlists')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            items: [
              { id: 'pl1', name: 'Focus', owner: { id: 'my-id' } },
              { id: 'pl2', name: 'Friend\'s Mix', owner: { id: 'someone-else' } },
            ],
          }),
        },
      };
    }
    if (url.includes('/playlists/pl1/items')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            // `item`, not the deprecated `track` field — this is the current shape
            items: [{ item: { uri: 'spotify:track:aaa', name: 'Song A', artists: [{ name: 'Artist A' }] } }],
          }),
        },
      };
    }
    if (url.includes('/me/tracks?limit=50')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ items: [{ track: { uri: 'spotify:track:bbb', name: 'Song B', artists: [{ name: 'Artist B' }] } }] }),
        },
      };
    }
    if (url.includes('/me/player/play')) {
      return { value: { status: 204, ok: true, headers: {}, text: '' } };
    }
    return { value: { status: 404, ok: false, headers: {}, text: `unmocked url: ${url}` } };
  });
}

test('bare /spotify reports the band is open', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  const result = await $.command.run({ command: 'spotify', args: '' });
  expect(result.text).toContain('Spotify');
});

test('the band shows the current track when Spotify is running', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });

  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  expect(await ui.find({ text: /Midnight City/ })).toBeDefined();
  expect(await ui.find({ text: /M83/ })).toBeDefined();
  expect(await ui.find({ text: '⏸' })).toBeDefined();
  await ui.unmount();
});

test('every control button is present and pressable, not clipped out of the row', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  for (const text of [/✕/, /◫/, /⌄/, /⏮/, /⏸/, /⏭/, /🔇/]) {
    expect(await ui.find({ text })).toBeDefined();
  }

  await ui.press({ key: 'next' });
  expect(calls.some(s => s.includes('next track'))).toBe(true);

  await ui.press({ key: 'mute' });
  expect(calls.some(s => s.includes('set sound volume to 0'))).toBe(true);

  await ui.unmount();
});

test('the band offers to open Spotify when it is not running', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { running: false });

  await $.command.run({ command: 'spotify', args: '' });

  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  expect(await ui.find({ text: /isn't running/ })).toBeDefined();
  expect(await ui.find({ text: /open Spotify/ })).toBeDefined();
  await ui.unmount();
});

test('pressing play-pause runs playpause and refreshes the band', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  await ui.press({ key: 'playpause' });
  expect(calls.some(s => s.includes('playpause'))).toBe(true);
  expect(await ui.find({ text: /Midnight City/ })).toBeDefined();

  await ui.unmount();
});

test('the compact toggle collapses the band to one line, and back', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  // expanded: the full three-line layout, "collapse" (⌄) offered
  expect(await ui.find({ text: /Midnight City/ })).toBeDefined();
  expect(await ui.find({ text: '⌄' })).toBeDefined();

  await ui.press({ key: 'spotify:compact' });

  // collapsed: everything on one row, separated by │, "expand" (⌃) offered now
  expect(await ui.find({ text: /Midnight City — M83/ })).toBeDefined();
  expect(await ui.find({ text: /1:01\/4:03/ })).toBeDefined();
  expect(await ui.find({ text: '⌃' })).toBeDefined();
  expect(await ui.find({ text: '⌄' })).toBeUndefined();

  await ui.press({ key: 'spotify:compact' });
  expect(await ui.find({ text: '⌄' })).toBeDefined();

  await ui.unmount();
});

test('the ticker client posts a tick every second, refreshing the position without a button press', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { positions: ['10', '20', '30'] });

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  expect(await ui.find({ text: /0:10/ })).toBeDefined();
  await ui.advance(1000);
  expect(await ui.find({ text: /0:20/ })).toBeDefined();
  await ui.advance(1000);
  expect(await ui.find({ text: /0:30/ })).toBeDefined();

  await ui.unmount();
});

test('with no Client ID configured, connecting falls back to the shared app instead of failing', async ($: any, on: any) => {
  // `register(on, {})` here really does mean "nobody set a Client ID" — the test harness
  // always resolves userConfig to its manifest defaults regardless of what's passed to
  // register() directly, and the manifest sets none. `clientIdFrom` used to throw in this
  // case; now it falls back to the mod's own shared Client ID, so login proceeds normally.
  register(on, {});
  installMocks(on);
  installStoreMocks(on);
  installWebApiMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /connect Spotify/ })).toBeDefined();

  await pane.press({ key: 'pane:connect' });
  // no error — the auth URL got opened (via the shared Client ID) and a pending login started
  expect(await pane.find({ text: /Spotify Client ID/ })).toBeUndefined();
  expect(await pane.find({ text: /approve in the browser/i })).toBeDefined();

  await pane.unmount();
});

test('connecting spawns a backgrounded local listener, and the tick picks up the code it catches — no paste needed', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });
  installStoreMocks(on);
  const files = new Map<string, string>();
  on('fs.write', async ($: any, e: any) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on('fs.read', async ($: any, e: any) => {
    if (!files.has(e.path)) throw new Error(`no such file: ${e.path}`);
    return { value: files.get(e.path) };
  });
  on('fs.exists', async ($: any, e: any) => ({ value: files.has(e.path) }));
  const apiCalls: string[] = [];
  installWebApiMocks(on, { apiCalls });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  await pane.press({ key: 'pane:connect' });

  // a listener script got written and spawned backgrounded, ready for the real redirect to land on
  expect(calls.some(c => c.includes('nohup python3'))).toBe(true);
  // a stale listener from an earlier, abandoned attempt can sit bound to the port for up to
  // three minutes — without clearing it first, a retry's new listener fails to bind at all
  expect(calls.some(c => c.includes('pkill -f spotify-mod-server-'))).toBe(true);
  const scriptPath = [...files.keys()].find(p => p.includes('spotify-mod-server-'));
  expect(scriptPath).toBeDefined();
  const state = scriptPath!.match(/spotify-mod-server-(.+)\.py$/)![1];

  // simulate what that listener would have written once Spotify actually redirected to it
  files.set(`/tmp/spotify-mod-callback-${state}.json`, JSON.stringify({ code: 'auth-code-1', state, error: '' }));

  await band.advance(1000); // the ticker's existing once-a-second tick, which now also polls for this

  expect(await pane.find({ text: /Focus/ })).toBeDefined(); // playlists loaded — login completed on its own
  expect(apiCalls.some(c => c.startsWith('POST https://accounts.spotify.com/api/token'))).toBe(true);
  expect(calls.some(c => c.startsWith('rm -f'))).toBe(true); // callback + script cleaned up after

  await band.unmount();
  await pane.unmount();
});

test('once connected, there is no like button in the band', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  installWebApiMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' }); // loads `auth` from the store

  expect(await band.find({ text: /🤍|💚|❓/ })).toBeUndefined();

  await band.unmount();
});

test('once connected, the sidebar lists playlists (names only, no track count, no player) and plays a track from one', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  const apiCalls: string[] = [];
  installWebApiMocks(on, { apiCalls });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /Focus/ })).toBeDefined();
  expect(await pane.find({ text: /Focus \(\d/ })).toBeUndefined(); // no track count next to the name
  expect(await pane.find({ text: /🤍|💚|⏸/ })).toBeUndefined(); // no player controls in the sidebar anymore
  expect(await pane.find({ text: /Friend/ })).toBeUndefined(); // owned by someone else — filtered out entirely

  await pane.press({ key: 'playlist:pl1' });
  expect(await pane.find({ text: /Song A/ })).toBeDefined();

  await pane.press({ key: 'track:spotify:track:aaa' });
  expect(apiCalls.some(c => c.startsWith('PUT https://api.spotify.com/v1/me/player/play'))).toBe(true);

  await pane.unmount();
});

test('Liked Songs shows up as a synthetic playlist and plays in order or shuffled from its own loaded tracks', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  const apiCalls: string[] = [];
  const bodies: string[] = [];
  installWebApiMocks(on, { apiCalls, bodies });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: 'Liked Songs' })).toBeDefined(); // synthesized, always listed first

  await pane.press({ key: 'playlist:__liked__' });
  expect(await pane.find({ text: /Song B/ })).toBeDefined();

  await pane.press({ key: 'pane:play' });
  expect(await pane.find({ text: /▶/ })).toBeDefined(); // the in-order button, next to shuffle
  const playCall = apiCalls.findIndex(c => c.startsWith('PUT https://api.spotify.com/v1/me/player/play'));
  expect(playCall).toBeGreaterThanOrEqual(0);
  // Liked Songs has no context_uri of its own — it plays the loaded tracks' own uris directly,
  // never Spotify's playlist-shuffle endpoint (which doesn't apply to it either)
  expect(JSON.parse(bodies[playCall]).uris).toEqual(['spotify:track:bbb']);
  expect(apiCalls.some(c => c.includes('/me/player/shuffle'))).toBe(false);

  await pane.unmount();
});

test('a failed track load shows an error inline without hiding the back button', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  on('http.fetch', async ($: any, e: any) => {
    const url = e.url as string;
    if (url.endsWith('/v1/me')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ id: 'my-id' }) } };
    }
    if (url.includes('/me/playlists')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [{ id: 'pl1', name: 'Focus', owner: { id: 'my-id' } }] }) } };
    }
    if (url.includes('/playlists/pl1/items')) {
      return { value: { status: 403, ok: false, headers: {}, text: '{"error":{"status":403,"message":"Forbidden"}}' } };
    }
    return { value: { status: 404, ok: false, headers: {}, text: `unmocked url: ${url}` } };
  });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  await pane.press({ key: 'playlist:pl1' });

  expect(await pane.find({ text: /403/ })).toBeDefined();
  expect(await pane.find({ text: /allow-listed/ })).toBeDefined();
  // the whole point of the fix: the back button is still there and still works
  expect(await pane.find({ text: '‹' })).toBeDefined();
  await pane.press({ key: 'pane:back-playlists' });
  expect(await pane.find({ text: /Playlists/ })).toBeDefined();

  await pane.unmount();
});

test('the local callback listener script is scoped to the right state, file, and port', async () => {
  const state = 'abc-123-def';
  const script = loopbackServerScript(state);
  expect(script).toContain(callbackFilePath(state));
  expect(script).toContain('8907');
  expect(serverScriptFilePath(state)).toContain(state);
  expect(callbackFilePath(state)).toContain(state);
  // a different login's state must never resolve to this one's file
  expect(callbackFilePath('other-state')).not.toBe(callbackFilePath(state));
  // it must loop until a real callback (code/error present), not stop after the first request of
  // any kind — a single-shot server is gone by the time the real redirect lands if a browser's
  // preconnect or a stray favicon fetch reaches the port first, which reads as the page hanging
  expect(script).toContain('got_it');
  expect(script).toMatch(/while not srv\.got_it/);
  // the page the browser actually renders distinguishes success from denial, rather than
  // showing the same "connected" text regardless of what Spotify's redirect actually says
  expect(script).toContain('Connected to Claude Code');
  expect(script).toContain('Connection failed');
});

test('/spotify logout clears the connection and returns the sidebar to the connect screen', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  const storeWrites: unknown[] = [];
  on('store.get', async ($: any, e: any) => ({
    value: e.key === 'spotify:tokens' ? { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } : undefined,
  }));
  on('store.set', async ($: any, e: any) => {
    if (e.key === 'spotify:tokens') storeWrites.push(e.value);
    return { value: undefined };
  });
  on('ui.open', async () => ({ value: undefined }));
  installWebApiMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' }); // loads `auth` from the store

  const result = await $.command.run({ command: 'spotify', args: 'logout' });
  expect(result.text).toContain('disconnected');
  expect(storeWrites[storeWrites.length - 1]).toBe(null);

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /connect Spotify/ })).toBeDefined();

  await band.unmount();
  await pane.unmount();
});

test('/spotify stop closes the band', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const result = await $.command.run({ command: 'spotify', args: 'stop' });
  expect(result.text).toContain('closed');
});
