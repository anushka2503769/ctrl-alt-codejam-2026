# RunVault hands-on test drive

This walkthrough exercises RunVault from the browser as a product user. It
uses a dedicated local data directory, so the demo can be stopped and resumed
without mixing its Agents and Runs with other local work.

## 1. Start the local app

You need Node.js 22+, npm 10+, a running Docker-compatible engine, and a
Volcengine Ark API key and model endpoint.

From the repository root:

```bash
git switch feature-improvements
docker info

printf "Ark API key: "
read -s ARK_API_KEY
printf "\n"
export ARK_API_KEY
export ARK_MODEL="ep-your-endpoint-id"

LOCAL_POC_DATA_ROOT="$PWD/.runvault-test-drive" npm run poc
```

The first run may install project packages and build the local Runtime image.
When the terminal says the app is ready, open <http://localhost:3000>.

Do not use real credentials in any Agent prompt or test workspace. The Ark key
is passed only to the local startup process.

## 2. Create a test Agent

1. Select **Create Agent**.
2. Name it `RunVault Test Drive`.
3. Use this workspace instruction:

   ```text
   Make only the changes I request. Keep files small and explain what you changed.
   Never use real credentials or contact external services.
   ```

4. Create the Agent and open its Playground.

## 3. Exercise the main product flows

Run one scenario at a time and wait for its RunVault decision before starting
the next one.

### A. Safe work is promoted automatically

Prompt:

```text
Create docs/welcome.md with a short heading and three bullet points explaining
that this is a RunVault test workspace. Do not change any other file.
```

Expected result:

- Workspace outcome is **Promoted**.
- The file list shows only `docs/welcome.md`.
- Verification may be **Skipped** because this tiny workspace has no test
  command. The standard policy still permits the safe change.

### B. Protected work is quarantined for review

Prompt:

```text
Create deploy/production.yml with a small example production rollout. Use only
placeholder values and do not change any other file.
```

Expected result:

- Workspace outcome is **Quarantined**.
- Findings identify `deploy/production.yml` as a protected path.
- RunVault shows path metadata but does not reveal the protected file contents.
- **Approve and promote**, **Discard staged work**, and revision controls are
  available.

Do not resolve this Run yet; use it for scenario C.

### C. Revise quarantined work safely

In **Request revisions**, enter:

```text
Remove the deploy/production.yml change. Put the rollout proposal in
docs/rollout-plan.md instead. Do not change any protected path.
```

Select **Create revision Run**.

Expected result:

- A child Run is created and the original review is retained.
- The new review shows its relationship to the parent Run.
- If only the documentation remains, the revision is promoted automatically.
- The committed Agent conversation advances to the promoted revision, not the
  quarantined parent.

### D. Approve an intentional protected change

Prompt:

```text
Create deploy/manual-approval.yml containing a harmless placeholder deployment
name and one placeholder environment value. Do not change any other file.
```

After it is quarantined, inspect the findings and select **Approve and
promote**.

Expected result:

- The outcome changes from quarantined to promoted by approval.
- The review records that a person approved the protected change.
- The next Run continues from this approved version.

### E. Discard unwanted work

Prompt:

```text
Create .env.demo containing only PLACEHOLDER_ONLY=true. Do not change any other
file.
```

After it is quarantined, select **Discard staged work**.

Expected result:

- The outcome becomes **Discarded**.
- The staged proposal is removed rather than entering the trusted workspace.
- Later Runs continue from the last promoted version.

### F. See several findings together

Prompt:

```text
Create .env.multi-test containing PLACEHOLDER_ONLY=true, create a minimal
package.json, and add 21 tiny text files under generated/ named sample-01.txt
through sample-21.txt. These are disposable test files; do not use secrets.
```

Expected result:

- The Run is quarantined.
- RunVault reports several concerns together, including a protected path, a
  dependency-file change, and too many changed files.
- The review remains bounded and does not expose the protected file contents.

Discard this Run when finished reviewing it.

## 4. Inspect history and diagnostics

1. Select **Run history** in the sidebar.
2. Confirm that promoted, quarantined, approved, revised, and discarded Runs
   are all represented.
3. Try the outcome, finding, verification, Agent, and lineage filters.
4. Reopen an older Run and confirm its decision did not change when later Runs
   were completed.
5. Download an evidence JSON file. Check that it contains decision metadata and
   relative file names, but no prompt text, Agent output, absolute workspace
   path, or protected file contents.
6. Review the diagnostic cards for verifier availability, retained staging,
   dependency cache status, cleanup failures, and orphan count.

## 5. Optional strict-policy comparison

Stop the app with `Ctrl+C`, then restart the same demo with:

```bash
RUNVAULT_POLICY_PROFILE=strict \
LOCAL_POC_DATA_ROOT="$PWD/.runvault-test-drive" \
npm run poc
```

Create another safe documentation file. Under strict policy, a workspace with
no runnable verification can be quarantined because verification is required.
Compare its policy snapshot and wording with scenario A.

Stop with `Ctrl+C`. To resume later, export `ARK_API_KEY` and `ARK_MODEL` again
and run the same `LOCAL_POC_DATA_ROOT=... npm run poc` command. The demo data is
preserved in `.runvault-test-drive/` and ignored by Git.

## 6. Automated confidence checks

Use the ordinary developer check while iterating:

```bash
npm run check
```

Use a one-pass security/release smoke test when Docker and Terraform are
available:

```bash
RUNVAULT_STRESS_PASSES=1 npm run release-gate
```

Before treating a build as release-ready, run the complete 25-pass gate:

```bash
npm run release-gate
```

The release gate expects a running Docker daemon and the existing local
`volc-agent-runtime:local` image. It does not pull images or install packages.

## Feedback template

For each suggestion, capture:

- Scenario and Run ID
- What you expected
- What actually happened
- What felt unclear, slow, or unsafe
- Your suggested wording or behavior
- Screenshot or downloaded redacted evidence, if useful

Never attach API keys, real `.env` contents, or other credentials.
