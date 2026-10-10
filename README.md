# Repo Autopilot

An open-source GitHub dashboard and future development orchestrator for any repository. MIT licensed, with no Debatt-AI-specific configuration.

## Web dashboard (GitHub Pages)

[Open the dashboard](https://cryptomanxxx.github.io/repo-autopilot/) — this address becomes available after the Pages workflow is merged, Pages is enabled, and deployment succeeds.

The hosted dashboard works with **public repositories** directly through GitHub's API. It requires no Vercel server, login, GitHub token or paid AI API. Enter any `owner/repository` or full `https://github.com/owner/repository` URL; the hosted mode fetches 5 recent PRs and 15 workflow runs. GitHub's anonymous API limit still applies (normally 60 requests/hour per IP); loading 5 PRs uses up to 28 requests. Refreshes within 60 seconds reuse the browser's in-memory snapshot. Partial detail failures are shown explicitly. Private repos remain supported only by the local server mode below.

### Enable publishing

In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. After merging the Pages workflow into `main`, check **Actions → Deploy dashboard to GitHub Pages**. If needed, use **Run workflow**. The completed deployment reports the exact URL. Put that URL into **About → Edit → Website**.

The deployment uploads only the static files in `dist/`; no `.env`, token or server is published. Assets use relative paths so the dashboard works under the `/repo-autopilot/` project path. This static dashboard does not host MCP or autonomous workers.

```sh
npm run build
# For a local static preview:
python -m http.server 8080 --directory dist
```

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

Open http://127.0.0.1:3000 and enter `owner/repository` or a full GitHub repository URL. Public repositories can be read without a token, subject to GitHub's anonymous rate limit. Private repositories require a token with read access to the selected repositories and Metadata, Pull requests, Issues, Actions, Checks and Commit statuses. Credentials remain on the server; the browser receives only dashboard data. Snapshots are cached for 60 seconds with at most 20 repository entries.

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
