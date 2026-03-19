# Web3270

Run a 3270 mainframe terminal directly in the browser — no desktop emulator required.

The server spawns `c3270` on demand and pipes its I/O to the browser over a WebSocket. Each browser session gets its own `c3270` child process, so one Node server can handle connections to multiple mainframes simultaneously.

## How it works

1. The browser loads the dashboard and fetches the list of available servers
2. The user selects a server from the dropdown
3. The frontend emits a `connect_to_mainframe` event with the server id and terminal dimensions
4. The server resolves the full host configuration (including env-var substitution) and spawns `c3270`
5. `c3270` I/O is piped back to the browser over the socket — the terminal renders live in the page

Credentials and host details never reach the browser. The client only sends an `id`.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [`c3270`](https://x3270.miraheze.org/wiki/C3270) installed and on `PATH`
  - Debian/Ubuntu: `apt install c3270`
  - macOS: `brew install c3270`

## Configuration

Servers are defined in `mainframes.json`:

```json
[
  {
    "id": "prod",
    "name": "Production",
    "hostname": "mainframe.company.com",
    "port": 23,
    "secure": true,
    "user": "$MAINFRAME_USER"
  }
]
```

`$VAR` and `${VAR}` placeholders are resolved from environment variables at connect time — no restart needed when credentials change.

| Field      | Description                                      |
|------------|--------------------------------------------------|
| `id`       | Unique identifier, sent by the browser           |
| `name`     | Display name shown in the dashboard              |
| `hostname` | TN3270 host (supports env-var substitution)      |
| `port`     | TN3270 port (typically `23` or `2323`)           |
| `secure`   | Use TLS (`-secure -noverifycert` passed to c3270)|
| `user`     | Optional username (supports env-var substitution)|

### Environment variables

| Variable               | Default     | Description                               |
|------------------------|-------------|-------------------------------------------|
| `PORT`                 | `8080`      | HTTP port the server listens on           |
| `DEFAULT_SERVER`       | _(none)_    | Server id pre-selected on load            |
| `LOCAL_MAINFRAME_HOST` | `127.0.0.1` | Hostname for the `local` entry (Docker)   |

## Development

```bash
npm install
npm run dev            # tsx watch — reloads server on save
npm run dev:local      # same, with DEFAULT_SERVER=local
npm run dev:dev        # same, with DEFAULT_SERVER=dev
npm run dev:prod       # same, with DEFAULT_SERVER=prod
```

The server starts on `http://localhost:8080`. Client-side code (`public/app.js`) is plain JS — edit and refresh.

## Production build

```bash
npm run build          # compiles src/server.ts → dist/server.js
npm start              # build + run
npm run start:local    # build + run with DEFAULT_SERVER=local
```

Frontend assets (`xterm.js`, `addon-fit.js`, `xterm.css`) are served directly from `node_modules` at runtime — no bundler, no CDN.

## Deployment (tarball)

Build a self-contained tarball (sources and `mainframes.json` excluded):

```bash
npm run build && npm pack
# → web-terminal-mainframe-1.0.0.tgz (contains dist/ and public/ only)
```

On the production machine:

```bash
mkdir /opt/web3270 && cd /opt/web3270
tar -xzf web-terminal-mainframe-1.0.0.tgz --strip-components=1
npm install               # recompiles node-pty natively on this machine
cp /path/to/mainframes.json .
PORT=8080 node dist/server.js
```

> **Note:** `node-pty` is a native addon — `npm install` must run on the production machine (or a matching arch/OS) so it compiles against the right Node version. Requires `build-essential` (Linux) or Xcode CLT (macOS).

## Docker (local mainframe)

To run the full stack locally — including a real MVS 3.8j mainframe via Hercules:

```bash
docker compose up --build
```

Then open `http://localhost:8080` and select **Local (TN3270)**.

**Note:** Hercules takes 2–3 minutes to IPL (boot) MVS. The terminal will fail to connect until IPL completes. You can watch the boot progress at `http://localhost:8038` (Hercules operator console).

Default MVS login credentials:

| User     | Password |
|----------|----------|
| `HERC01` | `CUL8TR` |
| `HERC02` | `CUL8TR` |
| `HERC03` | `CUL8TR` |
| `HERC04` | `CUL8TR` |

To run only the web3270 server (pointing at an external mainframe):

```bash
docker compose run --service-ports web3270
```

### Exposed ports

| Port   | Service                    |
|--------|----------------------------|
| `8080` | Web3270 browser interface  |
| `2323` | TN3270 (Hercules/MVS)      |
| `8038` | Hercules operator console  |
