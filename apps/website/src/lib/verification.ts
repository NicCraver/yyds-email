import type { MessageDetail } from "../api/yydsMail";

export interface VerificationCandidate {
  code: string;
  confidence: number;
  source: "context" | "numeric" | "alphanumeric";
}

function decodeHtml(html: string): string {
  if (typeof window === "undefined") {
    return html.replace(/<[^>]*>/g, " ");
  }

  const parser = new DOMParser();
  return parser.parseFromString(html, "text/html").body.textContent ?? "";
}

export function htmlToText(input?: string[] | string): string {
  if (!input) {
    return "";
  }

  const html = Array.isArray(input) ? input.join("\n") : input;
  return decodeHtml(html).replace(/\s+/g, " ").trim();
}

export function getMessageBodyText(message?: Pick<MessageDetail, "text" | "html">): string {
  if (!message) {
    return "";
  }

  const text = message.text?.trim();
  if (text) {
    return text;
  }

  return htmlToText(message.html);
}

function pushCandidate(
  store: Map<string, VerificationCandidate>,
  code: string,
  confidence: number,
  source: VerificationCandidate["source"],
): void {
  const normalized = code.toUpperCase();
  const current = store.get(normalized);

  if (!current || confidence > current.confidence) {
    store.set(normalized, {
      code: normalized,
      confidence,
      source,
    });
  }
}

/** 仅当标题含此短语时，才对验证码做解析（且只使用标题文本） */
export const SUBJECT_VERIFICATION_MARKER = /please\s+enter\s+the\s+following\s+code/i;

export function subjectHasVerificationMarker(subject: string): boolean {
  return SUBJECT_VERIFICATION_MARKER.test(subject.trim());
}

/** 标题含标记时，仅从标题解析验证码（不读正文） */
export function extractVerificationCodesFromSubjectLine(subject: string): VerificationCandidate[] {
  if (!subjectHasVerificationMarker(subject)) {
    return [];
  }
  return extractVerificationCodes({ subject });
}

export function extractVerificationCodes(
  message: Pick<MessageDetail, "subject" | "text" | "html">,
): VerificationCandidate[] {
  const subject = message.subject ?? "";
  const plainText = getMessageBodyText(message);
  const haystack = [subject, plainText].filter(Boolean).join("\n");
  const store = new Map<string, VerificationCandidate>();

  const contextualPatterns = [
    /(?:验证码|驗證碼|校验码|动态码|verification code|verify code|one-time code|one-time password|otp|passcode)[^A-Z0-9]{0,24}([A-Z0-9-]{4,10})/gi,
    /([A-Z0-9-]{4,10})[^A-Z0-9]{0,24}(?:验证码|驗證碼|校验码|dynamic code|verification code|otp|passcode)/gi,
    /(?:please\s+enter\s+the\s+following\s+code)[^A-Z0-9]{0,40}([A-Z0-9-]{4,10})/gi,
  ];

  for (const pattern of contextualPatterns) {
    for (const match of haystack.matchAll(pattern)) {
      const code = (match[1] ?? match[0]).replace(/-/g, "");
      if (/^[A-Z0-9]{4,10}$/.test(code)) {
        pushCandidate(store, code, 100 - match.index!, "context");
      }
    }
  }

  for (const match of haystack.matchAll(/\b\d{4,8}\b/g)) {
    pushCandidate(store, match[0], 60 - match.index!, "numeric");
  }

  for (const match of haystack.matchAll(/\b(?=[A-Z0-9]{6,8}\b)(?=.*\d)[A-Z0-9]+\b/g)) {
    pushCandidate(store, match[0], 40 - match.index!, "alphanumeric");
  }

  return [...store.values()].sort((left, right) => right.confidence - left.confidence);
}
