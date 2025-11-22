Below is an architecture plan you can implement as a `Radicle` module, consistent with your “modules that orchestrate agents and tools” style.

---

## 1. Goal and responsibilities

**Goal:** Provide a high-level API for coding/planning agents to work on repositories via a local Radicle network, hiding git/PR mechanics and managing ephemeral workspaces.

Responsibilities:

1. Manage ephemeral workspaces:

   * Create temporary working directories for tasks.
   * Clone/fetch the Radicle tracking branch into the temp dir.
   * Clean up temp dirs deterministically after use.
2. Abstract git + Radicle:

   * Ensure a single persistent Radicle/git repo exists on disk.
   * Use branches for work; no extra duplicated clones on disk.
   * Hide git commands behind a simple interface (status, commit, diff, branch).
3. Provide a “PR-like” flow:

   * Start a feature branch for a task or set of tasks.
   * Apply changes in temp workspace.
   * Commit & push to Radicle.
   * Optionally create/annotate a Radicle “patch/merge request”-like record.
4. Integrate with multi-agent task execution:

   * Given a task, prepare a workspace and context for coding agents.
   * On success, commit and push.
   * On failure, collect diffs/logs and discard workspace.

---

## 2. High-level module structure

Create something like `src/modules/radicle.ts` with these main concepts:

* `RadicleRepoManager` – manages the single persistent Radicle-backed repo and branches.
* `WorkspaceManager` – handles creation and cleanup of ephemeral working dirs.
* `RadicleSession` – one logical unit of work for a task or task group, bound to a branch and a workspace.
* `RadiclePatchFlow` – optional helper for “PR-like” patch flow on Radicle.

Directory-level:

```text
src/
  modules/
    radicle/
      index.ts          // public module API
      repoManager.ts    // RadicleRepoManager
      workspace.ts      // WorkspaceManager
      session.ts        // RadicleSession
      patchFlow.ts      // RadiclePatchFlow (optional)
      types.ts          // shared types/interfaces
```

---

## 3. Core types

```ts
// types.ts
export interface RadicleConfig {
  persistentRepoPath: string; // path to the single persistent repo
  radicleProjectId: string;   // Radicle project identifier
  defaultRemote?: string;     // e.g. "rad"
  tempRootDir?: string;       // base for temp dirs; system temp if omitted
}

export interface RadicleBranchInfo {
  name: string;
  baseBranch: string;     // e.g. "main"
  description?: string;
}

export interface RadicleSessionInit {
  taskId: string;
  branchInfo: RadicleBranchInfo;
  author: {
    name: string;
    email: string;
  };
  // optional: metadata to embed in commit messages or patch notes
  metadata?: Record<string, string>;
}

export interface WorkspaceInfo {
  workspacePath: string;
  branchName: string;
  baseBranch: string;
}

export interface CommitResult {
  branch: string;
  commitHash: string;
  message: string;
  changedFiles: string[];
}

export interface DiffResult {
  branch: string;
  diffText: string;
}

export interface RadiclePatch {
  patchId: string;
  branch: string;
  baseBranch: string;
  title: string;
  description: string;
}
```

---

## 4. `RadicleRepoManager`

This component owns the persistent Radicle/git repo instance and provides branch-level operations. It is the only one touching the canonical repo on disk.

Responsibilities:

* Ensure persistent repo exists and is initialised with Radicle.
* Manage branches:

  * Create feature branches from base branch.
  * Fetch/pull updates from Radicle remote.
* Provide snapshot and sync primitives for workspaces:

  * Export current branch state to an ephemeral workspace.
  * Import changes back from workspace to persistent repo (commit & push).

Key methods (pseudo-API):

```ts
export class RadicleRepoManager {
  constructor(private config: RadicleConfig) {}

  async initIfNeeded(): Promise<void> {
    // ensure repo exists at config.persistentRepoPath
    // if not, rad init + git init + remote setup, etc.
  }

  async ensureBranch(branch: RadicleBranchInfo): Promise<void> {
    // create branch from branch.baseBranch if not exists
    // otherwise ensure up to date with remote
  }

  async exportBranchToPath(branchName: string, destPath: string): Promise<void> {
    // use git worktree or a temporary clone to populate destPath
    // but conceptually, you want to start from persistent repo’s branch
  }

  async importChangesFromPath(
    workspacePath: string,
    branchName: string,
    commitMessage: string,
    author: { name: string; email: string; },
    metadata?: Record<string, string>
  ): Promise<CommitResult> {
    // copy changed files from workspacePath back into persistent repo
    // stage, commit, push to Radicle remote
  }

  async getDiffForBranch(branchName: string, baseBranch: string): Promise<DiffResult> {
    // run git diff baseBranch..branchName
  }

  async pushToRadicle(branchName: string): Promise<void> {
    // push branch to Radicle remote
  }
}
```

Implementation choices:

* For “only one instance of the repo”:

  * Use the persistent repo as the only clone.
  * For workspaces you can:

    * Option A: `git worktree` from the persistent repo into ephemeral dirs. No extra clones, still using same .git.
    * Option B: tar/rsync tree from `.git` to workspace; but this duplicates.
  * Prefer `git worktree` as it is lightweight and respects your “single repo” requirement.

If using worktrees:

* `exportBranchToPath`:

  * `git worktree add <workspacePath> <branchName>`
* `importChangesFromPath`:

  * Worktree already uses same `.git`. Just commit in worktree then push from persistent repo or directly from worktree.
  * On cleanup, `git worktree remove <workspacePath>` from persistent repo, then delete the directory.

---

## 5. `WorkspaceManager`

Responsible for creating, tracking, and cleaning up temporary directories used as workspaces.

Responsibilities:

* Create a new temp workspace (possibly as a git worktree target).
* Track mapping `sessionId → workspacePath`.
* Provide safe cleanup that:

  * Removes worktree (if used).
  * Deletes workspace directory, even after failures.

Key methods:

```ts
export class WorkspaceManager {
  constructor(private config: RadicleConfig) {}

  async createWorkspace(sessionId: string): Promise<string> {
    // create temp dir under config.tempRootDir or system temp
    // return path
  }

  async cleanupWorkspace(sessionId: string, workspacePath: string): Promise<void> {
    // remove git worktree if used; delete directory
  }
}
```

You can also add:

* `listActiveWorkspaces()`
* `cleanupAll()` for emergency teardown.

---

## 6. `RadicleSession`

This is the object your orchestrator will use per task or task group. It binds together:

* A branch (`RadicleBranchInfo`).
* A workspace directory.
* The persistent repo (via `RadicleRepoManager`).
* Lifetime: created for a task, used while agents edit files, then finalised (commit & push) and disposed.

Lifecycle:

1. `start()`:

   * Ensure base repo exists (`repoManager.initIfNeeded`).
   * Ensure branch exists (`repoManager.ensureBranch`).
   * Create workspace (`workspaceManager.createWorkspace`).
   * Export branch into workspace (`repoManager.exportBranchToPath`).
   * Return `WorkspaceInfo` to caller so agents know where to read/write files.

2. Agents run:

   * Coding agents operate in `workspacePath`, modifying files.
   * They never touch `persistentRepoPath` directly.

3. `commitAndPush()`:

   * Run git status/diff in workspace to see if anything changed.
   * If changes exist:

     * Commit changes with message that includes taskId and metadata.
     * Push branch to Radicle remote.
   * Return `CommitResult`.

4. `abort()`:

   * No commit/push.
   * Clean up workspace (remove worktree + delete dir).

5. `finish()`:

   * Wrap `commitAndPush()` + cleanup.

API sketch:

```ts
export class RadicleSession {
  private workspace?: WorkspaceInfo;
  private committed = false;

  constructor(
    private repoManager: RadicleRepoManager,
    private workspaceManager: WorkspaceManager,
    private init: RadicleSessionInit
  ) {}

  async start(): Promise<WorkspaceInfo> {
    await this.repoManager.initIfNeeded();
    await this.repoManager.ensureBranch(this.init.branchInfo);

    const workspacePath = await this.workspaceManager.createWorkspace(this.init.taskId);
    await this.repoManager.exportBranchToPath(this.init.branchInfo.name, workspacePath);

    this.workspace = {
      workspacePath,
      branchName: this.init.branchInfo.name,
      baseBranch: this.init.branchInfo.baseBranch,
    };
    return this.workspace;
  }

  getWorkspace(): WorkspaceInfo {
    if (!this.workspace) {
      throw new Error("Session not started");
    }
    return this.workspace;
  }

  async commitAndPush(commitMessage: string): Promise<CommitResult> {
    if (!this.workspace) throw new Error("Session not started");

    const result = await this.repoManager.importChangesFromPath(
      this.workspace.workspacePath,
      this.workspace.branchName,
      commitMessage,
      this.init.author,
      this.init.metadata
    );

    await this.repoManager.pushToRadicle(this.workspace.branchName);
    this.committed = true;
    return result;
  }

  async abort(): Promise<void> {
    if (!this.workspace) return;
    await this.workspaceManager.cleanupWorkspace(this.init.taskId, this.workspace.workspacePath);
    this.workspace = undefined;
  }

  async finish(commitMessage: string): Promise<CommitResult | null> {
    try {
      if (!this.workspace) return null;

      // Optionally check if there are changes before committing
      const commitResult = await this.commitAndPush(commitMessage);
      return commitResult;
    } finally {
      if (this.workspace) {
        await this.workspaceManager.cleanupWorkspace(this.init.taskId, this.workspace.workspacePath);
        this.workspace = undefined;
      }
    }
  }
}
```

---

## 7. `RadiclePatchFlow` (PR-like abstraction)

If you want a PR-like abstraction on top of Radicle:

Responsibilities:

* Create and manage “patch” metadata linked to branches.
* Provide methods to:

  * Open a patch (title, description, branch, base).
  * Update notes (e.g. from verifier agent).
  * Retrieve diff for review.
  * Mark patch as “ready to merge” or similar.

API sketch:

```ts
export interface PatchOpenParams {
  branchName: string;
  baseBranch: string;
  title: string;
  description: string;
}

export class RadiclePatchFlow {
  constructor(private repoManager: RadicleRepoManager, private config: RadicleConfig) {}

  async openPatch(params: PatchOpenParams): Promise<RadiclePatch> {
    // create Radicle patch (e.g. via rad patch/mr/whatever CLI or metadata in repo)
    // return RadiclePatch
  }

  async updatePatchDescription(patchId: string, description: string): Promise<void> {
    // update associated metadata
  }

  async getPatchDiff(patchId: string): Promise<DiffResult> {
    // look up branch/base and call repoManager.getDiffForBranch
  }
}
```

Even if you don’t model Radicle’s patch objects initially, you can store patch metadata in a simple local store (JSON file or sqlite) keyed by `patchId`, and later integrate with Radicle CLI.

---

## 8. Integration with the rest of the system

From the perspective of your multi-agent orchestration:

1. **Task execution flow:**

   * Planner assigns a task to be executed on branch `feature/task-123`.
   * Orchestrator does:

     1. Create `RadicleSession` with:

        * `taskId = "task-123"`.
        * `branchInfo` (base `main`, name `feature/task-123`).
     2. `session.start()` → `WorkspaceInfo`.
     3. Invoke coding agents, passing `workspacePath` and repo info:

        * Worker agent reads/modifies files under `workspacePath`.
        * Instructor agent checks diffs and tests also under `workspacePath`.
     4. If successful:

        * `session.finish("task-123: implement foo feature")`
        * Optionally open/update Radicle patch via `RadiclePatchFlow`.
     5. If failed:

        * `session.abort()`.

2. **Single persistent repo guarantee:**

   * Application startup:

     * Instantiate a single `RadicleRepoManager` pointing to `config.persistentRepoPath`.
   * All `RadicleSession`s share this manager; they only differ by:

     * `branchInfo`
     * `workspacePath`
   * Use `git worktree` to avoid multiple `.git` directories.

3. **Automatic cleanup:**

   * `RadicleSession.finish` and `RadicleSession.abort` must call `WorkspaceManager.cleanupWorkspace`.
   * You may additionally have:

     * A periodic job that scans `tempRootDir` for stale dirs and removes them.
     * A “shutdown” hook to call `workspaceManager.cleanupAll()`.

---

## 9. Error handling and safety

Consider these cases:

* Failure when creating workspace:

  * Abort session, report error up to orchestrator.
* Failure when committing or pushing:

  * Do not delete workspace immediately; record error and path for debugging.
  * Optionally have a flag `persistentOnError` to keep workspace; else store patchable diff/log in another artifact.
* Failure when cleaning up:

  * Log and continue. Provide a manual `cleanupAll` method to run later.

For concurrency:

* If multiple tasks work on same branch, you must control access:

  * Easiest: “one session per branch at a time”.
  * Use a simple lock map `{ branchName → mutex }` around commit/push operations.

---

## 10. Public module API

In `src/modules/radicle/index.ts`, expose a simple facade:

```ts
export class RadicleModule {
  private repoManager: RadicleRepoManager;
  private workspaceManager: WorkspaceManager;
  private patchFlow: RadiclePatchFlow;

  constructor(private config: RadicleConfig) {
    this.repoManager = new RadicleRepoManager(config);
    this.workspaceManager = new WorkspaceManager(config);
    this.patchFlow = new RadiclePatchFlow(this.repoManager, config);
  }

  createSession(init: RadicleSessionInit): RadicleSession {
    return new RadicleSession(this.repoManager, this.workspaceManager, init);
  }

  getPatchFlow(): RadiclePatchFlow {
    return this.patchFlow;
  }

  // Optional utility methods
  async getDiff(branch: string, base: string): Promise<DiffResult> {
    return this.repoManager.getDiffForBranch(branch, base);
  }
}
```

Your higher-level orchestration code then only needs:

* `RadicleModule.createSession` for per-task work.
* Optionally `RadicleModule.getPatchFlow` for PR-like operations.

This gives you a clear, implementable architecture that:

* Uses temporary directories for runtime work.
* Keeps a single persistent Radicle/git repo on disk.
* Provides a clean, PR-like flow for agents and humans.
