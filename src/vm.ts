import fs from "node:fs";
import path from "node:path";
import { createHttpHooks, ReadonlyProvider, RealFSProvider, type VirtualProvider, VM } from "@earendil-works/gondolin";
import { type BoxConfig, resolveSecrets } from "./config.ts";
import { expandHome, GUEST_WORKSPACE, type Workspace } from "./workspace.ts";

export type BoxVm = {
  vm: VM;
  /** configured secrets whose host env var was unset (not injected) */
  missingSecrets: string[];
};

/** Workspace at GUEST_WORKSPACE plus any configured extra mounts (host dirs are created if missing). */
function buildMounts(config: BoxConfig, workspace: Workspace): Record<string, VirtualProvider> {
  const mounts: Record<string, VirtualProvider> = {
    [GUEST_WORKSPACE]: new RealFSProvider(workspace.hostRoot),
  };
  for (const [guestPath, mount] of Object.entries(config.mounts ?? {})) {
    const { host, readonly = false } = typeof mount === "string" ? { host: mount } : mount;
    const normalized = path.posix.normalize(guestPath);
    if (normalized === GUEST_WORKSPACE || normalized.startsWith(`${GUEST_WORKSPACE}/`)) {
      throw new Error(`pi-box mount "${guestPath}" overlaps ${GUEST_WORKSPACE}`);
    }
    const hostPath = path.resolve(expandHome(host));
    fs.mkdirSync(hostPath, { recursive: true });
    const provider = new RealFSProvider(hostPath);
    mounts[normalized] = readonly ? new ReadonlyProvider(provider) : provider;
  }
  return mounts;
}

const PROFILE_SCRIPT = "/etc/profile.d/zz-pi-box.sh";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const HOSTNAME = "pi-box";

/** The guest boots without a hostname, so prompts (Alpine's default `\h`) show "(none)". */
async function setHostname(vm: VM): Promise<void> {
  await vm.fs.writeFile("/etc/hostname", `${HOSTNAME}\n`, { encoding: "utf8" });
  const result = await vm.exec(["hostname", HOSTNAME]);
  if (result.exitCode !== 0) throw new Error(`pi-box: failed to set guest hostname (exit ${result.exitCode})`);
}

/** Login shells (pi's bash tool, pi-box shell) source /etc/profile.d after /etc/profile resets PATH. */
async function writeProfile(vm: VM, config: BoxConfig): Promise<void> {
  if (!config.path?.length) return;
  const line = `export PATH=${config.path.map(shellQuote).join(":")}:"$PATH"`;
  await vm.fs.writeFile(PROFILE_SCRIPT, `${line}\n`, { encoding: "utf8" });
}

/**
 * Boot a Gondolin VM with the workspace mounted and secrets wired into the
 * HTTP proxy. The guest only sees placeholder values in its environment; the
 * host swaps them for the real values on requests to each secret's hosts.
 */
export async function createBoxVm(config: BoxConfig, workspace: Workspace, sessionLabel: string): Promise<BoxVm> {
  const { secrets, missing } = resolveSecrets(config);
  const { httpHooks, env } = createHttpHooks({
    ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}),
    secrets,
  });
  const vm = await VM.create({
    sessionLabel,
    httpHooks,
    env: { ...config.env, ...env },
    ...(config.memory ? { memory: config.memory } : {}),
    ...(config.cpus ? { cpus: config.cpus } : {}),
    ...(config.diskSize ? { rootfs: { size: config.diskSize } } : {}),
    ...(config.image || config.vmm
      ? {
          sandbox: {
            ...(config.image ? { imagePath: expandHome(config.image) } : {}),
            ...(config.vmm ? { vmm: config.vmm } : {}),
          },
        }
      : {}),
    // Gondolin requires per-host synthetic DNS to route mapped TCP connections.
    ...(config.tcpHosts && Object.keys(config.tcpHosts).length > 0
      ? { tcp: { hosts: config.tcpHosts }, dns: { mode: "synthetic", syntheticHostMapping: "per-host" } }
      : {}),
    vfs: { mounts: buildMounts(config, workspace) },
  });
  await setHostname(vm);
  await writeProfile(vm, config);
  return { vm, missingSecrets: missing };
}
