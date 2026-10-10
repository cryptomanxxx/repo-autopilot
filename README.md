# Repo Autopilot

An open-source GitHub dashboard and future development orchestrator for any repository. MIT licensed, with no Debatt-AI-specific configuration.

## v0.1: real GitHub dashboard

View the 10 most recently updated pull requests, opened/merged timestamps, review submissions with their commit SHA, Codex comment text, head-commit check/status results, and 15 recent GitHub Actions runs. Links open the corresponding GitHub discussion or workflow. Empty states and API errors are shown explicitly.

Autonomy is **off**. This release does not edit code, request reviews, run agents, or merge PRs. A successful CI indicator is informational: it does not establish branch protection, resolved conversations, current review approval, or merge eligibility. Review histories and comments are limited to 100 entries per endpoint, with truncation warnings. Codex thumbs-up reactions are not yet collected and must not be inferred from missing comments.

## Run

Requires Node.js 22 or later. No dependencies or paid AI API are required for this version.

```sh
cp .env.example .env
# Optionally set GITHUB_TOKEN in .env for private repos / higher limits.
npm start
```

Open http://127.0.0.1:3000 and enter `owner/repository`. Public repositories can be read without a token, subject to GitHub's anonymous rate limit. Private repositories require a token with read access to the selected repositories and Metadata, Pull requests, Issues, Actions, Checks and Commit statuses. Credentials remain on the server; the browser receives only dashboard data. Snapshots are cached for 60 seconds with at most 20 repository entries.

The server binds to loopback and is intended for local development. Do not expose this token-backed server publicly: multi-user authentication, repository authorization, rate limiting and production hosting have not been implemented.

```sh
npm run check
npm test
```

## Product roadmap

1. Dashboard foundation (this release).
2. GitHub App authentication, explicit repository selection, full pagination and precise Codex review/reaction tracking.
3. MCP tools and a ChatGPT-compatible dashboard component, tested against current OpenAI documentation and supported clients. This repository is not yet an installable ChatGPT plugin.
4. Optional external orchestration: review feedback → code-agent fix → CI → re-review. Explicit per-repository opt-in, bounded retries, audit history and human stop controls.
5. Optional merge policy enforcing current-head review approval, required checks, branch rules and resolved feedback.

ChatGPT UI integration and background work are separate components: a dashboard presents state; an external worker continues tasks when the chat is closed. Future code-agent use may require paid API access or other compute; no subscription coverage or free hosting is assumed.
