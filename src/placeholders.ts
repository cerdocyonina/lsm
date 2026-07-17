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
 *
 * Подстановка идёт РОВНО ЗА ОДИН проход: вставленные значения не пересканируются.
 * Два прохода ({name}, затем DUMMY) покорёжили бы любое значение, содержащее
 * подстроку "DUMMY" — например пароль из base64url или клиента с именем
 * "DUMMY-test".
 */
export function resolveTemplate(template: string, resolved: Record<string, string>): string {
  return template.replace(
    new RegExp(`\\{(\\w+)\\}|${LEGACY_UUID_PLACEHOLDER}`, "g"),
    (_match, key: string | undefined) => (key === undefined ? resolved.uuid ?? "" : resolved[key] ?? ""),
  );
}
