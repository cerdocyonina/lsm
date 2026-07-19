/**
 * Приводит ss://-ссылку к виду SIP002: ss://base64url(method:credentials)@host:port#tag.
 *
 * Шаблон ss-сервера мы храним с ПЛОСКИМ userinfo — "ss://<method>:<iPSK>:{sskey}@host:port#tag" —
 * чтобы одно-проходный резолвер плейсхолдеров мог подставить per-user PSK внутрь. Уже ПОСЛЕ
 * подстановки этот шаг кодирует userinfo (всё между "ss://" и первым "@") в base64url и
 * отдаёт стандартную ss://-ссылку, которую понимают клиенты.
 *
 * Идемпотентно и безопасно для не-ss ссылок: base64url userinfo не содержит ':' и '@',
 * поэтому повторный вызов (или ссылка без userinfo-двоеточия) возвращается как есть.
 */
export function encodeShadowsocksLink(link: string): string {
  if (!link.startsWith("ss://")) return link;
  const rest = link.slice("ss://".length);
  const at = rest.indexOf("@");
  if (at === -1) return link; // нет userinfo — оставляем как есть

  const userinfo = rest.slice(0, at);
  // Уже закодировано (base64url без ':') либо статическая ss-строка без method:pass — не трогаем.
  if (!userinfo.includes(":")) return link;

  const hostAndTag = rest.slice(at); // включает ведущий '@…#tag'
  const encoded = Buffer.from(userinfo, "utf8").toString("base64url");
  return `ss://${encoded}${hostAndTag}`;
}
