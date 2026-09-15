import { setAuth } from "../state/auth";

const PREFIX = "/api";

// Plain fields, not constructor parameter properties: the template enables
// erasableSyntaxOnly, which bans TS syntax that emits runtime code.
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Every call goes through here, which buys two things the vanilla app repeated
 * by hand at each call site: the /api prefix in one place, and a single 401
 * handler that drops the whole app to logged-out.
 *
 * Safe to make global because fastapi-users answers bad credentials with 400,
 * not 401 -- so a failed login surfaces in the login form instead of being
 * swallowed as "your session expired".
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(PREFIX + path, init);
  if (res.status === 401) {
    setAuth("anon");
    throw new HttpError(401, "");
  }
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
  return res;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiFetch(path, init)).json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// URLSearchParams, not JSON: fastapi-users' login is an OAuth2PasswordRequestForm.
const form = (fields: Record<string, string>): RequestInit => ({ body: new URLSearchParams(fields) });

export const api = {
  listSessions: () => apiJson<{ sessions: import("./types").SessionSummary[] }>("/sessions"),
  createSession: () => apiJson<{ session_id: string }>("/sessions", { method: "POST" }),
  deleteSession: (id: string) => apiFetch(`/sessions/${id}`, { method: "DELETE" }),
  renameSession: (id: string, title: string) => apiFetch(`/sessions/${id}`, { method: "PATCH", ...json({ title }) }),
  transcript: (id: string) => apiJson<{ turns: import("./types").TurnOut[] }>(`/sessions/${id}/messages`),
  generateTitle: (id: string, message: string) => apiJson<{ title: string }>(`/sessions/${id}/title`, { method: "POST", ...json({ message }) }),

  login: (email: string, password: string) => apiFetch("/auth/login", { method: "POST", ...form({ username: email, password }) }),
  register: (email: string, password: string) => apiFetch("/auth/register", { method: "POST", ...json({ email, password }) }),
  logout: () => apiFetch("/auth/logout", { method: "POST" }),
};
