# npm module quickstart

This module turns any npm package into a machine-orchestratable asset. It can:

- Download a package tarball directly from the registry, resolve its entry point, and statically analyze the TypeScript AST.
- Emit structured "contracts" for every exported function, class, or object, complete with Zod expressions and JSON Schema that describe inputs/outputs (including async `Promise` return values).
- Install, uninstall, or otherwise manage dependencies inside an arbitrary working directory via shell-safe `npm` commands.
- Invoke any exported contract inside an isolated `worker_threads` sandbox, validating arguments against the captured schemas before dispatching.

## Public API

| Function | Description |
| --- | --- |
| `generatePackageContracts(spec: string)` | Extracts the package identified by `spec` (name, range, tarball URL, etc.), walks its exports, and returns a `PackageIntrospection` bundle of contracts. Contracts now record `isAsync` plus `Promise` schemas so orchestration layers know when to await results. |
| `installDependencies(pkgs: string[], opts)` / `uninstallDependencies(pkgs: string[], opts)` | Thin wrappers around `npm install/uninstall` that respect `cwd`, `--save-dev`, and optional registry overrides. |
| `invokeLibraryContract(options)` | Executes a function or class contract by spinning up a worker, loading the package relative to `options.cwd`, validating args with Zod, and proxying the result (awaiting async functions automatically). |

## Typical flow

1. **Introspect**: `const report = await generatePackageContracts('lodash@latest')`.
2. **Select contract**: pick a `FunctionContract`, `ClassContract`, or `ObjectContract` from `report.contracts`.
3. **Install deps**: `await installDependencies(['lodash@latest'], { cwd })`.
4. **Invoke**: `await invokeLibraryContract({ cwd, packageSpecifier: 'lodash', contract, args: [...] })`.

The returned contracts ship with:

- `tsType` string for quick inspection.
- `recipe` (internal ADT) -> `zod` expression -> JSON Schema for machine-readable IO.
- `isAsync` on callable exports plus `promise` recipe nodes so downstream planners can await flows correctly.

## Testing & validation

- Unit tests live in `src/modules/npm.test.ts`. They mock registry/network calls while exercising real workers for invocation.
- Run `npm run test` (or `npx vitest run src/modules/npm.test.ts`) after modifying the module.
- When adding dependencies for analysis, follow the repo rule: `npm i package@latest`.

## Notes

- Contract generation relies on TypeScript's compiler API; ensure `tsconfig.json` stays aligned with the features you need to introspect.
- JSON Schema cannot serialize Promises directly, so the generator annotates the resolved shape while recording async metadata separately.
- Worker executions clean up temporary anchor files automatically and support configurable timeouts via `options.timeoutMs`.
