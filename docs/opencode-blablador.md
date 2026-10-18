# OpenCode with Blablador

Repo Autopilot has an experimental manual GitHub Actions coding workflow in `.github/workflows/opencode-blablador.yml`. It runs OpenCode in a GitHub runner, using Helmholtz Blablador for AI inference. The existing Cloudflare chat and Codex dashboard are unchanged.

## Setup from Android

1. Add the repository Actions secret `BLABLADOR_API_KEY` to `repo-autopilot`. Secrets in other repositories are not shared automatically.
2. In GitHub repository Settings, enable the Actions option allowing GitHub Actions to create pull requests, if your policies permit it.
3. Once this PR is merged, open Actions, select `OpenCode coding agent (Blablador)`, choose Run workflow, and enter a short coding task.
4. Review any resulting PR and follow its CI and Codex feedback in the dashboard. Merge manually.

This workflow uses `blablador/alias-code`. It installs OpenCode in an Ubuntu runner, validates changes with `npm run check` and `npm test`, and only then proposes a PR. It does not launch tasks from the Repo Autopilot chat UI and currently works in this repository only.

GitHub runner usage and Blablador availability still apply. OpenCode can execute commands, so only submit trusted tasks and always review the resulting changes. No automatic merging is enabled.

References: https://sdlaml.pages.jsc.fz-juelich.de/ai/guides/blablador_opencode/ and https://opencode.ai/docs/cli/.

## Security boundary (initial version)

The OpenCode job has read-only repository permissions and receives the Blablador key, but **never receives a GitHub write token**. It creates a bounded patch artifact after local project checks. A separate fresh GitHub Actions job downloads the patch, checks that it is based on the same default-branch commit, independently validates protected paths and file types, then creates a pull request with short-lived write credentials. No code from the proposed repository edits is executed in the privileged publishing job, and no automatic merge occurs.

For safety, manual dispatch of this experimental workflow is currently restricted to the **personal repository owner**. Organization-owned forks are not yet supported by this workflow, even though the dashboard itself supports organization forks. A repository variable such as `AUTOPILOT_TASK_USER` is not an adequate workflow authorization boundary because collaborators with write access may change it. An organization-compatible version must introduce a separately protected approval or authorization policy.

If the default branch changes during an agent run, the privileged publisher refuses the stale patch and the workflow must be rerun. OpenCode's installed package version is pinned to `1.19.3`.

## Required protected environment configuration (security-critical)

**Do not run this workflow yet** until the environment is configured. In GitHub **Settings → Environments**, create `opencode-blablador`, restrict deployments to the repository's default branch only, and configure required reviewers to include the trusted repository owner (where the plan supports required reviewers). In Settings → Environments → opencode-blablador → Environment secrets, add `BLABLADOR_API_KEY` there. **Delete the repository-level `BLABLADOR_API_KEY` secret** afterwards; otherwise another write collaborator can dispatch a modified workflow on another ref and read the repository secret without passing the environment gate. A repository-level secret is not protected by declaring an environment on this job. The existing `HIP_API_KEY` is not used by this workflow; restrict it separately if collaborators are not trusted.

If your repository plan does not support protected environment reviewers or branch restrictions, do not treat this as an owner-only security boundary; instead use a separate tightly controlled private execution repository or another trusted access mechanism. The workflow still contains an in-file actor guard, but that alone is not authorization against writers who can change workflow YAML on branches.

The publisher validates that each staged added/modified blob is at most 1 MiB and the total is at most 5 MiB, after applying the patch and before obtaining its GitHub write token.
