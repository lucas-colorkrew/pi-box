/**
 * Open an interactive shell (or run a command) in a pi-box VM using the same
 * workspace, image, egress and secret configuration as the pi extension.
 *
 * Usage (from any directory):
 *   pi-box shell                 # interactive bash in the guest cwd
 *   pi-box shell -- git status   # run a single command
 */

import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createBoxVm } from "../src/vm.ts";
import { GUEST_WORKSPACE, resolveWorkspace } from "../src/workspace.ts";

const separator = process.argv.indexOf("--");
const command = separator === -1 ? [] : process.argv.slice(separator + 1);

const config = loadConfig();
const workspace = resolveWorkspace(process.cwd(), config.workspace);
const { vm, missingSecrets } = await createBoxVm(config, workspace, `shell ${path.basename(workspace.hostCwd)}`);

console.error(`pi-box: ${workspace.hostRoot} mounted at ${GUEST_WORKSPACE}, cwd ${workspace.guestCwd}`);
if (missingSecrets.length > 0) {
  console.error(`pi-box: secrets not injected (host env var unset): ${missingSecrets.join(", ")}`);
}

// `exec "$@"` under a login shell so the command is looked up on the guest PATH
const argv = command.length > 0 ? ["/bin/sh", "-lc", 'exec "$@"', "sh", ...command] : undefined;
// sh -l sources /etc/profile.d (pi-box PATH) first, so fish (which skips it) inherits PATH and is found
// on it too; non-login bash only reads /etc/bash/bashrc, hence bash -l. An empty fish_greeting silences fish's welcome.
const loginShell = [
  "/bin/sh",
  "-lc",
  "command -v fish >/dev/null && exec env fish_greeting= fish -l; command -v bash >/dev/null && exec bash -l; exec sh -l",
];

let exitCode = 1;
try {
  if (process.stdin.isTTY) {
    // interactive: guest pty attached to this terminal
    const result = await vm.shell({ cwd: workspace.guestCwd, command: argv ?? loginShell });
    exitCode = result.exitCode;
  } else if (argv) {
    // piped/scripted: plain streams, no pty (vm.shell only attaches output in a tty)
    const result = await vm.exec(argv, {
      cwd: workspace.guestCwd,
      stdin: process.stdin,
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = result.exitCode;
  } else {
    console.error("pi-box: an interactive shell needs a TTY; pass a command after --");
  }
} finally {
  await vm.close();
}
process.exit(exitCode);
