import type { SessionID } from "cojson";
import type { SessionDurabilityMarker } from "jazz-tools";
import { sessionDurabilityMarkerKey as markerKey } from "jazz-tools";

/**
 * localStorage-backed durability marker. Writes are synchronous, so a marker
 * set before a network send is (best-effort) durable before the server can
 * ever be ahead of local storage for that session.
 */
export const BrowserSessionDurabilityMarker: SessionDurabilityMarker = {
  set(sessionID: SessionID) {
    localStorage.setItem(markerKey(sessionID), "1");
  },
  clear(sessionID: SessionID) {
    localStorage.removeItem(markerKey(sessionID));
  },
  isSet(sessionID: SessionID) {
    return localStorage.getItem(markerKey(sessionID)) !== null;
  },
};
