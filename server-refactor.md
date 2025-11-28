# Server Refactor Plan

## Phase 1 — Core Scaffolding
Foundation work to extract shared config, middleware, and lifecycle helpers from `ui/server/app.ts` into reusable modules.

Most reusable logic (git helpers, workflow services, review engines, etc.) should graduate into `src/modules` so it behaves like an internal Node.js library that the server consumes. Only thin HTTP wiring should stay inside the server package.

We are not keeping any backwards-compatibility shims; every refactored path must be covered by comprehensive regression tests before it replaces the legacy implementation.

- [x] Identify shared utilities (config, TLS, persistence, git helpers)
- [x] Move Express bootstrap into a new `core/server.ts`
- [x] Add tests covering the extracted helpers

## Phase 2 — Widget-Aligned Modules
Restructure backend endpoints so each front-end widget (`workspace-summary`, `workspace-workflows`, `workspace-terminal`, `workspace-code-server`, `workspace-sessions`) has a matching server module.

- [x] Create module folders and dependency contracts per widget
- [x] Move existing handlers into their respective modules
- [x] Ensure router mounting preserves current API behavior

## Phase 3 — Service Isolation
Encapsulate long-running services (workflow runtime, review scheduler, code-server sessions, terminal sockets) with explicit lifecycles.

- [ ] Define service interfaces (start/stop) per subsystem
- [ ] Wire lifecycle management through `createServerApp`
- [ ] Add unit tests for service boundaries

## Phase 4 — Observability & Cleanup
Tighten logging, error handling, and documentation after the split to ensure maintainability.

- [ ] Centralize structured logging for each module
- [ ] Document new architecture in `architecture.md`
- [ ] Remove deprecated code paths from the old monolith
