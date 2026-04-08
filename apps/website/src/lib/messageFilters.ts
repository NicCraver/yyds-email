import type { MessageSummary } from "../api/yydsMail";

/**
 * 营销 / 欢迎类邮件（对收验证码无帮助），例如：
 * 「Hi Ylpfw, welcome to Alibaba.com！」
 */
export function isMarketingOrWelcomeNoise(m: Pick<MessageSummary, "subject" | "from">): boolean {
  const subj = (m.subject ?? "").replace(/\s+/g, " ").trim();
  const from = (m.from?.address ?? "").toLowerCase();

  if (/welcome\s+to\s+alibaba/i.test(subj)) {
    return true;
  }
  if (/^hi\s+[^,\n]+,\s*welcome\s+to\s+alibaba/i.test(subj)) {
    return true;
  }
  if (from.includes("alibaba") && /welcome\s+to/i.test(subj)) {
    return true;
  }
  return false;
}

export function filterInboxMessages(messages: MessageSummary[]): MessageSummary[] {
  return messages.filter((m) => !isMarketingOrWelcomeNoise(m));
}
