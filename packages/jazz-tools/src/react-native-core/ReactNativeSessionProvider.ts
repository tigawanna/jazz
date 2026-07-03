import {
  CryptoProvider,
  KvStoreContext,
  SessionID,
  SessionProvider,
} from "jazz-tools";
import { AgentID, RawAccountID } from "cojson";
import { ReactNativeSessionDurabilityMarker } from "./ReactNativeSessionDurabilityMarker.js";

const lockedSessions = new Set<SessionID>();

export class ReactNativeSessionProvider implements SessionProvider {
  readonly durabilityMarker = ReactNativeSessionDurabilityMarker;

  async acquireSession(
    accountID: string,
    crypto: CryptoProvider,
  ): Promise<{ sessionID: SessionID; sessionDone: () => void }> {
    const kvStore = KvStoreContext.getInstance().getStorage();
    let existingSession = await kvStore.get(accountID as string);

    let abandonedDirtySession: SessionID | undefined;

    if (
      existingSession &&
      (await ReactNativeSessionDurabilityMarker.isSet(
        existingSession as SessionID,
      ))
    ) {
      // The previous run crashed while it had transactions sent to a sync
      // server but not yet persisted locally: reusing this session could fork
      // its hash chain. Abandon it and fall through to minting a fresh one.
      // The marker is cleared only AFTER the new session overwrites the kv
      // entry, so a crash in between still leaves the session marked dirty.
      abandonedDirtySession = existingSession as SessionID;
      existingSession = null;
    }

    if (!existingSession) {
      const newSessionID = crypto.newRandomSessionID(
        accountID as RawAccountID | AgentID,
      );
      await kvStore.set(accountID, newSessionID);
      if (abandonedDirtySession) {
        ReactNativeSessionDurabilityMarker.clear(abandonedDirtySession);
      }
      lockedSessions.add(newSessionID);

      console.log("Created new session", newSessionID);

      return Promise.resolve({
        sessionID: newSessionID,
        sessionDone: () => {
          lockedSessions.delete(newSessionID);
        },
      });
    }

    // Check if the session is already in use, should happen only if the dev
    // mounts multiple providers at the same time
    if (lockedSessions.has(existingSession as SessionID)) {
      const newSessionID = crypto.newRandomSessionID(
        accountID as RawAccountID | AgentID,
      );

      console.error("Existing session in use, creating new one", newSessionID);

      return Promise.resolve({
        sessionID: newSessionID,
        sessionDone: () => {},
      });
    }

    console.log("Using existing session", existingSession);
    lockedSessions.add(existingSession as SessionID);

    return Promise.resolve({
      sessionID: existingSession as SessionID,
      sessionDone: () => {
        lockedSessions.delete(existingSession as SessionID);
      },
    });
  }

  async persistSession(
    accountID: string,
    sessionID: SessionID,
  ): Promise<{ sessionDone: () => void }> {
    const kvStore = KvStoreContext.getInstance().getStorage();
    await kvStore.set(accountID, sessionID);
    lockedSessions.add(sessionID);

    console.log("Persisted session", sessionID);

    return Promise.resolve({
      sessionDone: () => {
        lockedSessions.delete(sessionID);
      },
    });
  }
}
