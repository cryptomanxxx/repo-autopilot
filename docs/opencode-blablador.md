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
