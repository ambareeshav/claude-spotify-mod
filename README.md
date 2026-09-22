# spotify

Spotify controls above the prompt — the same `AbovePrompt` band tetris and pong draw in — via `/spotify`. Icon-only prev/play-pause/next/mute/like, and what's currently playing, with no setup at all beyond the local Spotify app. A `⛶` button opens a fullscreen sidebar for browsing and playing your playlists, which does need a one-time login.

## Install

```
claude plugin marketplace add ambareeshav/claude-spotify-mod
claude plugin install spotify@spotify
```

Restart Claude Code (a full quit/relaunch) and `/spotify` is available.

## Play

1. `/spotify` opens the band (`/spotify stop` closes it).
2. Buttons, icons only: `✕` close, `⛶` fullscreen, `⏮` prev, `▶`/`⏸` play/pause, `⏭` next, `🔇`/`🔊` mute/unmute, and — once connected — `🤍`/`💚` like/unlike. Track/artist/album and a position bar are shown below them, ticking on their own once a second.
3. If Spotify isn't open, the band offers an `open Spotify` button instead of controls.
4. `⛶` opens a sidebar (`Pane`) — playlists only, no player (the band already has one): a **Playlists** list, and inside one, its tracks to play individually or `🔀` shuffle-play the whole thing. `‹` goes back to the list.

## Connecting the sidebar (optional, for liking + playlists)

The band's transport controls need nothing. Liking a track and the sidebar's playlist browsing need a real Spotify login, because AppleScript's local Spotify dictionary doesn't expose playlists or a "save track" action at all — this is a hard requirement of the Spotify Web API, not a shortcut skipped.

1. Create a free app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
2. In its settings, add this **exact** Redirect URI: `http://127.0.0.1:8907/callback`.
3. Copy its **Client ID** into this plugin's config (`clientId` in its `userConfig` — via your Claude Code plugin settings, or `.claude/settings.json`).
4. In the sidebar, press **connect Spotify**. Your browser opens Spotify's own login/consent page.
5. After you approve, the browser redirects to `127.0.0.1:8907` and — since nothing is actually listening there — shows a "can't reach this page" error. That's expected: the authorization code is sitting right there in the address bar.
6. Copy that URL (or just the `code=...` part) and paste it into the sidebar's input field, Enter to submit.

No client secret is stored or needed (PKCE), and no local server ever actually listens on that port — the redirect URI only exists so Spotify has somewhere to put the code for you to copy.

## How it works

- **The band** talks to the local **Spotify desktop app** via `osascript` (AppleScript) — no login, no API keys.
  - Reading "what's playing" checks whether Spotify is running (via System Events) first and never launches it just to check. The transport buttons do launch it if it's closed, the same as clicking its dock icon would.
  - It's narrow (40 cols, icon-only buttons need far less room than labeled ones) and draws in a row with `{await next(e)}` — the same `AbovePrompt` site other mods (tetris, pong) use, so it can sit beside whatever else draws there instead of hiding it.
  - A zero-size `Client` (`boards/ticker.tsx`) is mounted purely for its drawing-thread timer: it posts a tick once a second, which the hooks module answers by re-running the AppleScript query and invalidating the render. That's what keeps the position/progress bar moving without a button press — the hooks module has no timer of its own, only a `Client`'s `surface.every` does.
  - Mute remembers the volume it muted from (in memory, for this session) so unmute restores it instead of guessing.
  - The like button lives here, not in the sidebar — the sidebar exists for browsing/playing playlists, and liking is a one-track action that fits the always-visible band better. It only checks the Web API for the current track's saved status once per track change (not every tick), to avoid hammering the API.
- **The sidebar** is playlists only — no now-playing card, no transport controls, since the band already owns those. It talks to the real **Spotify Web API**, authenticated via OAuth's Authorization Code + PKCE flow — no client secret, since PKCE's whole point is not needing one for a public/desktop client.
  - The "paste the redirect URL back" step exists because nothing in this mod can run a persistent local HTTP server to catch the OAuth redirect automatically — `$.process.run` runs one-shot commands, not long-lived listeners. A loopback redirect URI needs no real listener, though: the code is in the browser's address bar regardless of whether anything answers it.
  - Tokens (access + refresh) persist in `$.store` across sessions; the access token silently refreshes on expiry (or on a 401), once per call, before failing for real.
  - A failed request (a 403 from a Spotify Development-Mode app whose account isn't allow-listed, a flaky connection, whatever) shows as a small dismissible banner, not a screen that replaces the whole sidebar — navigating back and retrying always stays available. An earlier version let one failed request (checking "is this liked") hide the entire playlists list and its back button; this is the fix.

## Requirements

- macOS with the Spotify desktop app installed (not the web player) — the band always needs this.
- Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` — the `$` API is early access and may change between releases.
- The first control you press may prompt macOS for permission to let Claude Code (your terminal) control Spotify via Accessibility/Automation — allow it once.
- For liking/playlists: a free Spotify Developer app (see above) and a one-time browser login. A Spotify Premium account is needed to *start* playback remotely via the Web API (Spotify's own restriction, not this mod's) — reading and liking work on any account.
- **A new Spotify Developer app starts in "Development Mode"**, which only lets *allow-listed* accounts use it — if the like button or a playlist's tracks 403 right after connecting, add your own Spotify account under the app's **Users and Access** section in the dashboard.
- **Spotify-generated playlists can't be read via the Web API at all, for any third-party app** — Discover Weekly, Daily Mix N, Release Radar, Liked Songs, a Blend, and similar are blocked by a Spotify policy change from November 2024, not by this mod or by Development Mode. A playlist you made yourself works; one of these won't, ever, until Spotify changes that policy. The sidebar's error message tells you which of these two 403 causes it might be when a playlist's tracks fail to load.

## Known limitations / next steps

- **No local HTTP listener for the OAuth redirect** — by design (see above); you copy-paste the code back once per login instead.
- **The progress bar ticks once a second**, driven by the ticker `Client`'s own timer — not sample-accurate, but close enough to read at a glance.
- **Session-scoped mute memory.** The volume mute restores to resets on plugin reload.
- **Playing needs an active Spotify Connect device.** If nothing's playing anywhere, the mod looks up your devices and targets one, but if none exist yet it asks you to press play in Spotify once first — a Web API restriction, not a workaround avoided.
