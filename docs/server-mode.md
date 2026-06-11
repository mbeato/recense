# brain-memory: headless Linux server-mode guide (SERVE-03)

This guide walks through deploying brain-memory on a headless Linux host so it is
reachable over HTTP from remote consumers (Tonos, Claude Code hooks, curl). Following
it verbatim produces a secure-by-construction setup: loopback-by-default bind,
Bearer-token auth, TLS via Caddy, systemd reboot-survival for both the server and
the hourly sleep-pass, and BYO API keys that never touch the repo.

---

## Prerequisites

1. **Clone and build**

   ```sh
   git clone https://github.com/yourname/brain-memory.git /home/user/brain-memory
   cd /home/user/brain-memory
   npm ci
   npm run build
   ```

2. **BYO API keys in sleep.env**

   Create `~/.config/brain-memory/sleep.env` (the file `brain init` writes and the
   systemd units source):

   ```sh
   mkdir -p ~/.config/brain-memory
   cat > ~/.config/brain-memory/sleep.env <<'EOF'
   ANTHROPIC_API_KEY=sk-ant-...
   OPENAI_API_KEY=sk-...
   BRAIN_MEMORY_DB=/home/user/.config/brain-memory/brain.db
   EOF
   chmod 600 ~/.config/brain-memory/sleep.env
   ```

3. **Run `brain init`**

   ```sh
   BRAIN_MEMORY_NODE_BIN=$(which node) node dist/src/adapter/brain.js init
   ```

   `brain init` writes `BRAIN_MEMORY_NODE_BIN` into sleep.env, initialises the DB
   schema, and wires the hooks. On headless Linux the hooks step can be skipped — it
   fails silently if `~/.claude/settings.json` is absent.

4. **Pin `BRAIN_MEMORY_NODE_BIN`**

   The value must match the Node.js binary that compiled better-sqlite3
   (NODE_MODULE_VERSION). `brain doctor` reports it:

   ```sh
   node dist/src/adapter/brain.js doctor | grep "Node ABI"
   # ✓ Node ABI: NMV=127, bin=/home/user/.nvm/versions/node/v22.x.x/bin/node
   ```

   Add that exact path to sleep.env:

   ```sh
   echo "BRAIN_MEMORY_NODE_BIN=/home/user/.nvm/versions/node/v22.x.x/bin/node" >> ~/.config/brain-memory/sleep.env
   ```

---

## First run + token

`brain serve` generates `BRAIN_SERVE_TOKEN` on the **first run** and prints it
**exactly once**. Record the token now — it will not be printed again.

```sh
node dist/src/adapter/brain.js serve --db ~/.config/brain-memory/brain.db
# brain serve: token generated.
#   BRAIN_SERVE_TOKEN=<64-char hex>
#   Record this token — it will NOT be printed again.
# brain serve: listening on http://127.0.0.1:7701
```

The token is stored in `~/.config/brain-memory/sleep.env` (chmod 600, never
committed). On subsequent runs the token is read silently.

---

## Network posture

`brain serve` binds to **127.0.0.1 by default** — requests from outside the machine
are refused before they reach the auth gate. Remote exposure requires an explicit flag:

```sh
brain serve --host 0.0.0.0 --port 7701
```

The loopback default is intentional: a misconfigured Caddy config exposes a 401 wall,
not an open port. `--host 0.0.0.0` is the explicit opt-in for remote.

Default port: **7701** (`--port` overrides it).

---

## TLS via reverse proxy (Caddy)

`brain serve` speaks **plain HTTP**. Put Caddy (or nginx) in front for TLS. Caddy
provisions Let's Encrypt certs automatically.

Install Caddy:

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Create `/etc/caddy/Caddyfile`:

```
brain-memory.example.com {
    reverse_proxy 127.0.0.1:7701
}
```

Restart Caddy:

```sh
sudo systemctl reload caddy
```

brain-memory sees plain HTTP on 127.0.0.1:7701. Caddy handles TLS termination, cert
renewal, and HTTPS redirect. The engine ships no cert code.

---

## No CORS

brain-memory intentionally ships **no CORS headers**. This is not an omission — it is
a deliberate security posture:

- A browser consumer would have to embed `BRAIN_SERVE_TOKEN` in client-visible
  JavaScript, making it extractable by anyone who can open DevTools. That is the exact
  attack this setup is designed to prevent.
- All intended consumers (Tonos backend, remote agent hooks, curl) are server-to-server
  callers that do not need cross-origin browser access.

Do not add a CORS middleware layer. If you need a browser UI, put an authenticated
server-side proxy in front of brain-serve rather than opening CORS.

---

## systemd: brain serve unit

Instantiate the template at `scripts/brain-serve.service.template`. Set the variables
for your host, then install and start the unit.

Define variables (adapt to your paths):

```sh
export YOUR_USER=max
export BRAIN_MEMORY_DIR=/home/user/brain-memory
export BRAIN_MEMORY_NODE_BIN=$(grep BRAIN_MEMORY_NODE_BIN ~/.config/brain-memory/sleep.env | cut -d= -f2)
export BRAIN_JS=/home/user/brain-memory/dist/src/adapter/brain.js
export PORT=7701
export HOME=/home/user
```

Instantiate and install:

```sh
envsubst < scripts/brain-serve.service.template > /tmp/brain-serve.service
sudo cp /tmp/brain-serve.service /etc/systemd/system/brain-serve.service
sudo systemctl daemon-reload
sudo systemctl enable brain-serve
sudo systemctl start brain-serve
```

Check status and view the request log:

```sh
sudo systemctl status brain-serve
journalctl -u brain-serve -f
```

The unit sets `Environment=BRAIN_MEMORY_NODE_BIN=<path>` so the pinned binary is
available to the process regardless of the service user's PATH. A bare `node` from
`/usr/bin` would load a different NODE_MODULE_VERSION and fail to open the
better-sqlite3 native addon.

---

## Scheduler: hourly sleep-pass (reboot-survival)

The sleep-pass (consolidation) must survive reboots to keep the semantic graph current.
Use the companion template at `scripts/brain-scheduler.service.template`:

```sh
envsubst < scripts/brain-scheduler.service.template > /tmp/brain-scheduler.service
sudo cp /tmp/brain-scheduler.service /etc/systemd/system/brain-scheduler.service
sudo systemctl daemon-reload
sudo systemctl enable brain-scheduler
sudo systemctl start brain-scheduler
```

The scheduler runs `brain scheduler run` — an in-process croner job that fires every
hour (`0 * * * *`), acquires the write lock, runs consolidation, then releases it. The
systemd unit handles crash-restart (`Restart=on-failure`) and boot-survival
(`WantedBy=multi-user.target`).

Check scheduler logs:

```sh
journalctl -u brain-scheduler -f
# or the log file:
tail -f /tmp/brain-memory-sleep.log
```

---

## Token rotation

To rotate `BRAIN_SERVE_TOKEN`:

1. Edit `~/.config/brain-memory/sleep.env` — delete the `BRAIN_SERVE_TOKEN=...` line
   (or set it to a new value).
2. Restart the serve unit:

   ```sh
   sudo systemctl restart brain-serve
   ```

3. If you deleted the line, `brain serve` generates a new token on startup and prints
   it once to stdout. Capture it from the journal:

   ```sh
   journalctl -u brain-serve -n 20 | grep BRAIN_SERVE_TOKEN
   ```

4. Verify the token and env file mode with `brain doctor`:

   ```sh
   node dist/src/adapter/brain.js doctor | grep "Serve token"
   # ✓ Serve token: BRAIN_SERVE_TOKEN set, env file mode 0600
   ```

There is no `brain rotate-token` command — editing the env file + restart is the full
rotation path.

---

## Remote smoke test

From your laptop (replace `brain-memory.example.com` with your domain or IP):

**Health check (no token required):**

```sh
curl -s https://brain-memory.example.com/health
# {"status":"ok","version":"0.1.0"}
```

**Authenticated search (replace `<token>` with your BRAIN_SERVE_TOKEN):**

```sh
curl -s -X POST https://brain-memory.example.com/v1/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"query":"what do I know about Tonos"}'
# {"results":[...]}
```

**Wrong token → 401 (not 500):**

```sh
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://brain-memory.example.com/v1/search \
  -H "Authorization: Bearer wrongtoken" \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'
# 401
```

---

## Verifying the full setup with `brain doctor`

From the server:

```sh
node dist/src/adapter/brain.js doctor
# brain doctor:
#   ✓ DB: DB at /home/user/.config/brain-memory/brain.db — schema v5
#   ✓ API keys: ANTHROPIC valid, OPENAI valid
#   ✓ Scheduler: brain scheduler run process detected
#   ✓ Hooks: ...
#   ✓ Node ABI: NMV=127, bin=/home/user/.nvm/.../node
#   ✓ Serve token: BRAIN_SERVE_TOKEN set, env file mode 0600
# All checks passed.
```

All six dimensions green means the deployment is ready.
