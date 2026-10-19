# OpenCode with Blablador

Repo Autopilot has an experimental manual GitHub Actions coding workflow in `.github/workflows/opencode-blablador.yml`. It runs OpenCode in a GitHub runner, using Helmholtz Blablador for AI inference through the private [`repo-autopilot-ai-gateway`](https://github.com/cryptomanxxx/repo-autopilot-ai-gateway) Cloudflare Worker. **No provider API key is stored in GitHub.** The existing Cloudflare chat and Codex dashboard are unchanged.

## Setup from Android

1. Deploy `repo-autopilot-ai-gateway` (see its README) and store `BLABLADOR_API_KEY` and `GATEWAY_LEASE_SIGNING_KEY` **only as Cloudflare Worker secrets**. Delete any `BLABLADOR_API_KEY` secret from GitHub (repository and environment level).
   Under Settings → Environments → `ai-agent-production`, allow only `main` and add yourself as a **required reviewer** (available on every plan for public repositories), and add the **environment variable** `AI_GATEWAY_URL` with the gateway's https origin (for example `https://repo-autopilot-ai-gateway.<account>.workers.dev`, no trailing path).
2. In GitHub repository Settings, enable the Actions option allowing GitHub Actions to create pull requests, if your policies permit it.
3. Once this PR is merged, open Actions, select `OpenCode coding agent (Blablador)`, choose Run workflow, and enter a short coding task.
4. Review any resulting PR and follow its CI and Codex feedback in the dashboard. Merge manually.

This workflow uses `blablador/alias-code`. It installs OpenCode in an Ubuntu runner, validates changes with `npm run check` and `npm test`, and only then proposes a PR. It does not launch tasks from the Repo Autopilot chat UI and currently works in this repository only.

GitHub runner usage and Blablador availability still apply. OpenCode can execute commands, so only submit trusted tasks and always review the resulting changes. No automatic merging is enabled.

References: https://sdlaml.pages.jsc.fz-juelich.de/ai/guides/blablador_opencode/ and https://opencode.ai/docs/cli/.

## Security boundary

```
propose job (id-token: write, ai-agent-production):
  GitHub OIDC JWT ──► gateway /v1/session ──► 30-min lease (100 calls)
  OpenCode ──lease──► gateway /v1/chat/completions ──BLABLADOR_API_KEY (Cloudflare secret)──► Blablador
publish job (contents/pull-requests: write): validates the patch and opens a PR
```

**This repository is public.** Its Actions logs and artifacts can be read by anyone, which shapes the design below.

- **Provider key:** exists only in Cloudflare Worker secrets. Neither GitHub nor OpenCode ever sees it.
- **Identity:** the gateway accepts only a GitHub-signed OIDC token from this repository's `opencode-blablador.yml` on `main`, dispatched by the owner via `workflow_dispatch` in the `ai-agent-production` environment, first run attempt only. Runs from other refs, reruns and other actors get no lease.
- **Lease:** OpenCode receives a lease that is valid only at the gateway, for 30 minutes and at most 100 model calls, with one in-flight generation. It is obtained and masked inside the `propose` job and never leaves that runner as a job output or artifact, since both would be public here.
- **OIDC in the agent job:** because the lease is obtained in the same job, agent-controlled code (OpenCode, npm scripts, tests) could request another GitHub OIDC token for this run. That gains nothing at the gateway, which returns the same lease for the same run. **Do not let any other system (cloud provider, registry, etc.) trust this repository's OIDC identity.**
- **Leak checks:** before the patch artifact is uploaded, and again in the publisher, any content or file name shaped like a gateway lease is rejected. This catches accidents. It cannot stop a deliberately malicious agent that sends the lease over the network, which is why the lease is short-lived and capped.
- **Publishing:** the OpenCode job has read-only repository permissions and **never receives a GitHub write token**. It creates a bounded patch artifact after local project checks. A separate fresh job downloads the patch and checks that it is based on the same default-branch commit. It then independently validates protected paths, file types and sizes, and rejects any staged content shaped like a gateway lease. Only then does it create a pull request with short-lived write credentials. No code from the proposed edits runs in the privileged publishing job, and nothing is merged automatically.

For safety, manual dispatch is restricted to the **personal repository owner**, both by the in-file actor guard and by the gateway's identity check (which cannot be edited from this repository). Organization-owned forks are not supported by this workflow.

If the default branch changes during an agent run, the publisher refuses the stale patch and the workflow must be rerun as a new dispatch: reruns of the same run cannot get a new gateway lease. OpenCode's installed package version is pinned to `1.19.3`.

## Required environment configuration (security-critical)

**Do not run this workflow** until the gateway is deployed and the environment is configured. In GitHub **Settings → Environments**, create `ai-agent-production`, set **Deployment branches and tags** to the default branch only, and add the `AI_GATEWAY_URL` environment variable. Environment variables can only be changed by repository admins. Never store a provider key or other secret in this repository: its logs and artifacts are public. The existing `HIP_API_KEY` is not used by this workflow; HIP will be added to the gateway later, not to GitHub.

**Approval.** Add yourself as a required reviewer on `ai-agent-production` so that every run waits for your approval. For public repositories this works on every GitHub plan. The workflow does not rely on it alone:

- **Who can use the model** is decided by the gateway, not by GitHub settings. It issues a lease only when GitHub's signed OIDC token shows the owner's account ID as the dispatching actor, `workflow_dispatch`, `refs/heads/main`, this exact workflow file on `main`, the `ai-agent-production` environment and the first run attempt. A collaborator who dispatches, or who edits the workflow on another branch, gets no lease. These checks live in the gateway's code and cannot be changed from this repository.
- **What reaches `main`** stays protected by the publisher job, which only opens a pull request. Protect `main` with a branch rule that requires a pull request, so that changes to this workflow are also reviewed before they run.
- On a personal repository without collaborators, only the owner can dispatch at all.

The publisher validates that each staged added/modified blob is at most 1 MiB and the total is at most 5 MiB, after applying the patch and before obtaining its GitHub write token.

Tested end to end via the production AI gateway.
