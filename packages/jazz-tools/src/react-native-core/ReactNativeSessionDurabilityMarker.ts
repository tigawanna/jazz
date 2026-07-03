import type { SessionID } from "cojson";
import type { SessionDurabilityMarker } from "jazz-tools";
// KvStoreContext must come from "jazz-tools" (not the sibling
// ./storage/kv-store-context.js module): the repo currently has two identical
// KvStoreContext classes with separate singleton state, and the session
// provider that reads this marker uses the "jazz-tools" one
import {
  KvStoreContext,
  sessionDurabilityMarkerKey as markerKey,
} from "jazz-tools";

/**
 * KvStore-backed durability marker. KvStore writes are async, so `set` can
 * only be *initiated* before the network send — a best-effort guarantee
 * (accepted limitation).
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
