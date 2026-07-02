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
