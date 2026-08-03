#!/usr/bin/env bash
# ============================================================================
# RONOR — Sovereign host preparation
# ----------------------------------------------------------------------------
# One-time preparation of a bare Ubuntu 22.04 host (DigitalOcean 2 GB droplet or
# equivalent) to run RONOR v0.5.0.
#
# It installs Docker Engine + Compose v2, Tailscale, a UFW firewall posture,
# fail2ban and unattended security upgrades; creates a non-root `ronor` service
# account; and hardens sshd.
#
# Usage (as root, on the SERVER — not on a workstation):
#
#   curl -fsSL <raw-url>/deploy/setup-server.sh -o setup-server.sh
#   chmod +x setup-server.sh
#   sudo ./setup-server.sh --tailscale-authkey tskey-auth-XXXX --public-edge
#
# Flags
#   --tailscale-authkey KEY   Join the tailnet non-interactively. An AUTH key
#                             (tskey-auth-...), not an API key (tskey-api-...);
#                             they are different credentials and `tailscale up`
#                             rejects the latter.
#   --tailscale-ssh           Enable Tailscale SSH (recommended; lets you close
#                             public port 22 entirely).
#   --public-edge             Open 80/443 for the nginx TLS edge. WITHOUT this
#                             flag the host has NO public listener and is
#                             reachable only over the tailnet — the sovereign
#                             default.
#   --ssh-port N              Keep public SSH on port N (default 22).
#   --no-ssh                  Close public SSH entirely. Only safe together with
#                             --tailscale-ssh, and the script enforces that.
#   --swap-gb N               Create an N GB swapfile (default 2). A 2 GB droplet
#                             running a TypeScript build plus Qdrant will
#                             OOM-kill without it, and the first symptom is a
#                             container that vanishes mid-deploy.
#   --skip-docker             Host already has Docker.
#
# Idempotent: safe to re-run. Every step checks its own precondition rather than
# assuming a clean host.
#
# Prepared by AMB · Mayleven Ecosystem
# ============================================================================

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------
readonly C_RESET=$'\033[0m'
readonly C_BOLD=$'\033[1m'
readonly C_RED=$'\033[31m'
readonly C_GREEN=$'\033[32m'
readonly C_YELLOW=$'\033[33m'
readonly C_BLUE=$'\033[34m'

log()   { printf '%s→%s %s\n'  "$C_BLUE"   "$C_RESET" "$*"; }
ok()    { printf '%s✓%s %s\n'  "$C_GREEN"  "$C_RESET" "$*"; }
warn()  { printf '%s!%s %s\n'  "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { printf '%s✗%s %s\n'  "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }
head1() { printf '\n%s%s%s\n%s\n' "$C_BOLD" "$*" "$C_RESET" \
          "────────────────────────────────────────────────────────────"; }

# Report the line that failed rather than dying silently under `set -e`.
trap 'fail "aborted at line $LINENO: ${BASH_COMMAND}"' ERR

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
TS_AUTHKEY=""
TS_SSH=false
PUBLIC_EDGE=false
SSH_PORT=22
NO_SSH=false
SWAP_GB=2
SKIP_DOCKER=false
SERVICE_USER="ronor"
APP_DIR="/opt/ronor"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tailscale-authkey) TS_AUTHKEY="${2:-}"; shift 2 ;;
    --tailscale-ssh)     TS_SSH=true; shift ;;
    --public-edge)       PUBLIC_EDGE=true; shift ;;
    --ssh-port)          SSH_PORT="${2:-22}"; shift 2 ;;
    --no-ssh)            NO_SSH=true; shift ;;
    --swap-gb)           SWAP_GB="${2:-2}"; shift 2 ;;
    --skip-docker)       SKIP_DOCKER=true; shift ;;
    --app-dir)           APP_DIR="${2:-/opt/ronor}"; shift 2 ;;
    -h|--help)           sed -n '2,45p' "$0"; exit 0 ;;
    *)                   fail "unknown flag: $1 (use --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "run as root: sudo $0 ..."

# A closed public SSH port on a host with no alternative path in is a host you
# have locked yourself out of. Refuse the combination rather than discover it.
if $NO_SSH && ! $TS_SSH; then
  fail "--no-ssh without --tailscale-ssh would leave no way to reach this host. Refusing."
fi
if $NO_SSH && [[ -z "$TS_AUTHKEY" ]]; then
  fail "--no-ssh requires --tailscale-authkey, otherwise the tailnet path does not exist yet. Refusing."
fi

head1 "RONOR — sovereign host preparation"
log "host      : $(hostname)"
log "os        : $(. /etc/os-release && echo "$PRETTY_NAME")"
log "arch      : $(uname -m)"
log "public ssh: $($NO_SSH && echo 'CLOSED' || echo "port $SSH_PORT")"
log "public web: $($PUBLIC_EDGE && echo '80/443 OPEN' || echo 'CLOSED (tailnet-only)')"
log "app dir   : $APP_DIR"

# Ubuntu 22.04 is the stated target. Other releases are allowed but flagged: the
# Docker apt repository line is derived from the codename, and a silent mismatch
# produces a repository that resolves to nothing.
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  warn "this host reports ID=${ID:-unknown}; the script targets Ubuntu 22.04. Continuing."
elif [[ "${VERSION_ID:-}" != "22.04" ]]; then
  warn "Ubuntu ${VERSION_ID:-?} detected, not 22.04. Continuing — packages are resolved by codename."
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1 · Base packages
# ---------------------------------------------------------------------------
head1 "1 · Base packages"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release git jq ufw fail2ban \
  unattended-upgrades apt-listchanges htop rsync openssl \
  python3-pip unzip tzdata
ok "base packages installed"

timedatectl set-timezone UTC || warn "could not set timezone to UTC"
ok "timezone: $(timedatectl show -p Timezone --value)"

# ---------------------------------------------------------------------------
# 2 · Swap
# ---------------------------------------------------------------------------
head1 "2 · Swap"
if [[ "$SWAP_GB" -gt 0 ]]; then
  if swapon --show | grep -q '/swapfile'; then
    ok "swapfile already active ($(swapon --show=SIZE --noheadings | head -1 | tr -d ' '))"
  else
    log "creating ${SWAP_GB}G swapfile"
    fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB*1024)) status=none
    chmod 600 /swapfile
    mkswap -q /swapfile
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # Low swappiness: swap is here to survive a build spike, not to be used
    # routinely. A droplet that swaps under normal load has latency nobody can
    # explain from the application logs.
    sysctl -qw vm.swappiness=10
    grep -q 'vm.swappiness' /etc/sysctl.d/99-ronor.conf 2>/dev/null || \
      echo 'vm.swappiness=10' >> /etc/sysctl.d/99-ronor.conf
    ok "${SWAP_GB}G swap active, vm.swappiness=10"
  fi
else
  warn "swap disabled by flag — a 2 GB host may OOM during the image build"
fi

# ---------------------------------------------------------------------------
# 3 · Kernel + limits
# ---------------------------------------------------------------------------
head1 "3 · Kernel tuning"
cat > /etc/sysctl.d/99-ronor.conf <<'SYSCTL'
# RONOR host tuning — prepared by AMB
vm.swappiness = 10
vm.overcommit_memory = 1
# Qdrant memory-maps its segments; the default map count is reached by a corpus
# far smaller than anyone expects, and the failure reads as a generic I/O error.
vm.max_map_count = 262144
net.core.somaxconn = 1024
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.ip_forward = 1
SYSCTL
sysctl -q --system
ok "sysctl applied (vm.max_map_count=262144 for Qdrant, ip_forward on for Tailscale)"

cat > /etc/security/limits.d/99-ronor.conf <<'LIMITS'
*  soft  nofile  65535
*  hard  nofile  65535
LIMITS
ok "file descriptor limit raised to 65535"

# ---------------------------------------------------------------------------
# 4 · Docker Engine + Compose v2
# ---------------------------------------------------------------------------
head1 "4 · Docker Engine + Compose v2"
if $SKIP_DOCKER; then
  warn "skipping Docker install by flag"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker present: $(docker --version | cut -d, -f1), $(docker compose version --short)"
else
  # Docker's own repository, not Ubuntu's docker.io. The distribution package
  # lags and does not ship the compose v2 plugin, and `docker-compose` v1 is
  # end-of-life — a deployment written against v2 syntax will not run on it.
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  ok "docker installed: $(docker --version | cut -d, -f1), compose $(docker compose version --short)"
fi

# Bounded logs at the daemon level too, so any container started outside compose
# inherits the limit.
if [[ ! -f /etc/docker/daemon.json ]]; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'DAEMON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true,
  "default-address-pools": [ { "base": "172.30.0.0/16", "size": 24 } ]
}
DAEMON
  systemctl restart docker
  ok "docker daemon: bounded logs, live-restore on"
else
  warn "/etc/docker/daemon.json exists — left untouched"
fi

# ---------------------------------------------------------------------------
# 5 · Service account
# ---------------------------------------------------------------------------
head1 "5 · Service account"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user '$SERVICE_USER' exists"
else
  useradd --create-home --shell /bin/bash "$SERVICE_USER"
  ok "user '$SERVICE_USER' created"
fi
usermod -aG docker "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$APP_DIR/backups"
ok "docker group + $APP_DIR (0750, owned by $SERVICE_USER)"

# Membership of the docker group is root-equivalent. Say so out loud rather than
# leaving it as folklore.
warn "note: membership of the 'docker' group is equivalent to root on this host"

# ---------------------------------------------------------------------------
# 6 · Tailscale
# ---------------------------------------------------------------------------
head1 "6 · Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  ok "tailscale present: $(tailscale version | head -1)"
else
  curl -fsSL https://tailscale.com/install.sh | sh
  ok "tailscale installed: $(tailscale version | head -1)"
fi
systemctl enable --now tailscaled

if [[ -n "$TS_AUTHKEY" ]]; then
  if [[ "$TS_AUTHKEY" == tskey-api-* ]]; then
    fail "that is an API key (tskey-api-...). 'tailscale up' needs an AUTH key (tskey-auth-...). Mint one under Settings → Keys → Auth keys."
  fi
  up_args=(--authkey "$TS_AUTHKEY" --hostname "${TAILSCALE_HOSTNAME:-ronor-runtime}" --accept-routes)
  $TS_SSH && up_args+=(--ssh)
  log "joining tailnet as ${TAILSCALE_HOSTNAME:-ronor-runtime}"
  tailscale up "${up_args[@]}"
  sleep 3
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [[ -n "$TS_IP" ]]; then
    ok "tailnet joined — this host is $TS_IP"
  else
    warn "tailscale up returned but no IPv4 address yet; check 'tailscale status'"
  fi
  # Reachability of the declared peer is REPORTED, never assumed. A setup script
  # that prints success for an unreachable peer teaches the operator to distrust
  # every other line it printed.
  PEER_IP="${TAILSCALE_PEER_IP:-100.108.229.28}"
  PEER_HOST="${TAILSCALE_PEER_HOSTNAME:-desktop-eapcqug}"
  log "probing declared peer $PEER_HOST ($PEER_IP)"
  if tailscale ping --c 2 --timeout 5s "$PEER_IP" >/dev/null 2>&1; then
    ok "peer $PEER_HOST reachable over the tailnet"
  else
    warn "peer $PEER_HOST ($PEER_IP) did NOT answer. It may be offline, or ACLs may forbid this host. RONOR will start regardless; the peer path is optional."
  fi
else
  warn "no --tailscale-authkey given: tailscaled is installed and enabled but this host has NOT joined a tailnet. Run: tailscale up --ssh"
fi

# ---------------------------------------------------------------------------
# 7 · Firewall
# ---------------------------------------------------------------------------
head1 "7 · Firewall (UFW)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null

# Tailscale interface trusted wholesale. The tailnet is authenticated at the
# WireGuard layer by device key; per-port rules on top of it duplicate the
# tailnet ACLs in a second place that will drift out of agreement with the first.
ufw allow in on tailscale0 comment 'tailnet (device-authenticated)' >/dev/null
ufw allow 41641/udp comment 'tailscale direct (avoids DERP relay)' >/dev/null

if $NO_SSH; then
  warn "public SSH will be CLOSED — reach this host with: tailscale ssh ${SERVICE_USER}@${TAILSCALE_HOSTNAME:-ronor-runtime}"
else
  ufw allow "${SSH_PORT}/tcp" comment 'ssh' >/dev/null
  # Rate-limited SSH: brute-force attempts are throttled by the firewall before
  # fail2ban ever parses a log line.
  ufw limit "${SSH_PORT}/tcp" >/dev/null 2>&1 || true
  ok "public SSH allowed on ${SSH_PORT}/tcp (rate-limited)"
fi

if $PUBLIC_EDGE; then
  ufw allow 80/tcp  comment 'http — ACME challenge + redirect' >/dev/null
  ufw allow 443/tcp comment 'https — nginx TLS edge' >/dev/null
  ok "public 80/443 open for the nginx edge"
else
  ok "no public web listener — RONOR is reachable only over the tailnet"
fi

# 3000, 6333, 6334 and 6379 are NEVER opened. Every one of those services binds
# to 127.0.0.1 in docker-compose.production.yml. Docker publishes container ports
# by writing DOCKER-USER iptables rules that BYPASS the UFW INPUT chain, so a
# service published as "0.0.0.0:6333" is reachable from the internet even with
# ufw showing `deny incoming`. Loopback binding is what actually prevents it;
# the firewall is the second line, not the first.
ufw --force enable >/dev/null
ok "ufw active"
ufw status verbose | sed 's/^/    /'

# ---------------------------------------------------------------------------
# 8 · fail2ban
# ---------------------------------------------------------------------------
head1 "8 · fail2ban"
cat > /etc/fail2ban/jail.d/ronor.local <<JAIL
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
# Never ban the tailnet: locking out the private administrative path during an
# incident is how a small outage becomes an unreachable host.
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10

[sshd]
enabled = true
port    = ${SSH_PORT}
JAIL
systemctl enable --now fail2ban
systemctl restart fail2ban
ok "fail2ban active (sshd jail; tailnet 100.64.0.0/10 exempt)"

# ---------------------------------------------------------------------------
# 9 · Unattended security upgrades
# ---------------------------------------------------------------------------
head1 "9 · Unattended upgrades"
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'UU'
Unattended-Upgrade::Allowed-Origins {
        "${distro_id}:${distro_codename}-security";
        "${distro_id}ESMApps:${distro_codename}-apps-security";
        "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
// Reboots are NOT automatic. An unannounced 02:00 reboot is an unannounced
// outage, and the containers restart policy cannot cover a kernel replacement
// that also needs a compose bring-up check. Patch automatically, reboot
// deliberately.
Unattended-Upgrade::Automatic-Reboot "false";
UU
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AU'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AU
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "security patches automatic; reboots remain manual (check /var/run/reboot-required)"

# ---------------------------------------------------------------------------
# 10 · sshd hardening
# ---------------------------------------------------------------------------
head1 "10 · sshd hardening"
# Password authentication is disabled ONLY when an authorised key already exists.
# Disabling it on a host reached by password is a lockout, and doing so silently
# is a lockout with no warning.
HAS_KEY=false
for f in /root/.ssh/authorized_keys "/home/${SERVICE_USER}/.ssh/authorized_keys"; do
  [[ -s "$f" ]] && HAS_KEY=true
done

if $HAS_KEY || $TS_SSH; then
  cat > /etc/ssh/sshd_config.d/99-ronor.conf <<SSHD
Port ${SSH_PORT}
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
AllowTcpForwarding no
SSHD
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    ok "sshd hardened: key-only auth, root password login disabled"
  else
    rm -f /etc/ssh/sshd_config.d/99-ronor.conf
    warn "sshd config test FAILED — hardening reverted, sshd untouched"
  fi
else
  warn "no authorised SSH key found and Tailscale SSH not enabled — password auth LEFT ON to avoid locking you out. Install a key, then re-run this script."
fi

# ---------------------------------------------------------------------------
# 11 · Log rotation for the app directory
# ---------------------------------------------------------------------------
cat > /etc/logrotate.d/ronor <<ROT
${APP_DIR}/logs/*.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
ROT
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$APP_DIR/logs"
ok "logrotate configured for ${APP_DIR}/logs"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
head1 "Host prepared"
printf '  docker      : %s\n' "$(command -v docker >/dev/null && docker --version | cut -d, -f1 || echo 'ABSENT')"
printf '  compose     : %s\n' "$(docker compose version --short 2>/dev/null || echo 'ABSENT')"
printf '  tailscale   : %s\n' "$(tailscale ip -4 2>/dev/null | head -1 || echo 'not joined')"
printf '  firewall    : %s\n' "$(ufw status | head -1)"
printf '  service user: %s (docker group)\n' "$SERVICE_USER"
printf '  app dir     : %s\n' "$APP_DIR"
printf '  reboot req. : %s\n' "$([[ -f /var/run/reboot-required ]] && echo YES || echo no)"

cat <<NEXT

Next steps
──────────
  1.  sudo -iu ${SERVICE_USER}
  2.  git clone https://github.com/Constantin1968/RONOR-.git ${APP_DIR}/app
      cd ${APP_DIR}/app && git checkout feature/sovereign-deployment
  3.  cp .env.production.template .env.production
      # fill every [REQUIRED] value, then:
      chmod 600 .env.production
  4.  ./deploy/deploy.sh --first-run

  Nothing above has started RONOR. This script prepared the host only.

Prepared by AMB · Mayleven Ecosystem
NEXT
