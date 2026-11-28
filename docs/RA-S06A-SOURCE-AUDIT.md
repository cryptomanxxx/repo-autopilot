# RA-S06A · Host source qualification

Review date: 2026-11-28. Documentation review only; no Oracle account, VM, credential, service or live agent created. No account-specific eligibility verified.

## Oracle candidate

Oracle's current [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) and [Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) describe the A1.Flex Arm allowance as 1,500 OCPU-hours and 9,000 GB-hours monthly, equivalent to 2 OCPUs and 12 GB memory. This is the aggregate tenancy allowance, not a per-VM entitlement. Older 4 OCPU/24 GB summaries must not be used. Home-region availability is required. Combined boot/block volumes have a 200 GB allowance and five volume backups. Ubuntu and Oracle Linux eligible images are documented. A 2 OCPU/12 GB VM would consume 1,488 OCPU-hours and 8,928 GB-hours over 31 days, before any other tenancy usage. This is arithmetic, not a billing estimate or account verification.

Proposed single pilot VM: A1.Flex, Ubuntu ARM64 eligible image, up to 2 OCPU/12 GB, 50 GB initial boot volume, only after actual remaining allowances and storage/network charges are verified. No paid upgrade, trial credit dependency, or resource creation. Oracle documents possible host-capacity shortages and reclamation of idle instances based on CPU/network/memory over seven days. Do not generate artificial load or evade reclamation. Preserve evidence outside ephemeral workspaces under separately verified existing allowances; assume host loss is possible.

## Symphony and Codex

Inspected exact upstream [Elixir README](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/README.md), Git blob c2653a046df8bfd73ec102264047904ca3f59366, via GitHub. It documents linux_arm64 release target and checksums, bundled Erlang/Elixir, external Codex/Git dependencies, prototype status and GitHub Issues adapter. Native status server remains disabled by default; no supported native start/pause/stop endpoint was established in RA-S03A. Do not run example workflows or live E2E: those can create resources and launch agents. Pin exact release source and verify artifact integrity before execution; rolling nightly tag is not a pin. No artifact fetched or executed in this audit. Actual ARM compatibility, dependency versions, disk/RAM use and sandbox behavior remain untested.

OpenAI's [Codex App Server subscription integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [overview](https://developers.openai.com/siwc/token-sharing-open-source) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) document OAuth plan-authorized inference for supported open-source app integrations. This is not proof that the pinned Symphony/Codex pairing supports that flow or that a specific Plus account has sufficient capacity. Prefer the supported Codex sign-in path after verification. Never store OAuth credentials in Git, chat, logs or browser dashboards; never use paid API fallback. Do not assume OAuth is unlimited or that quota telemetry prevents billing. Actual supported authentication path, account eligibility, limits, and fail-closed behavior still need qualification.

## Qualification decision

Public documentation: candidate suitable for further investigation. Account and actual host: NOT QUALIFIED. Production dispatch: NOT AUTHORIZED. No actual cost measurement. No server provisioned.

RA-S06B: operator reviews Oracle account type, home region, remaining A1 hours, memory hours, volume/backups, network and all associated resources, hard protection against charges, trial lifecycle and eligible image. Collect only redacted nonsecret evidence. If unavailable, block rather than upgrade. Account registration is an operator decision, not a prerequisite authorized by this PR. No payment information or secrets requested in chat.

RA-S06C: after separate provisioning approval and proven zero-cost boundary, verify host architecture and pinned artifacts, sandbox, storage recovery, account authorization and private transport with dispatch disabled. RA-S07 remains gated by actual durable control/stop and cost enforcement, repository isolation and DARE approval. No auto-start or live research on the strength of this documentary audit.
