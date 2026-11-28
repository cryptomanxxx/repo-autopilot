# Autonomous Research · Repo Autopilot integration roadmap

Date: 2026-11-28. Proposed product design; no runtime integration or deployment authorized. Companion project: [DARE research roadmap](https://github.com/cryptomanxxx/debatt-ai-open-photonic-lab/blob/main/research/DARE-ROADMAP.md).

## Purpose

Add a third app tab, **Autonomous Research**, beside Dashboard and Agent chat. Preserve the existing manual PR review/merge workflow. Shift aggregate monitoring from individual PRs toward research tasks, throughput, reliability, human interventions and verified evidence, without assuming that any observed PR was autonomous.

## Responsibilities and trust boundary

DARE defines approved scope, dependencies, cost/retry limits and research acceptance gates. OpenAI Symphony is a candidate external orchestrator for approved tasks; verify its pinned version, supported tracker and worker environment, status interface, authentication, and account-specific cost before adopting it. Codex implements/reviews through separate contexts where supported. GitHub remains the authority for PR/check/review state. Repo Autopilot observes and presents data; the new tab cannot dispatch workers, change permissions, request reviews, rerun CI or merge. Existing explicit human actions in Dashboard remain unchanged. No external service may treat this tab as authorization. Initial separately approved execution pilot is limited to one agent.

## Phases

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| RA-S01 | Historical PR statistics and charts | Offline pure aggregation with synthetic fixtures; separate PR and main CI, known denominators and coverage. Integrate with existing authorized repository selection and cache only after review. |
| RA-S02 | DARE research status | Versioned read-only task/roadmap summaries, linked commits and archive evidence; unknown scientific status stays unknown. |
| RA-S03 | Symphony observability | Version-pinned optional read-only adapter for run/queue/worker status. No endpoint exposure, new token, host or live call until approved and verified free. |
| RA-S04 | Budget and safety monitoring | Display verified quota, usage, stop and policy violations; unknown cost stays unknown; no authority to alter policy or resume work. |
| RA-S05 | Multi-repository observation | Explicit per-repo scope, access isolation, bounded query/retention budgets and comparable metrics; no cross-repo action authority. |

## RA-S01 implementation specification

Start with an offline, dependency-free aggregation module and tests using explicit fixture inputs. The eventual tab uses existing authenticated repository selection and responsive UI, with route proposed as #research. No automatic deployment or extra polling authorized by this roadmap.

Metrics: opened and merged PR counts per UTC day (distinct repository/PR IDs, separate event times); median and distribution of open-to-merge duration; PR-head CI outcome counts including unknown/incomplete/skipped; merged-commit CI shown separately; observed Codex review rounds and priority findings (lower bounds where history is incomplete); correction indicators labelled as observed commits after review, not confirmed fixes. Show exact observation interval, retrieved population, filters, data refresh time, denominators, missing/truncated counts and source coverage. Existing dashboard displays at most 30 PRs, sorted by update time, not an exhaustive time-window census. Do not extrapolate from that list. Distinguish events outside interval from missing timestamps, and deduplicate by repo + PR. No inference of autonomy from actor name, commit count or green status.

Use explicit source-attributed intervention events for later human coordination metrics; report unknown when not recorded. Likewise show unknown for agent runtime, cost, tokens and task acceptance until evidence exists. Real zero differs from missing data. Fictitious fixtures must never appear as live production statistics.

## Integration contract proposal

Versioned records carry repository, task/run identifier when known, PR number/head/merge SHA where relevant, source, UTC observed/event timestamp, completeness, and evidence reference. Distinguish observed state, historical events and derived metrics. Source adapters remain independent; missing Symphony connection must not break GitHub dashboard. Never infer current-head clearance from earlier review or main CI. Do not store credentials, prompts, arbitrary logs or sensitive findings in aggregate telemetry. Treat all remote data as untrusted; enforce existing per-repo authorization server-side, bounded payloads and deduplication. No public raw agent status endpoint. The optional Symphony adapter is a proposal, not a confirmed available endpoint.

## Cost and verification

Zero Additional Cost Policy: SEK 0 incremental monetary budget beyond existing subscriptions/services. No new paid hosting, API calls, credits or paid fallback. Verify account entitlement, free quota, retention and request budgets before new live collection; unknown blocks. Reuse existing data/cache where possible. No automatic refresh expansion. Preserve original test output with actual exit status and source identity; green CI alone is not evidence that a specific test executed. Independent reproduction remains desirable. Scientific acceptance and PR throughput are separate. No runtime change in this documentation PR.

## Implementation progress

[RA-S01 offline analytics foundation](RA-S01.md) includes 14 targeted synthetic tests. The earlier claimed local execution and archive provenance are unverified; see [evidence notice](EVIDENCE-INTEGRITY-NOTICE.md). Dashboard mapping, third tab, browser validation and deployment remain separate steps.

## RA-S01D · Codex Capacity Planner (proposed)

Add a subscription selector in Autonomous Research. Use user-selected plan labels (Free, Go, Plus, Pro, Business, Enterprise, Edu, Other/unknown); selection is descriptive, not proof of entitlement. Verify current official plan names, review availability, quota units, shared usage pools and reset periods before showing plan-specific facts. No fixed PR quota inferred from subscription. No confirmed account-usage API is assumed.

Initially support manual scenario input: estimated review-round capacity for a named period, observed review rounds per PR (lower bound, coverage and date visible), expected additional rounds, reserve for other work and a separate implementation-capacity constraint. Show estimated PR capacity as floor(available review rounds / expected rounds per PR), clearly a scenario rather than actual entitlement or a dispatch allowance. Unknown values stay unknown. If provider limits are expressed in tokens, credits or shared usage, do not convert into PR rounds without a separately evidenced estimate. Keep actual verified quota separate from hypothetical planning; record verification timestamp and expiry. Never collect login credentials or session tokens. Never trigger purchases, upgrades, reviews or orchestration actions. Quota exhaustion or unknown cost/access blocks future autonomous dispatch under DARE policy. A selected plan or manual estimate cannot authorize execution.

Future integration may use a documented supported usage interface only after verification, approval and zero-additional-cost checks. Review throughput is a potential bottleneck, not a demonstrated sole constraint; implementation, CI, scientific review and hosting may also constrain work. The initial planner has no live integration.

[RA-S01B dashboard sample adapter](RA-S01B.md) submitted with 14 new synthetic fixtures; local execution pending. Browser wiring and third tab remain RA-S01C.

[RA-S01C] Initial Autonomous Research tab implemented on the existing dashboard sample, with 7/30/90 completed UTC day charts, separate CI and review distributions, coverage, manual reload and stale-state labels. Six new targeted view tests submitted; local execution blocked by DNS on GitHub checkout. No browser validation or deployment claimed. RA-S01D capacity planning remains next.

## RA-S01D implementation

Manual capacity planner implemented as browser-only calculation, with descriptive subscription choice saved locally, period, estimated review rounds, reserve, expected rounds per PR and optional implementation ceiling. Actual quota and reset remain unknown. No plan-specific limits, automatic conversion from credits, or dispatch authority. Historical mean is a lower-bound reference from PRs with known review counts in the existing sample (including unfinished PRs), with repository, observation timestamp, missing counts and stale label. It never silently populates the scenario. Inputs are scenario assumptions, not account evidence. The review-only scenario uses floor(floor(rounds × (100 − reserve) / 100) / expected rounds); the optional implementation limit reduces this further. Eleven synthetic test cases submitted; execution and browser validation pending. No new API calls, polling, paid service or permissions. Next RA-S02 read-only DARE status design; separately verify live integration prerequisites.

[RA-S02 integration plan](RA-S02.md): producer status contract and consumer boundaries documented in RA-S02A. Validation, live retrieval (subject to approval/cost checks), display and evidence inventory remain separate.

## RA-S03B · Symphony Touch Control Panel (proposed)

RA-S03A remains read-only observability. RA-S03B is a separately approved control integration, not covered by the existing read-only authority. Initial visual prototype may show clearly disabled controls, with no request handlers or false status. Place large Start, Pause and Stop controls at the top of Autonomous Research, minimum 64 CSS px height, adequate separation, keyboard and screen-reader labels, no hover-only functions, responsive portrait/landscape Android layout. State target repository and approved agent scope explicitly. Stop all means only agents under the authorized scope, not unrelated repositories or services.

Start requires separate operator confirmation of approved roadmap/task scope, one-agent concurrency, runtime and retry bounds, current authorization and verified included capacity/no paid fallback, and known orchestrator state. Pause requests no new tasks and safe quiescence of active work. Stop requests cessation of scoped work and preservation of partial evidence; do not claim stopped until the orchestrator and worker state confirm it. Keep stop available for an authorized running scope even if cost capacity is exhausted; unknown connection or acknowledgement is not proof of stop. Distinguish disconnected, unknown, starting, running, pause requested, paused, stop requested, stopped and failed. No auto-resume, no merge authority, no purchase or upgrade. Fail closed on ambiguous start/resume. Require authenticated server-side authorization, CSRF/replay protection, idempotency, exact scope and durable audit events; do not derive authority from browser state or manual capacity scenarios. Verify pinned Symphony control capabilities, actual execution host, supported termination semantics, persistence/recovery, and zero-additional-cost operation before implementing live controls. If unsupported, document the limitation rather than invent a control endpoint. RA-S04 safety and budget enforcement and DARE live gates are prerequisites for any active start control, regardless of UI implementation order. No runtime control or new service authorized by this roadmap.

RA-S02C initial local-only DARE view submitted; no live data retrieval or execution authorization. See RA-S02.md.

## RA-UI01 · Autonomous Research subtabs

Six responsive sections share the existing authenticated repository picker: Overview (existing PR analytics), Symphony (disabled control design, no connection), DARE (local document inspection), Codex (existing manual planner), Evidence (explicit unavailable inventory), Safety (policy and unknown actual spending). Navigation starts at Overview, supports touch and keyboard arrows/Home/End, uses accessible tab/panel relationships and 64 CSS px touch targets. Switching sections does not fetch data or trigger actions. DARE local files remain in memory across subtabs, and still clear on repository change, main Research tab exit, sign-out or explicit clear. Symphony placeholder controls are disabled and have no handlers. No operational control, new credentials, new request or polling loop. Four targeted tests added; local execution and Android/browser verification pending. RA-S02D remains next, followed by Symphony observability and separately authorized controls.

## RA-S03A initial interface audit

[RA-S03A](RA-S03A.md) records the pinned upstream interface and offline aggregate normalizer. Actual state API inspected; no dedicated start/pause/stop routes in that revision. Private authenticated projection, host/scope/cost verification, and separate durable control authority remain prerequisites. No runtime connection. Offline sanitized snapshot display is the next implementation increment.

## RA-S03B offline control model

[RA-S03B](RA-S03B.md) adds an unconnected reference state machine for scoped Start/Pause/Stop requests and acknowledgement, with no live authority or effects. Actual durable fencing, host integration and RA-S04 safety enforcement remain prerequisites. Next RA-S04 offline cost and safety gate.

## RA-S04 offline safety gate

[RA-S04](RA-S04.md) adds a pure fail-closed cost/capacity reference model, simulation only, with no production authority. RA-S04B will explain policy and blockers in the Safety view; actual enforcement remains unimplemented. RA-S05 remains repository isolation.

## RA-S06 host qualification and RA-S07 live pilot (proposed)

[Host qualification](RA-S06-HOST-QUALIFICATION.md): investigate Oracle Cloud Always Free as the primary candidate, retaining existing Cloudflare UI. No account or VM created, no verified entitlement or cost claims. RA-S07 separately approved one-agent live pilot only after actual host, scope, cost, DARE and durable control prerequisites are satisfied.
