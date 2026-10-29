import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GUEST_WORKSPACE = "/workspace";

export type Workspace = {
  /** host directory mounted at GUEST_WORKSPACE */
  hostRoot: string;
  /** host directory pi was started in (always inside hostRoot) */
  hostCwd: string;
  /** guest path corresponding to hostCwd */
  guestCwd: string;
};

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * Mount `configuredRoot` when `cwd` is inside it, otherwise mount `cwd` itself.
 * Either way the guest starts in the directory matching `cwd`.
 */
export function resolveWorkspace(cwd: string, configuredRoot?: string): Workspace {
  const hostCwd = fs.realpathSync(cwd);
  let hostRoot = hostCwd;
  if (configuredRoot) {
    const candidate = fs.realpathSync(path.resolve(expandHome(configuredRoot)));
    if (isInsideHostPath(candidate, hostCwd)) hostRoot = candidate;
  }
  return { hostRoot, hostCwd, guestCwd: hostPathToGuest(hostRoot, hostCwd) };
}

export function hostPathToGuest(hostRoot: string, hostPath: string): string {
  if (!isInsideHostPath(hostRoot, hostPath)) return toPosix(hostPath);
  const relativePath = path.relative(hostRoot, hostPath);
  return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}
