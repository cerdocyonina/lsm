import { naiveLogin } from "./credentials";
import { ensureUserCredentials } from "./ensure-credentials";
import type { NodeRecord, Storage, UserRecord } from "./storage";

export type NaiveUser = { user: string; pass: string };

// Caddy basic_auth принимает только этот charset (зеркалит USER_RE/PASS_RE в CaddyBackend).
// pass всегда base64url и безопасен; login = <profile>.<clientName> и может содержать
// невалидный символ, если clientName кривой. Декларативный пуш всего списка означает, что
// один плохой логин иначе отверг бы синк всей ноды — поэтому пропускаем нарушителя и репортим.
const NAIVE_CRED_RE = /^[A-Za-z0-9._-]+$/;
// Mirrors UUID_RE in lsmnode's XrayBackend.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Целевой список для декларативной ноды. profiles — откуда взялись юзеры (сколько ушло из
 * каждого профиля): синк, нажатый в одном профиле, честно пушит всех, кто сидит на ноде,
 * и панель показывает эту разбивку, чтобы число не выглядело «синкнулись чужие профили».
 */
export type DeclarativeUsers = {
  users: NaiveUser[];
  skipped: string[];
  profiles: { name: string; users: number }[];
};

/**
 * Полный декларативный список юзеров для ноды — ОБЪЕДИНЕНИЕ юзеров ВСЕХ профилей, чей сервер
 * привязан к этой ноде. Синк декларативный (нода заменяет весь конфиг целиком), поэтому список
 * одного профиля затёр бы остальные — надо слать всех, кто попадает на ноду через любой профиль.
 * Логин (метка) namespace-нут профилем (<profile>.<clientName>), так что одинаковый clientName
 * в разных профилях (это разные люди) не конфликтует.
 *
 * Секрет даёт secretOf: кред из мешка ("pass" для naive, "sskey" для ss-2022, "mpass" для mieru)
 * или UUID юзера для xray — ровно тот же, что отдаст рендер подписки (источник истины один — БД).
 *
 * validSecret решает, годится ли секрет для целевого конфига: у Caddy basic_auth строгий
 * charset, у ss-2022 PSK — стандартный base64 (валиден по построению), поэтому проверка
 * разная. Метку валидируем всегда (её видит и Caddyfile, и email в Xray).
 */
function buildDeclarativeUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
  secretOf: (user: UserRecord) => string,
  validSecret: (secret: string) => boolean,
): DeclarativeUsers {
  const valid: NaiveUser[] = [];
  const skipped: string[] = [];
  const profiles: DeclarativeUsers["profiles"] = [];
  for (const profile of storage.listProfiles(ownerId)) {
    const usesNode = storage
      .listServerRecords(profile.name, ownerId)
      .some((server) => server.nodeId === nodeId);
    if (!usesNode) continue;

    let pushed = 0;
    for (const user of storage.listUsers(profile.name, ownerId)) {
      const login = naiveLogin(profile.name, user.clientName);
      const secret = secretOf(user);
      if (NAIVE_CRED_RE.test(login) && validSecret(secret)) {
        valid.push({ user: login, pass: secret });
        pushed++;
      } else {
        skipped.push(`${profile.name}/${user.clientName}`);
      }
    }
    profiles.push({ name: profile.name, users: pushed });
  }
  return { users: valid, skipped, profiles };
}

/** Кред из мешка юзера (создаётся, если его ещё нет). */
function credential(storage: Storage, key: string): (user: UserRecord) => string {
  return (user) => ensureUserCredentials(storage, user, [key])[key]!;
}

/** Naive-список (login <profile>.<clientName> + base64url-пароль, всё в строгом charset). */
export function buildNaiveUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
): DeclarativeUsers {
  return buildDeclarativeUsersForNode(storage, nodeId, ownerId, credential(storage, "pass"), (s) =>
    NAIVE_CRED_RE.test(s),
  );
}

/** Shadowsocks-2022 список (метка-email + personal-PSK в стандартном base64). */
export function buildShadowsocksUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
): DeclarativeUsers {
  // sskey генерится нами как стандартный base64 → валиден по построению; проверять не нужно.
  return buildDeclarativeUsersForNode(storage, nodeId, ownerId, credential(storage, "sskey"), () => true);
}

/**
 * mieru-список (mita): логин <profile>.<clientName> — тот же {user}, что у naive, а пароль —
 * отдельный кред {mpass}. Свой, а не общий {pass}: утечка конфига одного протокола не должна
 * раскрывать доступ к другому, и ротировать их можно независимо. Оба значения попадают
 * в mierus://-ссылку как userinfo без percent-encoding, поэтому charset тот же строгий.
 */
export function buildMieruUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
): DeclarativeUsers {
  return buildDeclarativeUsersForNode(storage, nodeId, ownerId, credential(storage, "mpass"), (s) =>
    NAIVE_CRED_RE.test(s),
  );
}

/**
 * Bare-Xray VLESS list: email = <profile>.<clientName> (the same label 3x-ui gets), and the
 * secret is the user's UUID, the {uuid} of the vless:// template. It travels as `pass` on the
 * same /sync-users wire as the other declarative backends.
 */
export function buildXrayUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
): DeclarativeUsers {
  // The agent rejects the whole list over one bad id, so a malformed UUID is skipped here instead.
  return buildDeclarativeUsersForNode(storage, nodeId, ownerId, (u) => u.userUuid, (s) => UUID_RE.test(s));
}

/** The full target list for any declarative node, by its type. */
export function buildDeclarativeUsers(storage: Storage, node: NodeRecord, ownerId: number): DeclarativeUsers {
  switch (node.type) {
    case "shadowsocks":
      return buildShadowsocksUsersForNode(storage, node.id, ownerId);
    case "mieru":
      return buildMieruUsersForNode(storage, node.id, ownerId);
    case "xray":
      return buildXrayUsersForNode(storage, node.id, ownerId);
    default:
      return buildNaiveUsersForNode(storage, node.id, ownerId);
  }
}

/** The pushed backends: everything but 3x-ui, which is merged client by client. */
export function isDeclarativeNode(node: { type: NodeRecord["type"] }): boolean {
  return node.type !== "xui";
}

/**
 * Синк naive-ноды декларативный: пушим весь целевой список, нода перерендеривает
 * конфиг. Удаление отдельного юзера — это тоже полный пуш, просто уже без него.
 */
export async function syncNaiveNode(
  node: NodeRecord,
  users: NaiveUser[],
): Promise<{ synced: number; failed: number; error?: string }> {
  try {
    const res = await fetch(`${node.url}/sync-users`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${node.secret}` },
      body: JSON.stringify({ users }),
      tls: { rejectUnauthorized: false },
    } as RequestInit);

    const data = (await res.json()) as { synced?: number; error?: string };
    if (!res.ok || data.error) {
      return { synced: 0, failed: users.length, error: data.error ?? `node returned ${res.status}` };
    }
    return { synced: data.synced ?? users.length, failed: 0 };
  } catch (err) {
    return { synced: 0, failed: users.length, error: err instanceof Error ? err.message : String(err) };
  }
}
