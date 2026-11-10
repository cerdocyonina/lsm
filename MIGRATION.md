# Shared connections migration

The master now stores hosts (agent access), services (backend/inbound bindings), shared connection templates, and profile memberships separately. The CLI and its build output were removed; import/export and diagnostics remain available in the web admin.

## Updating the master

1. Stop both the subscription and admin processes. They must run the same version.
2. Back up the SQLite database while stopped, including any `-wal`/`-shm` files if present, and keep the previous release available. A SQLite `.backup` is another option.
3. Install dependencies with `bun install --frozen-lockfile`, build with `bun run build`, then start both processes.
4. Check **Servers** and each profile's connections, ordering, and subscription output. Use **Sync** on each service to reconcile existing backend users when desired. Migration itself does not push users or modify backend configuration.

The transactional migration groups legacy nodes by administrator, agent origin, and secret, preserving their backend paths and inbound IDs. Identical templates attached to the same service are shared across profiles. Distinct variants and duplicate entries within a profile remain separate. Users, UUIDs, generated credentials, subscription tokens, fetch timestamps, profile names, membership labels, and ordering are retained. Host names initially use the agent hostname and can be edited.

Profile link-name overrides start empty, preserving existing subscription fragments. Setting one changes only that profile's link label. New services remain excluded until selected. “All current connections” is a one-time selection, not an automatic rule for future services.

Full exports preserve unassigned connections, unused hosts/services, shared membership identity, and profile link-name overrides. Legacy imports remain supported. A profile export contains its own selected connections; use **Export all** for a complete backup of the shared catalog.

Rollback requires stopping both processes and restoring the pre-upgrade database and previous release together. The migrated schema is not readable by older master versions.

## Updating lsmnode

Existing `.env`, `BACKENDS_CONFIG`, `backends.json`, backend files, and named/default HTTP routes remain compatible. No backend configuration migration is required. Deploy the agent before using **Discover services**; manual service setup also works with older agents.

The new authenticated `GET /backends` returns backend names, kinds, and paths, never backend secrets. `HOST` optionally controls the bind address (default `0.0.0.0`). Config-changing requests are serialized per backend.

Read-only validation from the agent's working directory:

```sh
bun --env-file=lsmnode/.env run lsmnode/src/check-config.ts
```

The systemd installer preserves existing multi-backend and legacy provider settings. It creates `.env.before-host-refactor` before changing requested settings; it no longer replaces a multi-backend configuration with xui-only values. Treat the backup like the original secret-bearing file.

## Deployment check on vyrfop

An isolated copy of the new agent was run on `127.0.0.1:19009` using the deployed configuration, alongside the existing service. Discovery correctly reported:

- `naive` → `/naive`
- `shadowsocks` → `/ss2022`
- `mieru` → `/mieru`

The default `/health` and all three named health responses matched the running agent, including healthy provider status. Hashes of `.env`, `backends.json`, the managed Caddy users file, and the SS2022 config were unchanged after the check. The shadow process was stopped. The production service was not replaced or restarted, and no user sync was sent.

Database migration is covered by a legacy SQLite fixture representing three profiles using those three service routes. This verifies consolidation and reopen idempotence; it is not a migration of the live master's database.
