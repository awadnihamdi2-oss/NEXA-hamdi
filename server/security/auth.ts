import crypto from 'node:crypto';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { getDb, nowIso, verifyPassword, recordAuditEvent } from '../db/database.ts';
import type { Role, SafeUser } from '../types/nexa.ts';

const ROLE_WEIGHT: Record<Role, number> = {
  viewer: 1,
  researcher: 2,
  operator: 3,
  admin: 4,
};

export function redactPii(text: string): { maskedText: string; redactions: number } {
  let count = 0;
  let output = text;

  // Email addresses
  output = output.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, () => {
    count++;
    return '[REDACTED_EMAIL]';
  });

  // Phone numbers (international and Italian/European formats)
  output = output.replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}\b/g, (match) => {
    if (match.replace(/\D/g, '').length >= 8) {
      count++;
      return '[REDACTED_PHONE]';
    }
    return match;
  });

  // Italian Codice Fiscale
  output = output.replace(/\b[A-Z]{6}[0-9]{2}[A-EHLMPR-T][0-9]{2}[A-Z][0-9]{3}[A-Z]\b/gi, () => {
    count++;
    return '[REDACTED_FISCAL_ID]';
  });

  // API key / Bearer token shapes (OpenAI, Gemini, OpenRouter, Anthropic, NVIDIA, Groq, Bearer headers)
  output = output.replace(/\bBearer\s+[a-zA-Z0-9._-]{8,}\b/gi, () => {
    count++;
    return 'Bearer [REDACTED_SECRET]';
  });
  output = output.replace(/\b(sk-[a-zA-Z0-9_-]{12,}|AIza[0-9A-Za-z_-]{16,}|nvapi-[a-zA-Z0-9_-]{12,}|gsk_[a-zA-Z0-9_-]{12,}|sk-ant-[a-zA-Z0-9_-]{12,}|sk-or-[a-zA-Z0-9_-]{12,})\b/g, () => {
    count++;
    return '[REDACTED_SECRET]';
  });

  return { maskedText: output, redactions: count };
}

export function sanitizeUntrustedContent(input: string, maxLength = 12000): string {
  const trimmed = String(input ?? '').slice(0, maxLength);
  // Strip control chars except newline/tab and wrap untrusted delimiters safely
  const cleaned = trimmed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned;
}

export function wrapUntrustedContext(label: string, content: string): string {
  const safeContent = sanitizeUntrustedContent(content, 16000)
    .replace(/<\/?untrusted_data>/gi, '[TAG_STRIPPED]');
  return `<untrusted_data source="${label}">\n${safeContent}\n</untrusted_data>`;
}

export function assertPathInsideRoot(rootDir: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, candidatePath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Security violation: path traversal blocked');
  }
  return resolvedTarget;
}

const EPHEMERAL_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');
const WEAK_SECRET_PATTERNS = new Set([
  'secret',
  'changeme',
  'default',
  'password',
  'my_session_secret',
  'nexa_secret',
  'nexa-session-secret',
  'replace_with_32_random_chars',
]);

export function validateSessionSecret(secretValue = process.env.NEXA_SESSION_SECRET): {
  configured: boolean;
  valid: boolean;
  mode: 'ENV_VALIDATED' | 'EPHEMERAL_FALLBACK' | 'INVALID_WEAK_SECRET';
  message: string;
} {
  const raw = (secretValue || '').trim();
  if (!raw) {
    return {
      configured: false,
      valid: true,
      mode: 'EPHEMERAL_FALLBACK',
      message: 'NEXA_SESSION_SECRET is unset; dev uses ephemeral CSPRNG key, production requires >= 32 random chars.',
    };
  }
  const uniqueChars = new Set(raw).size;
  if (raw.length < 32 || uniqueChars < 10 || WEAK_SECRET_PATTERNS.has(raw.toLowerCase())) {
    return {
      configured: true,
      valid: false,
      mode: 'INVALID_WEAK_SECRET',
      message: 'NEXA_SESSION_SECRET must be at least 32 cryptographically random characters (min 10 distinct characters).',
    };
  }
  return {
    configured: true,
    valid: true,
    mode: 'ENV_VALIDATED',
    message: 'NEXA_SESSION_SECRET validated (>= 32 random chars).',
  };
}

function getActiveSessionSecret(): string {
  const status = validateSessionSecret();
  if (process.env.NODE_ENV === 'production' && (!status.configured || !status.valid)) {
    throw new Error(status.message);
  }
  return status.configured && status.valid ? (process.env.NEXA_SESSION_SECRET || '').trim() : EPHEMERAL_FALLBACK_SECRET;
}

const WEAK_PASSWORD_PATTERNS = new Set([
  'nexa-operator-local',
  'password',
  'admin',
  'admin123456',
  'changeme',
  'default',
  '123456789012',
  'nexa_password',
]);

export function getConfiguredAdminPassword(): string {
  return (process.env.NEXA_ADMIN_PASSWORD || process.env.NEXA_DEFAULT_ADMIN_PASSWORD || '').trim();
}

export function validateAdminPassword(passwordValue = getConfiguredAdminPassword()): {
  configured: boolean;
  valid: boolean;
  sourceEnv: 'NEXA_ADMIN_PASSWORD' | 'NEXA_DEFAULT_ADMIN_PASSWORD' | 'NONE';
  message: string;
} {
  const primary = (process.env.NEXA_ADMIN_PASSWORD || '').trim();
  const legacy = (process.env.NEXA_DEFAULT_ADMIN_PASSWORD || '').trim();
  const raw = passwordValue.trim();
  const sourceEnv: 'NEXA_ADMIN_PASSWORD' | 'NEXA_DEFAULT_ADMIN_PASSWORD' | 'NONE' = primary
    ? 'NEXA_ADMIN_PASSWORD'
    : legacy
      ? 'NEXA_DEFAULT_ADMIN_PASSWORD'
      : 'NONE';

  if (!raw) {
    return {
      configured: false,
      valid: false,
      sourceEnv: 'NONE',
      message: 'NEXA_ADMIN_PASSWORD is unset; production requires a non-default password >= 12 chars.',
    };
  }
  const uniqueChars = new Set(raw).size;
  if (raw.length < 12 || uniqueChars < 6 || WEAK_PASSWORD_PATTERNS.has(raw.toLowerCase())) {
    return {
      configured: true,
      valid: false,
      sourceEnv,
      message: 'NEXA_ADMIN_PASSWORD must be >= 12 non-default characters with >= 6 distinct characters.',
    };
  }
  return {
    configured: true,
    valid: true,
    sourceEnv,
    message: `${sourceEnv} validated (>= 12 chars non-default).`,
  };
}

export function validateSchedulerSecret(tokenValue = process.env.NEXA_SCHEDULER_TOKEN): {
  configured: boolean;
  valid: boolean;
  message: string;
} {
  const raw = (tokenValue || '').trim();
  if (!raw) {
    return {
      configured: false,
      valid: false,
      message: 'NEXA_SCHEDULER_TOKEN is unset; production requires >= 24 random characters.',
    };
  }
  const uniqueChars = new Set(raw).size;
  if (raw.length < 24 || uniqueChars < 10 || WEAK_SECRET_PATTERNS.has(raw.toLowerCase())) {
    return {
      configured: true,
      valid: false,
      message: 'NEXA_SCHEDULER_TOKEN must be >= 24 cryptographically random characters (min 10 distinct characters).',
    };
  }
  return {
    configured: true,
    valid: true,
    message: 'NEXA_SCHEDULER_TOKEN validated (>= 24 random chars).',
  };
}

export function validateSchedulerTriggerToken(providedToken?: string | null): {
  configured: boolean;
  authorized: boolean;
  reason?: string;
} {
  const expected = (process.env.NEXA_SCHEDULER_TOKEN || '').trim();
  const check = validateSchedulerSecret(expected);
  if (!check.configured || !check.valid) {
    return {
      configured: false,
      authorized: false,
      reason: check.message,
    };
  }
  const candidate = (providedToken || '').trim();
  if (!candidate) {
    return { configured: true, authorized: false, reason: 'Missing scheduler trigger token.' };
  }
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  const candidateHash = crypto.createHash('sha256').update(candidate).digest();
  const authorized = crypto.timingSafeEqual(expectedHash, candidateHash);
  return {
    configured: true,
    authorized,
    reason: authorized ? undefined : 'Invalid scheduler trigger token.',
  };
}

export function getProductionSecurityReadiness() {
  const session = validateSessionSecret();
  const sessionProdOk = session.configured && session.valid;
  const scheduler = validateSchedulerSecret();
  const schedulerProdOk = scheduler.configured && scheduler.valid;
  const adminPassword = validateAdminPassword();
  const adminPasswordProdOk = adminPassword.configured && adminPassword.valid;
  const dbPath = (process.env.NEXA_DB_PATH || '').trim();
  const dbPathPersistentOk = Boolean(dbPath) && dbPath !== ':memory:';
  const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  const nodeEnv = process.env.NODE_ENV || 'development';
  const paidFallbackLockedOff = (process.env.NEXA_PAID_FALLBACK_ALLOWED || 'false').toLowerCase() !== 'true';
  const liveTradingLockedOff = (process.env.NEXA_LIVE_TRADING_ENABLED || 'false').toLowerCase() !== 'true';
  const externalCommerceApprovalGated = (process.env.NEXA_EXTERNAL_COMMERCE_ENABLED || 'false').toLowerCase() !== 'true';

  const failures: string[] = [];
  const warnings: string[] = [];

  if (!sessionProdOk) failures.push(session.message);
  if (!schedulerProdOk) failures.push(scheduler.message);
  if (!adminPasswordProdOk) failures.push(adminPassword.message);
  if (!dbPathPersistentOk) {
    failures.push('NEXA_DB_PATH must be set to a persistent non-:memory: SQLite path (e.g. /app/data/nexa_genesis.sqlite3).');
  }
  if (!paidFallbackLockedOff) failures.push('NEXA_PAID_FALLBACK_ALLOWED must be false in strict cost-guarded production.');
  if (!liveTradingLockedOff) failures.push('NEXA_LIVE_TRADING_ENABLED must remain false (Paper-Only safety lock).');
  if (!appUrl) warnings.push('APP_URL is unset; external links and OpenRouter Referer require public HTTPS APP_URL.');
  else if (nodeEnv === 'production' && !appUrl.startsWith('https://')) {
    warnings.push('APP_URL does not use https:// in production mode.');
  }

  return {
    nodeEnv,
    productionReady:
      nodeEnv === 'production' &&
      sessionProdOk &&
      schedulerProdOk &&
      adminPasswordProdOk &&
      dbPathPersistentOk &&
      paidFallbackLockedOff &&
      liveTradingLockedOff,
    secretsReadyWithoutNodeEnv:
      sessionProdOk &&
      schedulerProdOk &&
      adminPasswordProdOk &&
      dbPathPersistentOk &&
      paidFallbackLockedOff &&
      liveTradingLockedOff,
    failures,
    warnings,
    checks: {
      nodeEnvIsProduction: nodeEnv === 'production',
      sessionSecretValid: sessionProdOk,
      sessionSecretMode: session.mode,
      schedulerTokenConfigured: schedulerProdOk,
      adminPasswordStrong: adminPasswordProdOk,
      adminPasswordSourceEnv: adminPassword.sourceEnv,
      dbPathConfigured: dbPathPersistentOk,
      appUrlConfigured: Boolean(appUrl),
      paidFallbackLockedOff,
      liveTradingLockedOff,
      externalCommerceApprovalGated,
    },
    requiredProductionVariables: [
      { name: 'NODE_ENV', requiredValue: 'production', configured: nodeEnv === 'production' },
      { name: 'NEXA_SESSION_SECRET', requiredValue: '>= 32 cryptographically random chars', configured: sessionProdOk },
      { name: 'NEXA_SCHEDULER_TOKEN', requiredValue: '>= 24 cryptographically random chars', configured: schedulerProdOk },
      {
        name: 'NEXA_ADMIN_PASSWORD',
        requiredValue: '>= 12 chars non-default password (legacy alias NEXA_DEFAULT_ADMIN_PASSWORD supported)',
        configured: adminPasswordProdOk,
      },
      { name: 'NEXA_DB_PATH', requiredValue: 'Persistent SQLite file path (e.g. /app/data/nexa_genesis.sqlite3)', configured: dbPathPersistentOk },
      { name: 'NEXA_PAID_FALLBACK_ALLOWED', requiredValue: 'false', configured: paidFallbackLockedOff },
      { name: 'NEXA_LIVE_TRADING_ENABLED', requiredValue: 'false', configured: liveTradingLockedOff },
      { name: 'NEXA_EXTERNAL_COMMERCE_ENABLED', requiredValue: 'false (until explicit launch authorization)', configured: externalCommerceApprovalGated },
    ],
  };
}

export function runProductionPreflight(options?: { requireProductionNodeEnv?: boolean }) {
  const readiness = getProductionSecurityReadiness();
  const requireProd = options?.requireProductionNodeEnv ?? process.env.NODE_ENV === 'production';
  const failures = [...readiness.failures];
  if (requireProd && readiness.nodeEnv !== 'production') {
    failures.unshift(`NODE_ENV must be 'production' (currently '${readiness.nodeEnv}').`);
  }
  return {
    ok: failures.length === 0,
    checkedAt: nowIso(),
    nodeEnv: readiness.nodeEnv,
    strictProductionCheck: requireProd,
    failures,
    warnings: readiness.warnings,
    checks: readiness.checks,
    requiredProductionVariables: readiness.requiredProductionVariables,
  };
}

function hashSessionToken(token: string): string {
  return crypto.createHmac('sha256', getActiveSessionSecret()).update(token).digest('hex');
}

export function createSessionForUser(userId: string): { token: string; expiresAt: string } {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const sessionId = `ses_${crypto.randomUUID().slice(0, 12)}`;

  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    userId,
    tokenHash,
    expiresAt,
    nowIso()
  );

  return { token, expiresAt };
}

export function authenticateCredentials(username: string, password: string): { user: SafeUser; token: string; expiresAt: string } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT id, username, display_name, role, password_hash, preferred_language FROM users WHERE username = ?')
    .get(username.trim()) as
    | {
        id: string;
        username: string;
        display_name: string;
        role: Role;
        password_hash: string;
        preferred_language: 'en' | 'ar' | 'it' | 'fr';
      }
    | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    return null;
  }

  const session = createSessionForUser(row.id);
  recordAuditEvent(row.username, 'AUTH', 'USER_LOGIN', { role: row.role });

  return {
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      preferredLanguage: row.preferred_language,
    },
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

export function resolveUserFromToken(token?: string | null): SafeUser | null {
  if (!token) return null;
  const db = getDb();
  const tokenHash = hashSessionToken(token);
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.preferred_language, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as
    | {
        id: string;
        username: string;
        display_name: string;
        role: Role;
        preferred_language: 'en' | 'ar' | 'it' | 'fr';
        expires_at: string;
      }
    | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    preferredLanguage: row.preferred_language,
  };
}

export function revokeSessionToken(token?: string | null): boolean {
  if (!token) return false;
  const db = getDb();
  const tokenHash = hashSessionToken(token);
  const res = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  return Number(res.changes || 0) > 0;
}

export interface AuthedRequest extends Request {
  nexaUser?: SafeUser;
}

export function extractSessionTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (bearer) return bearer;
  const headerToken = (req.headers['x-nexa-session'] as string | undefined) || null;
  if (headerToken) return headerToken;
  const cookieHeader = req.headers.cookie || '';
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      if (k === 'nexa_session') {
        try {
          return decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
          return part.slice(idx + 1).trim();
        }
      }
    }
  }
  return null;
}

export function isRequestHttps(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return Boolean(req.secure || proto === 'https' || proto.startsWith('https,'));
}

export function buildSessionCookieHeader(token: string, req: Request): string {
  const parts = [`nexa_session=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${7 * 24 * 60 * 60}`];
  if (isRequestHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearSessionCookieHeader(req: Request): string {
  const parts = ['nexa_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isRequestHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

export function attachSessionMiddleware(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = extractSessionTokenFromRequest(req);

  const resolved = resolveUserFromToken(token);
  if (resolved) {
    req.nexaUser = resolved;
  } else if (process.env.NODE_ENV !== 'production') {
    // Local workspace operator fallback for zero-friction dev/preview; production requires explicit token auth
    const db = getDb();
    const fallback = db
      .prepare('SELECT id, username, display_name, role, preferred_language FROM users WHERE id = ?')
      .get('usr_operator') as
      | {
          id: string;
          username: string;
          display_name: string;
          role: Role;
          preferred_language: 'en' | 'ar' | 'it' | 'fr';
        }
      | undefined;
    if (fallback) {
      req.nexaUser = {
        id: fallback.id,
        username: fallback.username,
        displayName: fallback.display_name,
        role: fallback.role,
        preferredLanguage: fallback.preferred_language,
      };
    }
  }
  next();
}

export function requireRole(minRole: Role) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const user = req.nexaUser;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (ROLE_WEIGHT[user.role] < ROLE_WEIGHT[minRole]) {
      recordAuditEvent(user.username, 'SECURITY', 'RBAC_DENIED', { required: minRole, actual: user.role, path: req.path });
      res.status(403).json({ error: `Role '${minRole}' required (current: '${user.role}')` });
      return;
    }
    next();
  };
}

export function rateLimitMiddleware(maxPerWindow = 120, windowMs = 60000) {
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket?.remoteAddress || 'local';
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > maxPerWindow) {
      res.status(429).json({ error: 'Rate limit exceeded. Retry shortly.' });
      return;
    }
    next();
  };
}
