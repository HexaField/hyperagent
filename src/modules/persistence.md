Short answer: treat your server as stateless, move all long-lived state into a durable store (DB + volumes), and use Docker for packaging/replication, not as your primary persistence mechanism. Then build a small “workflow runtime” layer on top.

I’ll outline a concrete approach you can implement:

* Persistence strategy and data model
* Workflow runtime for agents
* Persistent/code-server lifecycle
* Docker/container layout
* How the existing modules should be refactored around this

---

## 1. Persistence strategy

Key principles:

1. The HTTP server / Node process is disposable.
2. All important state lives outside it:

   * Relational DB (Postgres or SQLite to start).
   * Filesystem volumes for:

     * Radicle repo(s).
     * Long-lived worktrees (e.g. “studio” worktrees for code-server).
     * Logs/artifacts.
3. Every long-running thing (workflow, agent run, code-server session) has a durable record in the DB and a clear state machine.

### 1.1. Use a DB for persistent state

A relational DB is enough; start with SQLite, upgrade to Postgres when needed.

Core tables (simplified):

* `projects`
* `planner_runs`
* `workflows`
* `workflow_steps` (or `workflow_tasks` if you map directly to your task DAG)
* `agent_runs`
* `code_server_sessions`
* `radicle_sessions` (mostly metadata; actual repo persists on disk)
* `events` / `logs` (optional, or you keep logs on disk and store paths in DB)

Representative schema sketch (not exact SQL, but close):

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  radicle_repo_path TEXT NOT NULL,
  radicle_project_id TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  planner_run_id TEXT,          -- optional link to planner result
  kind TEXT NOT NULL,           -- e.g. 'new_project', 'refactor', 'bugfix'
  status TEXT NOT NULL,         -- 'pending' | 'running' | 'paused' | 'completed' | 'failed'
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL,
  data JSONB NOT NULL           -- arbitrary metadata (parameters, config)
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  task_id TEXT,                 -- link to planner task graph if relevant
  status TEXT NOT NULL,         -- 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  sequence INT NOT NULL,
  depends_on TEXT[],            -- list of other step IDs
  data JSONB NOT NULL,          -- step definition (which agent, which branch, etc)
  result JSONB,                 -- outputs summary, diff, etc
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  workflow_step_id TEXT REFERENCES workflow_steps(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'planner' | 'coding' | ...
  status TEXT NOT NULL,         -- 'running' | 'succeeded' | 'failed'
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  logs_path TEXT                -- path to on-disk logs/transcript
);

CREATE TABLE code_server_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  url TEXT NOT NULL,
  auth_token TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'running' | 'stopped'
  started_at TIMESTAMP NOT NULL,
  stopped_at TIMESTAMP
);
```

All module “runtime” state should either be:

* Derived entirely from DB + filesystem, or
* Very short-lived in memory (e.g. a single in-flight LLM call).

---

## 2. Workflow runtime for agents

Your current orchestration is already close; you need to:

1. Formalise workflows as DB-backed state machines.
2. Have a separate worker process (or several) that:

   * Polls the DB for ready steps.
   * Executes them via the agent modules.
   * Updates status atomically.

### 2.1. Workflow manager module

New module: `WorkflowModule`.

Responsibilities:

* Create workflows based on planner outputs:

  * Map planner’s `TaskGraph` into `workflow_steps`.
* Expose operations:

  * Start workflow (status `pending` → `running`).
  * Pause/resume workflow.
  * Cancel workflow (mark remaining steps `skipped`).
  * Query status, history.

It should be pure orchestration + DB. No direct process control.

### 2.2. Workflow worker (runtime)

Separate process (could be the same codebase, different entry point):

* On startup:

  * Connect to DB.
  * Mark any `workflow_steps` with `status = 'running'` as `failed` or `pending` (depending on your resume semantics).
  * Enter main loop.

* Main loop:

  1. Find `workflow_steps` with:

     * `status = 'pending'`
     * Dependencies all `completed`.
     * Workflow `status = 'running'`.
  2. Claim a step, using a DB lock (e.g. `SELECT ... FOR UPDATE SKIP LOCKED`) so multiple workers can run in parallel.
  3. For each claimed step:

     * Create `agent_run` row (status `running`).
     * Call into your existing modules:

       * Create `RadicleSession` for branch.
       * Invoke coding or planner agents as per `workflow_steps.data`.
       * Commit/push via `RadicleSession.finish`.
     * Update `agent_run` and `workflow_step` status.
  4. Update workflow-level status:

     * If all steps `completed` → workflow `completed`.
     * If any step `failed` and you don’t allow retries → workflow `failed`.

Because all state is in DB and the worker is stateless, a server restart just restarts the loop and it picks up where it left off.

---

## 3. Persistence and code-server

For code-server, you don’t really “resume a process” after restart; you:

* Store the **intent** and **context** in DB.
* When the app comes back up, you can re-start code-server processes based on that state.

### 3.1. Code-server lifecycle with persistence

1. User starts a code-server session for project+branch:

   * `CodeServerManager.startSession(projectId, branch)`:

     * Ensures a studio worktree exists (Radicle module, persistent volume).
     * Spawns code-server pointing at that path.
     * Inserts `code_server_sessions` row with `status = 'running'`.
2. User navigates to `/code/:sessionId` (or project+branch mapping).
3. On server restart:

   * You can choose one of two behaviours:

     * Simple: treat previous sessions as dead. On first request after restart, create new `code_server_sessions` with fresh process.

       * DB records old entries as `stopped`.
       * Users see new sessions transparently but same repo state.
     * Advanced: have a supervisor restart code-server containers directly (see Docker section), then refresh DB state.
4. User stops session:

   * Kill process/container.
   * Set `code_server_sessions.status = 'stopped'`.

You don’t need process resurrection; restart is just “start a new process with same config + volume”.

---

## 4. Docker and process layout

Docker is good for packaging and deployment, but it is not the main persistence layer. Use it like this:

### 4.1. Container roles

Use multiple containers/services:

1. `app`:

   * Your HTTP API + StudioModule, RadicleModule, planner, etc.
2. `worker`:

   * Same codebase, but starts the Workflow worker instead of HTTP server.
3. `db`:

   * Postgres (or you mount SQLite into a volume).
4. `radicle-node` (optional):

   * If running a Radicle daemon locally.
5. `code-server`:

   * For flexibility, consider running code-server as a separate container per workspace, not as a child process of `app`.

Each of these is stateless except `db` and the volumes.

### 4.2. Persistence via volumes

Use named volumes or bind mounts for:

* `radicle-repos`:

  * Persistent Radicle repo(s).
* `worktrees`:

  * Studio worktrees and/or ephemeral ones (if you want them to survive container restarts).
* `logs`:

  * Agent run logs, transcripts, metrics.
* `db-data`:

  * Postgres or SQLite data.

Example `docker-compose.yml` sketch (conceptual):

```yaml
services:
  db:
    image: postgres:16
    volumes:
      - db-data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: studio
      POSTGRES_USER: studio
      POSTGRES_PASSWORD: password

  app:
    build: .
    depends_on:
      - db
    volumes:
      - radicle-repos:/radicle
      - worktrees:/worktrees
      - logs:/logs
    environment:
      DB_URL: postgres://studio:password@db:5432/studio

  worker:
    build: .
    command: ["node", "dist/worker.js"]
    depends_on:
      - db
    volumes:
      - radicle-repos:/radicle
      - worktrees:/worktrees
      - logs:/logs
    environment:
      DB_URL: postgres://studio:password@db:5432/studio

  # optional: code-server as sidecar per project/branch handled differently
  # or you run code-server inside the app container as subprocesses

volumes:
  db-data:
  radicle-repos:
  worktrees:
  logs:
```

### 4.3. “Multiple instances” question

> Can we try putting it in a docker image and invoking multiple instances?

Yes, but with a specific pattern:

* Build a single Docker image for your app/worker.
* Run multiple **containers** (instances) of:

  * `app` behind a reverse proxy if you need load balancing for HTTP.
  * `worker` if you want parallel workflow processing.

All of them share:

* One DB.
* Shared volumes for Radicle repo(s) and worktrees.

This gives you:

* Horizontal scalability.
* Fault tolerance (one container crashing doesn’t kill workflows; others continue).

You generally do **not** want “one container per workflow” for this use case; that’s overkill and complicates state and coordination (unless you later move to a k8s/nomad style job per workflow).

---

## 5. Module refactor for persistence

Refactor each module so that:

1. They have a **pure orchestration layer** (no direct DB).
2. They depend on small “repository” interfaces for persistence.

For example:

### 5.1. AgentModule

```ts
interface AgentRunRepository {
  create(run: Partial<AgentRun>): Promise<AgentRun>;
  update(id: AgentRunId, patch: Partial<AgentRun>): Promise<void>;
  findById(id: AgentRunId): Promise<AgentRun | null>;
}

class AgentModule {
  constructor(private repo: AgentRunRepository, private llmClient: LLMClient) {}

  async executeStep(step: WorkflowStep, context: ExecutionContext): Promise<AgentRun> {
    const run = await this.repo.create({
      projectId: context.projectId,
      branch: context.branch,
      status: "running",
      type: step.data.agentType,
      startedAt: new Date().toISOString(),
    });

    try {
      // do the LLM calls, interact with RadicleSession, etc.
      await this.repo.update(run.id, { status: "succeeded", finishedAt: new Date().toISOString() });
      return { ...run, status: "succeeded" };
    } catch (e) {
      await this.repo.update(run.id, { status: "failed", finishedAt: new Date().toISOString() });
      throw e;
    }
  }
}
```

### 5.2. CodeServerManager

```ts
interface CodeServerSessionRepository {
  upsert(session: CodeServerSession): Promise<void>;
  findByProjectAndBranch(projectId: string, branch: string): Promise<CodeServerSession | null>;
  markStopped(id: string): Promise<void>;
}

class CodeServerManager {
  constructor(private repo: CodeServerSessionRepository) {}

  async startSession(project: Project, branch: string): Promise<CodeServerSession> {
    // ensure worktree via RadicleModule
    // spawn or create container; generate URL/token
    // persist via repo.upsert
  }

  async stopSession(projectId: string, branch: string): Promise<void> {
    const session = await this.repo.findByProjectAndBranch(projectId, branch);
    if (!session) return;
    // kill process/container
    await this.repo.markStopped(session.id);
  }
}
```

### 5.3. WorkflowModule

* Uses `WorkflowRepository` + `WorkflowStepRepository`.
* Handles transitions purely via DB; runtime semantics are implemented in worker process using this module.

---

## 6. Managing multiple workflows and parallelism

With the above, managing workflows is straightforward:

* To start a new workflow:

  * Insert `workflow` and `workflow_steps` rows.
  * Set workflow `status = 'pending'` or `running`.
* To run multiple in parallel:

  * Run multiple worker processes or threads.
  * Use DB locking (`FOR UPDATE SKIP LOCKED`) when selecting steps to avoid double execution.
* To stop a workflow:

  * Set workflow `status = 'paused'` or `cancelled`.
  * Workers must check workflow status before executing steps.
* To inspect workflows:

  * The web UI just queries DB tables.

Everything continues to “exist” and be inspectable across restarts, with no special in-memory state.

---

## 7. Summary of recommended pattern

1. **True persistence:** Put all state in DB + volumes; design explicit tables for workflows, steps, agent runs, code-server sessions.
2. **Stateless services:** App and worker containers are stateless and disposable.
3. **Workflows as state machines:** DB-backed, with a worker loop that is safe to restart.
4. **code-server:** Treat as a restartable service (process or container) whose config and mapping to project/branch is stored in DB.
5. **Docker:** Use it to package and run multiple instances of app/worker; use shared volumes and a single DB for actual persistence, not “one container per workflow”.

If you adopt this, your agents and code-server will effectively “continue” across restarts because the system can always reconstruct and resume them from durable state, rather than relying on any particular process staying alive.
