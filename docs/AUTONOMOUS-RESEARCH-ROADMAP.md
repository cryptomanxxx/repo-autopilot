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

[RA-S01 offline analytics foundation](RA-S01.md) is submitted with 14 actual passing targeted synthetic tests and archived evidence. Dashboard mapping, third tab, browser validation and deployment remain separate steps.
