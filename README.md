# pi-box

Runs [pi](https://github.com/earendil-works/pi)'s built-in tools (read, write, edit, bash, ls, find, grep) inside a
local [Gondolin](https://earendil-works.github.io/gondolin/) micro-VM. It started from pi's official `gondolin` example
extension.

## Setup

Requirements: Node.js 26, [QEMU](https://www.qemu.org/download/), pi, bash. Gondolin uses `qemu-img` for every VM's
copy-on-write root disk, so QEMU is needed even with the krun backend.

Install dependencies, then symlink the launcher into a directory on your `PATH`:

```bash
npm install --ignore-scripts
ln -s "$PWD/bin/pi-box" ~/.local/bin/pi-box
```

## Workspace mounting

The host directory mounted at `/workspace` is:

- `$PI_BOX_WORKSPACE` (or `workspace` in the config file), when the current directory is inside it
- the current directory, otherwise

The agent always starts in the guest directory that matches your host cwd. For example, with
`PI_BOX_WORKSPACE=~/Development` and cwd `~/Development/foo/bar`, `~/Development` is mounted and the agent starts in
`/workspace/foo/bar`.

## Configuration

Optional JSON file at `~/.config/pi-box/config.json`, or wherever `$PI_BOX_CONFIG` points. See
[`config.example.json`](config.example.json).

| Key            | Env override       | Meaning                                                          |
| -------------- | ------------------ | ---------------------------------------------------------------- |
| `workspace`    | `PI_BOX_WORKSPACE` | Mount root (see above)                                           |
| `image`        | `PI_BOX_IMAGE`     | Gondolin image: `name:tag`, build id, or asset directory         |
| `vmm`          | `GONDOLIN_VMM`     | VM backend: `"qemu"` (default) or `"krun"`                       |
| `memory`       |                    | VM memory, e.g. `"2G"` (default `1G`)                            |
| `diskSize`     |                    | Minimum guest root disk, e.g. `"4G"` (default image: ~90MB free) |
| `cpus`         |                    | VM CPUs (default 2)                                              |
| `allowedHosts` |                    | HTTP(S) egress allowlist; leave it out to allow all hosts        |
| `tcpHosts`     |                    | Guest hostnames mapped to host-side TCP ports (see below)        |
| `mounts`       |                    | Extra persistent host directories (see below)                    |
| `path`         |                    | Guest directories prepended to `PATH`                            |
| `env`          |                    | Extra non-secret guest environment variables                     |
| `secrets`      |                    | Secrets injected into outbound HTTP requests (see below)         |

Don't set `PATH` in `env`: the guest's `/etc/profile` resets it in every login shell. Use `path` instead. pi-box writes
it to `/etc/profile.d/zz-pi-box.sh` at boot.

## Extra mounts

`mounts` maps absolute guest paths to host directories. pi-box creates a host directory if it doesn't exist. Files
written under a mount live on the host, so they persist across VMs and are shared with `pi-box shell`:

```json
{
  "mounts": {
    "/opt/mise": "~/.local/share/pi-box/mise",
    "/data/reference": { "host": "~/datasets", "readonly": true }
  }
}
```

Mounts may not overlap `/workspace`.

### Persistent mise tools

If your host's tool binaries won't run in the VM, you can give the VM its own mise directories:

```json
{
  "mounts": { "/opt/mise": "~/.local/share/pi-box/mise" },
  "env": {
    "MISE_DATA_DIR": "/opt/mise/data",
    "MISE_CACHE_DIR": "/opt/mise/cache",
    "MISE_CONFIG_DIR": "/opt/mise/config",
    "MISE_STATE_DIR": "/opt/mise/state",
    "MISE_ALL_COMPILE": "false"
  },
  "path": ["/opt/mise/bin", "/opt/mise/data/shims"]
}
```

Install mise into the mount once (if you use `allowedHosts`, it must include `mise.run`, `mise.jdx.dev`, `github.com`
and GitHub's asset hosts):

```bash
pi-box shell -- sh -c 'curl -fsSL https://mise.run | MISE_INSTALL_PATH=/opt/mise/bin/mise sh'
```

After that, tools that mise installs (from either pi or the shell) persist in `~/.local/share/pi-box/mise`.

Known limitations (verified with Gondolin 0.14.0):

- **`MISE_ALL_COMPILE=false` is needed on Alpine.** mise defaults `all_compile` to `true` on musl, which builds tools
  like Node from source; that's slow and runs out of space in the in-memory `/tmp`. With it set to `false`, mise
  installs prebuilt musl binaries.
- **`mise-versions.jdx.dev`** returned unparseable responses through Gondolin's proxy during testing. Use
  `MISE_USE_VERSIONS_HOST=false` (add it to `env`) to query GitHub directly.
- **`rm -rf` on mounts skips entries** in directories with more than ~16 files ("Directory not empty"). This is a
  Gondolin bug: `vfs/rpc-service.js` pages directory listings by index, and every deletion shifts the indices. It
  affects `/workspace` too (e.g. `rm -rf node_modules`). Each re-run of `rm -rf` removes more; repeat until it succeeds.

## Reaching host services

`tcpHosts` maps a guest `host:port` to a `host:port` that the host connects to. Use it to reach a server running on your
machine, such as a dev server or database:

```json
{
  "tcpHosts": {
    "host.internal:3000": "127.0.0.1:3000",
    "host.internal:5432": "127.0.0.1:5432"
  }
}
```

Inside the VM, `curl http://host.internal:3000` reaches the host's port 3000. Any TCP protocol works, not only HTTP.
`localhost` in the guest is the guest itself, so pick another name.

Mapped connections bypass the HTTP proxy, so `allowedHosts` doesn't restrict them and `secrets` aren't injected into
them. Setting `tcpHosts` also switches the guest to Gondolin's per-host synthetic DNS, which TCP mapping requires.

## Custom image

First, read Gondolin's [custom images guide](https://earendil-works.github.io/gondolin/custom-images/).

Create your own build config in `images/`, edit it, and build:

```bash
npx gondolin build --init-config > images/custom.json
npx gondolin build --config images/custom.json --tag pi-box:latest
export PI_BOX_IMAGE=pi-box:latest    # or set "image" in your pi-box config
```

## Shell access

```bash
pi-box shell                    # interactive shell in the guest, starting in the matching cwd
pi-box shell -- mise install    # run a single command
```

The interactive shell is fish if the guest has it, otherwise bash. It runs as a login shell, so it picks up `path`. The
guest's hostname is `pi-box`. The shell uses the same mount, image, allowlist and secrets as the extension. Each
invocation boots its own VM, separate from any running pi session. To attach to a running pi session's VM instead, use
`npx gondolin list`, then `npx gondolin attach <id>`.

## Secrets

Secrets go through Gondolin's HTTP proxy. The guest sees only a random placeholder in its environment variable. The host
replaces the placeholder with the real value in outbound request headers, and only for that secret's `hosts`:

```json
{
  "secrets": {
    "GITHUB_TOKEN": { "hosts": ["api.github.com"] },
    "NPM_TOKEN": { "hosts": ["registry.npmjs.org"], "env": "HOST_NPM_TOKEN" }
  }
}
```

Each real value is read from the host environment variable named by `env` (default: the secret's name). Values are never
stored in the config file. Load them from a secret manager or your keychain at launch, e.g. `GITHUB_TOKEN=$(gh auth
token) pi-box`. If a configured secret's host env var is unset, pi-box shows a warning and skips that secret.

Inside the VM, `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user` works, but `echo
$GITHUB_TOKEN` prints only the placeholder.

Bash commands receive only pi's session variables (`PI_SESSION_ID`, `PI_MODEL`, …). They do not receive the host
environment.
