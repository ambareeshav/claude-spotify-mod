import { test, expect } from 'claude-code/testing';
import { register } from './register';

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

function installWebApiMocks(on: any, opts: { apiCalls?: string[] } = {}) {
  const calls = opts.apiCalls ?? [];
  on('http.fetch', async ($: any, e: any) => {
    const url = e.url as string;
    calls.push(`${e.init?.method ?? 'GET'} ${url}`);

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
    if (url.includes('/me/playlists')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ items: [{ id: 'pl1', name: 'Focus', tracks: { total: 2 } }] }),
        },
      };
    }
    if (url.includes('/playlists/pl1/tracks')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            items: [{ track: { uri: 'spotify:track:aaa', name: 'Song A', artists: [{ name: 'Artist A' }] } }],
          }),
        },
      };
    }
    if (url.includes('/me/tracks/contains')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify([false]) } };
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
  expect(await ui.find({ text: /⏸ pause/ })).toBeDefined();
  await ui.unmount();
});

test('every control button is present and pressable, not clipped out of the row', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  for (const text of [/close/, /⏮ prev/, /⏸ pause/, /⏭ next/, /🔇 mute/]) {
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

test('the sidebar prompts to connect, and pressing connect without a configured Client ID surfaces a clear error', async ($: any, on: any) => {
  // note: this test environment always resolves userConfig to its manifest defaults
  // (clientId has none, so it's ''), regardless of what's passed to register() directly —
  // there's no way from a test to simulate a *configured* Client ID, so the real login
  // round-trip isn't exercisable here. What is testable, and what actually matters most:
  // that a missing Client ID fails loudly in the right place (see the next test for the
  // fix this one caught — the error used to be swallowed into a slot the screen never shows).
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
  expect(await pane.find({ text: /Spotify Client ID/ })).toBeDefined();

  await pane.unmount();
});

test('once connected, the sidebar lists playlists and plays a track from one', async ($: any, on: any) => {
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
  expect(await pane.find({ text: /🤍 like/ })).toBeDefined();

  await pane.press({ key: 'playlist:pl1' });
  expect(await pane.find({ text: /Song A/ })).toBeDefined();

  await pane.press({ key: 'track:spotify:track:aaa' });
  expect(apiCalls.some(c => c.startsWith('PUT https://api.spotify.com/v1/me/player/play'))).toBe(true);

  await pane.unmount();
});

test('/spotify stop closes the band', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const result = await $.command.run({ command: 'spotify', args: 'stop' });
  expect(result.text).toContain('closed');
});
