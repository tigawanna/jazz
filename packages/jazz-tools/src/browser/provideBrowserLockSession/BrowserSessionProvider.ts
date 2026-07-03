import { AgentID, CryptoProvider, RawAccountID, SessionID } from "cojson";
import { ID, Account, SessionProvider } from "jazz-tools";
import { SessionIDStorage } from "./SessionIDStorage";
import { BrowserSessionDurabilityMarker } from "./BrowserSessionDurabilityMarker";

export class BrowserSessionProvider implements SessionProvider {
  readonly durabilityMarker = BrowserSessionDurabilityMarker;

  async acquireSession(
    accountID: ID<Account> | AgentID,
    crypto: CryptoProvider,
  ): Promise<{ sessionID: SessionID; sessionDone: () => void }> {
    const { sessionPromise, resolveSession } = createSessionLockPromise();

    // Get the list of sessions for the account, to try to acquire an existing session
    const sessionsList = SessionIDStorage.getSessionsList(accountID);
    let dirtySlot: { index: number; sessionID: SessionID } | undefined;

    for (const [index, sessionID] of sessionsList.entries()) {
      // If the session crashed while it had sent-but-unpersisted transactions,
      // reusing it could fork the session's hash chain on the server.
      if (BrowserSessionDurabilityMarker.isSet(sessionID)) {
        dirtySlot ??= { index, sessionID };
        continue;
      }

      const sessionAcquired = await tryToAcquireSession(
        sessionID,
        sessionPromise,
      );

      if (sessionAcquired) {
        console.log("Using existing session", sessionID, "at index", index); // This log is used in the e2e tests to verify the correctness of the feature
        return {
          sessionID,
          sessionDone: resolveSession,
        };
      }
    }

    const newSessionID = crypto.newRandomSessionID(
      accountID as RawAccountID | AgentID,
    );

    // Acquire exclusively the session to store the new session ID for reuse in future sessions.
    // If a dirty slot was found, reclaim it so the list doesn't grow across crashes.
    await lockAndStoreSession(
      accountID,
      newSessionID,
      sessionPromise,
      dirtySlot,
    );

    console.log("Created new session", newSessionID); // This log is used in the e2e tests to verify the correctness of the feature

    return {
      sessionID: newSessionID,
      sessionDone: resolveSession,
    };
  }

  async persistSession(
    accountID: ID<Account> | AgentID,
    sessionID: SessionID,
  ): Promise<{ sessionDone: () => void }> {
    const { sessionPromise, resolveSession } = createSessionLockPromise();

    // Store the session id for future use and lock it until the session is done
    await lockAndStoreSession(accountID, sessionID, sessionPromise);

    console.log("Stored new session", sessionID);

    return { sessionDone: resolveSession };
  }
}

async function lockAndStoreSession(
  accountID: ID<Account> | AgentID,
  sessionID: SessionID,
  sessionPromise: Promise<void>,
  replaceSlot?: { index: number; sessionID: SessionID },
) {
  const sessionAcquired = await tryToAcquireSession(sessionID, sessionPromise);

  if (!sessionAcquired) {
    // This should never happen because the session has been randomly generated
    throw new Error("Couldn't get lock on new session");
  }

  // We don't need to wait for this to finish, we only need to acquire the lock on the new session
  storeSessionID(accountID, sessionID, replaceSlot);
}

function tryToAcquireSession(
  sessionID: SessionID,
  sessionDonePromise: Promise<void>,
) {
  return new Promise<boolean>((resolve) => {
    // Acquire exclusively the session if available
    navigator.locks.request(
      `load_session_${sessionID}`,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          resolve(false); // Session already in use
          return;
        }

        resolve(true); // Session is available

        // Return the promise to lock the session until sessionDone is called
        return sessionDonePromise;
      },
    );
  });
}

function storeSessionID(
  accountID: ID<Account> | AgentID,
  sessionID: SessionID,
  replaceSlot?: { index: number; sessionID: SessionID },
) {
  return navigator.locks.request(
    `store_session_${accountID}`,
    { mode: "exclusive" },
    async (lock) => {
      if (!lock) {
        console.error("Couldn't get lock to store session ID", accountID);
      }

      const sessionsList = SessionIDStorage.getSessionsList(accountID);

      // Reclaim the abandoned dirty session's slot so the list doesn't grow
      // across crashes — unless a concurrent tab already took it, in which
      // case append. The stale marker is dropped only after the slot is
      // written, so a crash in between leaves the session safely marked.
      const index =
        replaceSlot && sessionsList[replaceSlot.index] === replaceSlot.sessionID
          ? replaceSlot.index
          : sessionsList.length;

      SessionIDStorage.storeSessionID(accountID, sessionID, index);

      if (replaceSlot) {
        BrowserSessionDurabilityMarker.clear(replaceSlot.sessionID);
      }
    },
  );
}

function createSessionLockPromise() {
  let resolveSession: () => void;
  const sessionPromise = new Promise<void>((resolve) => {
    resolveSession = resolve;
  });

  return {
    sessionPromise,
    resolveSession: resolveSession!,
  };
}
