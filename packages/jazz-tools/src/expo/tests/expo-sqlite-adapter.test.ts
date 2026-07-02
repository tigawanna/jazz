import { describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn().mockResolvedValue({
    execAsync: vi.fn(),
  }),
  deleteDatabaseAsync: vi.fn(),
}));

import { ExpoSQLiteAdapter } from "../storage/expo-sqlite-adapter.js";

/**
 * Reproduces expo-sqlite's `withTransactionAsync` semantics: transactions are
 * not exclusive, a nested BEGIN throws, and a failed BEGIN still triggers a
 * ROLLBACK that aborts whichever transaction is currently active.
 */
function createFakeTransactionalDb() {
  let inTransaction = false;

  const execAsync = vi.fn(async (sql: string) => {
    if (sql === "BEGIN") {
      if (inTransaction) {
        throw new Error("cannot start a transaction within a transaction");
      }
      inTransaction = true;
    } else if (sql === "COMMIT") {
      if (!inTransaction) {
        throw new Error("cannot commit - no transaction is active");
      }
      inTransaction = false;
    } else if (sql === "ROLLBACK") {
      if (!inTransaction) {
        throw new Error("cannot rollback - no transaction is active");
      }
      inTransaction = false;
    }
  });

  return {
    execAsync,
    async withTransactionAsync(task: () => Promise<void>) {
      try {
        await execAsync("BEGIN");
        await task();
        await execAsync("COMMIT");
      } catch (e) {
        await execAsync("ROLLBACK");
        throw e;
      }
    },
  };
}

describe("ExpoSQLiteAdapter", () => {
  describe("getInstance", () => {
    it("returns the same instance for the same database name", async () => {
      const adapter1 = ExpoSQLiteAdapter.getInstance("test-db");
      const adapter2 = ExpoSQLiteAdapter.getInstance("test-db");

      expect(adapter1).toBe(adapter2);
    });

    it("returns different instances for different database names", async () => {
      const adapter1 = ExpoSQLiteAdapter.getInstance("test-db-a");
      const adapter2 = ExpoSQLiteAdapter.getInstance("test-db-b");

      expect(adapter1).not.toBe(adapter2);
    });

    it("initializes the database connection only once", async () => {
      const adapter1 = ExpoSQLiteAdapter.getInstance("test-db");
      const adapter2 = ExpoSQLiteAdapter.getInstance("test-db");
      const promise1 = adapter1.initialize();
      const promise2 = adapter2.initialize();

      await promise1;
      await promise2;

      // @ts-expect-error - db is private
      expect(adapter1.db?.execAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe("transaction", () => {
    it("serializes concurrent transactions on the same connection", async () => {
      const db = createFakeTransactionalDb();
      const adapter = ExpoSQLiteAdapter.withDB(
        db as unknown as Parameters<typeof ExpoSQLiteAdapter.withDB>[0],
      );

      const order: string[] = [];

      // Without serialization, the interleaved BEGINs throw
      // "cannot start a transaction within a transaction" and the resulting
      // ROLLBACK aborts the other transaction.
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          adapter.transaction(async () => {
            order.push(`start-${i}`);
            // Yield so a concurrent transaction would interleave here
            await new Promise((resolve) => setTimeout(resolve, (5 - i) * 2));
            order.push(`end-${i}`);
          }),
        ),
      );

      for (let i = 0; i < 5; i++) {
        expect(order[i * 2]).toBe(`start-${i}`);
        expect(order[i * 2 + 1]).toBe(`end-${i}`);
      }
    });

    it("keeps processing transactions after one fails", async () => {
      const db = createFakeTransactionalDb();
      const adapter = ExpoSQLiteAdapter.withDB(
        db as unknown as Parameters<typeof ExpoSQLiteAdapter.withDB>[0],
      );

      const failing = adapter.transaction(async () => {
        throw new Error("boom");
      });
      const succeeding = adapter.transaction(async () => {});

      await expect(failing).rejects.toThrow("boom");
      await expect(succeeding).resolves.not.toThrow();

      // The failed transaction rolled back exactly once, without touching
      // the following transaction.
      const rollbacks = db.execAsync.mock.calls.filter(
        ([sql]) => sql === "ROLLBACK",
      );
      expect(rollbacks).toHaveLength(1);
    });
  });
});
