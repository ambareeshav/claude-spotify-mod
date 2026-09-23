// Pure response shaping only — nothing here touches `$` or does any fetching (that's in
// register.tsx). Takes already-parsed JSON, returns the plain shapes the Pane renders.

export type TokenSet = {
  accessToken: string;
  refreshToken: string; // Spotify only sends a new one sometimes; keep the last one otherwise
  expiresAt: number; // epoch ms
};

export function tokenSetFrom(json: any, previousRefreshToken: string): TokenSet {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
}

export type Playlist = { id: string; name: string };

export function toPlaylists(json: any): Playlist[] {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.filter((p: any) => p && p.id).map((p: any) => ({ id: p.id, name: p.name ?? '(untitled)' }));
}

export type PlaylistTrack = { uri: string; name: string; artist: string };

// Fisher-Yates, used for shuffle-playing Liked Songs — that has no `context_uri` of its own to
// hand Spotify's own shuffle to (it isn't a playlist resource), so this mod does it client-side
// over whatever page of tracks it has loaded.
export function shuffled<T>(items: readonly T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function toPlaylistTracks(json: any): PlaylistTrack[] {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    // `item` is the current field (a TrackObject or EpisodeObject); `track` is Spotify's own
    // deprecated alias for the same thing, kept here only as a fallback for an older response
    .map((it: any) => it.item ?? it.track)
    .filter((t: any) => t && t.uri)
    .map((t: any) => ({
      uri: t.uri,
      name: t.name ?? '(untitled)',
      artist: (t.artists ?? []).map((a: any) => a.name).join(', '),
    }));
}
