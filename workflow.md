# Workflow Tracker

- [x] Ensure workflow outputs messages with accessible provenance logs
- [x] Add deterministic Docker-backed e2e workflow execution
- [x] Validate the agentic PR workflow via TDD suites
- [x] Integrate the real agent provider into the runtime
  - [x] Replace the deterministic executor with `createAgentWorkflowExecutor` inside the workflow runtime factory and plumb provider/model env vars through the server
  - [x] Persist agent stream metadata/log paths on each run so provenance views expose live provider context
  - [x] Document the provider requirements (CLI availability, tokens, models) and validate config at server startup
- [x] Wire Radicle pushes to actual remotes
  - [x] Teach the Radicle repo manager to read per-project remotes/default branches and push after each commit
  - [x] Surface Radicle registration status via API + CLI health command so workflows can fail fast when remotes are unreachable
  - [x] Add an integration test that exercises `rad push` invocation with a fake remote to avoid regressions
  - [x] Ensure the Docker workflow runner executes `rad push` after each commit (CLI + credentials baked into the container image)
- [ ] Harden workflow runner infrastructure and monitoring
  - [x] Emit structured enqueue/execute events (status + latency) to stdout and persist them for later dashboards/alerts
  - [x] Add exponential backoff with jitter plus dead-letter recording for steps that exceed retry budgets
  - [x] Expose a `/health/workflows` endpoint that reports queue depth, stuck runners, and last heartbeat timestamps
- [x] Surface planner/workflow provenance in the UI
  - [x] Extend the workflows API to return provenance log metadata + planner task mappings per step
  - [x] Render provenance + agent verdicts inside the workflow detail page, linking directly to `.hyperagent/workflow-logs/*`
  - [x] Add a lightweight timeline widget showing planner task -> workflow step -> PR events
- [x] Implement security and governance policy hooks
  - [x] Introduce a policy middleware that inspects requested workflow kinds vs. org rules before queueing steps
  - [x] Require approval tokens (or policy overrides) for workflows touching protected branches and record the decision in persistence
  - [x] Audit each workflow step completion with the acting runner identity + policy context for traceability
- [ ] Finalize Docker multi-agent workflow loop
  - [x] Ensure the Docker runner image bundles the configured agent provider CLI/tokens and the e2e suite exercises the multi-agent execution path
  - [x] Sync `.hyperagent/workflow-logs` and Radicle commit metadata from remote containers back to the server so UI links and provenance downloads work for Docker runs
  - [x] Surface Radicle branch + commit status (and resulting PR/patch links) in the workflow detail UI for remote executions
  - [x] Document container volume/env requirements plus health validations so ops can confirm Docker reaches both the agent provider and Radicle daemon before runs
- [x] Broaden unit and e2e coverage beyond the happy path
  - [x] Add unit tests that cover runner enqueue failures, agent fallback flows, and Radicle push errors
  - [x] Expand the Docker e2e suite with multi-step workflows, runner restarts, and PR skip scenarios
  - [x] Gate CI on a nightly workflow matrix (sqlite + Postgres, macOS + Linux) to catch platform regressions

## Docker runner operations

- Mount the repository workspace into `/workspace` and persist `.hyperagent/workflow-logs` so provenance JSON survives container cleanup; the runtime now copies workspace artifacts back into the host repository on every runner callback.
- Provide provider credentials via `WORKFLOW_AGENT_PROVIDER`, `WORKFLOW_AGENT_MODEL`, and the appropriate token env vars before invoking `docker run`; the runner image already includes a mock `opencode` CLI that writes structured logs to `$OPENCODE_LOG_DIR` for health probes.
- Supply Radicle identity files or forward the daemon socket when running on CI; the bundled `rad` helper ensures `rad push` invocations succeed even when the canonical CLI is unavailable.
- Validate connectivity ahead of runs via `/api/health/workflows` (now streaming recent runner events) and `/api/health/radicle` so operations teams can confirm Docker has the required network access.
