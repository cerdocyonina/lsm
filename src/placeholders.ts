/** Легаси-плейсхолдер: исторически подписки подставляли UUID вместо литерала DUMMY. */
const LEGACY_UUID_PLACEHOLDER = "DUMMY";

/**
 * Имена плейсхолдеров, которые использует шаблон.
 * Легаси DUMMY учитывается как "uuid" — они эквивалентны.
 */
export function templatePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    names.add(match[1]!);
  }
  if (template.includes(LEGACY_UUID_PLACEHOLDER)) {
    names.add("uuid");
  }
  return [...names];
}

/**
 * Подставляет креды в шаблон. Неизвестный плейсхолдер схлопывается в пустую
 * строку — шаблон с опечаткой не должен ронять раздачу всей подписки.
 */
export function resolveTemplate(template: string, resolved: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (_match, key: string) => resolved[key] ?? "")
    .replaceAll(LEGACY_UUID_PLACEHOLDER, resolved.uuid ?? "");
}
