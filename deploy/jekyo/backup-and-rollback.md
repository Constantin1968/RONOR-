# Persistent data protection, backup and rollback

## Critical assets

- Qdrant collections: `cida_intel`, `ronor_archive`, `ronor_corpora`, `ronor_knowledge`, `ronor_knowledge_bge_1024`, `ronor_memory`, `ronor_missions`.
- RONOR configuration, evidence, runtime state and automation state.
- External source configuration and any credential references held outside the repository.

## Mandatory backup point before cutover

1. Create an immutable timestamped backup point for every named Docker volume used by RONOR.
2. Create Qdrant snapshots for every critical collection.
3. Export compose files, non-secret environment-variable key names, systemd units, reverse-proxy configuration and DNS records into the change record.
4. Verify backup readability and perform at least one non-destructive Qdrant restore.

## Rollback trigger

Rollback is mandatory if any of the following occur:

- a critical Qdrant collection is absent, inconsistent or cannot be queried;
- controller, LangGraph, egress proxy or automation cannot pass health checks;
- restart behaviour fails;
- secrets cannot be injected safely;
- ingress/TLS cannot serve the intended endpoint;
- scheduled audits or evidence writes fail.

## Rollback procedure

1. Stop routing new traffic to the JEKYO deployment.
2. Restore previous DNS/ingress routing.
3. Restart the previously validated Compose services using the preserved configuration.
4. Do not delete JEKYO volumes during investigation.
5. Compare logs, endpoint health and Qdrant collection counts before retrying cutover.

## Retention policy target

- Daily backups: 30 days.
- Weekly backups: 12 weeks.
- Pre-cutover immutable snapshot: retained until the JEKYO migration is accepted and a separate recovery test passes.
