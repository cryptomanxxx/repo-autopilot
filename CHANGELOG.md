# Changelog

## v0.1.0 — 2026-10-13

The first release: a self-hosted dashboard for the Codex review loop on GitHub pull requests.

- **Dashboard.** Pull requests with merge readiness, CI, Codex status and P1/P2 counts, and recent GitHub Actions runs. Live updates through a GitHub App webhook. **Show more** for longer lists.
- **Codex review loop.** Each pull request's activity flow (review requests, findings, new commits, completed reviews, Codex 👍) and its Codex findings, with priority, place in the code, whether they concern the current code and whether their thread is resolved. **Ask Codex to review** when Codex has not reviewed the current code yet.
- **Merge from the dashboard.** The **Merge** button turns green once Codex has given the current code a 👍 and GitHub reports no blocker. It squash-merges exactly the commit you saw checked.
- **Agent chat (experimental).** Ask about the code or request small changes with a free Workers AI model. It proposes exact edits; **Create pull request** opens a pull request with them.
- **Runs in your own Cloudflare account** with GitHub sign-in. The deployed version is shown in the header.
- Layouts for desktop, tablet and phone.
