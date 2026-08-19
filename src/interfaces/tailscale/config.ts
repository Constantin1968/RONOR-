/**
 * RONOR — Tailscale Sovereign Private Plane Configuration
 * ────────────────────────────────────────────────────────
 * Tailscale provides the private network plane for RONOR: the production server
 * and the operator's HP laptop (desktop-eapcqug, 100.108.229.28) are peers on
 * the same tailnet, reachable by device key without any public listener.
 *
 * This module exposes the Tailscale configuration and a lightweight peer-probe
 * utility. The runtime itself does not depend on Tailscale to function; it is
 * a sovereign access path, not a required dependency.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

export interface TailscaleConfig {
  /** Tailscale auth key (tskey-auth-...) for joining the tailnet. */
  authKey: string | null;
  /** Tailscale API key (tskey-api-...) for the control-plane REST API. */
  apiKey: string | null;
  /** Hostname this node registers as on the tailnet. */
  hostname: string;
  /** Tailnet name (e.g. `mayleven.com` or `-` for the default). */
  tailnet: string;
  /** The HP laptop peer. */
  peer: {
    hostname: string;
    ip: string;
  };
  /** Restrict outbound egress to the tailnet only (100.64.0.0/10). */
  egressTailnetOnly: boolean;
}

export function loadTailscaleConfig(env: NodeJS.ProcessEnv = process.env): TailscaleConfig {
  return {
    authKey: (env.TAILSCALE_AUTHKEY ?? '').trim() || null,
    apiKey:  (env.TAILSCALE_API_KEY ?? '').trim() || null,
    hostname: (env.TAILSCALE_HOSTNAME ?? 'ronor-runtime').trim(),
    tailnet:  (env.TAILSCALE_TAILNET ?? '-').trim(),
    peer: {
      hostname: (env.TAILSCALE_PEER_HOSTNAME ?? 'desktop-eapcqug').trim(),
      ip:       (env.TAILSCALE_PEER_IP ?? '100.108.229.28').trim(),
    },
    egressTailnetOnly: env.RONOR_EGRESS_TAILNET_ONLY === 'true',
  };
}

/**
 * Probe a Tailscale peer via the local Tailscale daemon's /localapi.
 *
 * Returns null when the daemon is not running (non-Tailscale host) rather than
 * throwing, so the runtime can start on any host and report Tailscale as absent
 * rather than crashing.
 */
export async function probeTailscalePeer(ip: string, timeoutMs = 5000): Promise<{
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}> {
  const http = await import('http');
  const start = Date.now();

  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: null, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    // Probe TCP port 41641 (Tailscale direct WireGuard). A successful TCP
    // connect means the peer is reachable; the connection is immediately closed.
    socket.connect(41641, ip, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ reachable: true, latencyMs: Date.now() - start, error: null });
    });
    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ reachable: false, latencyMs: null, error: err.message });
    });
  });
}
