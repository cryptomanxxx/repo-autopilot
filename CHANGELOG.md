# Changelog

## Unreleased

- **Connector for Claude and ChatGPT.** Add Repo Autopilot as a custom connector and ask about your pull requests in the chat. Sign-in goes through GitHub with OAuth; each connected app is listed in the dashboard under **Connected apps** and can be revoked there.
- **Read-only tools.** `list_repositories`, `list_pull_requests` and `pull_request_status` show the same data as the dashboard: merge readiness, CI, Codex status, every Codex finding with its state, and recent activity. They say when something could not be read instead of reporting it as absent. Merging stays in the dashboard.
- **The Repo Autopilot card in the chat.** In chat apps that support MCP Apps, such as Claude on the web, desktop and mobile, the pull request tools show a card with merge readiness, CI, Codex findings and recent activity, with filters, **Refresh**, **Full screen** and **Open dashboard**. It is read-only.
- **CI details, full Codex findings and a to-do list in the chat.** `pull_request_checks` shows why CI failed (annotations and the end of the job log), `codex_findings` the full text of each finding, and `waiting_on_me` what each open pull request across your repositories needs.
- **Workflow runs in the chat.** `list_workflow_runs` lists a repository's recent GitHub Actions runs, optionally only failed ones or one branch.
- **Choose the repository in the card.** The card has a repository picker, and **Pin** where the chat app can keep the card in view.
- **Links to the dashboard.** The pull request tools link each pull request to your Repo Autopilot dashboard as well as to GitHub; the link opens its repository and the pull request, where it can be merged.
- **A clearer connect page.** **Allow and sign in with GitHub** shows at once that it was clicked, and a second click no longer ends on an expired page.
- **Logs for troubleshooting the connector.** Each MCP message and each step of connecting an app leaves one line in the Worker's log, without codes, tokens or tool arguments.
- **Codex findings show when they are fixed.** A finding is marked ✅ once Codex has given the current code a 👍, and 🔄 while changed code waits for Codex.

## v0.1.0 — 2026-10-13

The first release: a self-hosted dashboard for the Codex review loop on GitHub pull requests.

- **Dashboard.** Pull requests with merge readiness, CI, Codex status and P1/P2 counts, and recent GitHub Actions runs. Live updates through a GitHub App webhook. **Show more** for longer lists.
- **Codex review loop.** Each pull request's activity flow (review requests, findings, new commits, completed reviews, Codex 👍) and its Codex findings, with priority, place in the code, whether they concern the current code and whether their thread is resolved. **Ask Codex to review** when Codex has not reviewed the current code yet.
- **Merge from the dashboard.** The **Merge** button turns green once Codex has given the current code a 👍 and GitHub reports no blocker. It squash-merges exactly the commit you saw checked.
- **Agent chat (experimental).** Ask about the code or request small changes with a free Workers AI model. It proposes exact edits; **Create pull request** opens a pull request with them.
- **Runs in your own Cloudflare account** with GitHub sign-in. The deployed version is shown in the header.
- Layouts for desktop, tablet and phone.
