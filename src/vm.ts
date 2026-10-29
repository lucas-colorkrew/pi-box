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

/** cyan "pi-box", blue cwd; the guest has no hostname, so Alpine's default `\h` shows "(none)" */
const DEFAULT_PROMPT = "\\[\\e[1;36m\\]pi-box\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ ";

/** Login shells (pi's bash tool, pi-box-shell) source /etc/profile.d after /etc/profile resets PATH and PS1. */
async function writeProfile(vm: VM, config: BoxConfig): Promise<void> {
  const lines = [`PS1=${shellQuote(config.prompt ?? DEFAULT_PROMPT)}`];
  if (config.path?.length) lines.push(`export PATH=${config.path.map(shellQuote).join(":")}:"$PATH"`);
  await vm.fs.writeFile(PROFILE_SCRIPT, `${lines.join("\n")}\n`, { encoding: "utf8" });
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
    ...(config.image ? { sandbox: { imagePath: expandHome(config.image) } } : {}),
    // Gondolin requires per-host synthetic DNS to route mapped TCP connections.
    ...(config.tcpHosts && Object.keys(config.tcpHosts).length > 0
      ? { tcp: { hosts: config.tcpHosts }, dns: { mode: "synthetic", syntheticHostMapping: "per-host" } }
      : {}),
    vfs: { mounts: buildMounts(config, workspace) },
  });
  await writeProfile(vm, config);
  return { vm, missingSecrets: missing };
}
