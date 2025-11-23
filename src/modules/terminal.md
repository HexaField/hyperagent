You can treat this as a small, self-contained “Terminal” module that integrates into the Studio, but is conceptually independent of Radicle/planner/agents.

Below is a concrete architecture you can implement.

---

## 1. Goal and constraints

Goal: Expose an interactive shell on the host machine through your existing web UI, accessible from mobile, with:

- Secure authentication/authorisation through your app.
- WebSocket-based bidirectional stream between browser and shell.
- Clean boundaries so the module is easy to disable/lock down.

You have two basic options:

1. **Direct PTY shell** on the host (no real SSH, but shell via pseudo-terminal).
2. **SSH client bridge**: your module connects to `sshd` via SSH and forwards the session to the browser.

Option 1 is simpler and enough for “terminal to the computer”, so I’ll describe that as the default. You can switch to SSH-client later if you need key and user separation.

---

## 2. Module boundaries

New module: `TerminalModule`.

Responsibilities:

- Manage terminal sessions and their lifecycle.
- Connect each session to a PTY on the host (or to `ssh` command if you want to strictly go through an SSH server).
- Expose a WebSocket endpoint (`/ws/terminal/:sessionId`) that:
  - Forwards input from the browser to the PTY.
  - Streams output from the PTY back to the browser.

- Persist session metadata for observability, not the live stream.

Non-responsibilities:

- User authentication (handled by your app).
- Authorization decisions (module gets a user/role from the app and enforces or denies).

---

## 3. Data model

Add to your persistence layer:

```ts
export type TerminalSessionId = string

export interface TerminalSessionRecord {
  id: TerminalSessionId
  userId: string
  projectId?: string // optional, if you tie sessions to a project
  createdAt: string
  closedAt?: string
  shellCommand: string // e.g. '/bin/bash' or '/bin/zsh'
  initialCwd?: string // default working directory
  status: 'active' | 'closed' | 'error'
}
```

Database table `terminal_sessions`:

- `id TEXT PRIMARY KEY`
- `user_id TEXT NOT NULL`
- `project_id TEXT NULL`
- `shell_command TEXT NOT NULL`
- `initial_cwd TEXT NULL`
- `status TEXT NOT NULL`
- `created_at TIMESTAMP NOT NULL`
- `closed_at TIMESTAMP NULL`

You do not need to store the stream itself; only metadata.

---

## 4. Backend design

### 4.1. TerminalModule

Create `src/modules/terminal/index.ts`:

```ts
interface TerminalSessionRepository {
  create(record: Partial<TerminalSessionRecord>): Promise<TerminalSessionRecord>
  update(id: TerminalSessionId, patch: Partial<TerminalSessionRecord>): Promise<void>
  findById(id: TerminalSessionId): Promise<TerminalSessionRecord | null>
  listByUser(userId: string): Promise<TerminalSessionRecord[]>
}

export interface TerminalConfig {
  defaultShell: string // e.g. "/bin/bash"
  defaultCwd?: string // e.g. "/radicle" or "/"
  maxSessionsPerUser?: number
}

// Represents a live PTY session in memory
export interface LiveTerminalSession {
  id: TerminalSessionId
  pty: any // node-pty instance
  userId: string
}

export class TerminalModule {
  private liveSessions: Map<TerminalSessionId, LiveTerminalSession> = new Map()

  constructor(
    private config: TerminalConfig,
    private repo: TerminalSessionRepository
  ) {}

  async createSession(userId: string, opts?: { cwd?: string; shell?: string }): Promise<TerminalSessionRecord> {
    // enforce max sessions per user
    const existing = await this.repo.listByUser(userId)
    if (
      this.config.maxSessionsPerUser &&
      existing.filter((s) => s.status === 'active').length >= this.config.maxSessionsPerUser
    ) {
      throw new Error('Too many active terminal sessions')
    }

    const shellCommand = opts?.shell ?? this.config.defaultShell
    const cwd = opts?.cwd ?? this.config.defaultCwd

    const record = await this.repo.create({
      userId,
      shellCommand,
      initialCwd: cwd,
      status: 'active',
      createdAt: new Date().toISOString()
    })

    // Don't actually spawn PTY here; do it when WebSocket attaches
    return record
  }

  async attachPty(sessionId: TerminalSessionId, userId: string): Promise<LiveTerminalSession> {
    const record = await this.repo.findById(sessionId)
    if (!record) throw new Error('Session not found')
    if (record.userId !== userId) throw new Error('Unauthorized')

    // If already running, just reuse
    const existing = this.liveSessions.get(sessionId)
    if (existing) return existing

    // Spawn PTY
    const ptyProcess = spawnPty(record.shellCommand, {
      cwd: record.initialCwd,
      env: process.env
    })

    const live: LiveTerminalSession = {
      id: record.id,
      pty: ptyProcess,
      userId: record.userId
    }

    this.liveSessions.set(sessionId, live)

    ptyProcess.onExit(async () => {
      this.liveSessions.delete(sessionId)
      await this.repo.update(sessionId, {
        status: 'closed',
        closedAt: new Date().toISOString()
      })
    })

    return live
  }

  async closeSession(sessionId: TerminalSessionId, userId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId)
    const record = await this.repo.findById(sessionId)
    if (!record || record.userId !== userId) return

    if (live) {
      live.pty.kill()
      this.liveSessions.delete(sessionId)
    }
    await this.repo.update(sessionId, {
      status: 'closed',
      closedAt: new Date().toISOString()
    })
  }
}
```

Implementation detail:

- `spawnPty` is a thin wrapper around something like `node-pty` (Node) or `pty` in whatever runtime you use.

### 4.2. WebSocket handler

Create a WebSocket route, for example `/ws/terminal/:sessionId`.

Pseudocode:

```ts
import WebSocket from 'ws'

function createTerminalWebSocketHandler(terminalModule: TerminalModule) {
  return async (ws: WebSocket, req: HttpRequest) => {
    const sessionId = req.params.sessionId
    const userId = req.auth.userId // assuming your auth middleware

    let live: LiveTerminalSession

    try {
      live = await terminalModule.attachPty(sessionId, userId)
    } catch (err) {
      ws.close(1011, 'Unable to attach PTY')
      return
    }

    // PTY -> WebSocket
    live.pty.onData((data: string) => {
      ws.send(JSON.stringify({ type: 'output', data }))
    })

    // WebSocket -> PTY
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'input') {
          live.pty.write(msg.data)
        } else if (msg.type === 'resize') {
          live.pty.resize(msg.cols, msg.rows)
        }
      } catch {
        // ignore malformed
      }
    })

    ws.on('close', () => {
      // Optionally leave PTY running so user can reconnect
      // Or kill it; your choice. For mobile, leaving it running is often nicer.
    })
  }
}
```

---

## 5. Frontend design (mobile-friendly web terminal)

Use:

- `xterm.js` (or similar) for the terminal UI.
- A page/route like `/terminal` inside your Studio UI.

Frontend flow:

1. User opens `/terminal` on mobile.
2. Frontend calls `POST /api/terminal/sessions`:
   - Response: `sessionId`.

3. Frontend opens WebSocket to `/ws/terminal/:sessionId`.
4. Initialize `xterm.js` and wire:
   - On keypress / input: send `{"type":"input","data": "<keys>"}` to WS.
   - On WS message of type `output`: write `data` to terminal.
   - On resize: send `{"type":"resize","cols":..., "rows":...}`.

Basic API endpoints:

- `POST /api/terminal/sessions` → create session.
- `GET /api/terminal/sessions` → list user’s sessions (for reconnection).
- `DELETE /api/terminal/sessions/:id` → close session.

For mobile:

- Use full-screen terminal.
- Minimal UI: close button, session selector.

---

## 6. Security and isolation concerns

Since this is effectively a shell on the host, you must be explicit about boundaries:

- Restrict to authenticated users with an explicit “terminal access” role.
- Make it off by default; config-driven.
- Optionally restrict `cwd` to within a specific directory (e.g. the radicle workspace root) rather than `/`.
- Optionally run shell under a less-privileged OS user:
  - For example, run your app + PTY under a “studio” user that has limited filesystem permissions.

If you want strict SSH semantics:

- Instead of spawning `/bin/bash` directly:
  - Spawn `ssh localhost` as the PTY command and rely on the OS `sshd` for auth/key management.
  - Or, run the whole thing in a container with a dedicated user.

---

## 7. Docker / deployment

In your Docker layout, nothing special is required beyond exposing the terminal WebSocket:

- The PTY processes run inside the `app` container.
- Mobile devices connect to your reverse proxy (e.g. Nginx) → `app` HTTP/WS.

Notes:

- Ensure your reverse proxy is WS-aware for `/ws/terminal/*`.
- Use TLS externally; for a mobile terminal, this is important.

Example Nginx snippet (conceptual):

```nginx
location /ws/terminal/ {
  proxy_pass http://app:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "Upgrade";
  proxy_set_header Host $host;
}
```

---

## 8. Integration with the rest of the platform

Inside your Studio:

- Add a “Terminal” tab globally or per project:
  - Per project:
    - Start sessions with `cwd` set to the project’s Radicle repo/worktree.

  - Global:
    - Start sessions with `cwd = '/'` or a safe base location.

The `Project` page can expose:

- “Open Terminal in this project”:
  - Calls `createSession(userId, { cwd: project.radicleRepoPath })`.
  - Opens the terminal UI with that session.

Because sessions are DB-backed, you can:

- Reconnect to an existing session from mobile after switching networks.
- List old sessions for observability, even if the PTY is closed.

---

This gives you a small, modular Terminal module:

- Backend: `TerminalModule` + WebSocket handler + DB-backed `TerminalSessionRepository`.
- Frontend: an xterm.js-based terminal page which works well on mobile.
- Integrates cleanly into your existing platform and respects your persistence design.
