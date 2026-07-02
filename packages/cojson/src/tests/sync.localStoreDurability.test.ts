import { beforeEach, describe, expect, test, vi } from "vitest";
import { SyncMessagesLog, setupTestNode, waitFor } from "./testUtils";
import { registerStorageCleanupRunner } from "./testStorage";

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

    await waitFor(() => expect(events.some((e) => !e.hasPending)).toBe(true));

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
    expect(sessions.every((s) => s === client.node.currentSessionID)).toBe(
      true,
    );
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
    const { peerState } = client.connectToSyncServer();

    // Simulate the crash window: storage accepts writes but never completes them
    storage.store = async () => {};

    const events: boolean[] = [];
    client.node.syncManager.onLocalStoreDurabilityChange = (hasPending) =>
      events.push(hasPending);

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    // Wait for the content to reach the server (peer sync only) — storage sync
    // never resolves in this scenario since store() is stubbed to a no-op, so
    // we can't use map.core.waitForSync() here, which also waits on storage.
    await client.node.syncManager.waitForSyncWithPeer(
      peerState.id,
      map.id,
      5000,
    );
    expect(events).toEqual([true]); // opened, never closed
  });
});
