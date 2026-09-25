# RONOR → JEKYO direct migration plan

## Objective

Move the active RONOR runtime from the existing Docker Compose estate on `ronor-secondary` to JEKYO while preserving persistent data, restoring operational restart resilience, and retaining a verified fallback until acceptance.

## Preconditions

- Complete live-node inventory: OS, Docker services, ports, volumes, compose files, systemd units, proxy, firewall and storage.
- Identify the actual images, commands, environment variables, secrets, network dependencies and health endpoints for every service.
- Obtain a verified Qdrant snapshot and a filesystem-level backup of all RONOR persistent volumes.
- Record the existing DNS, TLS and ingress topology.
- Confirm that JEKYO preflight reports no unresolved blocker or document the minimal remediation.

## Migration order

1. **Data protection**
   - Freeze a named backup point for Qdrant and RONOR evidence/state volumes.
   - Verify a non-destructive Qdrant restore into a separate collection or target path.

2. **Platform bootstrap**
   - Install JEKYO only after the ingress, runtime and port plan is approved.
   - Configure persistent storage and the backup target before application deployment.

3. **Qdrant**
   - Deploy Qdrant with a named persistent volume.
   - Restore the verified snapshot.
   - Validate the critical collections: `cida_intel`, `ronor_archive`, `ronor_corpora`, `ronor_knowledge`, `ronor_knowledge_bge_1024`, `ronor_memory`, `ronor_missions`.

4. **Core runtime**
   - Deploy controller, LangGraph and model-egress proxy.
   - Validate internal connectivity, secrets injection, health endpoints and restart behaviour.

5. **Automation**
   - Deploy automation runtime, evidence runner, OpenHands bridge and Codex verifier.
   - Validate evidence write paths and scheduled audit jobs.

6. **Ingress cutover**
   - Move one endpoint at a time only after the replacement service is healthy.
   - Preserve the old Compose ingress until DNS/TLS acceptance is complete.

7. **Portfolio intelligence**
   - Deploy the daily briefing worker after RONOR core acceptance.
   - Validate scheduled execution at 06:00 in `Europe/Bucharest`, output retention and delivery channels.

## Acceptance gates

- Every persistent dataset is present and queryable after migration.
- Every long-running service has a health check and restart behaviour validated by service and host reboot tests.
- Backup and restore are tested, not merely configured.
- Logs and status are visible through JEKYO.
- The former stack remains recoverable until all gates are accepted.
