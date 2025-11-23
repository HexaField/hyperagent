Here is a concrete, modular architecture for a **Pull Request Review** module over your Radicle repositories, with:

- A PR workflow (branch/patch-based).
- GitHub-style UI (timeline + commits + diff + comments).
- LLM-powered comprehensive review (like CodeRabbit / Claude Code / Copilot).

You can treat this as a set of small modules that plug into your existing Radicle + Studio + Workflow setup.

---

## 1. Core goals and boundaries

**Goals:**

- Provide a first-class “Pull Request” abstraction over Radicle branches/patches.
- Show GitHub-like UI:
  - PR list
  - PR detail:
    - Header (title, status, branches)
    - Timeline of events (open, updates, reviews, comments)
    - Commit list
    - File tree + diff
    - Inline comments

- Run LLM-based code review on demand (or automatically) and surface:
  - Global summary
  - Per-file/per-hunk comments
  - Concrete suggestions (including patch snippets).

**Non-goals (v1):**

- Complex merge strategies (just assume fast-forward or simple merge handled elsewhere).
- Full Radicle patch protocol implementation (you can adapt later; start with branches).

---

## 2. Domain model

Define PR-related entities in your DB layer (types + tables). Focus on Radicle and branches; you can later plug in Radicle patch IDs.

### 2.1. Types

```ts
export type PullRequestId = string
export type ReviewRunId = string
export type ReviewCommentId = string
export type ReviewThreadId = string

export interface PullRequest {
  id: PullRequestId
  projectId: string
  title: string
  description?: string

  // Branch-based diff; optionally also a Radicle patch id
  sourceBranch: string // head
  targetBranch: string // base, e.g. "main"

  radiclePatchId?: string

  status: 'open' | 'merged' | 'closed'
  authorUserId: string

  createdAt: string
  updatedAt: string
  mergedAt?: string
  closedAt?: string
}

export interface PullRequestCommit {
  id: string
  pullRequestId: PullRequestId
  commitHash: string
  message: string
  authorName: string
  authorEmail: string
  authoredAt: string
  createdAt: string // record creation time in DB
}

export interface ReviewRun {
  id: ReviewRunId
  pullRequestId: PullRequestId
  trigger: 'manual' | 'auto_on_open' | 'auto_on_update'
  status: 'queued' | 'running' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string

  // Global review summary and suggestions
  summary?: string
  highLevelFindings?: string // bullet points
  riskAssessment?: string // "low/medium/high", text explanation
}

export interface ReviewThread {
  id: ReviewThreadId
  pullRequestId: PullRequestId
  reviewRunId?: ReviewRunId // optional: which review run created it
  filePath: string
  // line positions are "position in diff" and "position in file"
  // to handle moved lines
  diffHunkRange: {
    startLine: number
    endLine: number
  }
  fileLine?: number
  resolved: boolean
  createdAt: string
  resolvedAt?: string
}

export interface ReviewComment {
  id: ReviewCommentId
  threadId: ReviewThreadId
  authorUserId?: string // null for system/agent
  authorKind: 'user' | 'agent'
  body: string
  createdAt: string

  // optional link to suggested patch
  suggestedPatch?: string // unified diff snippet
}
```

You will also want a generic `PullRequestEvent` table to back the timeline:

```ts
export type PullRequestEventKind =
  | 'opened'
  | 'closed'
  | 'merged'
  | 'commit_added'
  | 'review_requested'
  | 'review_run_started'
  | 'review_run_completed'
  | 'comment_added'
  | 'comment_resolved'

export interface PullRequestEvent {
  id: string
  pullRequestId: PullRequestId
  kind: PullRequestEventKind
  actorUserId?: string // user/system/agent
  createdAt: string
  data: any // JSON metadata per event type
}
```

### 2.2. Diff representation

Use a lightweight diff model, generated through Radicle/git:

```ts
export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  previousPath?: string
  hunks: DiffHunk[]
}

export interface DiffHunk {
  header: string // @@ -a,b +c,d @@
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed'
  oldLineNumber?: number
  newLineNumber?: number
  content: string // line text
}
```

This is the input for both the UI and the reviewer agent.

---

## 3. Modules and responsibilities

Break it into several small modules:

1. `PullRequestModule` – PR lifecycle, commits, events.
2. `DiffModule` – diff calculation via Radicle/git.
3. `ReviewEngineModule` – LLM-based review over diffs.
4. `ReviewSchedulerModule` – orchestrator that triggers ReviewEngine runs and persists outputs.
5. UI integration – PR list/detail, diff viewer, timeline, comments.

### 3.1. PullRequestModule

File: `src/modules/pullRequest/index.ts`

Responsibilities:

- CRUD for PRs.
- Track commits for a PR (via Radicle/git).
- Emit PR events (opened, updates, merged, etc).
- Provide PR views for API/UI.

Key API:

```ts
class PullRequestModule {
  constructor(
    private prRepo: PullRequestRepository,
    private commitRepo: PullRequestCommitRepository,
    private eventRepo: PullRequestEventRepository,
    private radicle: RadicleModule
  ) {}

  async createPullRequest(params: {
    projectId: string
    title: string
    description?: string
    sourceBranch: string
    targetBranch: string
    authorUserId: string
    radiclePatchId?: string
  }): Promise<PullRequest> {
    // validate branches exist via radicle
    // compute initial commit set
    // persist PR + commits + "opened" event
  }

  async updatePullRequestCommits(prId: PullRequestId): Promise<void> {
    // recompute commit list from Radicle branch range
    // insert new ones, emit "commit_added" events
  }

  async listPullRequests(projectId: string): Promise<PullRequest[]> {
    /* ... */
  }

  async getPullRequestWithCommits(prId: PullRequestId): Promise<{
    pullRequest: PullRequest
    commits: PullRequestCommit[]
    events: PullRequestEvent[]
  }> {
    /* ... */
  }

  async mergePullRequest(prId: PullRequestId, actorUserId: string): Promise<void> {
    // call Radicle module to merge source into target
    // update PR status, add events
  }

  async closePullRequest(prId: PullRequestId, actorUserId: string): Promise<void> {
    // status -> closed, event
  }
}
```

### 3.2. DiffModule

Uses `RadicleModule` and git to compute diffs for PRs.

File: `src/modules/diff/index.ts`

```ts
class DiffModule {
  constructor(private radicle: RadicleModule) {}

  async getPullRequestDiff(pr: PullRequest): Promise<FileDiff[]> {
    // use radicle.repoManager.getDiffForBranch(pr.sourceBranch, pr.targetBranch)
    // parse into FileDiff[]
  }
}
```

This is shared by:

- PR UI (diff viewer).
- ReviewEngine (LLM input).

---

## 4. Review engine

### 4.1. ReviewEngineModule

This is your LLM agent that does the code review.

File: `src/modules/reviewEngine/index.ts`

Responsibilities:

- Given a PR and its diff, produce:
  - Global summary and high-level findings.
  - Per-file/per-hunk comments and suggestions.

Shape of result:

```ts
export interface ReviewEngineResult {
  summary: string
  highLevelFindings: string[]
  riskAssessment: string
  fileComments: FileReviewResult[]
}

export interface FileReviewResult {
  filePath: string
  hunkComments: HunkReviewComment[]
}

export interface HunkReviewComment {
  diffHunkHeader: string // or numeric range
  comment: string
  severity: 'info' | 'suggestion' | 'warning' | 'critical'
  suggestedPatch?: string // unified diff snippet limited to that file/hunk
}
```

API:

```ts
class ReviewEngineModule {
  constructor(private llmClient: LLMClient) {}

  async reviewPullRequest(input: {
    pullRequest: PullRequest
    diff: FileDiff[]
    commits: PullRequestCommit[]
    context?: {
      projectPrinciples?: ArchitecturalPrinciple[]
      codingGuidelines?: string
    }
  }): Promise<ReviewEngineResult> {
    // slice diff into chunks appropriate for LLM
    // run one or more LLM calls
    // aggregate into ReviewEngineResult
  }
}
```

Internally you can:

- First call: global summary + high-level findings (based on summary of diffs/commits).
- Second layer: per-file/per-hunk pass, chunked and parallelised.

### 4.2. ReviewSchedulerModule

File: `src/modules/reviewScheduler/index.ts`

Responsibilities:

- Manage `ReviewRun` entities.
- Queue and execute review runs (could integrate with your existing Workflow worker).
- Create review threads/comments from engine results.
- Emit PR events.

API:

```ts
class ReviewSchedulerModule {
  constructor(
    private reviewRunRepo: ReviewRunRepository,
    private threadRepo: ReviewThreadRepository,
    private commentRepo: ReviewCommentRepository,
    private eventRepo: PullRequestEventRepository,
    private prModule: PullRequestModule,
    private diffModule: DiffModule,
    private reviewEngine: ReviewEngineModule
  ) {}

  async requestReview(prId: PullRequestId, trigger: ReviewRun['trigger']): Promise<ReviewRun> {
    const pr = await this.prModule.getPullRequest(prId)
    const run = await this.reviewRunRepo.create({
      pullRequestId: prId,
      trigger,
      status: 'queued',
      createdAt: new Date().toISOString()
    })

    await this.eventRepo.create({
      pullRequestId: prId,
      kind: 'review_run_started',
      createdAt: new Date().toISOString(),
      data: { reviewRunId: run.id, trigger }
    })

    // Could push to a worker queue; for now, call processReviewRun
    return run
  }

  async processReviewRun(runId: ReviewRunId): Promise<void> {
    const run = await this.reviewRunRepo.findById(runId)
    if (!run) return

    await this.reviewRunRepo.update(runId, { status: 'running' })

    const { pullRequest, commits, events } = await this.prModule.getPullRequestWithCommits(run.pullRequestId)
    const diff = await this.diffModule.getPullRequestDiff(pullRequest)

    const engineResult = await this.reviewEngine.reviewPullRequest({
      pullRequest,
      diff,
      commits,
      context: {
        /* e.g. project-level coding guide from planner */
      }
    })

    // Persist summary into ReviewRun
    await this.reviewRunRepo.update(runId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      summary: engineResult.summary,
      highLevelFindings: engineResult.highLevelFindings.join('\n'),
      riskAssessment: engineResult.riskAssessment
    })

    // Create threads and comments from fileComments
    for (const fileReview of engineResult.fileComments) {
      for (const c of fileReview.hunkComments) {
        const thread = await this.threadRepo.create({
          pullRequestId: pullRequest.id,
          reviewRunId: runId,
          filePath: fileReview.filePath,
          diffHunkRange: deriveRangeFromHeader(c.diffHunkHeader),
          resolved: false,
          createdAt: new Date().toISOString()
        })

        await this.commentRepo.create({
          threadId: thread.id,
          authorKind: 'agent',
          body: c.comment,
          suggestedPatch: c.suggestedPatch,
          createdAt: new Date().toISOString()
        })

        await this.eventRepo.create({
          pullRequestId: pullRequest.id,
          kind: 'comment_added',
          createdAt: new Date().toISOString(),
          data: { threadId: thread.id, source: 'review_engine' }
        })
      }
    }

    await this.eventRepo.create({
      pullRequestId: pullRequest.id,
      kind: 'review_run_completed',
      createdAt: new Date().toISOString(),
      data: { reviewRunId: runId }
    })
  }
}
```

You can hook `requestReview` into:

- On PR open (`auto_on_open`).
- On new commits (`auto_on_update`).
- Manual “Run review” button in UI (`manual`).

---

## 5. UI design (GitHub-like PR view)

### 5.1. PR list

Route: `/projects/:projectId/pulls`

- Columns: PR # (id), title, source → target, status, author, last updated.
- Filters: open/closed, mine, branch.

Backend endpoint:

- `GET /api/projects/:projectId/pull-requests`

Uses `PullRequestModule.listPullRequests`.

### 5.2. PR detail view

Route: `/projects/:projectId/pulls/:prId`

Layout:

1. **Header:**
   - Title, status chip, sourceBranch → targetBranch.
   - Author, created date.
   - Buttons:
     - “Merge” (if checks pass).
     - “Close”.
     - “Run Review”.

2. **Tabs:**
   - Conversation
   - Commits
   - Files changed (diff)

#### Conversation tab

- Timeline UI built from `PullRequestEvent`:
  - Opened event (with description).
  - New commits (“commit_added”).
  - Review runs (“review_run_started/completed”).
  - Comments (thread-level).
  - Resolution events.

- At top: latest review summary:
  - `ReviewRun.summary`, `highLevelFindings`, `riskAssessment`.

- Comment box for top-level discussion.

Backend endpoints:

- `GET /api/pull-requests/:id` → PR + commits + events + latest review run info.
- `POST /api/pull-requests/:id/comments` (top-level).

#### Commits tab

- List commits from `PullRequestCommit`:
  - Hash, message, author, time.

- Clicking a commit:
  - Show commit diff (via DiffModule with base = previous commit or target branch).
  - You can also let the LLM review per-commit later if needed.

#### Files changed tab

- File tree left; diff viewer right.
- Data from `DiffModule.getPullRequestDiff`.
- Inline comments:
  - List threads for each file and hunk; annotate lines in diff.
  - When clicking a line, show existing comments and allow new comment (stored as human `ReviewComment` with `authorKind = 'user'`).

- For LLM comments:
  - Show them as comments with agent badge and “Apply suggestion” button (if `suggestedPatch` present).

Backend endpoints:

- `GET /api/pull-requests/:id/diff` → `FileDiff[]`.
- `GET /api/pull-requests/:id/threads` → threads + comments.
- `POST /api/threads/:threadId/comments` → add comment.
- `POST /api/threads/:threadId/resolve` → mark resolved.

---

## 6. Integration with Radicle + agents

### 6.1. PR creation and patches

Initially:

- PR is defined by `sourceBranch` and `targetBranch` in your Radicle repo.
- When you add Radicle patches:
  - `radiclePatchId` maps to Radicle’s patch object.
  - `PullRequestModule` can sync status from/to patch if you integrate CLI later.

### 6.2. Applying suggestions

For comments with `suggestedPatch`:

- Backend route: `POST /api/pull-requests/:id/apply-suggestion`
  - Payload: `threadId`, `commentId`.

- Flow:
  - Use `RadicleSession` on `sourceBranch`:
    - Apply `suggestedPatch` using `git apply` in workspace.
    - Commit with message referencing the comment/thread.
    - Push to Radicle.

  - Update PR’s commit list.
  - Optionally re-run review.

You can route this either:

- Directly via `RadicleModule` in a small helper.
- Or as a `workflow_step` executed by the workflow worker (if you want full auditability).

### 6.3. Planner and architecture context

Feed planner outputs (architecture + guidelines) into ReviewEngine:

- Project-level:
  - Store `ImplementationGuides` and `ArchitectureOverview` in `projects` or `planner_runs`.

- When calling `ReviewEngineModule.reviewPullRequest`, include:
  - Principles.
  - Coding guidelines.
  - Key architectural decisions.

This gives you “architecture-aware” review, not just localized diff linting.

---

## 7. Persistence and parallel workflows

Because your platform now has a workflow runtime and DB:

- `PullRequest`, `ReviewRun`, `ReviewThread`, `ReviewComment`, and `PullRequestEvent` are just more persistent tables.
- Reviews can be run in parallel:
  - `ReviewSchedulerModule.requestReview` inserts a `ReviewRun` with `status = 'queued'`.
  - Your worker picks up queued runs (similar to workflow steps), calls `processReviewRun`, and updates DB.

- On server restart:
  - Existing PRs, comments, review runs are all intact.
  - Any `ReviewRun` stuck in `running` can be marked as `failed` or `queued` again on startup.

---

## 8. Summary of modules

To keep things small and modular:

- `pullRequest` module
  - PR lifecycle, commits, events, merge/close.

- `diff` module
  - Compute diffs between source/target branches using Radicle/git.

- `reviewEngine` module
  - LLM-based code review, returning structured suggestions.

- `reviewScheduler` module
  - Manage `ReviewRun` lifecycle, persist summaries, create threads/comments, emit events.

- `comments` module (optional separate)
  - CRUD for `ReviewThread` + `ReviewComment`, used by both humans and agent.

- UI layer
  - PR list + detail (timeline, commits, diff + comments), “Run Review” and “Apply suggestion” actions.

This will give you a first-class, Radicle-native PR review system with a GitHub-like UI and advanced review suggestions, fully integrated with your agents and workflows.
