# Pull Request Review System – Functional Spec

This document defines the backend contracts, persistence, HTTP routes, and Docker-based runner backend that power the `review.md` view. All code is TypeScript in `src/modules`, following the repository's factory/module conventions.

---

## 1. Goals and Scope

- Expose a first-class pull-request abstraction over Radicle branches (patch support can follow the same shape).
- Persist PR metadata, commits, review runs, and inline comments so server restarts never lose state.
- Execute LLM-powered code reviews that produce summaries, inline feedback, and patch suggestions.
- Run every review inside an isolated Docker runner so long analyses cannot block the API server and can be retried.
- Keep the implementation minimal, modular, and active by default (no gates/flags).

Non-goals for v1: merge conflict UX, Radicle patch parity, or human approval workflows.

---

## 2. Domain Model (Persistent Tables)

All tables live in the shared persistence layer that already powers workflows.

```ts
export type PullRequestId = string
export type ReviewRunId = string
export type ReviewThreadId = string
export type ReviewCommentId = string
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

export interface PullRequest {
  id: PullRequestId
  projectId: string
  title: string
  description?: string
  sourceBranch: string
  targetBranch: string
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
  createdAt: string
}

export interface PullRequestEvent {
  id: string
  pullRequestId: PullRequestId
  kind: PullRequestEventKind
  actorUserId?: string
  createdAt: string
  data: Record<string, unknown>
}

export interface ReviewRun {
  id: ReviewRunId
  pullRequestId: PullRequestId
  trigger: 'manual' | 'auto_on_open' | 'auto_on_update'
  runnerAgent: 'docker'
  status: 'queued' | 'running' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string
  summary?: string
  highLevelFindings?: string
  riskAssessment?: string
  runnerInstanceId?: string
  logsPath?: string
}

export interface ReviewThread {
  id: ReviewThreadId
  pullRequestId: PullRequestId
  reviewRunId?: ReviewRunId
  filePath: string
  diffHunkRange: { startLine: number; endLine: number }
  fileLine?: number
  resolved: boolean
  createdAt: string
  resolvedAt?: string
}

export interface ReviewComment {
  id: ReviewCommentId
  threadId: ReviewThreadId
  authorUserId?: string
  authorKind: 'user' | 'agent'
  body: string
  suggestedPatch?: string
  createdAt: string
}

export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  previousPath?: string
  hunks: DiffHunk[]
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed'
  oldLineNumber?: number
  newLineNumber?: number
  content: string
}
```

---

## 3. Module Interfaces

Each module is exported via a factory to keep dependencies explicit and testable.

### 3.1 Pull Request Module (`src/modules/pullRequest/index.ts`)

```ts
export type PullRequestModule = ReturnType<typeof createPullRequestModule>

export function createPullRequestModule(deps: {
  prRepo: PullRequestRepository
  commitRepo: PullRequestCommitRepository
  eventRepo: PullRequestEventRepository
  radicle: RadicleModule
}) {
  return {
    createPullRequest,
    listPullRequests,
    getPullRequestWithCommits,
    updatePullRequestCommits,
    mergePullRequest,
    closePullRequest
  }

  async function createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    /* ... */
  }
  async function listPullRequests(projectId: string): Promise<PullRequest[]> {
    /* ... */
  }
  async function getPullRequestWithCommits(id: string): Promise<PullRequestDetail> {
    /* ... */
  }
  async function updatePullRequestCommits(id: string): Promise<void> {
    /* ... */
  }
  async function mergePullRequest(id: string, actorUserId: string): Promise<void> {
    /* ... */
  }
  async function closePullRequest(id: string, actorUserId: string): Promise<void> {
    /* ... */
  }
}
```

Responsibilities: validate Radicle branches, compute commit deltas via `radicle.repoManager`, persist events, and expose PR detail aggregations for the API.

### 3.2 Diff Module (`src/modules/diff/index.ts`)

```ts
export function createDiffModule(radicle: RadicleModule) {
  return { getPullRequestDiff }

  async function getPullRequestDiff(pr: PullRequest): Promise<FileDiff[]> {
    const diff = await radicle.getDiffForBranch(pr.sourceBranch, pr.targetBranch)
    return parseUnifiedDiff(diff.diffText)
  }
}
```

The parsed diff feeds both the UI diff viewer and the review engine.

### 3.3 Review Engine Module (`src/modules/reviewEngine/index.ts`)

```ts
export interface ReviewEngineResult {
  summary: string
  highLevelFindings: string[]
  riskAssessment: string
  fileComments: Array<{
    filePath: string
    hunkComments: Array<{
      diffHunkHeader: string
      comment: string
      severity: 'info' | 'suggestion' | 'warning' | 'critical'
      suggestedPatch?: string
    }>
  }>
}

export function createReviewEngineModule(llmClient: LLMClient) {
  return { reviewPullRequest }

  async function reviewPullRequest(input: ReviewEngineInput): Promise<ReviewEngineResult> {
    // chunk diff, stream through LLM, normalize into structured output
  }
}
```

### 3.4 Review Scheduler Module (`src/modules/reviewScheduler/index.ts`)

```ts
export function createReviewSchedulerModule(deps: {
  reviewRunRepo: ReviewRunRepository
  threadRepo: ReviewThreadRepository
  commentRepo: ReviewCommentRepository
  eventRepo: PullRequestEventRepository
  prModule: PullRequestModule
  diffModule: DiffModule
  reviewEngine: ReviewEngineModule
  runnerGateway: ReviewRunnerGateway
}) {
  return { requestReview, handleRunnerCallback }

  async function requestReview(prId: PullRequestId, trigger: ReviewRun['trigger']): Promise<ReviewRun> {
    const run = await reviewRunRepo.create({
      pullRequestId: prId,
      trigger,
      runnerAgent: 'docker',
      status: 'queued',
      createdAt: new Date().toISOString()
    })
    await eventRepo.create({
      pullRequestId: prId,
      kind: 'review_requested',
      createdAt: new Date().toISOString(),
      data: { runId: run.id, trigger }
    })
    await runnerGateway.enqueue(run.id)
    return run
  }

  async function handleRunnerCallback(payload: RunnerCallbackPayload): Promise<void> {
    if (payload.status === 'failed') {
      await reviewRunRepo.update(payload.runId, {
        status: 'failed',
        logsPath: payload.logsPath
      })
      await eventRepo.create({
        pullRequestId: payload.pullRequestId,
        kind: 'review_run_completed',
        createdAt: new Date().toISOString(),
        data: { runId: payload.runId, status: 'failed' }
      })
      return
    }

    const { pullRequest, commits } = await prModule.getPullRequestWithCommits(payload.pullRequestId)
    const diff = await diffModule.getPullRequestDiff(pullRequest)
    const engineResult = await reviewEngine.reviewPullRequest({ pullRequest, diff, commits })

    await reviewRunRepo.update(payload.runId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      summary: engineResult.summary,
      highLevelFindings: engineResult.highLevelFindings.join('\n'),
      riskAssessment: engineResult.riskAssessment,
      logsPath: payload.logsPath
    })

    for (const file of engineResult.fileComments) {
      for (const comment of file.hunkComments) {
        const thread = await threadRepo.create({
          /* map diffHunkHeader -> range */
        })
        await commentRepo.create({
          threadId: thread.id,
          authorKind: 'agent',
          body: comment.comment,
          suggestedPatch: comment.suggestedPatch,
          createdAt: new Date().toISOString()
        })
        await eventRepo.create({
          pullRequestId: pullRequest.id,
          kind: 'comment_added',
          createdAt: new Date().toISOString(),
          data: { threadId: thread.id, runId: payload.runId }
        })
      }
    }

    await eventRepo.create({
      pullRequestId: pullRequest.id,
      kind: 'review_run_completed',
      createdAt: new Date().toISOString(),
      data: { runId: payload.runId, status: 'completed' }
    })
  }
}
```

### 3.5 Threads + Comments Module (`src/modules/reviewComments/index.ts`)

Provides CRUD helpers for UI actions such as replying, resolving, or applying suggestions. The scheduler depends on this module for persistence, and the UI server calls it directly for human comments.

### 3.6 Review Runner Gateway (`src/modules/reviewRunnerGateway/index.ts`)

Abstraction over Docker orchestration. Minimal interface:

```ts
export interface ReviewRunnerGateway {
  enqueue(runId: ReviewRunId): Promise<void>
}
```

Implementation details live in section 5; the gateway simply shells out to Docker (or a supervisor) and stores the created container/job id back onto the `ReviewRun` record.

---

## 4. HTTP Surface

All routes are served from `ui/server/app.ts` using the existing Fastify-style conventions.

- `GET /api/projects/:projectId/pull-requests` → list PRs (`PullRequestModule.listPullRequests`).
- `POST /api/projects/:projectId/pull-requests` → create PR (source/target, title, description).
- `GET /api/pull-requests/:prId` → PR detail including commits + events + latest review summary.
- `POST /api/pull-requests/:prId/merge` → merge PR.
- `POST /api/pull-requests/:prId/close` → close PR.
- `GET /api/pull-requests/:prId/diff` → `FileDiff[]`.
- `GET /api/pull-requests/:prId/threads` → threads + comments.
- `POST /api/threads/:threadId/comments` → add comment (user or agent service).
- `POST /api/threads/:threadId/resolve` → mark resolved.
- `POST /api/pull-requests/:prId/reviews` → trigger review (`ReviewSchedulerModule.requestReview`).
- `POST /api/review-runs/:runId/callback` → runner callback hitting `handleRunnerCallback`.

All endpoints reuse the shared `ProjectAuthContext` (same as workflows) to ensure a project cannot escalate into another workspace.

---

## 5. Docker Runner Architecture

Each review run executes inside a disposable container so the API server remains responsive and failures do not poison global state.

### 5.1 Image & Entry Point

- Base image: official `node:20-bullseye` or an internal derivative that already contains Radicle + git tooling.
- Layer in project-specific CLI deps using `npm i package@latest` (per instructions) during image build.
- Entrypoint script `runner/review-entrypoint.ts` bundled into the image via `ts-node` or compiled JS.

### 5.2 Runtime Inputs

Runner receives everything via environment variables and mounted volumes:

| Variable          | Meaning                                           |
| ----------------- | ------------------------------------------------- |
| `REVIEW_RUN_ID`   | ReviewRun primary key                             |
| `PULL_REQUEST_ID` | PullRequest id                                    |
| `PROJECT_ID`      | Owning project                                    |
| `RADICLE_SEED`    | Seed URL to clone                                 |
| `SOURCE_BRANCH`   | PR head                                           |
| `TARGET_BRANCH`   | PR base                                           |
| `CALLBACK_URL`    | Server endpoint for status updates                |
| `CALLBACK_TOKEN`  | HMAC/shared secret for authentication             |
| `LLM_PROVIDER`    | Provider slug (reused from workflow agent config) |
| `LLM_MODEL`       | Model name                                        |

The host mounts the Radicle working copy (read-only) plus an ephemeral `/runner/output` directory where logs and artifacts land.

### 5.3 Runner Steps

1. Checkout Radicle project (if not already mounted) and fetch source/target branches.
2. Generate unified diff (`git diff target...source`).
3. Package payload for the API server (diff metadata, commit list) and optionally cache to disk for debugging.
4. Call `POST CALLBACK_URL` with `{ runId, pullRequestId, status: 'started' }` once containers boot.
5. Execute `reviewEngine.reviewPullRequest` (inside the container) using the same shared modules so parity between in-process tests and runner execution is maintained.
6. Write detailed logs to `/runner/output/review.log` and include path in callback.
7. On success, send `{ status: 'completed', logsPath }`; on failure send `{ status: 'failed', error, logsPath }`.

### 5.4 Gateway Implementation Sketch

```ts
export function createDockerReviewRunnerGateway(deps: {
  docker: DockerClient
  projectsDir: string
  callbackUrl: string
  callbackToken: string
}) {
  return { enqueue }

  async function enqueue(runId: ReviewRunId) {
    const run = await deps.reviewRunRepo.getById(runId)
    const pr = await deps.pullRequestRepo.getById(run.pullRequestId)
    const container = await deps.docker.run({
      image: 'hyperagent/review-runner:latest',
      env: buildEnv(pr, run),
      mounts: [
        `${deps.projectsDir}/${pr.projectId}:/workspace:ro`,
        `/var/log/hyperagent/reviews/${run.id}:/runner/output`
      ]
    })
    await deps.reviewRunRepo.update(runId, {
      status: 'running',
      runnerInstanceId: container.id,
      logsPath: `/var/log/hyperagent/reviews/${run.id}`
    })
  }
}
```

---

## 6. Review Flow (End-to-End)

1. User opens PR detail UI and clicks **Run Review** (or auto-trigger fires on creation/update).
2. Server calls `requestReview`, inserts `ReviewRun`, emits event, enqueues Docker job.
3. Runner container starts, clones repo (or uses mounted workspace), sends `review_run_started` callback.
4. Runner executes review logic, stores artifacts, and posts completion payload.
5. Scheduler handles callback, runs ReviewEngine in-process (optional optimization: execute engine fully inside container, then callback with serialized result), persists summary + inline comments, emits `review_run_completed`.
6. UI subscribes via existing polling/stream channels and renders latest review summary and inline comments.

Parallel runs are safe because each run has an isolated Docker container and persistence row; scheduling can simply look for `status = 'queued'` entries on boot to resume work.

---

## 7. Failure & Retry Semantics

- Runner crash or timeout → callback never arrives; a watchdog marks the run `failed` after `RUNNER_TIMEOUT_MS` and exposes logs to the UI.
- User can re-trigger review; a new run row is created, leaving historical runs intact for auditing.
- If scheduler crashes mid-processing, unhandled callbacks can be retried because callback payloads are idempotent (`runId` is unique).

---

## 8. UI Integration Notes

- `web/src/pages/WorkflowDetailPage.tsx` already fetches workflow data; mirror that approach for PR pages using the HTTP routes above.
- Inline comments use the same `DiffViewer` component; agent comments show an "Agent" badge and an **Apply suggestion** button that issues a `POST /api/pull-requests/:id/apply-suggestion` call which applies the patch via the Radicle session and commits with metadata referencing `reviewCommentId`.
- Review summaries appear at the top of the conversation tab, populated from the latest completed `ReviewRun` record.

---

This specification keeps the implementation modular, activates new functionality without feature flags, and guarantees tests will fail if any module deviates from the contracts described above.
