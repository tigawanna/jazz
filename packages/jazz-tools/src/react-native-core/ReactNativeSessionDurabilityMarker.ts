import type { SessionID } from "cojson";
import type { SessionDurabilityMarker } from "jazz-tools";
import { KvStoreContext } from "jazz-tools";

function markerKey(sessionID: SessionID) {
  return `jazz_session_dirty_${sessionID}`;
}

/**
 * KvStore-backed durability marker. KvStore writes are async, so `set` can
 * only be *initiated* before the network send — a best-effort guarantee
 * (accepted limitation, see the design spec's residual-risk section).
 */
export const ReactNativeSessionDurabilityMarker: SessionDurabilityMarker = {
  set(sessionID: SessionID) {
    KvStoreContext.getInstance()
      .getStorage()
      .set(markerKey(sessionID), "1")
      .catch((err) =>
        console.warn("Failed to set session durability marker", err),
      );
  },
  clear(sessionID: SessionID) {
    KvStoreContext.getInstance()
      .getStorage()
      .delete(markerKey(sessionID))
      .catch((err) =>
        console.warn("Failed to clear session durability marker", err),
      );
  },
  async isSet(sessionID: SessionID) {
    const value = await KvStoreContext.getInstance()
      .getStorage()
      .get(markerKey(sessionID));
    return value !== null;
  },
};
