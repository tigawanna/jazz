# Session Durability Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unrecoverable session forking when a client crashes after sending transactions to a sync server but before persisting them locally, by marking the session "unsafe to reuse" during that window and having session providers mint a fresh session instead of reusing a dirty one.

**Architecture:** cojson's `SyncManager` tracks locally-created content that is queued for async storage but not yet durably stored; while such content is also being sent to peers, a listener (supplied via `LocalNode` creation options) is notified synchronously *before* the first network send. jazz-tools adapts that listener to a crash-surviving per-session marker (localStorage on web, KvStore on RN), and the browser/RN session providers skip marked sessions at acquire time. Synchronous storage completes stores inline, so the whole feature is a no-op there.

**Tech Stack:** TypeScript, vitest (`pnpm test <pattern>` from each package dir), pnpm workspaces, changesets.

**Spec:** `docs/superpowers/specs/2026-07-02-session-durability-marker-design.md`

**Conventions for all commits:** plain conventional-commit messages, no AI/assistant attribution of any kind (no Co-Authored-By lines, no "Generated with" footers).

---

## Background for the implementer (read first)

The race (see spec for full detail): `SyncManager.syncContent()` (`packages/cojson/src/sync.ts:1427`) is called — only for **locally-created** transactions — by `LocalTransactionsSyncQueue`. It calls `storeContent()`, which merely *enqueues* the write into the async `StoreQueue`, then immediately `trySendToPeer()`. A crash after the server received the content but before the local write completed leaves local storage behind the server **within the same session**. Session IDs are reused across restarts, and per-session transactions form a hash chain, so the restarted client eventually produces a conflicting transaction at the same position → the server rejects it forever.

Key existing code you will touch:

- `packages/cojson/src/queue/StoreQueue.ts` — FIFO queue of `{data, correctionCallback}` entries.
- `packages/cojson/src/storage/types.ts:63` — `StorageAPI.store(data, handleCorrection)` interface.
- `packages/cojson/src/storage/storageAsync.ts:270` — `StorageApiAsync.store` (pushes to StoreQueue, processes via `storeSingle` which returns `Promise<boolean>` success).
- `packages/cojson/src/storage/storageSync.ts:303` — `StorageApiSync.store` (calls `storeSingle` inline, returns `boolean`).
- `packages/cojson/src/sync.ts:1427-1456` — `syncContent`; `sync.ts:1501` — `storeContent`.
- `packages/cojson/src/localNode.ts:79-95` — `LocalNode` constructor with an `options` object; static creators `internalCreateAccount` (line 283), `withNewlyCreatedAccount` (line 352), `withLoadedAccount` (line 422).
- `packages/cojson/src/tests/testStorage.ts:257` — `trackStorageMessages` monkey-patches `storage.store` with a **2-arg** wrapper; it must forward the new third arg or every cojson test would silently drop `done`.
- `packages/jazz-tools/src/tools/implementation/createContext.ts:32` — `SessionProvider` interface; `createJazzContextFromExistingCredentials` (line 107) and `createJazzContextForNewAccount` (line 185) create the `LocalNode`.
- `packages/jazz-tools/src/browser/provideBrowserLockSession/` — `BrowserSessionProvider.ts`, `SessionIDStorage.ts` (slot-indexed localStorage list), `BrowserSessionProvider.test.ts` (happy-dom, mocked `navigator.locks`).
- `packages/jazz-tools/src/react-native-core/ReactNativeSessionProvider.ts` — single kv entry per account; test at `react-native-core/tests/ReactNativeSessionProvider.test.ts` uses `InMemoryKVStore`.

Test commands:
- cojson: `cd packages/cojson && pnpm test <file-name-substring>`
- jazz-tools: `cd packages/jazz-tools && pnpm test <file-name-substring>`

---

### Task 1: StoreQueue carries an optional `done` callback

**Files:**
- Modify: `packages/cojson/src/queue/StoreQueue.ts`
- Test: `packages/cojson/src/tests/StoreQueue.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

```ts
// packages/cojson/src/tests/StoreQueue.test.ts
import { describe, expect, test, vi } from "vitest";
import { StoreQueue } from "../queue/StoreQueue";
import { NewContentMessage } from "../sync";

const msg = (id: string) =>
  ({ action: "content", id, new: {}, priority: 0 }) as unknown as NewContentMessage;

describe("StoreQueue done callbacks", () => {
  test("passes each entry's done callback to the processing callback", async () => {
    const queue = new StoreQueue();
    const done1 = vi.fn();

    queue.push(msg("co_z1"), () => undefined, done1);
    queue.push(msg("co_z2"), () => undefined);

    const seen: Array<(() => void) | undefined> = [];
    await queue.processQueue(async (_data, _correction, done) => {
      seen.push(done);
    });

    expect(seen).toEqual([done1, undefined]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cojson && pnpm test StoreQueue.test`
Expected: FAIL — TypeScript/runtime error because `push` takes 2 args and the processing callback receives 2 args.

- [ ] **Step 3: Implement**

In `packages/cojson/src/queue/StoreQueue.ts`, change the entry type, `push`, and `processQueue`:

```ts
type StoreQueueEntry = {
  data: NewContentMessage;
  correctionCallback: CorrectionCallback;
  done?: () => void;
};
```

```ts
  public push(
    data: NewContentMessage,
    correctionCallback: CorrectionCallback,
    done?: () => void,
  ) {
    if (this.closed) {
      return;
    }

    this.queue.push({ data, correctionCallback, done });
  }
```

```ts
  processQueue(
    callback: (
      data: NewContentMessage,
      correctionCallback: CorrectionCallback,
      done?: () => void,
    ) => Promise<unknown>,
  ) {
    if (this.processing) {
      return;
    }

    this.processing = true;

    return StoreQueue.manager.schedule(this, async () => {
      let entry: StoreQueueEntry | undefined;

      while ((entry = this.pull())) {
        const { data, correctionCallback, done } = entry;

        try {
          this.lastCallback = callback(data, correctionCallback, done);
          await this.lastCallback;
        } catch (err) {
          logger.error("Error processing message in store queue", { err });
        }
      }

      this.lastCallback = undefined;
      this.processing = false;
    });
  }
```

Note: `close()` still drops queued entries without invoking `done` — that is intentional: an entry whose `done` never fires keeps the durability window open, which is the safe outcome (see Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cojson && pnpm test StoreQueue.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cojson/src/queue/StoreQueue.ts packages/cojson/src/tests/StoreQueue.test.ts
git commit -m "feat(cojson): thread optional done callback through StoreQueue entries"
```

---

### Task 2: `StorageAPI.store` completion callback (async + sync + test wrapper)

**Files:**
- Modify: `packages/cojson/src/storage/types.ts:63`
- Modify: `packages/cojson/src/storage/storageAsync.ts:270-281`
- Modify: `packages/cojson/src/storage/storageSync.ts:303-305`
- Modify: `packages/cojson/src/tests/testStorage.ts:257` (forward `done` in `trackStorageMessages`)
- Test: `packages/cojson/src/tests/sync.localStoreDurability.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cojson/src/tests/sync.localStoreDurability.test.ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  SyncMessagesLog,
  loadCoValueOrFail,
  setupTestNode,
  waitFor,
} from "./testUtils";
import { getDbPath, registerStorageCleanupRunner } from "./testStorage";

let jazzCloud: ReturnType<typeof setupTestNode>;

beforeEach(async () => {
  registerStorageCleanupRunner();
  SyncMessagesLog.clear();
  jazzCloud = setupTestNode({ isSyncServer: true });
});

describe("StorageAPI.store done callback", () => {
  test("async storage invokes done after the write completes", async () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    // Attach storage after creating the group so our manual store is the only write
    const { storage } = await client.addAsyncStorage();

    const content = group.core.newContentSince(undefined)!;
    const done = vi.fn();

    storage.store(content[0]!, () => undefined, done);

    expect(done).not.toHaveBeenCalled();
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  test("sync storage invokes done synchronously", async () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const { storage } = client.addStorage();

    const content = group.core.newContentSince(undefined)!;
    const done = vi.fn();

    storage.store(content[0]!, () => undefined, done);

    expect(done).toHaveBeenCalledTimes(1);
  });

  test("async storage invokes done after a successful correction round-trip", async () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("a", 1, "trusting");
    const { storage } = await client.addAsyncStorage();

    const fullContent = map.core.newContentSince(undefined)!;
    // Content without the header, stored into empty storage → triggers a correction
    const withoutHeader = map.core.newContentSince({
      id: map.id,
      header: true,
      sessions: {},
    })!;
    const done = vi.fn();

    storage.store(withoutHeader[0]!, () => fullContent, done);

    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });
});
```

Note: `setupTestNode` registers a graceful-shutdown hook; creating covalues *before* attaching storage keeps the node's own automatic stores out of the picture for these three tests. If `addAsyncStorage`/`addStorage` immediately triggers stores in your run, the assertions still hold — our `done` is per-entry.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cojson && pnpm test sync.localStoreDurability`
Expected: FAIL — `done` is never called (the third argument is ignored by both storage implementations and by the `trackStorageMessages` wrapper).

- [ ] **Step 3: Implement**

`packages/cojson/src/storage/types.ts` — replace line 63:

```ts
  /**
   * Stores the content. `done` is invoked only after the content is durably
   * stored (including any correction round-trip). It is NOT invoked when the
   * write fails or is dropped — callers rely on that to detect content that
   * was sent to peers but never persisted.
   */
  store(
    data: NewContentMessage,
    handleCorrection: CorrectionCallback,
    done?: () => void,
  ): void;
```

`packages/cojson/src/storage/storageAsync.ts` — replace the `store` method (line 270-281):

```ts
  async store(
    msg: NewContentMessage,
    correctionCallback: CorrectionCallback,
    done?: () => void,
  ) {
    /**
     * The store operations must be done one by one, because we can't start a new transaction when there
     * is already a transaction open.
     */
    this.storeQueue.push(msg, correctionCallback, done);

    this.storeQueue.processQueue(async (data, correctionCallback, done) => {
      this.interruptEraser("store");
      const success = await this.storeSingle(data, correctionCallback);

      if (success) {
        done?.();
      }

      return success;
    });
  }
```

`packages/cojson/src/storage/storageSync.ts` — replace the `store` method (line 303-305):

```ts
  store(
    msg: NewContentMessage,
    correctionCallback: CorrectionCallback,
    done?: () => void,
  ) {
    const success = this.storeSingle(msg, correctionCallback);

    if (success) {
      done?.();
    }

    return success;
  }
```

`packages/cojson/src/tests/testStorage.ts` — the `trackStorageMessages` store wrapper (line 257) must forward `done`:

```ts
  storage.store = function (data, correctionCallback, done) {
    SyncMessagesLog.add({
      from: nodeName,
      to: storageName,
      msg: data,
    });

    return originalStore.call(
      storage,
      data,
      (correction) => {
        SyncMessagesLog.add({
          from: storageName,
          to: nodeName,
          msg: {
            action: "known",
            isCorrection: true,
            ...correction,
          },
        });

        const correctionMessages = correctionCallback(correction);

        if (correctionMessages) {
          for (const msg of correctionMessages) {
            SyncMessagesLog.add({
              from: nodeName,
              to: storageName,
              msg,
            });
          }
        }

        return correctionMessages;
      },
      done,
    );
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cojson && pnpm test sync.localStoreDurability`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the storage test suites to check for regressions**

Run: `cd packages/cojson && pnpm test StorageApi && pnpm test sync.storage`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cojson/src/storage/types.ts packages/cojson/src/storage/storageAsync.ts packages/cojson/src/storage/storageSync.ts packages/cojson/src/tests/testStorage.ts packages/cojson/src/tests/sync.localStoreDurability.test.ts
git commit -m "feat(cojson): add store completion callback to StorageAPI"
```

---

### Task 3: SyncManager durability window tracking

**Files:**
- Modify: `packages/cojson/src/sync.ts` (`syncContent` at 1427, `storeContent` at 1501, new fields near `syncQueue` at 1421)
- Test: `packages/cojson/src/tests/sync.localStoreDurability.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (append to the file from Task 2)

```ts
describe("local store durability window", () => {
  test("opens before the first peer send and closes when async storage drains", async () => {
    const client = setupTestNode();
    await client.addAsyncStorage();
    client.connectToSyncServer();

    let contentSent = false;
    const originalTrySend = client.node.syncManager.trySendToPeer.bind(
      client.node.syncManager,
    );
    vi.spyOn(client.node.syncManager, "trySendToPeer").mockImplementation(
      (peer, msg) => {
        if (msg.action === "content") {
          contentSent = true;
        }
        return originalTrySend(peer, msg);
      },
    );

    const events: Array<{ hasPending: boolean; contentSentAlready: boolean }> =
      [];
    client.node.syncManager.onLocalStoreDurabilityChange = (hasPending) => {
      events.push({ hasPending, contentSentAlready: contentSent });
    };

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await waitFor(() =>
      expect(events.some((e) => !e.hasPending)).toBe(true),
    );

    // The window opened BEFORE any content was sent to a peer
    expect(events[0]).toEqual({ hasPending: true, contentSentAlready: false });
    // ...and eventually closed once storage drained
    expect(events.at(-1)!.hasPending).toBe(false);
  });

  test("reports the node's current session ID", async () => {
    const client = setupTestNode();
    await client.addAsyncStorage();
    client.connectToSyncServer();

    const sessions: string[] = [];
    client.node.syncManager.onLocalStoreDurabilityChange = (
      _hasPending,
      sessionID,
    ) => {
      sessions.push(sessionID);
    };

    const group = client.node.createGroup();
    group.createMap().set("hello", "world", "trusting");

    await waitFor(() => expect(sessions.length).toBeGreaterThan(0));
    expect(
      sessions.every((s) => s === client.node.currentSessionID),
    ).toBe(true);
  });

  test("does not fire with synchronous storage", async () => {
    const client = setupTestNode();
    client.addStorage();
    client.connectToSyncServer();

    const listener = vi.fn();
    client.node.syncManager.onLocalStoreDurabilityChange = listener;

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await map.core.waitForSync();
    expect(listener).not.toHaveBeenCalled();
  });

  test("does not fire when there are no peers to send to", async () => {
    const client = setupTestNode(); // not connected
    await client.addAsyncStorage();

    const listener = vi.fn();
    client.node.syncManager.onLocalStoreDurabilityChange = listener;

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await client.node.syncManager.waitForStorageSync(map.id);
    expect(listener).not.toHaveBeenCalled();
  });

  test("remote content does not open the window on the receiving node", async () => {
    const server = setupTestNode({ isSyncServer: true });
    await server.addAsyncStorage({ ourName: "server" });

    const listener = vi.fn();
    server.node.syncManager.onLocalStoreDurabilityChange = listener;

    const client = setupTestNode({ connected: true });
    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await map.core.waitForSync();
    expect(listener).not.toHaveBeenCalled();
  });

  test("window stays open when storage writes never complete (crash window)", async () => {
    const client = setupTestNode();
    const { storage } = await client.addAsyncStorage();
    client.connectToSyncServer();

    // Simulate the crash window: storage accepts writes but never completes them
    storage.store = () => {};

    const events: boolean[] = [];
    client.node.syncManager.onLocalStoreDurabilityChange = (hasPending) =>
      events.push(hasPending);

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await map.core.waitForSync(); // reached the server
    expect(events).toEqual([true]); // opened, never closed
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cojson && pnpm test sync.localStoreDurability`
Expected: FAIL — `onLocalStoreDurabilityChange` doesn't exist on SyncManager.

- [ ] **Step 3: Implement in `packages/cojson/src/sync.ts`**

Add the exported listener type near the top of the file (next to the other exported types; `SessionID` is already imported from `./ids.js`):

```ts
export type LocalStoreDurabilityListener = (
  hasPending: boolean,
  sessionID: SessionID,
) => void;
```

Add fields and helpers to `SyncManager`, right after the `syncQueue`/`syncLocalTransaction` block (line ~1425):

```ts
  /**
   * Tracks locally-created content that has been handed to async storage but
   * is not yet durably stored. If such content is also sent to a peer and the
   * process crashes before the write completes, local storage ends up behind
   * what the server received for this session — reusing the session after
   * restart would then fork its hash chain. The listener lets the platform
   * layer mark the session as unsafe to reuse while that window is open.
   *
   * With synchronous storage the store completes inline, the counter is back
   * to 0 before any send, and the listener never fires.
   */
  onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
  private pendingLocalStores = 0;
  private localStoreDurabilityWindowOpen = false;

  private handleLocalStoreDone = () => {
    this.pendingLocalStores--;

    if (this.pendingLocalStores === 0 && this.localStoreDurabilityWindowOpen) {
      this.localStoreDurabilityWindowOpen = false;
      this.onLocalStoreDurabilityChange?.(false, this.local.currentSessionID);
    }
  };

  private openLocalStoreDurabilityWindow() {
    if (this.pendingLocalStores > 0 && !this.localStoreDurabilityWindowOpen) {
      this.localStoreDurabilityWindowOpen = true;
      this.onLocalStoreDurabilityChange?.(true, this.local.currentSessionID);
    }
  }
```

Modify `syncContent` (line 1427): count the store, and open the window immediately before each send (the open helper is idempotent, so it fires once, before the *first* actual send):

```ts
  syncContent(content: NewContentMessage) {
    const coValue = this.local.getCoValue(content.id);

    if (this.local.storage) {
      this.pendingLocalStores++;
      this.storeContent(content, this.handleLocalStoreDone);
    }

    this.trackSyncState(coValue.id);

    const contentKnownState = knownStateFromContent(content);

    for (const peer of this.getPeers(coValue.id)) {
      // Only subscribed CoValues are synced to clients
      if (
        peer.role === "client" &&
        !peer.isCoValueSubscribedToPeer(coValue.id)
      ) {
        continue;
      }

      if (peer.closed || coValue.isErroredInPeer(peer.id)) {
        peer.emitCoValueChange(content.id);
        continue;
      }

      // The content is about to leave the node while its local store may still
      // be pending: mark the session as unsafe to reuse until storage drains.
      this.openLocalStoreDurabilityWindow();

      // We assume that the peer already knows anything before this content
      // Any eventual reconciliation will be handled through the known state messages exchange
      this.trySendToPeer(peer, content);
      peer.combineOptimisticWith(coValue.id, contentKnownState);
      peer.trackToldKnownState(coValue.id);
    }
  }
```

Modify `storeContent` (line 1501) to accept and forward the completion callback. The remote-content caller (`handleNewContent`, line 1371) stays unchanged and never passes `onStored`, so remote content never counts toward the window:

```ts
  private storeContent(content: NewContentMessage, onStored?: () => void) {
    const storage = this.local.storage;

    if (!storage) return;

    const value = this.local.getCoValue(content.id);

    if (value.isDeleted) {
      // This doesn't persist the delete flag, it only signals the storage
      // API that the delete transaction is valid
      storage.markDeleteAsValid(value.id);
    }

    // Try to store the content as-is for performance
    // In case that some transactions are missing, a correction will be requested, but it's an edge case
    storage.store(
      content,
      (correction) => {
        if (!value.verified) {
          logger.error(
            "Correction requested for a CoValue with no verified content",
            {
              id: content.id,
              content: getContenDebugInfo(content),
              correction,
              state: value.loadingState,
            },
          );
          return undefined;
        }

        return value.newContentSince(correction);
      },
      onStored,
    );
  }
```

Note the behavior change in `syncContent`: previously it called `this.storeContent(content)` unconditionally (a no-op without storage); now the call is guarded by `this.local.storage` so the counter only increments when a store is actually enqueued. Behavior without storage is identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cojson && pnpm test sync.localStoreDurability`
Expected: PASS (all tests from Tasks 2 and 3)

- [ ] **Step 5: Run the broader sync suites for regressions**

Run: `cd packages/cojson && pnpm test sync.`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cojson/src/sync.ts packages/cojson/src/tests/sync.localStoreDurability.test.ts
git commit -m "feat(cojson): track sent-but-unpersisted local content as a session durability window"
```

---

### Task 4: Thread the listener through LocalNode creation options

**Files:**
- Modify: `packages/cojson/src/localNode.ts` (constructor at 79, `internalCreateAccount` at 283, `withNewlyCreatedAccount` at 352, `withLoadedAccount` at 422)
- Modify: `packages/cojson/src/exports.ts` (export the listener type, near the existing `./sync.js` type exports at line 71-76)
- Test: `packages/cojson/src/tests/sync.localStoreDurability.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to the durability describe block or add a new one)

```ts
import { LocalNode } from "../localNode";
import { WasmCrypto } from "../crypto/WasmCrypto";

// at module scope, next to the other top-level constants:
const Crypto = await WasmCrypto.create();

describe("LocalNode creation options", () => {
  test("withNewlyCreatedAccount wires onLocalStoreDurabilityChange before first sync", async () => {
    const listener = vi.fn();

    const { node } = await LocalNode.withNewlyCreatedAccount({
      creationProps: { name: "test" },
      crypto: Crypto,
      peers: [],
      onLocalStoreDurabilityChange: listener,
    });

    expect(node.syncManager.onLocalStoreDurabilityChange).toBe(listener);
    await node.gracefulShutdown();
  });
});
```

(If the `WasmCrypto` import path differs, mirror the import used by other cojson tests — check `grep -rn "WasmCrypto" packages/cojson/src/tests/*.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cojson && pnpm test sync.localStoreDurability`
Expected: FAIL — the option is not accepted / not wired.

- [ ] **Step 3: Implement in `packages/cojson/src/localNode.ts`**

Import the type (extend the existing import from `./sync.js` at line 39):

```ts
import {
  Peer,
  PeerID,
  SyncManager,
  type LocalStoreDurabilityListener,
  type SyncWhen,
} from "./sync.js";
```

Constructor (line 79-95) — extend the options type and wire the listener:

```ts
  constructor(
    agentSecret: AgentSecret,
    currentSessionID: SessionID,
    crypto: CryptoProvider,
    public readonly syncWhen?: SyncWhen,
    enableFullStorageReconciliation?: boolean,
    options?: {
      experimental_clockSyncFromServerPings?: boolean;
      onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
    },
  ) {
    this.agentSecret = agentSecret;
    this.currentSessionID = currentSessionID;
    this.crypto = crypto;
    if (enableFullStorageReconciliation) {
      this.syncManager.fullStorageReconciliationEnabled = true;
    }
    this.#clockSyncEnabled =
      options?.experimental_clockSyncFromServerPings ?? false;
    this.syncManager.onLocalStoreDurabilityChange =
      options?.onLocalStoreDurabilityChange;
  }
```

`internalCreateAccount` (line 283) — add to the opts type and forward:

```ts
  static internalCreateAccount(opts: {
    crypto: CryptoProvider;
    initialAgentSecret?: AgentSecret;
    peers?: Peer[];
    syncWhen?: SyncWhen;
    storage?: StorageAPI;
    enableFullStorageReconciliation?: boolean;
    experimental_clockSyncFromServerPings?: boolean;
    onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
  }): RawAccount {
```

and in its `new LocalNode(...)` call, extend the options object:

```ts
      {
        experimental_clockSyncFromServerPings:
          opts.experimental_clockSyncFromServerPings,
        onLocalStoreDurabilityChange: opts.onLocalStoreDurabilityChange,
      },
```

`withNewlyCreatedAccount` (line 352) — add `onLocalStoreDurabilityChange` to the destructured params and its type:

```ts
    storage,
    enableFullStorageReconciliation,
    experimental_clockSyncFromServerPings,
    onLocalStoreDurabilityChange,
  }: {
    ...
    experimental_clockSyncFromServerPings?: boolean;
    onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
  })
```

and forward it in the `LocalNode.internalCreateAccount({...})` call:

```ts
    const account = LocalNode.internalCreateAccount({
      crypto,
      initialAgentSecret,
      peers,
      syncWhen,
      storage,
      enableFullStorageReconciliation,
      experimental_clockSyncFromServerPings,
      onLocalStoreDurabilityChange,
    });
```

`withLoadedAccount` (line 422) — same param addition, and extend its `new LocalNode(...)` options:

```ts
      const node = new LocalNode(
        accountSecret,
        sessionID || crypto.newRandomSessionID(accountID),
        crypto,
        syncWhen,
        enableFullStorageReconciliation,
        {
          experimental_clockSyncFromServerPings,
          onLocalStoreDurabilityChange,
        },
      );
```

`packages/cojson/src/exports.ts` — add `LocalStoreDurabilityListener` to the existing type re-export from `./sync.js` (the block at line 71-76):

```ts
export type { ..., LocalStoreDurabilityListener } from "./sync.js";
```

(Keep the existing names in that block; just append the new one.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cojson && pnpm test sync.localStoreDurability`
Expected: PASS

- [ ] **Step 5: Typecheck the package**

Run: `cd packages/cojson && pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/cojson/src/localNode.ts packages/cojson/src/exports.ts packages/cojson/src/tests/sync.localStoreDurability.test.ts
git commit -m "feat(cojson): accept onLocalStoreDurabilityChange in LocalNode creation options"
```

---

### Task 5: jazz-tools marker interface, listener factory, and context wiring

**Files:**
- Create: `packages/jazz-tools/src/tools/implementation/sessionDurabilityMarker.ts`
- Modify: `packages/jazz-tools/src/tools/implementation/createContext.ts` (interface at line 32, wiring in both create functions)
- Test: `packages/jazz-tools/src/tools/tests/sessionDurabilityMarker.test.ts` (new file)

`internal.ts:35` already does `export * from "./implementation/createContext.js"`; add a matching `export * from "./implementation/sessionDurabilityMarker.js"` line next to it so the new symbols reach the public `jazz-tools` surface (browser/RN packages import from `"jazz-tools"`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/jazz-tools/src/tools/tests/sessionDurabilityMarker.test.ts
import type { SessionID } from "cojson";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeDurabilityMarkerListener } from "../implementation/sessionDurabilityMarker.js";

const sessionID = "co_ztest_session_ztest" as SessionID;

function mockMarker() {
  return { set: vi.fn(), clear: vi.fn(), isSet: vi.fn(() => false) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("makeDurabilityMarkerListener", () => {
  test("sets the marker synchronously when the window opens", () => {
    const marker = mockMarker();
    const listener = makeDurabilityMarkerListener(marker);

    listener(true, sessionID);

    expect(marker.set).toHaveBeenCalledWith(sessionID);
    expect(marker.clear).not.toHaveBeenCalled();
  });

  test("clears the marker only after the debounce delay", () => {
    vi.useFakeTimers();
    const marker = mockMarker();
    const listener = makeDurabilityMarkerListener(marker, 200);

    listener(true, sessionID);
    listener(false, sessionID);
    expect(marker.clear).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(marker.clear).toHaveBeenCalledWith(sessionID);
  });

  test("a new pending window cancels a scheduled clear", () => {
    vi.useFakeTimers();
    const marker = mockMarker();
    const listener = makeDurabilityMarkerListener(marker, 200);

    listener(true, sessionID);
    listener(false, sessionID);
    listener(true, sessionID); // window re-opens within the debounce
    vi.advanceTimersByTime(500);

    expect(marker.clear).not.toHaveBeenCalled();
  });

  test("marker errors are swallowed with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const marker = mockMarker();
    marker.set.mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const listener = makeDurabilityMarkerListener(marker);

    expect(() => listener(true, sessionID)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/jazz-tools && pnpm test sessionDurabilityMarker`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `sessionDurabilityMarker.ts`**

```ts
// packages/jazz-tools/src/tools/implementation/sessionDurabilityMarker.ts
import type { SessionID } from "cojson";

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
): (hasPending: boolean, sessionID: SessionID) => void {
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  return (hasPending, sessionID) => {
    if (hasPending) {
      if (clearTimer !== undefined) {
        clearTimeout(clearTimer);
        clearTimer = undefined;
      }

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
```

Add to `packages/jazz-tools/src/tools/internal.ts`, next to line 35:

```ts
export * from "./implementation/sessionDurabilityMarker.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/jazz-tools && pnpm test sessionDurabilityMarker`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into createContext**

In `packages/jazz-tools/src/tools/implementation/createContext.ts`:

Add the import:

```ts
import {
  type SessionDurabilityMarker,
  makeDurabilityMarkerListener,
} from "./sessionDurabilityMarker.js";
```

Extend the `SessionProvider` interface (line 32):

```ts
export interface SessionProvider {
  acquireSession: (
    accountID: ID<Account>,
    crypto: CryptoProvider,
  ) => Promise<{ sessionID: SessionID; sessionDone: () => void }>;
  persistSession: (
    accountID: ID<Account>,
    sessionID: SessionID,
  ) => Promise<{ sessionDone: () => void }>;
  /**
   * When present, the context marks sessions as unsafe-to-reuse while they
   * have transactions sent to a sync server but not yet persisted locally,
   * and the provider must skip marked sessions in acquireSession.
   */
  durabilityMarker?: SessionDurabilityMarker;
}
```

In `createJazzContextFromExistingCredentials`, before the `LocalNode.withLoadedAccount` call (line 145):

```ts
  const onLocalStoreDurabilityChange = sessionProvider.durabilityMarker
    ? makeDurabilityMarkerListener(sessionProvider.durabilityMarker)
    : undefined;
```

and add `onLocalStoreDurabilityChange,` to the `withLoadedAccount({...})` argument object.

In `createJazzContextForNewAccount`, do the same before the `LocalNode.withNewlyCreatedAccount` call (line 218) and add `onLocalStoreDurabilityChange,` to its argument object.

- [ ] **Step 6: Write the wiring test** (append to `sessionDurabilityMarker.test.ts`)

This uses the same harness as `createContext.test.ts` (test sync server + async storage + `createJazzTestAccount`):

```ts
import { LocalNode } from "cojson";
import {
  MockSessionProvider,
  createJazzContextFromExistingCredentials,
} from "../exports";
import { createJazzTestAccount, setupJazzTestSync } from "../testing";
import { getPeerConnectedToTestSyncServer } from "../testing";

describe("createContext wiring", () => {
  test("passes a durability listener to LocalNode when the provider has a marker", async () => {
    await setupJazzTestSync();
    const account = await createJazzTestAccount({
      isCurrentActiveAccount: true,
    });

    const spy = vi.spyOn(LocalNode, "withLoadedAccount");

    const provider = new MockSessionProvider();
    (provider as any).durabilityMarker = mockMarker();

    const context = await createJazzContextFromExistingCredentials({
      credentials: {
        accountID: account.$jazz.id,
        secret: account.$jazz.localNode.agentSecret,
      },
      peers: [getPeerConnectedToTestSyncServer()],
      crypto: account.$jazz.localNode.crypto,
      sessionProvider: provider,
      asActiveAccount: false,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        onLocalStoreDurabilityChange: expect.any(Function),
      }),
    );

    context.done();
    spy.mockRestore();
  });
});
```

(Adjust imports/harness details to match `createContext.test.ts` if signatures differ — that file is the reference for how to build valid credentials in tests.)

- [ ] **Step 7: Run tests + typecheck**

Run: `cd packages/jazz-tools && pnpm test sessionDurabilityMarker && pnpm test createContext`
Expected: PASS (new tests + no regressions in createContext tests)

- [ ] **Step 8: Commit**

```bash
git add packages/jazz-tools/src/tools/implementation/sessionDurabilityMarker.ts packages/jazz-tools/src/tools/implementation/createContext.ts packages/jazz-tools/src/tools/internal.ts packages/jazz-tools/src/tools/tests/sessionDurabilityMarker.test.ts
git commit -m "feat(jazz-tools): session durability marker interface and context wiring"
```

---

### Task 6: Browser marker + BrowserSessionProvider skip/reclaim

**Files:**
- Create: `packages/jazz-tools/src/browser/provideBrowserLockSession/BrowserSessionDurabilityMarker.ts`
- Modify: `packages/jazz-tools/src/browser/provideBrowserLockSession/BrowserSessionProvider.ts`
- Test: `packages/jazz-tools/src/browser/provideBrowserLockSession/BrowserSessionProvider.test.ts` (extend; happy-dom provides `localStorage`, `navigator.locks` is mocked at the top of the file)

- [ ] **Step 1: Write the failing tests** (append inside the existing describe, after the existing acquire tests)

```ts
import { BrowserSessionDurabilityMarker } from "./BrowserSessionDurabilityMarker.js";

describe("session durability marker", () => {
  test("acquireSession skips a dirty session and reclaims its slot", async () => {
    const provider = new BrowserSessionProvider();
    const accountID = "co_zdirtytest" as any;

    // A previously stored session that crashed inside the durability window
    const dirtySession = Crypto.newRandomSessionID(accountID) as SessionID;
    SessionIDStorage.storeSessionID(accountID, dirtySession, 0);
    BrowserSessionDurabilityMarker.set(dirtySession);

    const { sessionID, sessionDone } = await provider.acquireSession(
      accountID,
      Crypto as CryptoProvider,
    );

    // A fresh session was minted instead of reusing the dirty one
    expect(sessionID).not.toBe(dirtySession);
    // The dirty session's slot was overwritten (list does not grow)
    expect(SessionIDStorage.getSessionsList(accountID)).toEqual([sessionID]);
    // The old marker was cleaned up
    expect(BrowserSessionDurabilityMarker.isSet(dirtySession)).toBe(false);

    sessionDone();
  });

  test("acquireSession still reuses a clean stored session", async () => {
    const provider = new BrowserSessionProvider();
    const accountID = "co_zcleantest" as any;

    const cleanSession = Crypto.newRandomSessionID(accountID) as SessionID;
    SessionIDStorage.storeSessionID(accountID, cleanSession, 0);

    const { sessionID, sessionDone } = await provider.acquireSession(
      accountID,
      Crypto as CryptoProvider,
    );

    expect(sessionID).toBe(cleanSession);
    sessionDone();
  });

  test("marker set/clear/isSet round-trips through localStorage", () => {
    const id = "co_zx_session_zy" as SessionID;
    expect(BrowserSessionDurabilityMarker.isSet(id)).toBe(false);
    BrowserSessionDurabilityMarker.set(id);
    expect(BrowserSessionDurabilityMarker.isSet(id)).toBe(true);
    BrowserSessionDurabilityMarker.clear(id);
    expect(BrowserSessionDurabilityMarker.isSet(id)).toBe(false);
  });
});
```

(Match the existing file's setup: it already imports `SessionIDStorage`, `Crypto`, and clears state in `beforeEach` — reuse those. Add `localStorage.clear()` to the `beforeEach` if the existing tests don't already do it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/jazz-tools && pnpm test BrowserSessionProvider`
Expected: FAIL — `BrowserSessionDurabilityMarker` does not exist.

- [ ] **Step 3: Implement the marker**

```ts
// packages/jazz-tools/src/browser/provideBrowserLockSession/BrowserSessionDurabilityMarker.ts
import type { SessionID } from "cojson";
import type { SessionDurabilityMarker } from "jazz-tools";

function markerKey(sessionID: SessionID) {
  return `jazz_session_dirty_${sessionID}`;
}

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
```

- [ ] **Step 4: Implement the provider changes**

In `BrowserSessionProvider.ts`:

Add the import and the provider field:

```ts
import { BrowserSessionDurabilityMarker } from "./BrowserSessionDurabilityMarker";
```

```ts
export class BrowserSessionProvider implements SessionProvider {
  durabilityMarker = BrowserSessionDurabilityMarker;
```

Replace the body of `acquireSession` with:

```ts
  async acquireSession(
    accountID: ID<Account> | AgentID,
    crypto: CryptoProvider,
  ): Promise<{ sessionID: SessionID; sessionDone: () => void }> {
    const { sessionPromise, resolveSession } = createSessionLockPromise();

    // Get the list of sessions for the account, to try to acquire an existing session
    const sessionsList = SessionIDStorage.getSessionsList(accountID);

    let dirtySlot: { index: number; sessionID: SessionID } | undefined;

    for (const [index, sessionID] of sessionsList.entries()) {
      if (BrowserSessionDurabilityMarker.isSet(sessionID)) {
        // The session crashed while it had transactions sent to a sync server
        // but not yet persisted locally: reusing it could fork its hash chain.
        // Remember the slot so the replacement session can reclaim it.
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

    // Acquire exclusively the session to store the new session ID for reuse in future sessions
    await lockAndStoreSession(accountID, newSessionID, sessionPromise, dirtySlot);

    console.log("Created new session", newSessionID); // This log is used in the e2e tests to verify the correctness of the feature

    return {
      sessionID: newSessionID,
      sessionDone: resolveSession,
    };
  }
```

Extend `lockAndStoreSession` and `storeSessionID`:

```ts
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
```

```ts
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

      if (replaceSlot) {
        // Overwrite the abandoned dirty session's slot so the list doesn't
        // grow across crashes, and drop its now-stale marker.
        SessionIDStorage.storeSessionID(accountID, sessionID, replaceSlot.index);
        BrowserSessionDurabilityMarker.clear(replaceSlot.sessionID);
        return;
      }

      const sessionsList = SessionIDStorage.getSessionsList(accountID);
      SessionIDStorage.storeSessionID(
        accountID,
        sessionID,
        sessionsList.length,
      );
    },
  );
}
```

Also export the marker from `packages/jazz-tools/src/browser/provideBrowserLockSession/index.ts`:

```ts
export { BrowserSessionDurabilityMarker } from "./BrowserSessionDurabilityMarker";
```

Note on `persistSession`: it stores a session the current process is actively using; no marker check is needed there (the runtime listener handles marking).

Known accepted edge (from the spec): if another live tab is inside its durability window (marker set) while this tab acquires, the dirty-but-alive session's slot gets reclaimed and that session is orphaned after its tab closes. That's equivalent to burning one session and cannot cause divergence.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/jazz-tools && pnpm test BrowserSessionProvider`
Expected: PASS (existing + 3 new tests)

- [ ] **Step 6: Commit**

```bash
git add packages/jazz-tools/src/browser/provideBrowserLockSession/
git commit -m "feat(jazz-tools): browser session durability marker with slot reclamation"
```

---

### Task 7: React Native marker + ReactNativeSessionProvider

**Files:**
- Create: `packages/jazz-tools/src/react-native-core/ReactNativeSessionDurabilityMarker.ts`
- Modify: `packages/jazz-tools/src/react-native-core/ReactNativeSessionProvider.ts`
- Modify: `packages/jazz-tools/src/react-native-core/index.ts` (export the marker)
- Test: `packages/jazz-tools/src/react-native-core/tests/ReactNativeSessionProvider.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (append a describe block; the file already sets up `InMemoryKVStore`, `Crypto`, and a fresh provider per test)

```ts
import { ReactNativeSessionDurabilityMarker } from "../ReactNativeSessionDurabilityMarker.js";

describe("session durability marker", () => {
  test("acquireSession mints a new session when the stored one is dirty", async () => {
    const accountID = account.$jazz.id;

    // Store a session, then mark it dirty (as a crash inside the window would leave it)
    const dirtySession = Crypto.newRandomSessionID(
      accountID as unknown as RawAccountID,
    );
    await kvStore.set(accountID, dirtySession);
    await ReactNativeSessionDurabilityMarker.set(dirtySession);

    const result = await sessionProvider.acquireSession(
      accountID,
      Crypto as CryptoProvider,
    );

    expect(result.sessionID).not.toBe(dirtySession);
    // The kv entry was overwritten with the new session
    expect(await kvStore.get(accountID)).toBe(result.sessionID);
    // The stale marker was removed
    expect(await ReactNativeSessionDurabilityMarker.isSet(dirtySession)).toBe(
      false,
    );

    result.sessionDone();
  });

  test("marker set/clear/isSet round-trips through the KvStore", async () => {
    const id = "co_zx_session_zy" as SessionID;
    expect(await ReactNativeSessionDurabilityMarker.isSet(id)).toBe(false);
    ReactNativeSessionDurabilityMarker.set(id);
    // set() is fire-and-forget; flush microtasks before asserting
    await Promise.resolve();
    expect(await ReactNativeSessionDurabilityMarker.isSet(id)).toBe(true);
    ReactNativeSessionDurabilityMarker.clear(id);
    await Promise.resolve();
    expect(await ReactNativeSessionDurabilityMarker.isSet(id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/jazz-tools && pnpm test ReactNativeSessionProvider`
Expected: FAIL — marker module does not exist.

- [ ] **Step 3: Implement the marker**

```ts
// packages/jazz-tools/src/react-native-core/ReactNativeSessionDurabilityMarker.ts
import type { SessionID } from "cojson";
import type { SessionDurabilityMarker } from "jazz-tools";
import { KvStoreContext } from "./storage/kv-store-context.js";

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
    void KvStoreContext.getInstance()
      .getStorage()
      .set(markerKey(sessionID), "1");
  },
  clear(sessionID: SessionID) {
    void KvStoreContext.getInstance().getStorage().delete(markerKey(sessionID));
  },
  async isSet(sessionID: SessionID) {
    const value = await KvStoreContext.getInstance()
      .getStorage()
      .get(markerKey(sessionID));
    return value !== null;
  },
};
```

- [ ] **Step 4: Implement the provider changes**

In `ReactNativeSessionProvider.ts`, add the import and field, and check the marker before reusing the stored session:

```ts
import { ReactNativeSessionDurabilityMarker } from "./ReactNativeSessionDurabilityMarker.js";
```

```ts
export class ReactNativeSessionProvider implements SessionProvider {
  durabilityMarker = ReactNativeSessionDurabilityMarker;

  async acquireSession(
    accountID: string,
    crypto: CryptoProvider,
  ): Promise<{ sessionID: SessionID; sessionDone: () => void }> {
    const kvStore = KvStoreContext.getInstance().getStorage();
    let existingSession = await kvStore.get(accountID as string);

    if (
      existingSession &&
      (await ReactNativeSessionDurabilityMarker.isSet(
        existingSession as SessionID,
      ))
    ) {
      // The previous run crashed while it had transactions sent to a sync
      // server but not yet persisted locally: reusing this session could fork
      // its hash chain. Abandon it and fall through to minting a fresh one
      // (which overwrites the kv entry below).
      await ReactNativeSessionDurabilityMarker.clear(
        existingSession as SessionID,
      );
      existingSession = null;
    }

    if (!existingSession) {
      // ... existing new-session branch, unchanged ...
```

(The rest of the method — the locked-session check and the reuse branch — stays exactly as it is.)

Export the marker from `packages/jazz-tools/src/react-native-core/index.ts` (next to the existing exports at the top):

```ts
export * from "./ReactNativeSessionDurabilityMarker.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/jazz-tools && pnpm test ReactNativeSessionProvider`
Expected: PASS (existing + 2 new tests)

- [ ] **Step 6: Commit**

```bash
git add packages/jazz-tools/src/react-native-core/
git commit -m "feat(jazz-tools): react-native session durability marker"
```

---

### Task 8: End-to-end regression test for the original bug (cojson)

**Files:**
- Test: `packages/cojson/src/tests/sync.localStoreDurability.test.ts` (extend)

This test proves the whole story at the cojson level: a crash inside the window leaves the marker "stuck dirty" (Task 3's last test), and a restart that follows the marker's advice — a **fresh session over the same storage** — recovers everything and syncs cleanly, with the crashed transaction coming back down from the server.

- [ ] **Step 1: Write the test** (append to the file)

```ts
import { expectMap } from "../coValue";

describe("crash recovery with a fresh session", () => {
  test("restarting with a new session over the same storage recovers and syncs cleanly", async () => {
    const client = setupTestNode();
    const dbPath = getDbPath();
    const { storage } = await client.addAsyncStorage({ filename: dbPath });
    client.connectToSyncServer();

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");
    await map.core.waitForSync();
    await client.node.syncManager.waitForStorageSync(map.id);

    // Enter the crash window: further writes reach the server but not storage
    storage.store = () => {};
    map.set("crashed", "yes", "trusting");
    await map.core.waitForSync();

    // "Crash": abandon the node without flushing (no graceful shutdown), then
    // restart with the SAME agent, SAME storage file, but a NEW session — which
    // is exactly what the session providers do when the durability marker is set.
    client.disconnect();
    const restarted = setupTestNode({ secret: client.node.agentSecret });
    await restarted.addAsyncStorage({ filename: dbPath });
    restarted.connectToSyncServer();

    // The crashed transaction comes back down from the server
    const mapOnRestart = await loadCoValueOrFail(restarted.node, map.id);
    await waitFor(() => expect(mapOnRestart.get("crashed")).toEqual("yes"));

    // New writes from the fresh session sync cleanly — no signature rejection
    mapOnRestart.set("recovered", "yes", "trusting");
    await mapOnRestart.core.waitForSync();

    const mapOnServer = await loadCoValueOrFail(jazzCloud.node, map.id);
    expect(mapOnServer.get("recovered")).toEqual("yes");
    expect(mapOnServer.get("crashed")).toEqual("yes");
  });
});
```

Notes for the implementer:
- `setupTestNode({ secret })` reuses the same agent (same account/permissions) with a fresh random session — the same thing a provider does after seeing a dirty marker.
- `client.disconnect()` severs the peer without a graceful shutdown, approximating a crash; the abandoned node's storage handle is cleaned up by the test-storage cleanup hooks.
- If `mapOnRestart.get(...)` isn't available on the value returned by `loadCoValueOrFail`, wrap with `expectMap(mapOnRestart.getCurrentContent())` — mirror how neighboring tests in `sync.storageAsync.test.ts` read map values, and drop the unused import otherwise.

- [ ] **Step 2: Run the test**

Run: `cd packages/cojson && pnpm test sync.localStoreDurability`
Expected: PASS

- [ ] **Step 3: Run the full cojson suite**

Run: `cd packages/cojson && pnpm test`
Expected: PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add packages/cojson/src/tests/sync.localStoreDurability.test.ts
git commit -m "test(cojson): crash-recovery regression test for session durability"
```

---

### Task 9: Changeset + full verification

**Files:**
- Create: `.changeset/session-durability-marker.md`

- [ ] **Step 1: Write the changeset**

```md
---
"cojson": patch
"jazz-tools": patch
---

Prevent unrecoverable session forking when a client crashes after transactions
were sent to the sync server but before they were persisted locally. Sessions
are now flagged while such a window is open, and the browser and React Native
session providers mint a fresh session instead of reusing a flagged one.
```

- [ ] **Step 2: Full verification**

Run: `cd packages/cojson && pnpm test && pnpm exec tsc --noEmit`
Run: `cd packages/jazz-tools && pnpm test && pnpm exec tsc --noEmit`
Expected: all PASS, no type errors. (If the packages have a different typecheck script — check `package.json` for `lint`/`typecheck` — use that instead.)

- [ ] **Step 3: Commit**

```bash
git add .changeset/session-durability-marker.md
git commit -m "chore: changeset for session durability marker"
```

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| `StorageAPI.store(data, correction, done?)` incl. correction path + sync-inline | 1, 2 |
| `pendingLocalStores` + `onLocalStoreDurabilityChange`, open-before-send, local-only counting | 3 |
| Listener via `LocalNode` creation options (live before migration syncs) | 4 |
| `SessionDurabilityMarker` interface, debounced clear, error swallowing, `SessionProvider.durabilityMarker`, context wiring | 5 |
| Browser marker + skip/reclaim in `BrowserSessionProvider` | 6 |
| RN marker (best-effort async) + `ReactNativeSessionProvider` | 7 |
| Regression test (crash → fresh session → clean sync) | 3 (stuck-dirty test), 8 |
| No window with sync storage / no storage / remote content | 3 |
