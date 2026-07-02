# Session Durability Marker — Design

**Date:** 2026-07-02
**Status:** Approved
**Packages:** `cojson`, `jazz-tools` (browser + react-native-core)

## Problem

A race between peer sync and local persistence can permanently break a session:

1. `makeTransaction()` (cojson `coValueCore.ts`) signs a transaction, adds it to in-memory
   verified state, and queues sync via `LocalTransactionsSyncQueue`.
2. Within the queued microtask, `SyncManager.syncContent()` calls `storeContent()` — which
   only *enqueues* the write into the async `StoreQueue` (IndexedDB / async SQLite) — and then
   immediately sends the content to peers with `trySendToPeer()`.
3. The remote send therefore always races ahead of local persistence. If the process crashes
   after the server stored the transaction (signature S1 at session position N) but before the
   local write completed, local storage holds only positions up to N-1.
4. Session IDs are deliberately reused across restarts (`BrowserSessionProvider`,
   `ReactNativeSessionProvider`). On restart the client loads the session up to N-1 from
   storage and eventually creates a *different* transaction at position N with signature S2.
5. Per-session transactions form a hash chain; the server rejects S2 as a signature mismatch.
   The divergence is unrecoverable — the session can never sync again.

## Scope decisions

- **Prevention only.** Sessions already diverged in the wild are out of scope.
- **No coupling of remote send to local persistence.** Time-to-server latency is preserved;
  the send keeps happening immediately.
- **Platforms:** browser (IndexedDB + `BrowserSessionProvider`) and React Native
  (async SQLite + `ReactNativeSessionProvider`). Node with synchronous better-sqlite3 storage
  has no race window (stores complete inline) and needs no change.

## Approach

**Invariant:** a session ID may only be reused on startup if, when the previous process died,
local storage provably contained everything that session had sent to server peers.

**Mechanism:** a per-session *dirty marker* in synchronous platform storage:

- The marker is set synchronously **before** locally-created content is sent to a peer while
  its local store is still pending, and cleared when the store queue drains.
- On startup, session providers skip any stored session whose marker is set and mint a fresh
  session ID instead, reclaiming the dirty session's storage slot.

Abandoning a session after a crash loses no data: transactions that reached the server come
back down on the next connect; transactions that reached neither server nor storage were
memory-only and are gone regardless. The only cost is one extra session per
crash-during-the-window.

Rejected alternatives:

- **Persist-before-send (write-ahead ordering):** correct but couples send latency to local
  write latency — rejected by constraint.
- **Clean-shutdown flag:** reuse only cleanly-released sessions. On React Native the OS kills
  apps rather than shutting them down, so this burns a session on nearly every launch.
- **Fresh session per restart:** trivially correct but causes unbounded session growth
  (known-state size, signature chains, storage), which session reuse exists to prevent.

## Component design

### cojson

1. **`StorageAPI.store(data, correctionCallback, done?)`** (`storage/types.ts`): new optional
   completion callback. `StoreQueue` entries carry it. `StorageApiAsync` invokes it when
   `storeSingle` finishes — including when the write resolved through the correction path.
   `StorageApiSync` invokes it synchronously inside `store()`.
2. **`SyncManager.pendingLocalStores` counter + listener**
   `onLocalStoreDurabilityChange(hasPending: boolean)`. Only stores initiated from
   `syncContent()` — the local-transaction path — pass a `done` callback and count toward the
   counter. Remote content (`handleNewContent` → `storeContent`) never counts: its slow
   persistence is irrelevant to our session's safety.
3. **Window-open notification** fires synchronously in `syncContent()` when both:
   (a) `pendingLocalStores > 0` after `storeContent()` returns, and
   (b) at least one eligible peer is about to receive the content —
   and it fires **before** the first `trySendToPeer()`. This gives the marker precise
   "sent ahead of persistence" semantics: an offline crash with unsent data does not burn a
   session, and synchronous storage never opens a window. **Window-closed** fires when the
   counter returns to 0.
4. **Listener supplied via `LocalNode` creation options**, not subscribed afterwards: account
   migration can create and sync transactions during node construction, so the hook must be
   live before the first peer send.

Ordering argument for correctness: `storeContent()` pushes into the FIFO `StoreQueue` before
`trySendToPeer()` runs, and the marker is written synchronously before the send. Therefore
"counter at 0" implies everything previously sent is on disk, and "marker set" is durable
before the server can ever be ahead of local storage.

### jazz-tools

1. **`SessionDurabilityMarker` interface** — `set(sessionID)`, `clear(sessionID)`,
   `isSet(sessionID)` — with two implementations:
   - **Browser:** one `localStorage` key per session ID; writes are synchronous.
   - **React Native:** existing `KvStore`; writes are async, so `set` is *initiated* before
     the send as a best effort (accepted limitation, see Residual risk).
2. **Context creation** passes the marker-wiring listener into node creation. `set` on
   window-open is immediate and synchronous; `clear` on window-close is debounced (~200 ms
   trailing) purely to avoid marker-flapping writes during active editing. The debounce only
   delays clearing — a crash inside it burns a session unnecessarily at worst.
3. **`BrowserSessionProvider.acquireSession`:** skip sessions whose marker is set. When
   minting a fresh session, overwrite the dirty session's slot in `SessionIDStorage` and
   delete its marker, so the slot list does not grow across crashes. A dirty session still
   web-locked by a live tab is skipped by the existing lock check before the marker is
   consulted.
4. **`ReactNativeSessionProvider`:** same logic for its single per-account KvStore key.

## Edge cases

- **Graceful shutdown / tab close:** the existing shutdown path flushes the `StoreQueue`; the
  counter reaches 0, the marker clears, the session is reused next launch — unchanged
  behavior. If the flush is cut short, the marker correctly stays set.
- **Account-session derivation** (`coValueCore.makeTransaction`): account edits use a session
  ID derived 1:1 from `node.currentSessionID`; both are only ever reused together, so one
  marker per node session covers both. Delete-transactions use fresh random session IDs —
  out of scope.
- **Multiple tabs:** each tab holds its own session via web locks; markers are keyed by
  session ID, so tabs never clobber each other.
- **Nodes without storage:** `storeContent()` returns early, the counter never increments,
  session reuse is unchanged. (Session reuse without any storage has separate pre-existing
  hazards, independent of this race — out of scope.)
- **Correction path:** `done` fires only after the correction is applied and stored, so the
  window cannot close early on a corrected write.

## Error handling & residual risk

- **Marker write throws** (quota, private browsing): log a warning and continue. Risk for that
  session equals today's status quo; no functional regression.
- **Marker durability is best-effort:** localStorage is not fsync-guaranteed on OS crash, and
  RN KV writes are async. The fix shrinks the vulnerable window from "any crash during any
  write" to "power loss within milliseconds of an edit" — accepted residual.

## Testing

- **cojson unit tests:**
  - `done` callback fires for async storage, sync storage (synchronously), and the correction
    path.
  - Window-open ordering: a spy asserts open is notified before `trySendToPeer`.
  - No window opens with synchronous storage; remote content never opens a window.
  - Counter handles interleaved batches: opens once, closes once at zero.
- **jazz-tools tests:**
  - `BrowserSessionProvider` skips a dirty session, reclaims its slot, clears the old marker.
  - `ReactNativeSessionProvider` equivalent with a mock KvStore.
- **Regression test for the original bug:** a node with artificially delayed async storage
  makes a transaction, syncs it to a test server peer, and is discarded without flushing
  ("crash"); a new context over the same storage + session provider must mint a fresh session
  and sync successfully, with no signature rejection from the server.
