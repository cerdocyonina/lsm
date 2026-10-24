/** Легаси-плейсхолдер: исторически подписки подставляли UUID вместо литерала DUMMY. */
const LEGACY_UUID_PLACEHOLDER = "DUMMY";

/**
 * Плейсхолдеры уровня СЕРВЕРА, а не юзера: значение одно на всех юзеров, берётся из
 * привязанной к серверу ноды и в мешке кредов не живёт.
 *   {ip} — хост из URL ноды (http://1.2.3.4:9000/ss2022 → 1.2.3.4). Переезд ноды на новый
 *          адрес тогда правится в одном месте — в URL ноды, а не в каждом шаблоне.
 */
export const SERVER_PLACEHOLDERS: readonly string[] = ["ip"];

/** Хост из URL ноды; IPv6 — в скобках ([::1]), т.е. сразу годен для "@{ip}:port". */
export function nodeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Шаблон ссылается на {ip}, а значит без привязанной ноды отрендерится с пустым хостом. */
export function templateNeedsNode(template: string): boolean {
  return templatePlaceholders(template).some((name) => SERVER_PLACEHOLDERS.includes(name));
}

/**
 * Подставляет серверные плейсхолдеры, НЕ трогая юзерские ({uuid}, {pass}, ...) — их потом
 * резолвит resolveTemplate. Применяется раньше всего остального (рендер подписки, пинг),
 * поэтому парсеры host:port видят уже настоящий адрес.
 *
 * Отдельный проход здесь безопасен, в отличие от {name}+DUMMY в resolveTemplate: URL-парсер
 * отдаёт hostname в нижнем регистре и без фигурных скобок, так что вставленное значение
 * не может оказаться ни "{name}", ни легаси "DUMMY".
 * Нода не привязана → пустая строка, как и для любого неизвестного плейсхолдера.
 */
export function applyServerPlaceholders(template: string, node: { url: string } | null): string {
  const values: Record<string, string> = { ip: node ? nodeHost(node.url) : "" };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(values, key) ? values[key]! : match));
}

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
