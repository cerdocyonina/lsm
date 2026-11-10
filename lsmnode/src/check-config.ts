import { buildBackends } from "./config";
// Constructs backend adapters without changing any backend configuration or users.
const registry = buildBackends(process.env);
console.log(
  JSON.stringify(
    {
      default: registry.defaultName,
      backends: [...registry.backends].map(([name, b]) => ({
        name,
        kind: b.kind,
        path: `/${name}`,
      })),
    },
    null,
    2,
  ),
);
