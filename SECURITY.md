# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Docker Compose gives the control-plane container access to the host Docker
  socket. Verification containers never receive that socket or the trusted
  workspace, but compromise of the control plane remains host-significant.
- Repository `npm test` scripts execute in a disposable no-network container
  with dropped capabilities and resource limits. Ordinary containers are still
  not a hardened multi-tenant sandbox.
- Trusted `.git` files and directories are not copied or content-hashed.
  Agent-created `.git` metadata is quarantined and cannot be approved; durable
  promotion recovery preserves trusted repository metadata separately.
- `node_modules` is not copied, content-hashed, or promoted as source. Existing
  trusted trees are preserved but never mounted into Runs. Optional managed
  caches are content-keyed and mounted read-only; RunVault never automatically
  installs packages during Agent or verification Runs.
- `DEPENDENCY_MODE=isolated-ci` exposes an authenticated preparation endpoint.
  Each request requires an explicit network confirmation and runs constrained
  `npm ci --ignore-scripts`; registry packages remain untrusted executable code
  when later imported by an Agent or test process.
- RunVault enforces configured per-Run and aggregate staging byte limits before
  copying, during execution, and before promotion. During execution these are
  application-level periodic measurements, not filesystem or block-device
  quotas, so a fast writer can temporarily pass the configured threshold before
  cancellation completes. Keep adequate disk headroom and use host-level disk
  quotas for stronger exhaustion resistance.
- Quarantined staging expires under the configured retention policy. Expiry
  preserves bounded redacted evidence but permanently removes the reviewable
  staged files; operators should approve, revise, or export anything needed
  before `expiresAt`.
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Use disposable workspaces and review quarantined path metadata before approval.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
