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

/**
 * Storage key under which a session's dirty flag is persisted. Shared by all
 * platform marker implementations so the key format cannot silently diverge.
 */
export function sessionDurabilityMarkerKey(sessionID: SessionID) {
  return `jazz_session_dirty_${sessionID}`;
}

export const SESSION_DURABILITY_CLEAR_DEBOUNCE_MS = 200;

/**
 * Adapts a SessionDurabilityMarker to LocalNode's onLocalStoreDurabilityChange
 * hook. Setting is immediate (correctness-critical); clearing is debounced so
 * the marker doesn't churn on every batch while the user is actively editing.
 * A crash inside the debounce at worst abandons one session unnecessarily.
 *
 * Returns undefined when no marker is provided, matching the optional
 * listener slot on LocalNode creation options.
 */
export function makeDurabilityMarkerListener(
  marker: SessionDurabilityMarker,
  clearDebounceMs?: number,
): LocalStoreDurabilityListener;
export function makeDurabilityMarkerListener(
  marker: SessionDurabilityMarker | undefined,
  clearDebounceMs?: number,
): LocalStoreDurabilityListener | undefined;
export function makeDurabilityMarkerListener(
  marker: SessionDurabilityMarker | undefined,
  clearDebounceMs: number = SESSION_DURABILITY_CLEAR_DEBOUNCE_MS,
): LocalStoreDurabilityListener | undefined {
  if (!marker) {
    return undefined;
  }

  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  let markerIsSet = false;

  return (hasPending, sessionID) => {
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }

    if (hasPending) {
      // A window reopening within the clear debounce finds the marker still
      // set: skip the write so steady-state editing costs no marker I/O
      if (markerIsSet) {
        return;
      }

      try {
        marker.set(sessionID);
        markerIsSet = true;
      } catch (err) {
        console.warn("Failed to set session durability marker", err);
      }
    } else {
      clearTimer = setTimeout(() => {
        clearTimer = undefined;

        try {
          marker.clear(sessionID);
          markerIsSet = false;
        } catch (err) {
          console.warn("Failed to clear session durability marker", err);
        }
      }, clearDebounceMs);
    }
  };
}
