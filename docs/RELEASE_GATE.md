# RunVault release gate

This release gate proves the single-user RunVault POC claims with executable
tests. It does not certify multi-tenant isolation, establish a tamper-proof
audit log, or expand the trust boundary documented in `SECURITY.md`.

## One-command gate

The gate requires Node.js 22+, Git, Terraform, Docker Compose, a running Docker
daemon, and the already-built `volc-agent-runtime:local` image. It never pulls
an image or installs dependencies.

```bash
./scripts/run-release-gate.sh
```

`RUNVAULT_STRESS_PASSES` can lower the repetition count for local diagnosis,
but release evidence requires the default 25 passes. Every stress pass enables
the real container integration suite; no Docker-only test is skipped.

## Evidence matrix

| Claim | Executable evidence |
| --- | --- |
| Historical Runs retain independent decisions | `run-history.test.ts`, `RunVaultReview.test.tsx`, and `runvault-history.test.ts` verify per-Run selection, review, filtering, and redaction. |
| Findings and outcome language remain complete | `runvault-policy.test.ts` covers simultaneous findings and precedence; `runvault-copy.test.ts` separates workspace outcome from passed, skipped, failed, and unavailable verification. |
| Review remains safe and bounded | `agent-service.test.ts`, `runvault-review.test.ts`, and `RunVaultReview.test.tsx` cover protected, binary, oversized, link, dependency, mass-change, diff, and secret evidence. |
| Revision lineage is transactionally consistent | `agent-service.test.ts` covers one and three generations, failed and cancelled revisions, lineage history, retained parents, trusted fingerprints, and committed-thread advancement only for the promoted final Run. |
| Decision races have one owner | `agent-service.test.ts` covers concurrent Runs, approval versus approval/discard/revision/expiry, and deletion cancelling an in-flight approval before removing staging. |
| Dependencies do not inflate staging | `runvault-workspace.test.ts` creates hundreds of dependency files and proves copied entry/byte metrics equal only the source snapshot; `dependency-manager.test.ts` proves cold preparation and warm immutable reuse. |
| Git metadata remains functional | `runvault-workspace.test.ts` uses a real repository with more than 50 loose objects and runs `git status`, `rev-parse`, and `fsck` after promotion and restart reconciliation. Worktree metadata has separate coverage. |
| Verifier isolation is enforced | The container integration suite proves no network, no server credentials, no host-root writes, bounded PIDs, forced cancellation/timeout cleanup, secret-output redaction, and read-only offline dependencies. Unit tests assert `--pull never`, no capabilities, no-new-privileges, read-only root, non-root user, and CPU/memory/PID limits. |
| Tampering and interruptions fail safely | `agent-service.test.ts` rejects trusted/staging tampering. `runvault-workspace.test.ts` exercises prepared, installed, metadata-transfer, committed, rollback, legacy-marker, and orphan-reconciliation paths. |
| Storage pressure remains bounded | `runvault-workspace.test.ts` and `agent-service.test.ts` cover per-Run/aggregate quotas, active growth cancellation, expiry, cleanup, diagnostics, and idempotent repeated reconciliation. |
| Secrets do not enter evidence | The secret fixture is checked against the JSON database, service/API evidence export, retained review, and rendered review UI. Metric schemas reject arbitrary content and paths. |
| Deployment definitions remain valid | The gate runs `terraform fmt -check -recursive deploy/volcengine` and `LAUNCHPAD_ENV_FILE=.env.example docker compose config --quiet`. |

## Required interpretation

A passing gate means the tested risky, interrupted, rejected, expired, and
tampered scenarios leave trusted source unchanged and do not commit a
provisional Codex thread. It also demonstrates verifier controls against the
specific adversarial fixtures above. It is not evidence that ordinary
containers resist every hostile workload or kernel-level attack.

## D1 validation record — 2026-08-31

- `npm run check`: passed, including typechecks, 187 server tests, 12 web tests,
  and both production builds. The five Docker-gated tests are intentionally
  skipped by the ordinary developer suite and proven below.
- Real verifier isolation: 5 of 5 Docker integration tests passed against
  `volc-agent-runtime:local` image
  `sha256:b7c94b3b3b4c9dfe31a1f2876ba882b1d5b31f5279b5e2e028898b1b40fec328`.
- Consecutive full-suite stress: 25 of 25 passes with
  `RUN_CONTAINER_INTEGRATION=1`; each pass ran 192 server tests and 12 web
  tests, for 5,100 passing test executions and no skipped tests.
- `terraform fmt -check -recursive deploy/volcengine`: passed.
- `LAUNCHPAD_ENV_FILE=.env.example docker compose config --quiet`: passed.
- Finalized gate orchestration: `RUNVAULT_STRESS_PASSES=1 npm run release-gate`
  passed end to end with Docker enabled in the stress pass.
- Toolchain: Node.js 24.19.0, npm 11.17.0, Git 2.55.0, Terraform 1.16.0,
  Docker 29.7.2, and Docker Compose 5.4.0.
