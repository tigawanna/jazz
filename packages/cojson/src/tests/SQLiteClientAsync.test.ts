import { beforeEach, describe, expect, test } from "vitest";
import { getDbPath } from "./testStorage.js";
import { setupTestNode } from "./testUtils.js";
import { DBClientInterfaceAsync } from "../exports.js";
import type { Transaction } from "../coValueCore/verifiedState.js";

function makeTrustingTransaction(changes: string) {
  return {
    privacy: "trusting",
    madeAt: 0,
    changes,
  } as unknown as Transaction;
}

describe("SQLiteClientAsync", () => {
  describe("transaction", () => {
    let dbClient: DBClientInterfaceAsync;

    beforeEach(async () => {
      const node = setupTestNode();
      const { storage } = await node.addAsyncStorage({
        ourName: "test",
        storageName: "test-storage",
        filename: getDbPath(),
      });
      // @ts-expect-error - dbClient is private
      dbClient = storage.dbClient;
    });

    test("serializes concurrent transactions to avoid SQLITE_BUSY errors", async () => {
      const times = Array.from({ length: 10 });
      await Promise.all(
        times.map(async (_, i) => {
          return dbClient.transaction(async (tx) => {
            // Sleep between 0 and 100ms to force interleaving
            await new Promise((r) => setTimeout(r, Math.random() * 100));
            return tx.addSignatureAfter({
              sessionRowID: 0,
              idx: i,
              signature: `signature_z${i}`,
            });
          });
        }),
      );

      const signatures = await dbClient.getSignatures(0, 0);
      expect(signatures.length).toBe(10);
      signatures.forEach(({ signature }, i) => {
        expect(signature).toBe(`signature_z${i}`);
      });
    });

    test("continues to serialize transactions even if one fails", async () => {
      // First transaction succeeds
      await dbClient.transaction(async (tx) => {
        return tx.addSignatureAfter({
          sessionRowID: 0,
          idx: 0,
          signature: `signature_z0`,
        });
      });
      // Second transaction fails
      await expect(
        dbClient.transaction(async () => {
          throw new Error("transaction failed");
        }),
      ).rejects.toThrow("transaction failed");
      // Third transaction succeeds
      await dbClient.transaction(async (tx) => {
        return tx.addSignatureAfter({
          sessionRowID: 0,
          idx: 1,
          signature: `signature_z1`,
        });
      });
    });

    test("addTransaction overwrites an orphan row at the same (ses, idx)", async () => {
      // Simulates a row left behind by an interrupted write transaction:
      // the session row was rolled back but the transaction row persisted.
      await dbClient.transaction(async (tx) => {
        return tx.addTransaction(1, 0, makeTrustingTransaction("orphan"));
      });

      await expect(
        dbClient.transaction(async (tx) => {
          return tx.addTransaction(1, 0, makeTrustingTransaction("recovered"));
        }),
      ).resolves.not.toThrow();

      const txs = await dbClient.getNewTransactionInSession(1, 0, 0);
      expect(txs).toHaveLength(1);
      expect(txs[0]?.tx).toEqual(makeTrustingTransaction("recovered"));
    });

    test("addSignatureAfter overwrites an orphan row at the same (ses, idx)", async () => {
      await dbClient.transaction(async (tx) => {
        return tx.addSignatureAfter({
          sessionRowID: 1,
          idx: 0,
          signature: "signature_zorphan",
        });
      });

      await expect(
        dbClient.transaction(async (tx) => {
          return tx.addSignatureAfter({
            sessionRowID: 1,
            idx: 0,
            signature: "signature_zrecovered",
          });
        }),
      ).resolves.not.toThrow();

      const signatures = await dbClient.getSignatures(1, 0);
      expect(signatures).toHaveLength(1);
      expect(signatures[0]?.signature).toBe("signature_zrecovered");
    });
  });
});
