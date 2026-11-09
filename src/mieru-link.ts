/**
 * Percent-кодирует значения query у mierus://-ссылки, чтобы в шаблоне можно было писать
 * человекочитаемое имя как есть: "?profile=🇩🇪 DE 2 [Mieru]&port=...". Клиенты mieru берут
 * отображаемое имя из profile (а не из #фрагмента), и сырые пробелы/эмодзи в query ломают
 * ссылку в части клиентов.
 *
 * Значение декодируется по правилам form-urlencoded — так же, как его читает Go-клиент mieru
 * (url.ParseQuery: '+' → пробел, %XX → байт), — и кодируется заново через encodeURIComponent.
 * Поэтому:
 *   - уже закодированное (в т.ч. экспорт `mieru export config simple` с '+' вместо пробела)
 *     остаётся с тем же смыслом для клиента;
 *   - вызов идемпотентен: на выходе нет ни '+', ни сырых символов, повторный проход ничего не меняет;
 *   - литеральный '+' в имени пишется как %2B (сырой '+' клиент и так прочитал бы как пробел);
 *   - значение с невалидным %-escape ("100% fast") считается сырым и кодируется целиком.
 *
 * Параметры делятся по '&', только если за ним идёт "ключ=" — так "profile=DE & NL" остаётся
 * одним значением. Фрагмент начинается с первого '#' и не трогается (его кодирование — дело
 * клиента, как и для остальных схем); '#' внутри profile надо писать как %23.
 */
export function encodeMieruLink(link: string): string {
  if (!link.startsWith("mierus://")) return link;
  const q = link.indexOf("?");
  if (q === -1) return link;
  const hash = link.indexOf("#", q);
  const end = hash === -1 ? link.length : hash;

  const params = link
    .slice(q + 1, end)
    .split(/&(?=[A-Za-z][\w-]*=)/)
    .map((param) => {
      const eq = param.indexOf("=");
      return eq === -1 ? param : `${param.slice(0, eq)}=${encodeURIComponent(decodeFormValue(param.slice(eq + 1)))}`;
    });
  return `${link.slice(0, q)}?${params.join("&")}${link.slice(end)}`;
}

function decodeFormValue(value: string): string {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    // Невалидный %-escape ("100% fast") — значит, значение не было закодировано: берём как есть.
    return spaced;
  }
}
