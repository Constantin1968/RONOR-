# Development verification correction

This correction does not prove that a development mission has succeeded.

## Corrected contracts

- The verifier explicitly requests one JSON object and still rejects non-JSON, extra properties and incorrectly typed verdicts. Errors contain a fixed diagnostic identifier, not provider response content.
- Git evidence includes staged changes and new, non-ignored files. With a pinned base it retains changes after the author creates a local commit. Collection does not stage files or modify the repository index.
- The isolated evidence runner receives the same approved base commit as the controller. New-file symlinks, oversized evidence and secret-like content are refused.
- A fresh installation gives the worker its own local Git identity, not the operator's identity.

## Narrow installation

After explicit deployment approval, place a SHA-256-verified archive of the reviewed commit under:

`/srv/ronor/development-automation/releases/<full-commit>`

Run its `scripts/install-development-verification-fix.sh --approved <full-commit>`.
The script refuses existing jobs, requires a clean project worktree, builds and replaces only `codex-verifier` and `automation-evidence-runner`, configures the dedicated worker identity, and verifies that the six other new-stack containers retain their identifiers. It does not invoke a model, run a development job, alter the project source, push, merge, release, modify firewall rules or touch the legacy stack.

After successful installation, management commands must retain the override:

```sh
root=/srv/ronor/development-automation
revision=<reviewed-full-commit>
docker compose --project-name ronor-development \
  --env-file "$root/environment" --env-file "$root/verification-fix.env" \
  -f "$root/tooling/docker-compose.development-isolated.yml" \
  -f "$root/releases/$revision/docker-compose.development-verification-fix.yml" ps
```

Using only the original Compose file could revert the correction. The original worktree base remains unchanged; the correction is a separately versioned control-plane release.

## Remaining proof

1. One authorized synthetic request must produce valid JSON and reject missing evidence.
2. Only then run the previously approved bounded regression-test task.
3. Independently verify its complete diff, test report, receipt and assurance decision.
4. Exercise interruption and explicit restart without duplicate execution.

No arbitrary provider fallback, relaxed JSON parsing, automatic semantic repair or worktree rotation is introduced by this correction.
