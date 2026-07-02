---
"cojson": patch
---

Recover from partially-written storage rows in async SQLite storage. Interrupted write transactions could leave orphan `transactions`/`signatureAfter` rows that made every subsequent store of the same session fail with "UNIQUE constraint failed: transactions.ses, transactions.idx"; those rows are now overwritten instead.
