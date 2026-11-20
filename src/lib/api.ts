const SESSION_KEY = 'nexa_session_token';

export function getStoredSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setStoredSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore storage errors
  }
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredSessionToken();
  const headers = new Headers(init?.headers || {});
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('x-nexa-session', token);
  }

  const resp = await fetch(path, { ...init, headers });
  const text = await resp.text();
  let data: unknown = {};
  let parsedAsJson = false;
  if (!text) {
    parsedAsJson = true;
  } else {
    try {
      data = JSON.parse(text);
      parsedAsJson = true;
    } catch {
      data = { raw: text };
    }
  }

  if (!resp.ok) {
    const errMsg =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${resp.status}`;
    throw new Error(errMsg);
  }

  if (!parsedAsJson || (path.startsWith('/api/') && (typeof data !== 'object' || data === null))) {
    throw new Error(`Invalid API response from ${path}`);
  }

  return data as T;
}
