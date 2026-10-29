/**
 * pi-box: run pi's built-in tools inside a local Gondolin micro-VM.
 *
 * The workspace root is mounted at /workspace in the guest. It is
 * $PI_BOX_WORKSPACE when the current directory is inside it, otherwise the
 * current directory. The agent always starts in the guest directory matching
 * the host's current directory. File changes under /workspace write through to
 * the host; other guest filesystem changes are isolated to the VM.
 *
 * See README.md for configuration (custom images, secrets, egress allowlist).
 */

import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  type EditOperations,
  type FindOperations,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  truncateHead,
  truncateLine,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { createBoxVm } from "./vm.ts";
import {
  GUEST_WORKSPACE,
  hostPathToGuest,
  isInsideHostPath,
  resolveWorkspace,
  toPosix,
  type Workspace,
} from "./workspace.ts";

const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toGuestPath(workspace: Workspace, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return workspace.guestCwd;
  if (path.isAbsolute(trimmed)) {
    // process.cwd() may differ from the realpath'd hostCwd (e.g. /tmp vs /private/tmp on macOS)
    const cwd = process.cwd();
    if (cwd !== workspace.hostCwd && isInsideHostPath(cwd, trimmed)) {
      return path.posix.join(workspace.guestCwd, toPosix(path.relative(cwd, trimmed)));
    }
    if (isInsideHostPath(workspace.hostRoot, trimmed)) return hostPathToGuest(workspace.hostRoot, trimmed);
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(workspace.guestCwd, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, workspace: Workspace): ReadOperations {
  return {
    readFile: async (filePath) => vm.fs.readFile(toGuestPath(workspace, filePath)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(workspace, filePath));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix.extname(toGuestPath(workspace, filePath)).toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

function createGondolinWriteOps(vm: VM, workspace: Workspace): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(toGuestPath(workspace, filePath), content, { encoding: "utf8" });
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(toGuestPath(workspace, dirPath), { recursive: true });
    },
  };
}

function createGondolinEditOps(vm: VM, workspace: Workspace): EditOperations {
  const readOps = createGondolinReadOps(vm, workspace);
  const writeOps = createGondolinWriteOps(vm, workspace);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

function createGondolinLsOps(vm: VM, workspace: Workspace): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(workspace, filePath));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => vm.fs.stat(toGuestPath(workspace, filePath)),
    readdir: async (dirPath) => vm.fs.listDir(toGuestPath(workspace, dirPath)),
  };
}

async function walkGuestFiles(
  vm: VM,
  root: string,
  visit: (guestPath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const stat = await vm.fs.stat(root, { signal });
  if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

  const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const entries = await vm.fs.listDir(dir, { signal });
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
      let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
      try {
        entryStat = await vm.fs.stat(guestPath, { signal });
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!(await walkDirectory(guestPath, relativePath))) return false;
      } else if (!(await visit(guestPath, relativePath))) {
        return false;
      }
    }
    return true;
  };

  return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosix(pattern);
  if (normalizedPattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalizedPattern) ||
      path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, workspace: Workspace): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(workspace, filePath));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = toGuestPath(workspace, cwd);
      const results: string[] = [];
      await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
        if (results.length >= options.limit) return false;
        if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
        return results.length < options.limit;
      });
      return results;
    },
  };
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
  outputLines: string[];
  lines: string[];
  relativePath: string;
  lineIndex: number;
  contextLines: number;
}): boolean {
  let linesTruncated = false;
  const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
  const end =
    params.contextLines > 0
      ? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
      : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
  }
  return linesTruncated;
}

async function executeGondolinGrep(
  vm: VM,
  workspace: Workspace,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
  const root = toGuestPath(workspace, params.path ?? ".");
  const rootStat = await vm.fs.stat(root, { signal });
  const rootIsDirectory = rootStat.isDirectory();
  const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
  const contextLines = params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
  const outputLines: string[] = [];
  const details: GrepToolDetails = {};
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  await walkGuestFiles(
    vm,
    root,
    async (guestPath, relativePath) => {
      if (matchCount >= effectiveLimit) return false;
      if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
      let content: string;
      try {
        content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
      } catch {
        return true;
      }
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
      for (let index = 0; index < lines.length; index++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
          linesTruncated = true;
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    },
    signal,
  );

  if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const notices: string[] = [];
  let output = truncation.content;

  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

/**
 * pi hands bash the full host environment (API keys, tokens, host PATH/HOME).
 * Only forward pi's session variables; everything else comes from the guest,
 * including secret placeholders set at VM creation.
 */
const FORWARDED_ENV = new Set(["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]);

function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (FORWARDED_ENV.has(key) && typeof value === "string") result[key] = value;
  }
  return result;
}

function createGondolinBashOps(vm: VM, workspace: Workspace, shellPath: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = toGuestPath(workspace, cwd);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec([shellPath, "-lc", command], {
          cwd: guestCwd,
          env: sanitizeEnv(env),
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of proc.output()) onData(chunk.data);
        const result = await proc;
        return { exitCode: result.exitCode };
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localLs = createLsTool(localCwd);

  const config = loadConfig();
  const workspace = resolveWorkspace(localCwd, config.workspace);

  let vm: VM | undefined;
  let vmStarting: Promise<VM> | undefined;
  let shellPath = "/bin/sh";

  async function startVm(ctx?: ExtensionContext): Promise<VM> {
    ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${GUEST_WORKSPACE}`));
    const { vm: created, missingSecrets } = await createBoxVm(
      config,
      workspace,
      `pi ${path.basename(workspace.hostCwd)}`,
    );
    const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
    shellPath = bashProbe.stdout.trim() || "/bin/sh";
    vm = created;
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("accent", `Gondolin: ${created.id.slice(0, 8)} (${workspace.guestCwd})`),
    );
    ctx?.ui.notify(`Gondolin VM ready. ${workspace.hostRoot} is mounted at ${GUEST_WORKSPACE}.`, "info");
    if (missingSecrets.length > 0) {
      ctx?.ui.notify(`Gondolin: secrets not injected (host env var unset): ${missingSecrets.join(", ")}`, "warning");
    }
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    if (!vmStarting) {
      vmStarting = startVm(ctx).finally(() => {
        vmStarting = undefined;
      });
    }
    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const activeVm = vm;
    vm = undefined;
    vmStarting = undefined;
    if (!activeVm) return;
    ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
    try {
      await activeVm.close();
    } finally {
      ctx.ui.setStatus("gondolin", undefined);
    }
  });

  pi.registerCommand("gondolin", {
    description: "Show Gondolin VM status",
    handler: async (_args, ctx) => {
      const activeVm = await ensureVm(ctx);
      ctx.ui.notify(
        [
          `Gondolin VM: ${activeVm.id}`,
          `Host workspace: ${workspace.hostRoot}`,
          `Guest workspace: ${GUEST_WORKSPACE}`,
          `Guest cwd: ${workspace.guestCwd}`,
          ...Object.entries(config.mounts ?? {}).map(
            ([guestPath, mount]) => `Mount: ${typeof mount === "string" ? mount : mount.host} -> ${guestPath}`,
          ),
          `Image: ${config.image ?? "default"}`,
          `Shell: ${shellPath}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(workspace.guestCwd, {
        operations: createGondolinReadOps(activeVm, workspace),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(workspace.guestCwd, {
        operations: createGondolinWriteOps(activeVm, workspace),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(workspace.guestCwd, {
        operations: createGondolinEditOps(activeVm, workspace),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(workspace.guestCwd, {
        operations: createGondolinBashOps(activeVm, workspace, shellPath),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createLsTool(workspace.guestCwd, {
        operations: createGondolinLsOps(activeVm, workspace),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createFindTool(workspace.guestCwd, {
        operations: createGondolinFindOps(activeVm, workspace),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return executeGondolinGrep(activeVm, workspace, params, signal);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await ensureVm(ctx);
    return { operations: createGondolinBashOps(activeVm, workspace, shellPath) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const localLine = `Current working directory: ${localCwd}`;
    const guestLine = `Current working directory: ${workspace.guestCwd} (Gondolin VM; host ${workspace.hostRoot} is mounted at ${GUEST_WORKSPACE})`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });
}
