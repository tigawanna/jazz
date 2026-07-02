import type { LocalStoreDurabilityListener, SessionID } from "cojson";

/**
 * Persists a per-session "dirty" flag that survives crashes.
 *
 * The flag is set while the session has transactions that were sent to a sync
 * server but are not yet durably stored locally. If the process dies inside
 * that window, local storage is behind what the server received for the
 * session, and reusing it would fork the session's hash chain. Session
 * providers must skip sessions whose flag is still set and mint a fresh
 * session instead.
 */
export interface SessionDurabilityMarker {
  /**
   * Must be initiated synchronously: the write has to win the race against
   * the network send that immediately follows it.
   */
  set(sessionID: SessionID): void;
  clear(sessionID: SessionID): void;
  isSet(sessionID: SessionID): boolean | Promise<boolean>;
}

export const SESSION_DURABILITY_CLEAR_DEBOUNCE_MS = 200;

/**
 * Adapts a SessionDurabilityMarker to LocalNode's onLocalStoreDurabilityChange
 * hook. Setting is immediate (correctness-critical); clearing is debounced so
 * the marker doesn't churn on every batch while the user is actively editing.
 * A crash inside the debounce at worst abandons one session unnecessarily.
 */
export function makeDurabilityMarkerListener(
  marker: SessionDurabilityMarker,
  clearDebounceMs: number = SESSION_DURABILITY_CLEAR_DEBOUNCE_MS,
): LocalStoreDurabilityListener {
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  return (hasPending, sessionID) => {
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }

    if (hasPending) {
      try {
        marker.set(sessionID);
      } catch (err) {
        console.warn("Failed to set session durability marker", err);
      }
    } else {
      clearTimer = setTimeout(() => {
        clearTimer = undefined;

        try {
          marker.clear(sessionID);
        } catch (err) {
          console.warn("Failed to clear session durability marker", err);
        }
      }, clearDebounceMs);
    }
  };
}
