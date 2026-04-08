<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  API_BASE_URL,
  createTempInbox,
  getCurrentTempInbox,
  getMessageDetail,
  listMessages,
  refreshTempInboxToken,
  type MessageDetail,
  type MessageSummary,
  type TempInbox,
} from "./api/yydsMail";
import { filterInboxMessages } from "./lib/messageFilters";
import {
  extractVerificationCodesFromSubjectLine,
  getMessageBodyText,
  subjectHasVerificationMarker,
} from "./lib/verification";

const LS_API_KEY = "yyds-mail-api-key";
const LS_INBOX = "yyds-mail-inbox";

interface StoredInbox {
  id: string;
  address: string;
  token: string;
  expiresAt: string;
}

const apiKey = ref("");
const showApiKey = ref(false);
const addressPrefix = ref("");
const domain = ref("");
const inbox = ref<StoredInbox | null>(null);
const messages = ref<MessageSummary[]>([]);
const unreadCount = ref(0);
const selectedId = ref<string | null>(null);
const detail = ref<MessageDetail | null>(null);
const loading = ref(false);
const detailLoading = ref(false);
const error = ref<string | null>(null);
const toast = ref<string | null>(null);
const pollMs = 12000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function listRowCodes(
  m: MessageSummary,
): ReturnType<typeof extractVerificationCodesFromSubjectLine> {
  return extractVerificationCodesFromSubjectLine(m.subject ?? "");
}

function showToast(text: string) {
  toast.value = text;
  window.setTimeout(() => {
    toast.value = null;
  }, 2000);
}

async function copyText(text: string, label = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    error.value = "复制失败，请手动选择文本复制";
  }
}

function loadStored() {
  try {
    const k = localStorage.getItem(LS_API_KEY);
    if (k) {
      apiKey.value = k;
    }
    const raw = localStorage.getItem(LS_INBOX);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredInbox;
      if (parsed?.token && parsed?.address) {
        inbox.value = parsed;
      }
    }
  } catch {
    /* ignore */
  }
}

loadStored();

function persistInbox(data: TempInbox) {
  const token = data.token;
  if (!token) {
    return;
  }
  const next: StoredInbox = {
    id: data.id,
    address: data.address,
    token,
    expiresAt: data.expiresAt,
  };
  inbox.value = next;
  localStorage.setItem(LS_INBOX, JSON.stringify(next));
}

watch(apiKey, (v) => {
  localStorage.setItem(LS_API_KEY, v.trim());
});

const hasInbox = computed(() => inbox.value !== null);

const visibleMessages = computed(() => filterInboxMessages(messages.value));

async function ensureSession(): Promise<string | null> {
  const token = inbox.value?.token;
  if (!token) {
    return null;
  }
  try {
    await getCurrentTempInbox(token);
    return token;
  } catch {
    inbox.value = null;
    localStorage.removeItem(LS_INBOX);
    error.value = "登录已过期，请重新创建邮箱";
    return null;
  }
}

async function fetchMessages() {
  const token = await ensureSession();
  if (!token || !inbox.value) {
    return;
  }
  try {
    const res = await listMessages({
      bearerToken: token,
      address: inbox.value.address,
      limit: 50,
    });
    messages.value = res.messages;
    unreadCount.value = res.unreadCount;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载邮件失败";
  }
}

async function openMessage(id: string) {
  if (!inbox.value) {
    return;
  }
  selectedId.value = id;
  detailLoading.value = true;
  detail.value = null;
  error.value = null;
  try {
    const d = await getMessageDetail({
      bearerToken: inbox.value.token,
      id,
      address: inbox.value.address,
    });
    detail.value = d;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "读取邮件详情失败";
  } finally {
    detailLoading.value = false;
  }
}

const verificationCodes = computed(() =>
  extractVerificationCodesFromSubjectLine(detail.value?.subject ?? ""),
);

const detailPreview = computed(() => {
  if (!detail.value) {
    return "";
  }
  const body = getMessageBodyText(detail.value);
  return body.slice(0, 2000);
});

async function createInbox() {
  const key = apiKey.value.trim();
  if (!key) {
    error.value = "请先填写 API Key（在 YYDS Mail 控制台创建）";
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const data = await createTempInbox({
      apiKey: key,
      address: addressPrefix.value.trim() || undefined,
      domain: domain.value.trim() || undefined,
    });
    persistInbox(data);
    messages.value = [];
    selectedId.value = null;
    detail.value = null;
    await fetchMessages();
    await copyText(data.address, "邮箱已创建并已复制");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "创建失败";
  } finally {
    loading.value = false;
  }
}

async function refreshToken() {
  if (!inbox.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const data = await refreshTempInboxToken(inbox.value.token, inbox.value.address);
    const next: StoredInbox = {
      ...inbox.value,
      token: data.token,
    };
    inbox.value = next;
    localStorage.setItem(LS_INBOX, JSON.stringify(next));
    showToast("令牌已刷新");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "刷新令牌失败";
  } finally {
    loading.value = false;
  }
}

function clearInbox() {
  inbox.value = null;
  messages.value = [];
  selectedId.value = null;
  detail.value = null;
  localStorage.removeItem(LS_INBOX);
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    void fetchMessages();
  }, pollMs);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onMounted(async () => {
  if (inbox.value?.token) {
    loading.value = true;
    const ok = await ensureSession();
    loading.value = false;
    if (ok) {
      await fetchMessages();
      startPoll();
    }
  }
});

onUnmounted(() => {
  stopPoll();
});

watch(inbox, (v) => {
  if (v) {
    startPoll();
  } else {
    stopPoll();
  }
});

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
</script>

<template>
  <div class="min-h-dvh bg-apple-gray text-apple-black">
    <!-- Nav -->
    <header
      class="sticky top-0 z-50 flex h-11 items-center justify-between border-b border-white/10 bg-black/80 px-4 backdrop-blur-xl backdrop-saturate-[1.8] md:h-12 md:px-6"
    >
      <div class="flex items-center gap-2">
        <svg
          class="h-4 w-4 text-white/90"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
        <span class="text-[13px] font-semibold tracking-tight text-white/90 md:text-sm"
          >YYDS Mail</span
        >
      </div>
      <a
        class="rounded-full bg-apple-blue px-3 py-1 text-xs font-medium text-white transition-all duration-200 hover:bg-apple-blue-hover active:scale-95"
        href="https://vip.215.im/docs"
        target="_blank"
        rel="noopener noreferrer"
        >API 文档</a
      >
    </header>

    <!-- Hero Banner -->
    <section class="bg-white px-4 py-6 text-center md:px-6 md:py-8">
      <h1 class="text-xl font-semibold tracking-tight text-apple-black md:text-2xl">临时邮箱</h1>
      <p class="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-black/50 md:text-sm">
        快速生成临时邮箱地址，自动识别并提取验证码
      </p>
    </section>

    <main class="mx-auto max-w-[720px] px-4 pb-8 pt-4 md:px-6 md:pb-12 md:pt-6">
      <!-- Toast -->
      <Transition name="fade">
        <p
          v-if="toast"
          class="fixed bottom-6 left-1/2 z-60 -translate-x-1/2 rounded-full bg-apple-black px-5 py-2 text-[13px] font-medium text-white shadow-lg"
          role="status"
        >
          {{ toast }}
        </p>
      </Transition>

      <!-- Error -->
      <Transition name="slide-fade">
        <div
          v-if="error"
          class="mb-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 md:text-sm"
          role="alert"
        >
          <svg
            class="mt-0.5 h-4 w-4 shrink-0 text-red-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{{ error }}</span>
        </div>
      </Transition>

      <!-- Setup Card -->
      <div class="mb-5 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/4">
        <div class="px-4 py-4 md:px-6 md:py-5">
          <!-- API Key Header -->
          <div class="mb-3 flex items-center justify-between">
            <label for="api-key-input" class="text-[13px] font-semibold text-apple-black md:text-sm"
              >API Key</label
            >
            <code
              class="rounded-md bg-apple-gray px-2 py-0.5 font-mono text-[11px] text-black/40"
              :title="API_BASE_URL"
              >{{ API_BASE_URL }}</code
            >
          </div>

          <!-- API Key Input -->
          <div class="flex gap-2">
            <div class="relative flex-1">
              <input
                id="api-key-input"
                v-model="apiKey"
                :type="showApiKey ? 'text' : 'password'"
                autocomplete="off"
                placeholder="粘贴 API Key（AC- 开头）"
                class="h-10 w-full rounded-lg border border-apple-border bg-apple-gray px-3 text-sm tracking-tight outline-none transition-all duration-200 placeholder:text-black/30 focus:border-apple-blue focus:bg-white focus:ring-2 focus:ring-apple-blue/20"
              />
            </div>
            <button
              type="button"
              class="h-10 shrink-0 rounded-lg border border-apple-border bg-white px-3 text-[13px] text-apple-black transition-all duration-200 hover:bg-apple-gray active:scale-[0.97]"
              :aria-label="showApiKey ? '隐藏密钥' : '显示密钥'"
              @click="showApiKey = !showApiKey"
            >
              <!-- Eye icon -->
              <svg
                v-if="!showApiKey"
                class="h-4 w-4 text-black/50"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg
                v-else
                class="h-4 w-4 text-black/50"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path
                  d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"
                />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
              </svg>
            </button>
          </div>

          <!-- Optional Fields -->
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label for="prefix-input" class="mb-1 block text-[12px] font-medium text-black/45"
                >前缀（可选）</label
              >
              <input
                id="prefix-input"
                v-model="addressPrefix"
                type="text"
                class="h-10 w-full rounded-lg border border-apple-border bg-apple-gray px-3 text-sm outline-none transition-all duration-200 placeholder:text-black/30 focus:border-apple-blue focus:bg-white focus:ring-2 focus:ring-apple-blue/20"
                placeholder="my-app"
              />
            </div>
            <div>
              <label for="domain-input" class="mb-1 block text-[12px] font-medium text-black/45"
                >域名（可选）</label
              >
              <input
                id="domain-input"
                v-model="domain"
                type="text"
                class="h-10 w-full rounded-lg border border-apple-border bg-apple-gray px-3 text-sm outline-none transition-all duration-200 placeholder:text-black/30 focus:border-apple-blue focus:bg-white focus:ring-2 focus:ring-apple-blue/20"
                placeholder="默认域名"
              />
            </div>
          </div>
        </div>

        <!-- Action Bar -->
        <div
          class="flex flex-wrap items-center gap-2 border-t border-black/4 bg-[#fafafa] px-4 py-3 md:px-6"
        >
          <button
            type="button"
            :disabled="loading"
            class="h-9 cursor-pointer rounded-full bg-apple-blue px-5 text-[13px] font-medium text-white transition-all duration-200 hover:bg-apple-blue-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
            @click="createInbox"
          >
            <span v-if="loading" class="flex items-center gap-1.5">
              <svg
                class="h-3.5 w-3.5 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  class="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  stroke-width="3"
                />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              处理中
            </span>
            <span v-else>生成临时邮箱</span>
          </button>
          <template v-if="hasInbox">
            <button
              type="button"
              :disabled="loading"
              class="h-9 cursor-pointer rounded-full border border-apple-blue/30 px-4 text-[13px] font-medium text-apple-blue transition-all duration-200 hover:bg-apple-blue/5 active:scale-[0.97] disabled:opacity-50"
              @click="refreshToken"
            >
              刷新令牌
            </button>
            <button
              type="button"
              class="h-9 cursor-pointer rounded-full border border-apple-border px-4 text-[13px] text-apple-black/70 transition-all duration-200 hover:bg-black/3 active:scale-[0.97]"
              @click="clearInbox"
            >
              清除会话
            </button>
          </template>
        </div>
      </div>

      <!-- Active Inbox Card -->
      <Transition name="slide-fade">
        <div
          v-if="hasInbox"
          class="mb-5 overflow-hidden rounded-2xl bg-apple-black p-4 text-white shadow-lg md:p-5"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="mb-1 text-[11px] font-semibold uppercase tracking-widest text-white/40">
                当前邮箱
              </div>
              <p
                class="break-all font-mono text-[15px] leading-relaxed tracking-wide text-white/95 md:text-base"
              >
                {{ inbox!.address }}
              </p>
              <p class="mt-2 flex items-center gap-2 text-[12px] text-white/45">
                <span>{{ formatTime(inbox!.expiresAt) }} 过期</span>
                <span
                  class="inline-block h-0.5 w-0.5 rounded-full bg-white/30"
                  aria-hidden="true"
                ></span>
                <span>{{ unreadCount }} 封未读</span>
              </p>
            </div>
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded-full bg-apple-blue px-4 py-2 text-[13px] font-medium text-white transition-all duration-200 hover:bg-apple-blue-hover active:scale-[0.97]"
              @click="copyText(inbox!.address, '邮箱已复制')"
            >
              复制地址
            </button>
          </div>
        </div>
      </Transition>

      <!-- Inbox Section -->
      <template v-if="hasInbox">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-base font-semibold tracking-tight text-apple-black md:text-lg">收件箱</h2>
          <button
            type="button"
            class="flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-white px-3 text-[13px] text-black/65 shadow-sm ring-1 ring-black/6 transition-all duration-200 hover:bg-apple-gray active:scale-[0.97]"
            @click="fetchMessages"
          >
            <svg
              class="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"
              />
            </svg>
            刷新
          </button>
        </div>

        <!-- Message List -->
        <div v-if="visibleMessages.length" class="space-y-2">
          <div v-for="m in visibleMessages" :key="m.id">
            <div
              class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 transition-all duration-200"
              :class="
                selectedId === m.id
                  ? 'ring-apple-blue shadow-md'
                  : 'ring-black/4 hover:shadow-md hover:ring-black/8'
              "
            >
              <!-- Verification Code Strip -->
              <div
                v-if="listRowCodes(m).length"
                class="flex flex-wrap items-center gap-2 border-b border-black/4 bg-[#f0f5ff] px-4 py-2.5"
              >
                <svg
                  class="h-4 w-4 text-apple-blue/60"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <button
                  v-for="c in listRowCodes(m)"
                  :key="`${m.id}-${c.code}-${c.source}`"
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-apple-blue px-3 py-1.5 font-mono text-sm font-semibold tracking-wider text-white transition-all duration-150 hover:bg-apple-blue-hover active:scale-[0.96]"
                  @click.stop="copyText(c.code, '验证码已复制')"
                >
                  {{ c.code }}
                  <svg
                    class="h-3.5 w-3.5 opacity-70"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </div>

              <!-- Message Row -->
              <button
                type="button"
                class="w-full cursor-pointer px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-apple-blue md:py-3.5"
                @click="openMessage(m.id)"
              >
                <div class="flex items-start justify-between gap-3">
                  <span
                    class="text-[14px] font-semibold leading-snug text-apple-black md:text-[15px]"
                    >{{ m.subject || "(无主题)" }}</span
                  >
                  <span class="shrink-0 text-[12px] tabular-nums text-black/35">{{
                    formatTime(m.createdAt)
                  }}</span>
                </div>
                <p class="mt-1 text-[13px] text-black/50">
                  {{ m.from?.name ? `${m.from.name} ` : "" }}{{ m.from?.address }}
                </p>
              </button>
            </div>
          </div>
        </div>

        <!-- Empty: filtered out -->
        <div
          v-else-if="messages.length > 0 && visibleMessages.length === 0"
          class="rounded-2xl bg-white px-4 py-10 text-center shadow-sm ring-1 ring-black/4"
        >
          <div
            class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-apple-gray"
          >
            <svg
              class="h-6 w-6 text-black/25"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
              <path d="m3 7 9 6 9-6" />
            </svg>
          </div>
          <p class="text-[13px] font-medium text-black/50">当前仅有欢迎/营销类邮件，已自动隐藏</p>
        </div>

        <!-- Empty: no messages -->
        <div
          v-else
          class="rounded-2xl bg-white px-4 py-10 text-center shadow-sm ring-1 ring-black/4"
        >
          <div
            class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-apple-gray"
          >
            <svg
              class="h-6 w-6 animate-pulse text-black/25"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </div>
          <p class="text-[14px] font-medium text-apple-black/60">等待接收邮件</p>
          <p class="mt-1 text-[12px] text-black/35">
            每 {{ pollMs / 1000 }} 秒自动检查，验证码会自动提取
          </p>
        </div>

        <!-- Detail Panel -->
        <Transition name="slide-fade">
          <div
            v-if="selectedId"
            class="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/4"
          >
            <div class="border-b border-black/4 px-4 py-3 md:px-6 md:py-4">
              <div class="flex items-center justify-between">
                <h3 class="text-[14px] font-semibold text-apple-black md:text-[15px]">邮件详情</h3>
                <button
                  type="button"
                  class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-black/30 transition-colors hover:bg-black/4 hover:text-black/50"
                  aria-label="关闭详情"
                  @click="
                    selectedId = null;
                    detail = null;
                  "
                >
                  <svg
                    class="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            <div class="px-4 py-4 md:px-6 md:py-5">
              <!-- Loading skeleton -->
              <div v-if="detailLoading" class="space-y-3">
                <div class="skeleton h-5 w-3/4"></div>
                <div class="skeleton h-4 w-1/2"></div>
                <div class="skeleton mt-4 h-32 w-full"></div>
              </div>

              <template v-else-if="detail">
                <!-- Verification Codes -->
                <div v-if="verificationCodes.length" class="mb-4 flex flex-wrap gap-2">
                  <button
                    v-for="c in verificationCodes"
                    :key="c.code + c.source"
                    type="button"
                    class="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-apple-blue px-5 py-2.5 font-mono text-lg font-semibold tracking-widest text-white transition-all duration-150 hover:bg-apple-blue-hover active:scale-[0.97]"
                    @click="copyText(c.code, '验证码已复制')"
                  >
                    {{ c.code }}
                    <svg
                      class="h-4 w-4 opacity-70"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>

                <!-- Subject -->
                <p class="text-[15px] font-semibold leading-snug text-apple-black md:text-base">
                  {{ detail.subject || "(无主题)" }}
                </p>

                <!-- Notices -->
                <div
                  v-if="
                    verificationCodes.length === 0 &&
                    subjectHasVerificationMarker(detail.subject ?? '')
                  "
                  class="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-[13px] text-amber-800"
                >
                  <svg
                    class="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                    />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  标题已含引导语，但未识别到验证码格式
                </div>
                <p
                  v-else-if="
                    verificationCodes.length === 0 &&
                    !subjectHasVerificationMarker(detail.subject ?? '')
                  "
                  class="mt-2 text-[12px] text-black/35"
                >
                  仅当标题包含「Please enter the following code」时从标题解析验证码
                </p>

                <!-- Body Preview -->
                <div class="mt-4">
                  <div
                    class="mb-2 text-[11px] font-semibold uppercase tracking-widest text-black/30"
                  >
                    正文预览
                  </div>
                  <pre
                    class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-apple-gray p-4 font-mono text-[13px] leading-relaxed text-apple-black/80 md:text-sm"
                    >{{ detailPreview }}</pre
                  >
                </div>
              </template>
            </div>
          </div>
        </Transition>
      </template>
    </main>

    <!-- Footer -->
    <footer class="border-t border-black/4 bg-white/80 px-4 py-5 text-center md:py-6">
      <a
        class="text-[13px] text-link transition-opacity hover:opacity-70"
        href="https://github.com/xiaolajiaoyyds"
        target="_blank"
        rel="noopener noreferrer"
        >GitHub</a
      >
      <span class="mx-2 text-black/20" aria-hidden="true">·</span>
      <span class="text-[12px] text-black/35">仅供合法用途使用</span>
    </footer>
  </div>
</template>
