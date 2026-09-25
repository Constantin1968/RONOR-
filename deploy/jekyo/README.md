# JEKYO migration artifacts

This directory contains the declarative deployment artifacts and operational runbooks for moving the existing RONOR Docker Compose estate to JEKYO.

## Scope

- `ronor-runtime.jekyo.yaml`: target declaration for the RONOR application runtime and internal services.
- `ronor-automation.jekyo.yaml`: target declaration for automation, evidence and agent workers.
- `portfolio-intelligence.jekyo.yaml`: target declaration for the daily portfolio-intelligence worker.
- `migration-plan.md`: service-by-service cutover procedure.
- `backup-and-rollback.md`: protection and recovery procedure for persistent data.
- `inventory-template.md`: live-node discovery record to complete before the production cutover.

## Safety boundary

These files are migration blueprints. They do not contain credentials, production DNS values, external API keys, or Qdrant data. Do not deploy a manifest until its image names, ports, volume paths, secrets, DNS names, and health endpoints have been reconciled with the live node.

## Intended operating model

1. JEKYO owns ingress, TLS, deployment lifecycle, health checks, logs, rollback and scheduled jobs.
2. Persistent RONOR data is externalized to named volumes and backed up before any cutover.
3. The existing Compose stack remains available as the fallback until health, data integrity and restart behaviour are accepted.
4. Secrets are injected through the target platform; they are never committed here.
