const WINDOW_MS = 1000 * 60 * 15;
const LOCKOUT_MS = 1000 * 60 * 15;
const IP_FAILURE_LIMIT = 10;
const USERNAME_FAILURE_LIMIT = 5;

type FailureRecord = {
  count: number;
  firstFailureAt: number;
  lockoutUntil: number;
};

type LoginAttemptStatus = {
  allowed: boolean;
  retryAfterSeconds: number;
};

function createFailureRecord(now: number): FailureRecord {
  return {
    count: 0,
    firstFailureAt: now,
    lockoutUntil: 0,
  };
}

function getActiveRecord(
  store: Map<string, FailureRecord>,
  key: string,
  now: number,
): FailureRecord {
  const existing = store.get(key);
  if (!existing) {
    const created = createFailureRecord(now);
    store.set(key, created);
    return created;
  }

  if (existing.lockoutUntil > 0 && existing.lockoutUntil <= now) {
    const reset = createFailureRecord(now);
    store.set(key, reset);
    return reset;
  }

  if (existing.firstFailureAt + WINDOW_MS <= now && existing.lockoutUntil === 0) {
    existing.count = 0;
    existing.firstFailureAt = now;
  }

  return existing;
}

function getRetryAfterSeconds(record: FailureRecord, now: number): number {
  return Math.max(1, Math.ceil((record.lockoutUntil - now) / 1000));
}

export class LoginRateLimiter {
  private readonly ipFailures = new Map<string, FailureRecord>();
  private readonly usernameFailures = new Map<string, FailureRecord>();

  public check(clientIp: string, username: string): LoginAttemptStatus {
    const now = Date.now();
    const ipRecord = getActiveRecord(this.ipFailures, clientIp, now);
    const usernameRecord = getActiveRecord(this.usernameFailures, username, now);

    if (ipRecord.lockoutUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: getRetryAfterSeconds(ipRecord, now),
      };
    }

    if (usernameRecord.lockoutUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: getRetryAfterSeconds(usernameRecord, now),
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  public recordFailure(clientIp: string, username: string): LoginAttemptStatus {
    const now = Date.now();
    const ipRecord = getActiveRecord(this.ipFailures, clientIp, now);
    const usernameRecord = getActiveRecord(this.usernameFailures, username, now);

    if (ipRecord.count === 0) {
      ipRecord.firstFailureAt = now;
    }
    if (usernameRecord.count === 0) {
      usernameRecord.firstFailureAt = now;
    }

    ipRecord.count += 1;
    usernameRecord.count += 1;

    let retryAfterSeconds = 0;

    if (ipRecord.count >= IP_FAILURE_LIMIT) {
      ipRecord.lockoutUntil = now + LOCKOUT_MS;
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        getRetryAfterSeconds(ipRecord, now),
      );
    }

    if (usernameRecord.count >= USERNAME_FAILURE_LIMIT) {
      usernameRecord.lockoutUntil = now + LOCKOUT_MS;
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        getRetryAfterSeconds(usernameRecord, now),
      );
    }

    return {
      allowed: retryAfterSeconds === 0,
      retryAfterSeconds,
    };
  }

  public reset(clientIp: string, username: string): void {
    this.ipFailures.delete(clientIp);
    this.usernameFailures.delete(username);
  }
}
