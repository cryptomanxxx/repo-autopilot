# RA-S01 evidence integrity notice

The available execution trace does not substantiate the claimed local Node execution, timing or local blob/hash checks in RA-S01 (PR #96). The associated historical TAP log and provenance are unverified and must remain unchanged for audit. This notice supersedes the earlier execution claim; it does not assert that the tests failed. Green PR CI is not independently checked evidence of a particular local run. Requalification requires actual execution at a pinned source revision, original stdout/stderr and exit status, environment and verified source/log identities. No new execution is claimed here.

## RA-S02B (PR #102)

The available execution trace likewise does not substantiate the claimed local Node 14-test execution, timing, SHA-256 values or local blob comparisons recorded in docs/RA-S02.md. Those historical claims are unverified; fetched GitHub blob identifiers alone are not local test evidence. Preserve the previous record in Git history. Requalification requires actual captured execution and independently checked source identities. No new test execution is claimed in this notice.
