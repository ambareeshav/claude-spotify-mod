# spotify

Skip a bad song without leaving the terminal. `/spotify` puts play/pause/skip/mute right above the prompt — no setup beyond having Spotify open — and a `◫` opens your playlists in a proper sidebar once you've connected your account.

## Install

```
claude plugin marketplace add ambareeshav/claude-spotify-mod
claude plugin install spotify@spotify
```

Restart Claude Code (a full quit/relaunch) and `/spotify` is available.

## Play

1. `/spotify` opens the band (`/spotify stop` closes it).
2. Buttons, icons only: `✕` close, `◫` sidebar, `⌄`/`⌃` collapse/expand, `⏮` prev, `▶`/`⏸` play/pause, `⏭` next, `🔇`/`🔈` mute/unmute. Track/artist/album and a position bar are shown below them, ticking on their own once a second.
3. `⌄` collapses the band to one line — buttons, then `│ track — artist │ 1:23/4:56` — for when three rows is more than you want to spare; `⌃` expands it back.
4. If Spotify isn't open, the band offers an `open Spotify` button instead of controls.
5. `◫` opens a sidebar (`Pane`) — playlists only, no player (the band already has one): a **Playlists** list (with **Liked Songs** always listed first, then playlists you created yourself — followed and other-owned playlists don't show up here, see below), and inside one, its tracks to play individually, `▶` play the whole thing in order, or `🔀` shuffle-play it. `‹` goes back to the list.

## Connecting the sidebar (optional, for playlist browsing)

The band's transport controls need nothing. The sidebar's playlist browsing needs a real Spotify login, because AppleScript's local Spotify dictionary doesn't expose playlists at all — this is a hard requirement of the Spotify Web API, not a shortcut skipped.

1. In the sidebar, press **connect Spotify**. Your browser opens Spotify's own login/consent page — no Spotify Developer app or Client ID of your own to set up, this mod ships with a shared one.
2. After you approve, the browser redirects to `127.0.0.1:8907`. Behind the scenes, pressing **connect Spotify** also spawned a one-shot local listener on that exact port, so this should connect automatically within a second or two — no copy-paste needed.
3. If it doesn't (no `python3` on your machine, or something else is already using that port), the browser instead shows a "can't reach this page" error — the code is still sitting right there in the address bar. Copy that URL (or just the `code=...` part) and paste it into the sidebar's input field, Enter to submit, as a fallback.

No client secret is stored or needed (PKCE), and neither is the shared Client ID — it's not a secret in this flow at all, which is exactly what lets it ship in the open.

**"Sign in with Spotify" failed / access denied?** The shared app is currently in Spotify's Development Mode, which caps it at 25 allow-listed accounts (see Requirements below) — ask whoever's maintaining this install to add your Spotify account. This goes away once the app clears Spotify's Extended Quota review.

**Testing the flow again from scratch**: `/spotify logout` clears the stored connection (and all in-memory sidebar state) without touching your Spotify account's own authorization — press **connect Spotify** again afterward to redo the login.

**Want to use your own Spotify app instead?** Set `clientId` in this plugin's config (`userConfig` — via your Claude Code plugin settings, or `.claude/settings.json`) to your own app's Client ID from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) (Redirect URI must be exactly `http://127.0.0.1:8907/callback`). Only worth doing if you specifically don't want to depend on the shared app's allow-list.

## How it works

- **The band** talks to the local **Spotify desktop app** via `osascript` (AppleScript) — no login, no API keys.
  - Reading "what's playing" checks whether Spotify is running (via System Events) first and never launches it just to check. The transport buttons do launch it if it's closed, the same as clicking its dock icon would.
  - It's narrow (icon-only buttons need far less room than labeled ones) and draws in a row with `{await next(e)}` — the same `AbovePrompt` site other mods (tetris, pong) use, so it can sit beside whatever else draws there instead of hiding it.
  - A zero-size `Client` (`boards/ticker.tsx`) is mounted purely for its drawing-thread timer: it posts a tick once a second, which the hooks module answers by re-running the AppleScript query and invalidating the render. That's what keeps the position/progress bar moving without a button press — the hooks module has no timer of its own, only a `Client`'s `surface.every` does.
  - Mute remembers the volume it muted from (in memory, for this session) so unmute restores it instead of guessing.
  - Collapsed (`⌄`/`⌃`) mode drops the fixed narrow column width and lets the row size to its content instead — the whole point of asking for one wide line rather than three narrow ones.
- **The sidebar** is playlists only — no now-playing card, no transport controls, since the band already owns those. It talks to the real **Spotify Web API**, authenticated via OAuth's Authorization Code + PKCE flow — no client secret, since PKCE's whole point is not needing one for a public/desktop client.
  - Login spawns a short-lived local Python HTTP server (`python3`, backgrounded via `nohup ... & disown` so the spawning call returns immediately) on `127.0.0.1:8907` to catch the OAuth redirect — `$.process.run` itself only runs one-shot commands that it waits on, not long-lived listeners, so the listener has to be launched detached from it. It writes what it catches to a state-scoped file, and the same `Client` ticker that drives the band's progress bar also polls for that file once a second while a login is pending, completing it automatically. If the listener can't start (no `python3`, the port's taken) or the redirect never reaches it, the sidebar's paste-the-URL `Input` is still there as a fallback — the loopback redirect URI needs no real listener either way, since the code lands in the browser's address bar regardless of whether anything answers it.
  - `/spotify logout` clears the stored tokens and all sidebar state, for testing the connect flow again from scratch.
  - Tokens (access + refresh) persist in `$.store` across sessions; the access token silently refreshes on expiry (or on a 401), once per call, before failing for real.
  - A failed request (a 403, a flaky connection, whatever) shows as a small dismissible banner, not a screen that replaces the whole sidebar — navigating back and retrying always stays available. An earlier version let one failed request hide the entire playlists list and its back button; this is the fix.
  - Playlist tracks come from `/playlists/{id}/items`, not `/playlists/{id}/tracks` — Spotify deprecated the latter in an early-2026 API migration. The response's per-item field also renamed (`track` → `item`); this mod reads `item` and falls back to `track` only for safety.
  - **The list only shows playlists you created.** As of a Feb 2026 Spotify API change, `/playlists/{id}/items` only serves tracks to the account that *owns* the playlist — a followed, collaborative-but-not-yours, or algorithmic playlist (Discover Weekly, Daily Mix, a Blend, ...) always 403s there now, for any third-party app, permanently. Rather than list something that's guaranteed to fail when opened, `loadPlaylists` fetches the account's own id from `/me` once and filters `/me/playlists` down to `owner.id === ` that id (`lib/spotifyApi.ts`'s `toPlaylists`) before the sidebar ever sees it.
  - **Liked Songs** isn't a real playlist — Spotify's `/me/playlists` never lists it, since it isn't a playlist resource. This mod synthesizes an entry for it from `/me/tracks` (the separate "Your Music" saved-tracks endpoint) instead, so it shows up and works the same as any other playlist to browse or play. It has no `context_uri` of its own either, so playing it (in order or shuffled) sends the loaded page of tracks' own URIs directly rather than asking Spotify to play a playlist context — capped at the one page (50 tracks) currently loaded for browsing it. It isn't subject to the owner-only filter above, since it's read from a different endpoint entirely.

## Requirements

- macOS with the Spotify desktop app installed (not the web player) — the band always needs this.
- Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` — the `$` API is early access and may change between releases.
- The first control you press may prompt macOS for permission to let Claude Code (your terminal) control Spotify via Accessibility/Automation — allow it once.
- For playlists: a one-time browser login (see above), nothing more. A Spotify Premium account is needed to *start* playback remotely via the Web API (Spotify's own restriction, not this mod's) — browsing works on any account.
- **This mod's shared Spotify app is currently in "Development Mode"**, which only lets *allow-listed* accounts connect at all (capped at 25 total) — if connecting fails outright, or a playlist you made yourself 403s right after connecting, your account likely isn't on that list yet. Ask whoever maintains this install to add it under the app's **Users and Access** section in its dashboard. This requirement disappears once the app clears Spotify's Extended Quota review.
- **Only playlists you created yourself show up in the sidebar.** Followed, collaborative-but-not-yours, and algorithmic playlists (Discover Weekly, Daily Mix, a Blend, ...) are filtered out before they're ever listed — their tracks are permanently unreadable via the Web API for any third-party app as of a Feb 2026 Spotify change, so there's nothing to show for them. Liked Songs is unaffected (different endpoint).

## Known limitations / next steps

- **Capped at 25 connected accounts until Extended Quota review.** The shared app is in Spotify's Development Mode; every new user has to be manually allow-listed until it's approved for Extended Quota Mode (removes the cap and the allow-list requirement entirely — a one-time Spotify submission, not built yet).
- **The local OAuth listener needs `python3` and a free port 8907** — if either's missing, connecting falls back to copy-pasting the redirect URL by hand.
- **The progress bar ticks once a second**, driven by the ticker `Client`'s own timer — not sample-accurate, but close enough to read at a glance.
- **Session-scoped mute memory.** The volume mute restores to resets on plugin reload.
- **Playing needs an active Spotify Connect device.** If nothing's playing anywhere, the mod looks up your devices and targets one, but if none exist yet it asks you to press play in Spotify once first — a Web API restriction, not a workaround avoided.
