import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./workspace.ts";

/**
 * pi-box configuration.
 *
 * Read from $PI_BOX_CONFIG, or ~/.config/pi-box/config.json if it exists.
 * PI_BOX_WORKSPACE and PI_BOX_IMAGE override the matching file settings.
 * Secret values are never stored in the file: each secret names the host
 * environment variable its value is read from.
 */
export type SecretConfig = {
  /** host patterns the secret may be sent to (e.g. "api.github.com", "*.example.com") */
  hosts: string[];
  /** host env var holding the real value (default: the secret's name) */
  env?: string;
};

export type MountConfig = {
  /** host directory; created if missing */
  host: string;
  /** mount read-only in the guest */
  readonly?: boolean;
};

export type VmmBackend = "qemu" | "krun";

export type BoxConfig = {
  /** directory to mount when the current directory is inside it */
  workspace?: string;
  /** gondolin image selector (name:tag, build id) or asset directory */
  image?: string;
  /** vm backend (default: $GONDOLIN_VMM, else "qemu"); krun needs an image built with krun assets */
  vmm?: VmmBackend;
  /** vm memory, qemu syntax (e.g. "2G") */
  memory?: string;
  /** minimum guest root disk size, e.g. "4G" (the default image has ~90MB free) */
  diskSize?: string;
  /** vm cpu count */
  cpus?: number;
  /** HTTP egress allowlist; omitted allows all hosts */
  allowedHosts?: string[];
  /** guest host[:port] -> host-side host:port TCP mappings (e.g. to reach a server on the host) */
  tcpHosts?: Record<string, string>;
  /** extra persistent mounts, keyed by absolute guest path; a string value is the host directory */
  mounts?: Record<string, string | MountConfig>;
  /** guest directories prepended to PATH in login shells (PATH in `env` is reset by /etc/profile) */
  path?: string[];
  /** extra non-secret guest environment variables */
  env?: Record<string, string>;
  /** secrets injected into outbound HTTP requests, keyed by guest env var name */
  secrets?: Record<string, SecretConfig>;
};

export type ResolvedSecret = { hosts: string[]; value: string };

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "pi-box", "config.json");

export function configPath(): string {
  return expandHome(process.env.PI_BOX_CONFIG || DEFAULT_CONFIG_PATH);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateConfig(raw: unknown, source: string): BoxConfig {
  const fail = (message: string): never => {
    throw new Error(`Invalid pi-box config (${source}): ${message}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("expected a JSON object");
  const config = raw as Record<string, unknown>;

  for (const key of ["workspace", "image", "memory", "diskSize"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") fail(`"${key}" must be a string`);
  }
  if (config.vmm !== undefined && config.vmm !== "qemu" && config.vmm !== "krun")
    fail(`"vmm" must be "qemu" or "krun"`);
  if (config.cpus !== undefined && typeof config.cpus !== "number") fail(`"cpus" must be a number`);
  if (config.allowedHosts !== undefined && !isStringArray(config.allowedHosts)) {
    fail(`"allowedHosts" must be an array of strings`);
  }
  if (config.path !== undefined && !isStringArray(config.path)) fail(`"path" must be an array of strings`);
  if (config.mounts !== undefined) {
    if (typeof config.mounts !== "object" || config.mounts === null) fail(`"mounts" must be an object`);
    for (const [guestPath, mount] of Object.entries(config.mounts as Record<string, unknown>)) {
      if (!guestPath.startsWith("/")) fail(`mount "${guestPath}" must be an absolute guest path`);
      const entry = typeof mount === "string" ? { host: mount } : (mount as Partial<MountConfig> | null);
      if (!entry || typeof entry.host !== "string" || entry.host === "") {
        fail(`mount "${guestPath}" needs a "host" path`);
      }
      if (entry?.readonly !== undefined && typeof entry.readonly !== "boolean") {
        fail(`mount "${guestPath}": "readonly" must be a boolean`);
      }
    }
  }
  if (config.env !== undefined) {
    if (typeof config.env !== "object" || config.env === null) fail(`"env" must be an object`);
    for (const [name, value] of Object.entries(config.env as Record<string, unknown>)) {
      if (typeof value !== "string") fail(`env "${name}" must be a string`);
    }
  }
  if (config.tcpHosts !== undefined) {
    if (typeof config.tcpHosts !== "object" || config.tcpHosts === null) fail(`"tcpHosts" must be an object`);
    for (const [guestHost, target] of Object.entries(config.tcpHosts as Record<string, unknown>)) {
      if (typeof target !== "string") fail(`tcpHosts "${guestHost}" must be a "host:port" string`);
    }
  }
  if (config.secrets !== undefined) {
    if (typeof config.secrets !== "object" || config.secrets === null) fail(`"secrets" must be an object`);
    for (const [name, secret] of Object.entries(config.secrets as Record<string, unknown>)) {
      const entry = secret as Partial<SecretConfig> | null;
      if (!entry || !isStringArray(entry.hosts) || entry.hosts.length === 0) {
        fail(`secret "${name}" needs a non-empty "hosts" array`);
      }
      if (entry?.env !== undefined && typeof entry.env !== "string") fail(`secret "${name}": "env" must be a string`);
    }
  }
  return config as BoxConfig;
}

export function loadConfig(): BoxConfig {
  const file = configPath();
  let config: BoxConfig = {};
  if (fs.existsSync(file)) {
    config = validateConfig(JSON.parse(fs.readFileSync(file, "utf8")), file);
  } else if (process.env.PI_BOX_CONFIG) {
    throw new Error(`PI_BOX_CONFIG points to a missing file: ${file}`);
  }
  return {
    ...config,
    workspace: process.env.PI_BOX_WORKSPACE || config.workspace,
    image: process.env.PI_BOX_IMAGE || config.image,
  };
}

/** Resolve secret values from the host environment; missing values are reported, not fatal. */
export function resolveSecrets(config: BoxConfig): { secrets: Record<string, ResolvedSecret>; missing: string[] } {
  const secrets: Record<string, ResolvedSecret> = {};
  const missing: string[] = [];
  for (const [name, secret] of Object.entries(config.secrets ?? {})) {
    const envName = secret.env ?? name;
    const value = process.env[envName];
    if (value) secrets[name] = { hosts: secret.hosts, value };
    else missing.push(`${name} (from $${envName})`);
  }
  return { secrets, missing };
}
