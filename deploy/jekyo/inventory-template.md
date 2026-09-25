# Live-node inventory record — ronor-secondary

Complete this record through the server executor before the production JEKYO install. Do not place secrets in this file.

## Host

- Hostname:
- Ubuntu release and kernel:
- CPU / RAM:
- Disk layout and free capacity:
- Timezone and NTP status:
- GPU / NVIDIA runtime:

## Existing platform services

- Docker engine / Compose versions:
- containerd / k3s / Kubernetes presence:
- systemd units related to RONOR:
- reverse proxy and certificate manager:
- firewall rules:
- listening ports: 80, 443, 6443 and RONOR internal ports:

## RONOR service map

| Service | Current image | Command | Port(s) | Volumes | Restart policy | Health check | Dependencies | Target JEKYO manifest |
|---|---|---|---|---|---|---|---|---|
| Qdrant | | | | | | | | `ronor-runtime.jekyo.yaml` |
| Controller | | | | | | | | `ronor-runtime.jekyo.yaml` |
| LangGraph | | | | | | | | `ronor-runtime.jekyo.yaml` |
| Model egress proxy | | | | | | | | `ronor-runtime.jekyo.yaml` |
| Automation runtime | | | | | | | | `ronor-automation.jekyo.yaml` |
| Evidence runner | | | | | | | | `ronor-automation.jekyo.yaml` |
| OpenHands bridge | | | | | | | | `ronor-automation.jekyo.yaml` |
| Codex verifier | | | | | | | | `ronor-automation.jekyo.yaml` |

## Persistent datasets

| Dataset / volume | Current path | Size | Backup method | Snapshot verified | Restore verified | Target JEKYO volume |
|---|---|---:|---|---|---|---|
| `cida_intel` | | | | | | `qdrant-storage` |
| `ronor_archive` | | | | | | `qdrant-storage` |
| `ronor_corpora` | | | | | | `qdrant-storage` |
| `ronor_knowledge` | | | | | | `qdrant-storage` |
| `ronor_knowledge_bge_1024` | | | | | | `qdrant-storage` |
| `ronor_memory` | | | | | | `qdrant-storage` |
| `ronor_missions` | | | | | | `qdrant-storage` |

## Cutover record

- Backup point ID:
- Approved maintenance window:
- DNS/ingress change record:
- JEKYO deployment IDs:
- Health-check acceptance evidence:
- Restart test evidence:
- Rollback readiness confirmation:
