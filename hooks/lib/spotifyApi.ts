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

export type Playlist = { id: string; name: string; trackCount: number };

export function toPlaylists(json: any): Playlist[] {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    .filter((p: any) => p && p.id)
    .map((p: any) => ({ id: p.id, name: p.name ?? '(untitled)', trackCount: p.tracks?.total ?? 0 }));
}

export type PlaylistTrack = { uri: string; name: string; artist: string };

export function toPlaylistTracks(json: any): PlaylistTrack[] {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    .map((it: any) => it.track)
    .filter((t: any) => t && t.uri)
    .map((t: any) => ({
      uri: t.uri,
      name: t.name ?? '(untitled)',
      artist: (t.artists ?? []).map((a: any) => a.name).join(', '),
    }));
}
