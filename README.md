# Hyperagent

A developer-oriented platform for running and observing automated workflows that interact with repositories and external providers. The repository contains the client UI, server APIs, workflow runtime, and runner image used to execute steps in isolation.

## Overview

- Purpose: Define and execute workflows (DAGs) that coordinate agents, external providers, and repository operations. Provide observability (logs, provenance) and interactive controls (terminals, code-server) for operator intervention.
- Scope: Local development and CI/e2e testing. Workflow steps may run locally or in a Docker-based runner image.

## Monorepo layout

- `src/client`: Web UI built with SolidJS and Vite. Widget registry, workspace selection, and canvas layout are implemented here.
- `src/server` / `src/modules`: Express-based API server and helper modules for git, terminals (pty), workflows, and narration.
- `docker/workflow-runner`: Docker image and scripts that execute workflow steps in a contained environment and copy provenance artifacts back to the host.
- `serve`: Production wrapper to host the compiled app.
- `packages/agent` (`@hexafield/agent-workflow`): Shared workflow utilities and types used by runtime and tests.

## Quickstart

1. Install dependencies:

   `npm install`

2. Start development servers (UI + API):

   `npm run ui:dev`
   - The command starts the Express API and the Vite dev server.
   - Default UI URL: `http://localhost:5173`

3. In the UI, select a workspace repository and add widgets (Workflows, Terminals, Code-server, Narrator) as needed.

4. Run or test workflows using the Workflows widget or the server API. Provenance and run logs are written under `.hyperagent/workflow-logs/`.

## Capabilities

- Workflows: Define DAGs; planner produces execution graphs consumed by the workflow runtime. Rerun, retries, and backoff follow configured policies.
- AgentExecutor: Executes steps, emits structured events, and writes artifacts and provenance to disk.
- Runners: Steps can execute locally or inside `docker/workflow-runner` for isolation. Runners copy `.hyperagent/workflow-logs` back to the host.
- Observability: Token-level streams and structured events for narration and audit. APIs expose queue depth, retries, and runner heartbeats.
- Repository operations: Git status, branch switching, commits, and Radicle-backed pushes are supported by server helpers.

## Architecture

- Client: `src/client/src/App.tsx` bootstraps the app and lazy-loads widget modules from `widgets/registry.tsx`.
- Server: `src/server/core/server.ts` composes API routes and integrates modules from `src/modules` for workflows, narrator, terminals, and summaries.
- Workflow runtime: Implemented in `src/modules/workflows.ts` and related agent loop modules. Handles execution, retries, and delegation to runners.
- Runner: `docker/workflow-runner` executes steps with provider CLIs and copies provenance artifacts for post-run inspection; it can perform `rad` pushes after commits.

## Testing and developer tooling

- Unit and integration tests: `npm test`
- E2E tests: `npm run test:e2e`
- Storybook: `npm run storybook`
- Generate local TLS certs: `npm run certs:generate`

## Configuration

- Node requirement: Node 18 or later.
- Environment variables used by workflow agents: `WORKFLOW_AGENT_PROVIDER`, `WORKFLOW_AGENT_MODEL`, provider tokens, and Radicle credentials when running Dockerized steps.

## File locations for runtime artifacts

- Provenance and run logs: `.hyperagent/workflow-logs/`
- Runner-related scripts: `docker/workflow-runner/bin/`

## Maintenance notes

- Follow the repository layout when making changes: keep UI, server, and runner concerns separated.
- Tests should cover workflow execution and provenance handling when modifying runtime code.
