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
