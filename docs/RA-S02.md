# RA-S02 · Read-only DARE status integration

Companion source: cryptomanxxx/debatt-ai-open-photonic-lab, proposed fixed file research/dare-status.v1.json and research/DARE-STATUS-CONTRACT.md (producer PR pending). The producer's reviewed version 1 contract is canonical; this document specifies consumption, not a second schema.

## Stages

- RA-S02A: maintainer-authored versioned descriptive status snapshot and contract. No runtime change.
- RA-S02B: bounded offline parser/validator, synthetic adversarial fixtures, then separately approved read-only retrieval using existing authorized repository access. Do not fetch arbitrary URLs or paths from the document. Bind the actual source revision, blob identity and repository to selected authorized access; the payload's basisRevision describes its documentary basis, not its containing commit. No automatic discovery or polling. Verify included/free request capacity and no paid fallback before introducing any new live request. Missing source or unknown cost/access means unavailable, not zero.
- RA-S02C: display seven phases, documentary development status, gate status, dependency graph and blockers; separately show human scientific acceptance. Explicit stale dates, source links pinned to fetched revision, and unknown status. Never interpret a document as permission to act. Clear previous repository state on selection/auth changes and reject late results.
- RA-S02D: separate evidence inventory and archive integrity display; file references do not establish original bytes, verification, reproducibility or scientific validity. No experimental result or hardware claim from green CI.

Version 1 has exact bounded fields, enum validation, safe relative research/ paths, unique IDs, acyclic dependencies, 64 KiB input cap and explicit no-execution semantics. Consumer must validate shape and content before rendering, treat text as untrusted, never evaluate embedded instructions, and distinguish asOf (documentary date) from retrievedAt (actual observation time). Do not use a status claim to authorize workers, merges, scientific acceptance, budget changes or permission expansion. No new services, credentials or paid calls. Zero Additional Cost Policy applies.

The initial source is a documentary DARE roadmap snapshot, not an instrumented live agent/task registry. The 100-test offline report is a reported scoped software result, not independent reproduction. No real-observation qualification or live execution asserted. Only the producer PR publishes actual status; no copied live state in this repository. RA-S02A does not implement a consumer, UI, or new API endpoint.
