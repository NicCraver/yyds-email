export const API_BASE_URL = (import.meta.env.VITE_YYDS_API_BASE_URL ?? "/v1").replace(/\/$/, "");

/** 解析为浏览器可请求的绝对 URL（支持相对路径如 `/v1`，配合 dev 代理避免 CORS） */
function resolveApiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (/^https?:\/\//i.test(API_BASE_URL)) {
    return `${API_BASE_URL}${p}`;
  }
  if (typeof window === "undefined") {
    return `${API_BASE_URL}${p}`;
  }
  return `${window.location.origin}${API_BASE_URL}${p}`;
}

export function getApiOrigin(): string {
  if (/^https?:\/\//i.test(API_BASE_URL)) {
    return new URL(API_BASE_URL).origin;
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}

export type AutoDomainStrategy = "balanced" | "prefer_owned" | "prefer_public";

export interface TempInbox {
  id: string;
  address: string;
  token?: string;
  inboxType: string;
  source: string;
  expiresAt: string;
  isActive: boolean;
  createdAt: string;
  messageCount?: number;
}

export interface MailContact {
  name: string;
  address: string;
}

export interface MailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  downloadUrl: string;
}

export interface MessageSummary {
  id: string;
  inbox_id?: string;
  inboxId?: string;
  from: MailContact;
  to: MailContact[];
  subject: string;
  seen: boolean;
  hasAttachments: boolean;
  size: number;
  createdAt: string;
}

export interface MessageDetail extends MessageSummary {
  text?: string;
  html?: string[];
  attachments?: MailAttachment[];
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface AuthConfig {
  apiKey?: string;
  bearerToken?: string;
}

export interface ListMessagesResponse {
  messages: MessageSummary[];
  total: number;
  unreadCount: number;
}

export interface CreateInboxInput {
  apiKey: string;
  address?: string;
  domain?: string;
  autoDomainStrategy?: AutoDomainStrategy;
}

function shouldStringifyJsonBody(
  body: RequestInit["body"] | Record<string, unknown> | undefined,
): body is Record<string, unknown> {
  if (body === undefined || body === null) {
    return false;
  }
  if (typeof body === "string") {
    return false;
  }
  if (
    typeof body === "object" &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(body) &&
    !(body instanceof URLSearchParams)
  ) {
    return true;
  }
  return false;
}

async function requestJson<T>(
  path: string,
  options: Omit<RequestInit, "body"> & {
    auth?: AuthConfig;
    query?: Record<string, string | number | undefined>;
    body?: RequestInit["body"] | Record<string, unknown>;
  } = {},
): Promise<T> {
  const { auth, query, headers, body, ...init } = options;
  const url = new URL(resolveApiUrl(path));

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const requestHeaders = new Headers(headers);

  if (auth?.apiKey) {
    requestHeaders.set("X-API-Key", auth.apiKey);
  }

  if (auth?.bearerToken) {
    requestHeaders.set("Authorization", `Bearer ${auth.bearerToken}`);
  }

  const isJsonBody = shouldStringifyJsonBody(body);

  if (isJsonBody) {
    requestHeaders.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers: requestHeaders,
    body: isJsonBody ? JSON.stringify(body) : (body as BodyInit | undefined),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: ApiEnvelope<T> | null = null;

  if (text) {
    payload = JSON.parse(text) as ApiEnvelope<T>;
  }

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error ?? `请求失败，状态码 ${response.status}`);
  }

  return payload.data;
}

export async function createTempInbox(input: CreateInboxInput): Promise<TempInbox> {
  const { apiKey, address, domain, autoDomainStrategy } = input;
  return requestJson<TempInbox>("/accounts", {
    method: "POST",
    auth: { apiKey },
    body: {
      address: address || undefined,
      domain: domain || undefined,
      autoDomainStrategy,
    },
  });
}

export async function getCurrentTempInbox(bearerToken: string): Promise<TempInbox> {
  return requestJson<TempInbox>("/accounts/me", {
    auth: { bearerToken },
  });
}

export async function refreshTempInboxToken(
  bearerToken: string,
  address: string,
): Promise<Pick<TempInbox, "id" | "address" | "token">> {
  return requestJson<Pick<TempInbox, "id" | "address" | "token">>("/token", {
    method: "POST",
    auth: { bearerToken },
    body: { address },
  });
}

export async function listMessages(input: {
  bearerToken: string;
  address?: string;
  limit?: number;
}): Promise<ListMessagesResponse> {
  const { bearerToken, address, limit } = input;
  return requestJson<ListMessagesResponse>("/messages", {
    auth: { bearerToken },
    query: {
      address,
      limit,
    },
  });
}

export async function getMessageDetail(input: {
  bearerToken: string;
  id: string;
  address?: string;
}): Promise<MessageDetail> {
  const { bearerToken, id, address } = input;
  return requestJson<MessageDetail>(`/messages/${id}`, {
    auth: { bearerToken },
    query: {
      address,
    },
  });
}

export async function deleteTempInbox(id: string, bearerToken: string): Promise<void> {
  return requestJson<void>(`/accounts/${id}`, {
    method: "DELETE",
    auth: { bearerToken },
  });
}

export function toAbsoluteApiUrl(path: string): string {
  const origin = getApiOrigin();
  if (!origin) {
    return path;
  }
  return new URL(path, `${origin}/`).toString();
}
