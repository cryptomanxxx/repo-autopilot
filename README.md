# Repo Autopilot

An open-source GitHub dashboard and coding-agent chat for your repositories. MIT licensed.

Repo Autopilot is one app on Cloudflare Workers with GitHub sign-in: a live dashboard and the agent chat in two tabs, for any repository where its GitHub App is installed. To run your own, follow the [Quick start](#quick-start); details are in [Repo Autopilot app on Cloudflare Workers](#repo-autopilot-app-on-cloudflare-workers).

Automatic merge is **off**. The coding agent proposes changes as pull requests; it does not execute generated code or merge changes. A successful CI indicator is informational: it does not establish branch protection, resolved conversations, current review approval, or merge eligibility.

## How it works best

Repo Autopilot shows the work and lets you merge it; the coding and the reviewing are done by tools you already use. It works best with at least **Claude Pro** and **ChatGPT Plus with Codex**:

- **Coding agent:** Claude Code (Claude Pro or higher) or Codex in ChatGPT writes the change and fixes what the review finds. With Claude Code on the web, turn on automatic pull request fixing in its settings, so it picks up Codex's findings by itself.
- **Reviewer:** Codex code review (ChatGPT Plus or higher), with automatic reviews set to run **on every push** (Codex settings → Code review). Then each fix is reviewed again without anyone asking for it.

The flow:

1. You describe what you want once, in the Claude app (Claude Code) or in ChatGPT (Codex).
2. The coding agent writes the change and opens a pull request.
3. Codex reviews the pull request automatically.
4. The coding agent fixes what Codex found and pushes; Codex reviews the new commit.
5. Steps 3–4 repeat until Codex gives the current code a 👍. You follow every round in the dashboard's PR activity.
6. The **Merge** button turns green, and you merge from the dashboard.

This loop has been run end to end with Claude Code as the coding agent. With Codex as the coding agent, check that its fixes are pushed to the pull request's own branch: a fix that opens a new pull request or stays in a Codex task does not move the loop on.

The agent chat built into Repo Autopilot is experimental and is not part of this flow; see [Agent chat](#agent-chat).

## Quick start

You run your own copy of Repo Autopilot, in your own free Cloudflare account; nobody else holds your GitHub access. Setting it up takes about 15 minutes. You need a GitHub account and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

1. **Fork this repository** to your GitHub account. In the fork, open **Actions** and enable workflows (GitHub turns them off in new forks).
2. **Find your Workers address.** In the Cloudflare dashboard, open **Workers & Pages**: your subdomain is shown there (`<your-subdomain>.workers.dev`). The app will live at `https://repo-autopilot-chat.<your-subdomain>.workers.dev`.
3. **Create a GitHub App** at GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**. If your fork belongs to an organization, create the app under the organization instead (the organization's Settings → Developer settings → GitHub Apps), since an app can only be installed on the account that owns it:
   - **GitHub App name:** any name not taken on GitHub, for example `Repo Autopilot <your-login>`.
   - **Homepage URL:** `https://repo-autopilot-chat.<your-subdomain>.workers.dev`.
   - **Callback URL:** `https://repo-autopilot-chat.<your-subdomain>.workers.dev/auth/callback`. Keep **Expire user authorization tokens** checked.
   - **Webhook:** uncheck **Active** for now (you can [turn it on later](#live-updates-with-the-webhook)).
   - **Repository permissions:** *Contents* and *Pull requests*: Read and write. *Actions*, *Checks*, *Commit statuses* and *Issues*: Read-only.
   - **Where can this GitHub App be installed?** Keep **Only on this account**.
   - Create the app, note its **Client ID**, and click **Generate a new client secret**.
   - Open **Install App** and install it on the repositories you want to see, including your fork.
4. **Create a Cloudflare API token:** My Profile → API Tokens → **Create Token** → template **Edit Cloudflare Workers**. Also copy your **Account ID** (on the Workers & Pages overview).
5. **Add them to your fork** under *Settings → Secrets and variables → Actions*:
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTOPILOT_CHAT_CLIENT_SECRET` (the app's client secret).
   - Variable: `AUTOPILOT_CHAT_CLIENT_ID` (the app's Client ID).
6. **Deploy:** in **Actions**, run the **Agent chat Worker** workflow. When it is green, open `https://repo-autopilot-chat.<your-subdomain>.workers.dev` and sign in with GitHub.
7. **Set up the review loop** described in [How it works best](#how-it-works-best): connect Codex code review to your repositories with reviews on every push, and use Claude Code or Codex as the coding agent.

Only the owner of the fork can sign in. For an organization's fork, also set the repository variable `AUTOPILOT_TASK_USER` to the GitHub login allowed to sign in; see [Set up the app](#set-up-the-app). Updates: sync your fork with this repository on GitHub (**Sync fork**); the workflow deploys the new version when Worker files changed. The header shows which version is live. Something not working? [Open an issue](https://github.com/cryptomanxxx/repo-autopilot/issues).

## Screenshots

<p align="center"><img src="docs/screenshots/dashboard.png" width="860" alt="Dashboard tab: repository picker, the six most recently updated pull requests with merge readiness, CI and Codex status, and recent GitHub Actions runs"></p>

**Dashboard.** Pick a repository, then see at a glance which pull requests are ready to merge, which have failing CI or open Codex findings, and what GitHub Actions is running. It updates within seconds when GitHub reports a change. An open pull request's details have a **Merge** button that turns green only once Codex has given the current code a 👍 and GitHub reports no blocker (failed CI, conflicts, requested changes). It squash-merges into the default branch after you confirm, listing anything not verified. The server checks everything again just before merging and merges only the exact commit whose status you saw. Afterwards it removes the chat's `autopilot/chat-…` branch. When Codex has not reviewed the current code yet, **Ask Codex to review** comments `@codex review` on the pull request with your GitHub account, at most once per commit. Codex findings are fixed in the pull request itself; the dashboard does not ask Codex to fix them, since Codex's fixes do not land on the pull request's branch. GitHub's branch protection, required checks and reviews still apply.

<p align="center"><img src="docs/screenshots/activity.png" width="860" alt="An expanded pull request showing its activity chain: opened, Codex review requested, findings, code changed, review completed and Codex thumbs-up"></p>

**PR activity.** Expand a pull request to follow its history as a chain: review requests, Codex findings, new commits, completed reviews and the final 👍.

<p align="center"><img src="docs/screenshots/chat.png" width="860" alt="Agent chat tab: a question about checkout totals, the agent's explanation and exact code edits, and a Create pull request button"></p>

**Agent chat (experimental).** Ask about the code or describe a change, with an optional screenshot. The agent reads the repository's current files, answers with exact edits, and opens a pull request when you press **Create pull request**.

<p align="center"><img src="docs/screenshots/mobile.png" width="300" alt="The dashboard on a phone, with each pull request shown as a card"></p>

**Phone and tablet.** The layout adapts to small screens, and the controls are sized for touch.

<sub>The screenshots use invented demo data.</sub>

## Development

Requires Node.js 22 or later. There are no dependencies.

```sh
npm run check
npm test
```

## Product roadmap

1. Dashboard foundation.
2. GitHub App authentication and repository selection (done); full pagination and precise Codex review/reaction tracking.
3. MCP tools and a ChatGPT-compatible dashboard component, tested against current OpenAI documentation and supported clients. This repository is not yet an installable ChatGPT plugin.
4. Optional external orchestration: review feedback → code-agent fix → CI → re-review. Explicit per-repository opt-in, bounded retries, audit history and human stop controls.
5. Optional merge policy enforcing current-head review approval, required checks, branch rules and resolved feedback.

ChatGPT UI integration and background work are separate components: a dashboard presents state; an external worker continues tasks when the chat is closed. Future code-agent use may require paid API access or other compute; no subscription coverage or free hosting is assumed.


## PR progress and merge readiness

PR cards show review acknowledgement, completion for the latest code, Codex outcome, completed review rounds, commits after review and merge readiness. Confirmation summaries and raw technical feedback are hidden; use the GitHub history link for details.

Review counts are **lower bounds**: GitHub edits Codex summaries in place, so some older clean rounds cannot be recovered. Review submissions, outcome comments and summaries for the same commit within 10 seconds are deduplicated. Commits after review counts subsequent commits in the PR after the earliest reviewed commit found in its history; it does not prove that feedback was fixed. Missing/truncated histories show unknown update counts.

Readiness distinguishes merged, closed, known blockers and unverified state. It does **not** show green merge readiness from CI alone: the dashboard also asks GitHub GraphQL for current-head merge state, review decision and conversation resolution. Ready requires current Codex clearance, complete successful CI, conflict-free merging, GitHub CLEAN state, no missing approvals or requested changes, and all conversations resolved. Truncated thread results or API errors stay unverified. This is a snapshot, never permission to bypass GitHub rules or an automatic merge action. If the GraphQL read fails, readiness stays unknown.

## Activity flow and filters

PR rows expand to the pull request's Codex findings: each with its priority, headline (linking to the comment), file and line, whether it is about the current code or an older commit, and where it stands: ✅ **fixed** once its review thread is resolved on GitHub or Codex has given the current code a 👍 after the finding was reported; 🔄 **waiting for Codex** when the code it points at has changed since (GitHub marks the thread outdated), which is not yet proof of a fix; ⚠ **open**; or ❔ **unverified** when GitHub's thread status could not be read. Open findings come first and fixed ones last, newest first within each group. Below that is a chronological activity flow: PR opened, explicit Codex review requests, observed running/completed reviews, subsequent commits, current-commit Codex thumbs-up and merge. This is observed history, not proof that an agent fixed a finding. Commit timestamps may precede their push, summaries are edited in place, and older/truncated events may be missing. No missing steps are invented.

Filter PRs by open, needs attention, merged or all, and workflows by CI, deployment or all. On wide screens, shared column headings reduce repetition.

Historical P1/P2 counts use top-level Codex finding comments with explicit priority badges, deduplicated by comment identity. Replies and summary text do not count as new findings. Counts remain after resolution; incomplete history is marked as a lower bound. The separate unresolved-thread count includes all reviewers and is unverified if authenticated thread retrieval fails. #Commits counts commits after review, not the number of findings fixed.

## Repo Autopilot app on Cloudflare Workers

`worker/` is a Cloudflare Worker with two tabs, **Dashboard** and **Agent chat**, behind GitHub sign-in.

### Choosing a repository

The **Repository** menu at the top lists the repositories where the Repo Autopilot GitHub App is installed, most recently pushed first; a GitHub App sign-in can only reach those. To stay within the Workers subrequest limit, the list covers up to 5 installations and 200 repositories each. It is a large native menu, so on Android tablets it opens the system's full-screen touch list. The choice is remembered on the device and applies to both tabs. Conversations belong to the repository they started in: the chat list shows the selected repository's conversations, and opening an older conversation switches the menu to its repository.

To add a repository, open **Add repositories** (GitHub → Settings → Applications → Repo Autopilot → Configure), select it, then tap **Reload list**.

### Dashboard

The **Dashboard** tab reads live data from GitHub with your sign-in: the 6 most recently updated pull requests with merge readiness, CI, Codex progress and activity flow, and 15 recent GitHub Actions runs. **Show more pull requests** adds 6 at a time, up to 30, and **Show more runs** adds 15 at a time, up to 60; the larger lists stay until another repository is picked. On tablets in portrait each pull request's values fit on one row, and on phones they take two rows while the activity flow runs downwards. The overview takes three GitHub requests and each pull request is loaded by its own request with at most ten, so every Worker call stays well under the Workers subrequest limit. Results are cached in the Durable Object for a minute (an hour for merged or closed pull requests); a pull request whose `updatedAt` changed, and the **Refresh** button, bypass the cache. With the [webhook](#live-updates-with-the-webhook) set up, the tab reloads within about 15 seconds of a change on GitHub; without it, every three minutes while it is open. When a chat answer has become a pull request, **Follow in dashboard** opens that pull request's row. Addresses keep the view: `#dashboard`, `#pr-<number>`, `#chat` and `#chat/<conversation>`.

The header shows which version is live: the commit the deploy workflow shipped (linking to it on GitHub) and when. After a merge, the version changes once the **Agent chat Worker** workflow has deployed; a merge that touches no Worker files deploys nothing, so the version stays. A Worker deployed some other way shows "version unknown".

### Agent chat

> **Experimental.** The default model, `@cf/meta/llama-4-scout-17b-16e-instruct` on Cloudflare Workers AI, is free but too weak to fix code reliably: its edits are often incomplete or wrong, and it cannot work through review findings. It does not replace Claude Code or ChatGPT (Codex) as the coding agent, nor Codex as the reviewer. Use the chat for questions about the code and small, simple changes, and check every change it proposes. For real work, use the flow in [How it works best](#how-it-works-best).

The **Agent chat** tab lets you talk to the coding agent directly. You sign in with GitHub, ask about the code or describe a change, and can attach or paste a screenshot. For each message the Worker downloads the current default branch as one archive. It sends whole relevant files, not excerpts, to the model together with the conversation. Answers arrive within seconds once the model replies.

When the agent proposes a change it adds exact search/replace blocks. The Worker checks them against the current files, and each search text must match exactly once. Which files may be edited depends on the repository:

- **Other repositories:** source, style, page and documentation files (for example `.js`, `.ts`, `.tsx`, `.css`, `.html`, `.md`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.rb`, `.php`). Never files in hidden folders such as `.github`, package manifests (`package.json`, `requirements*.txt`, `setup.py`), lockfiles, environment files, `node_modules`, build output, or build and test-runner configuration (`*.config.*`, `conftest.py`, `build.rs`, `Package.swift`, `mix.exs`, `project.clj`, webpack, gulp and Grunt files).
- **Repo Autopilot itself:** only README and `.js`, `.css`, `.html` and `.md` files under `src/`, `public/` and `test/`, minus the files the Worker runs on (see *Limits*).

 
If a block does not apply, the model gets one correction round. A **Create pull request** button then re-applies the edits to the latest default branch and opens a pull request with your GitHub account, so CI runs on it as usual. The agent never merges on its own; you merge from the dashboard when you decide to.

The chat shows what the agent works on and what it is doing:

- **While it answers**, each step appears as it happens: reading the latest code (branch and commit), choosing the relevant files, asking the model, checking the proposed edits and any correction round.
- **Each answer** names the repository, branch and commit it is based on and how many files the agent read, for example `acme/webshop · main @ 3fb55a7 · read 14 of 312 files`. When the branch has newer commits, the line says so.
- **A proposed change** names the branch the pull request will target and the new branch it is opened from (`autopilot/chat-…`). Once opened, it shows the pull request's number, CI, Codex status and merge readiness, kept current by the webhook. **Follow in dashboard** opens its row, where you merge it.
- **Pull request descriptions** are written automatically: your request, the agent's explanation and the files it changes.

- **Model:** Workers AI with `@cf/meta/llama-4-scout-17b-16e-instruct` by default. This model reads images, and the binding needs no API key. Each message sends up to `CONTEXT_CHARS` characters of files (default 60,000, roughly 15–20k tokens). The free Workers AI allocation is a fixed daily amount, so it covers a limited number of messages per day; check usage in the Cloudflare dashboard under AI → Workers AI. Set the repository variable `AUTOPILOT_CHAT_MODEL` to use another Workers AI model. To use an OpenAI-compatible provider instead, set the repository variables `AUTOPILOT_CHAT_MODEL_PROVIDER=openai-compatible`, `AUTOPILOT_CHAT_MODEL_BASE_URL` (HTTPS, for example `https://api.groq.com/openai/v1`) and `AUTOPILOT_CHAT_MODEL`, plus the secret `AUTOPILOT_CHAT_MODEL_API_KEY`. `AUTOPILOT_CHAT_CONTEXT_CHARS` changes the file budget. Make these changes in the repository settings, not the Cloudflare dashboard: each deploy replaces the Worker's variables.
- **Storage and security:** Conversations, sessions and locks live in one SQLite-backed Durable Object in your Cloudflare account. They are private. Sign-in uses the GitHub App user flow with PKCE and an encrypted, browser-bound state. Only the configured owner is admitted, and only GitHub App user tokens (`ghu_`) are accepted. The token is valid for at most eight hours and is stored server-side; the browser only gets an HttpOnly session cookie, and only a hash of that cookie is stored. Writes require the exact origin and a CSRF token, and one answer is generated at a time. A dashboard sign-in keeps its GitHub tokens, sealed, only as long as the session lasts, so that it can connect one app through the [connector](#claude-and-chatgpt-connector) without a second GitHub sign-in; an expired session is removed with them, also when nobody visits. Only apps you connect hold a long-lived GitHub credential, until you revoke them.
- **Images:** The browser scales images down and converts them to JPEG before upload. The image is sent to the model for that message only and is not stored.
- **Limits:** The agent cannot edit the code it runs on (`worker/` and the files it bundles: `src/agent.js`, `src/github.js`, `src/codex.js`, `src/progress.js`), workflows, dependencies or credentials. A test fails if the Worker starts bundling another repository file without making it read-only. Edits keep each file's line endings. On the Workers Free plan each request has a small CPU budget; the archive is decompressed natively to stay within it. If Cloudflare reports *Worker exceeded CPU time limit*, lower `AUTOPILOT_CHAT_CONTEXT_CHARS` or switch to Workers Paid. Very large repositories may still exceed the free CPU budget or the archive size limit (12 MB); the chat then reports an error, and the dashboard keeps working.

### Set up the app

1. **GitHub App.** Create a GitHub App owned by your account, install it on the repositories you want to work with, and give it **Contents** and **Pull requests** set to *Read and write* and **Actions**, **Checks**, **Commit statuses** and **Issues** set to *Read-only* (the dashboard reads workflow runs, checks, statuses and PR comments with your sign-in, which only has the app's permissions). In the app settings:
   - Add the callback URL `https://repo-autopilot-chat.<your-subdomain>.workers.dev/auth/callback`.
   - Keep **Expire user authorization tokens** enabled.
   - Generate a client secret.
2. **Cloudflare API token.** In the Cloudflare dashboard, create an API token from the **Edit Cloudflare Workers** template and copy your **Account ID**.
3. **Repository settings.** Under *Settings → Secrets and variables → Actions*, add:
   - the secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `AUTOPILOT_CHAT_CLIENT_SECRET` (the app's client secret)
   - the variable `AUTOPILOT_CHAT_CLIENT_ID` (the app's client ID)
4. **Deploy.** Run the **Agent chat Worker** workflow, or push a change under `worker/`. It runs the tests, then deploys with Wrangler and uploads the client secret together with the code, so no version runs without it. Without the settings it only builds and skips deployment.
5. **Owner account.** Only the repository owner can sign in. For a repository owned by an organization, set the repository variable `AUTOPILOT_TASK_USER` to the GitHub login allowed to use the app, then run the **Agent chat Worker** workflow again: the value is applied when the Worker is deployed.
6. **Webhook (recommended).** See below.

### Claude and ChatGPT connector

Claude and ChatGPT can read the same status the dashboard shows, through a connector in your own Worker. The address is shown under **Connected apps** in the dashboard: `https://repo-autopilot-chat.<your-subdomain>.workers.dev/mcp`. No review by Anthropic or OpenAI is needed; you add it yourself.

- **Claude:** Customize → Connectors → **Add custom connector**, paste the address and click **Add**. If Claude asks how to identify itself, choose **Register automatically**. Custom connectors work on every Claude plan, and the Free plan allows one ([Claude's documentation](https://claude.com/docs/connectors/custom/remote-mcp)).
- **ChatGPT:** turn on **Developer mode** in the settings (a beta feature) and add an app with the same address.
- Connecting shows a Repo Autopilot page naming the app and where it returns to. **Allow** signs you in with GitHub, then you are back in the chat app. If you are signed in to the dashboard in the same browser, **Allow** connects the app at once with the GitHub tokens of that sign-in, with no trip to GitHub; each dashboard sign-in connects one app this way, as GitHub renews a refresh token only once.

The tools, all read-only and reading the same data and cache as the dashboard:

- `list_repositories`: the repositories Repo Autopilot reads.
- `list_pull_requests`: a repository's most recently updated pull requests with merge readiness, CI, Codex status and finding counts. To stay within the Workers subrequest limit, at most two pull requests are loaded from GitHub per call; the others come from the cache or are marked as not loaded.
- `pull_request_status`: one pull request in full: why it is or is not ready to merge, CI, Codex status, every Codex finding with its state (open, waiting for Codex, fixed) and recent activity.
- `list_workflow_runs`: a repository's most recent GitHub Actions runs (15 by default, up to 60), newest first, with workflow, status and conclusion, branch, commit and link; optionally only failed runs or one branch.
- `pull_request_checks`: the CI of one pull request in detail, read live: every check and status on its head commit, and for up to four failed checks GitHub's summary, their annotations and the last 40 lines of the GitHub Actions job log.
- `pull_request_files`: what one pull request changes, read live: every changed file with its status and added and removed lines, and the diffs, up to 12,000 characters in all and 3,000 per file (a cut diff says so). Ask with `path` for one file's whole diff (up to 20,000 characters), and with `page` for files beyond the first 100.
- `codex_findings`: one pull request's Codex findings with their full text (what is wrong and how to fix it), optionally only open, waiting, unverified or fixed ones.
- `waiting_on_me`: the open pull requests in the six most recently pushed repositories and what each needs: fix (findings, failed CI, conflict, review comments), merge, or wait.
- Both pull request tools take `fresh: true` to read GitHub again instead of the cache, which the card's **Refresh** uses: CI results, for example, change without changing a pull request's update time.

**The Repo Autopilot card.** In chat apps that support [MCP Apps](https://modelcontextprotocol.io/extensions/apps), the two pull request tools also show their result as a card next to the answer: the pull requests with merge readiness, CI and finding counts, a repository picker that loads another repository's pull requests, filters (**All**, **Needs attention**, **Ready**), and each pull request's Codex findings and recent activity when you open it. A pull request the list did not load in full still shows whether it is open, merged or closed, and **Load details** loads it in place with `pull_request_status`. Many fixed findings are folded away. **Refresh** loads the same tool again, **Full screen** and **Pin** (which keeps the card in view while the conversation scrolls) are offered where the app supports them, and **Open dashboard** opens your Repo Autopilot, where merging happens. The card only shows what the tool returned: it talks to the chat app through the official [MCP Apps SDK](https://github.com/modelcontextprotocol/ext-apps) client, inlined in the card (`worker/src/vendor/ext-apps.js`, regenerated with `scripts/vendor-ext-apps.mjs`), loads nothing from other sites and cannot change anything. Claude shows it in chats on the web, the desktop app and the mobile apps, and ChatGPT shows it too; Claude Code shows the same result as text.

**Troubleshooting.** The Worker writes one line to its log for every MCP message a chat app sends (the method, and the tool or resource when it is one of the connector's, the app and its user agent) and for every step of connecting an app (`oauth`: registering, the consent page, the decision, the GitHub sign-in and the token exchange, each with its status and any OAuth error), never codes, tokens or tool arguments. Find them in Cloudflare under **Workers & Pages → repo-autopilot-chat → Observability**, searching for `connector`.

New tools or cards reach a chat app when it reads the connector's tool list again. In Claude, that happens when you disconnect and connect Repo Autopilot again; code changes to existing tools take effect at once.

Ask Claude or ChatGPT things like "Which pull requests are ready to merge?" or "Why is #80 not ready, and what do its Codex findings mean?". Every tool only reads: nothing can be changed, commented on or merged through the connector, and merging stays in the dashboard. Each pull request in the answers links both to GitHub and to your dashboard (`/?repo=owner/name#pr-80`), which opens that repository and pull request.

How it stays signed in: the connector uses OAuth 2.1 with PKCE and dynamic client registration. Its access tokens last an hour and its refresh tokens rotate on every use. The GitHub sign-in made while connecting, including GitHub's refresh token, is stored sealed (AES-GCM, with a key derived from the GitHub client secret) in your Durable Object, and the Worker renews it with GitHub when it expires. That GitHub token has the GitHub App's permissions, including write, even though the connector's tools only read. A connected app therefore stays connected for as long as GitHub lets its sign-in be renewed (about six months), until you click **Revoke** under **Connected apps**. Revoking GitHub's authorization of the app (GitHub → Settings → Applications) also ends it. At most 10 apps can be connected; a new one replaces the least recently used.

### Live updates with the webhook

GitHub can tell the app when something changes, so the dashboard updates within seconds instead of every three minutes. The webhook only clears the cached data the event affects; the dashboard then reloads it with your sign-in, so the webhook needs no GitHub credential of its own.

1. Create a random secret, for example with `openssl rand -hex 32`.
2. Add it as the repository secret `AUTOPILOT_WEBHOOK_SECRET`, then run the **Agent chat Worker** workflow so the Worker gets it.
3. In the GitHub App settings (*General → Webhook*), check **Active**, set the **Webhook URL** to `https://repo-autopilot-chat.<your-subdomain>.workers.dev/api/webhook` and the **Webhook secret** to the same value.
4. Under *Permissions & events → Subscribe to events*, check **Pull request**, **Pull request review**, **Pull request review comment**, **Pull request review thread**, **Issue comment**, **Check run**, **Check suite**, **Status**, **Workflow run** and **Push**.

Every delivery is verified with GitHub's `X-Hub-Signature-256` HMAC; without the secret the endpoint is disabled. Check and status events are matched with the head commits of loaded pull requests, so checks on other branches cause no reload, and data loaded while an event arrived is not cached. Each deploy keeps Worker secrets that are not in the workflow; to turn the webhook off, uncheck **Active** in the app settings. *Recent Deliveries* in the app settings shows each delivery; a working setup answers `204`. Events from every repository where the app is installed are handled. Reactions (such as the Codex thumbs-up) send no event and appear on the next load.

Local check: `npx wrangler deploy --dry-run --config worker/wrangler.jsonc` bundles the Worker without deploying.

