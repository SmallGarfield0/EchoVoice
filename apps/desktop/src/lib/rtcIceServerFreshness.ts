/**
 * The TURN credentials returned by `GET /api/v1/rtc-config` are issued with a
 * two hour lifetime. A screen share session outlives that easily, and the ICE
 * servers the app fetched at sign-in are the only ones a connection created an
 * hour later will see. When such a credential expires the relay allocation is
 * rejected, so a viewer that can only reach us through TURN stops connecting at
 * all - while a direct path still works, which makes the failure look random.
 *
 * Refresh well before the credential expires: one cheap request, only when the
 * list is actually old enough to matter.
 */
export const rtcIceServerRefreshAfterMS = 90 * 60 * 1000;

/**
 * True when the cached ICE server list must be fetched again before it is used
 * to build a peer connection.
 *
 * A missing or unusable timestamp counts as stale: without knowing when the
 * list was fetched we cannot prove the credentials are still valid, and paying
 * for one request is cheaper than diagnosing a dead relay later.
 */
export function rtcIceServersNeedRefresh(
  fetchedAtMS: number | null | undefined,
  nowMS: number
): boolean {
  if (!fetchedAtMS || !Number.isFinite(fetchedAtMS) || fetchedAtMS <= 0) return true;
  if (!Number.isFinite(nowMS)) return true;
  return nowMS - fetchedAtMS >= rtcIceServerRefreshAfterMS;
}
