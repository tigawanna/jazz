---
"jazz-tools": patch
---

Serialize Expo SQLite transactions at the connection level. The adapter is shared across providers/contexts, so concurrent storage clients could nest `BEGIN` statements on the same connection, causing "cannot start a transaction within a transaction" and "cannot rollback - no transaction is active" errors during storage reconciliation.
