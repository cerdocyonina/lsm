# LSM project notes for Claude

## Version bumping

Run `bun run version:patch` (or `minor`/`major`) after any change that affects deployed behavior — new endpoints, bug fixes, lsmnode changes, deploy script changes. This updates `package.json`, commits, and tags.

The version in `package.json` is the single source of truth: lsmnode reads it at startup and returns it from the `/health` endpoint, visible in the Nodes panel after clicking the ping button.

When to bump:
- `patch` — bug fixes, small UI tweaks, deploy script fixes
- `minor` — new features (new endpoints, new UI panels, new lsmnode capabilities)
- `major` — breaking changes (API changes that require updating deployed lsmnodes)
