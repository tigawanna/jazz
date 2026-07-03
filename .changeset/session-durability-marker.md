---
"cojson": patch
"jazz-tools": patch
---

Prevent unrecoverable session forking when a client crashes after transactions
were sent to the sync server but before they were persisted locally. Sessions
are now flagged while such a window is open, and the browser and React Native
session providers mint a fresh session instead of reusing a flagged one.
