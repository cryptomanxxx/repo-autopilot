# RA-S01 · Historical PR analytics foundation

Status at initial submission: offline aggregation module implemented; targeted synthetic tests added. Historical local execution claim below is unverified and superseded by the [evidence integrity notice](EVIDENCE-INTEGRITY-NOTICE.md).

[research-analytics.js](../src/research-analytics.js) accepts explicitly normalized records for one repository and an interval of whole UTC days [start,end), up to 366 days and 1,000 input rows. The interval ends at or before fetchedAt. It counts separate opened/merged events, unknown and outside-window timestamps, open-to-merge duration for merges in the interval, and PR-head/main CI separately. CI and review distributions describe the retrieved snapshot population, not historical CI execution events or time series. Duplicate identical identities collapse; conflicting identities are excluded and reported. Other repository identities are rejected. The schema requires explicit completeness for CI; no success inferred from missing data. Review-round counts are observed lower bounds, priority and commit counts have known/unknown coverage. Missing data for human interventions, autonomy, agent runtime, costs and scientific acceptance remain null.

The module is pure, not a provider adapter or authorization boundary. The retrieved sample is not a full historical census. A zero event bucket means zero observed events, not necessarily zero actual events. The dashboard fallback currently substitutes updatedAt for openedAt on unavailable details; the later adapter must never use that as an actual opening event. Similarly, explicit exact-head and merge-commit association and completeness must be established from existing provider data before mapping CI states. The module assumes JSON-compatible normalized records, and future adapter work must enforce this and cap values.

## Historical reported validation (unverified; retained for audit)

Node v22.16.0, local isolated directory: `node --test test/research-analytics.test.js`, exit 0, 14 passed, 0 failed, 127.967523 ms. Both source files matched the repository blob identities at source commit 3ba2d3b58629a8ae5324e03af6843a1b0eaed64f. [Original TAP log](evidence/ra-s01/analytics-14.tap) and [provenance](evidence/ra-s01/provenance.json) retained; fetched archive log Git blob identity matched local original. This was not the full repository suite, UI/browser test or real-data analysis.

## Next

RA-S01B: map actual dashboard snapshot fields into the analytics contract, including unavailable details, explicit source timestamps, PR/main CI completeness, lower-bound review counts, repository switching and stale data. Test the mapping and then add the third tab and responsive charts using existing authorized dashboard snapshots only. No extra polling, live Symphony calls or new paid services. Existing Dashboard and Agent chat unchanged. Zero Additional Cost Policy applies.
