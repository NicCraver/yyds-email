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
  extractVerificationCodes,
  extractVerificationCodesFromSubjectLine,
  getMessageBodyText,
  subjectHasVerificationMarker,
} from "./lib/verification";

const LS_API_KEY = "yyds-mail-api-key";
const LS_INBOX = "yyds-mail-inbox";
const LS_THEME = "yyds-mail-theme";

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
const pollMs = 3000;
const isDark = ref(false);
const nowTick = ref(Date.now());
/** 下次自动拉取邮件列表的时间戳（用于「等待接收邮件」旁倒计时） */
const nextInboxPollAt = ref<number | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

const nextPollCountdownSec = computed(() => {
  if (nextInboxPollAt.value === null) {
    return null;
  }
  // 与 nextInboxPollAt（按 Date.now() 设定）同一时钟；勿用 nowTick 相减，否则 tick 落后真实时间约 1s 会 ceil 成 4
  void nowTick.value;
  return Math.max(0, Math.ceil((nextInboxPollAt.value - Date.now()) / 1000));
});

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
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label);
      return;
    } catch {
      /* 异步后部分浏览器会撤销用户激活导致失败，改用 execCommand 回退 */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (!ok) {
      throw new Error("execCommand copy failed");
    }
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

function initTheme() {
  try {
    const t = localStorage.getItem(LS_THEME);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (t === "dark" || (t !== "light" && prefersDark)) {
      isDark.value = true;
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
    } else {
      isDark.value = false;
      document.documentElement.classList.add("light");
      document.documentElement.classList.remove("dark");
    }
  } catch {
    /* ignore */
  }
}

function toggleDark() {
  isDark.value = !isDark.value;
  if (isDark.value) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
    localStorage.setItem(LS_THEME, "dark");
  } else {
    document.documentElement.classList.add("light");
    document.documentElement.classList.remove("dark");
    localStorage.setItem(LS_THEME, "light");
  }
}

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

const visibleMessagesWithCodes = computed(() =>
  visibleMessages.value.map((m) => ({
    ...m,
    _codes: extractVerificationCodesFromSubjectLine(m.subject ?? ""),
  })),
);

/** 用于在「快速设置」卡片内直接展示可复制验证码（标题可解析时免请求；否则拉取最新一封可见邮件正文解析） */
const setupInboxCodes = ref<ReturnType<typeof extractVerificationCodes>>([]);
let setupCodesFetchGeneration = 0;

const sortedVisibleMessages = computed(() =>
  [...visibleMessages.value].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  ),
);

const setupCodesTrigger = computed(() => {
  if (!inbox.value?.token) {
    return "";
  }
  return sortedVisibleMessages.value.map((m) => `${m.id}\t${m.subject ?? ""}`).join("\n");
});

async function refreshSetupInboxCodes() {
  const token = inbox.value?.token;
  const addr = inbox.value?.address;
  if (!token || !addr) {
    setupCodesFetchGeneration++;
    setupInboxCodes.value = [];
    return;
  }

  const sorted = sortedVisibleMessages.value;

  for (const m of sorted) {
    const fromSubject = listRowCodes(m);
    if (fromSubject.length) {
      setupCodesFetchGeneration++;
      setupInboxCodes.value = fromSubject;
      return;
    }
  }

  const newest = sorted[0];
  if (!newest) {
    setupCodesFetchGeneration++;
    setupInboxCodes.value = [];
    return;
  }

  const gen = ++setupCodesFetchGeneration;
  try {
    const d = await getMessageDetail({
      bearerToken: token,
      id: newest.id,
      address: addr,
    });
    if (gen !== setupCodesFetchGeneration) {
      return;
    }
    setupInboxCodes.value = extractVerificationCodes(d);
  } catch {
    if (gen !== setupCodesFetchGeneration) {
      return;
    }
    setupInboxCodes.value = [];
  }
}

watch(
  setupCodesTrigger,
  () => {
    void refreshSetupInboxCodes();
  },
  { immediate: true },
);

const expiresCountdown = computed(() => {
  if (!inbox.value) {
    return "00:00";
  }
  const end = new Date(inbox.value.expiresAt).getTime();
  const ms = Math.max(0, end - nowTick.value);
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
});

function startExpiryTick() {
  stopExpiryTick();
  tickTimer = window.setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
}

function stopExpiryTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

watch(hasInbox, (v) => {
  if (v) {
    startExpiryTick();
  } else {
    stopExpiryTick();
  }
});

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
    // 清除会话等操作可能在请求途中发生，避免继续写入状态或重置轮询
    if (!inbox.value) {
      return;
    }
    messages.value = res.messages;
    unreadCount.value = res.unreadCount;
    if (res.messages.length > 0) {
      stopPoll();
    } else if (pollTimer) {
      nextInboxPollAt.value = Date.now() + pollMs;
    }
  } catch (e) {
    if (!inbox.value) {
      return;
    }
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
    messages.value = [];
    selectedId.value = null;
    detail.value = null;
    persistInbox(data);
    await copyText(data.address, "邮箱已创建并已复制");
    await fetchMessages();
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
  stopPoll();
  inbox.value = null;
  messages.value = [];
  selectedId.value = null;
  detail.value = null;
  localStorage.removeItem(LS_INBOX);
}

/** 保留已填写的 API Key 与可选前缀/域名；不先清空 inbox，避免界面切回连接服务页 */
async function createAnotherInbox() {
  const key = apiKey.value.trim();
  if (!key) {
    error.value =
      "无法新建：未找到 API Key。请先点击「清除会话」，在连接服务处填写 API Key 后再生成。";
    return;
  }
  loading.value = true;
  error.value = null;
  messages.value = [];
  selectedId.value = null;
  detail.value = null;
  stopPoll();
  try {
    const data = await createTempInbox({
      apiKey: key,
      address: addressPrefix.value.trim() || undefined,
      domain: domain.value.trim() || undefined,
    });
    persistInbox(data);
    await copyText(data.address, "新邮箱已创建并已复制");
    await fetchMessages();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "创建失败";
  } finally {
    loading.value = false;
  }
}

function startPoll() {
  stopPoll();
  if (!inbox.value || messages.value.length > 0) {
    return;
  }
  pollTimer = window.setInterval(() => {
    if (!inbox.value) {
      stopPoll();
      return;
    }
    void fetchMessages();
  }, pollMs);
  nextInboxPollAt.value = Date.now() + pollMs;
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  nextInboxPollAt.value = null;
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function navToInbox() {
  scrollToSection(hasInbox.value ? "inbox" : "setup");
}

onMounted(async () => {
  initTheme();
  if (inbox.value?.token) {
    startExpiryTick();
  }
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
  stopExpiryTick();
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

function formatRelativeTime(iso: string) {
  try {
    const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) {
      return "刚刚";
    }
    if (sec < 3600) {
      return `${Math.floor(sec / 60)} 分钟前`;
    }
    if (sec < 86400) {
      return `${Math.floor(sec / 3600)} 小时前`;
    }
    return formatTime(iso);
  } catch {
    return formatTime(iso);
  }
}
</script>

<template>
  <div
    class="flex min-h-dvh flex-col bg-background font-body text-on-surface selection:bg-primary-container selection:text-on-primary-container"
  >
    <!-- TopNavBar -->
    <nav
      class="fixed top-0 z-50 w-full bg-surface/80 backdrop-blur-md transition-all duration-300 dark:bg-inverse-surface/85"
    >
      <div class="mx-auto flex h-20 max-w-screen-2xl items-center justify-between px-6 md:px-8">
        <button
          type="button"
          class="text-left font-headline text-2xl font-black tracking-tight text-primary"
          @click="scrollToSection('setup')"
        >
          YYDS Mail
        </button>
        <!--<div class="hidden items-center gap-8 md:flex">
          <button
            type="button"
            class="border-primary pb-1 font-medium text-primary transition-colors duration-300 border-b-2"
            @click="navToInbox"
          >
            收件箱
          </button>
          <a
            class="font-medium text-on-surface-variant transition-colors duration-300 hover:text-primary"
            href="https://vip.215.im/docs"
            target="_blank"
            rel="noopener noreferrer"
            >API</a
          >
          <button
            type="button"
            class="font-medium text-on-surface-variant transition-colors duration-300 hover:text-primary"
            @click="scrollToSection('security')"
          >
            隐私与安全
          </button>
        </div>-->
        <div class="flex items-center gap-3 md:gap-4">
          <button
            type="button"
            class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition-all hover:text-primary active:scale-95"
            :aria-label="isDark ? '切换浅色' : '切换深色'"
            @click="toggleDark"
          >
            <span class="material-symbols-outlined text-[22px] leading-none" aria-hidden="true">{{
              isDark ? "light_mode" : "dark_mode"
            }}</span>
          </button>
          <a
            class="inline-flex h-10 items-center rounded-xl bg-primary px-4 font-headline text-sm font-bold leading-none tracking-wide text-on-primary shadow-sm transition-all hover:brightness-110 active:scale-95 md:px-6"
            href="https://vip.215.im/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            >控制台与文档</a
          >
        </div>
      </div>
    </nav>

    <main class="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-32">
      <!-- Toast -->
      <Transition name="fade">
        <p
          v-if="toast"
          class="fixed bottom-6 left-1/2 z-60 -translate-x-1/2 rounded-full bg-inverse-surface px-5 py-2 text-[13px] font-medium text-inverse-on-surface shadow-lg dark:bg-surface-container-high dark:text-on-surface"
          role="status"
        >
          {{ toast }}
        </p>
      </Transition>

      <!-- Error -->
      <Transition name="slide-fade">
        <div
          v-if="error"
          class="mb-6 flex items-center gap-2.5 rounded-2xl border border-error/25 bg-error-container px-4 py-3 text-[13px] text-on-error-container md:text-sm"
          role="alert"
        >
          <span class="material-symbols-outlined shrink-0 text-error">error</span>
          <span>{{ error }}</span>
        </div>
      </Transition>

      <!-- Hero -->
      <section class="mb-16 grid grid-cols-1 gap-8 lg:grid-cols-12">
        <div id="setup" class="flex flex-col justify-center lg:col-span-7">
          <h1
            class="mb-6 font-headline text-4xl font-extrabold leading-[1.1] tracking-tight text-on-surface md:text-5xl lg:text-6xl"
          >
            <span class="text-primary">临时邮箱</span>，快速创建、轻松收码。
          </h1>
          <p class="mb-4 max-w-xl text-lg leading-relaxed text-on-surface-variant">
            几秒生成地址、自动识别验证码，一键复制即用。
          </p>
          <p class="mb-8 max-w-xl text-sm text-on-surface-variant/70">
            每个临时邮箱只接收第一封邮件，收到后自动停止轮询。
          </p>

          <div
            class="rounded-xl border border-outline-variant/10 bg-surface-container-low p-6 shadow-sm"
          >
            <template v-if="!hasInbox">
              <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
                <span class="font-headline text-sm font-bold text-on-surface">连接服务</span>
                <code
                  class="max-w-[min(100%,14rem)] truncate rounded-lg bg-surface-container px-2 py-1 font-mono text-[11px] text-on-surface-variant"
                  :title="API_BASE_URL"
                  >{{ API_BASE_URL }}</code
                >
              </div>
              <div class="flex flex-col gap-4 md:flex-row">
                <div class="relative min-w-0 flex-1">
                  <input
                    v-model="apiKey"
                    :type="showApiKey ? 'text' : 'password'"
                    autocomplete="off"
                    placeholder="粘贴 API Key（AC- 开头）"
                    class="focus:ring-primary/20 w-full rounded-xl border-none bg-surface-container-highest px-5 py-4 font-mono text-sm text-on-surface outline-none ring-0 transition-all placeholder:text-on-surface-variant focus:ring-2 dark:bg-surface-container-high"
                  />
                  <button
                    type="button"
                    class="absolute right-3 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10"
                    :aria-label="showApiKey ? '隐藏密钥' : '显示密钥'"
                    @click="showApiKey = !showApiKey"
                  >
                    <span
                      class="material-symbols-outlined text-[22px] leading-none"
                      aria-hidden="true"
                      >{{ showApiKey ? "visibility_off" : "visibility" }}</span
                    >
                  </button>
                </div>
                <button
                  type="button"
                  :disabled="loading"
                  class="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-6 py-4 font-headline font-bold text-on-primary transition-all hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
                  @click="createInbox"
                >
                  <span v-if="loading" class="material-symbols-outlined animate-spin text-[22px]"
                    >progress_activity</span
                  >
                  <span v-else class="material-symbols-outlined text-[22px]">add_circle</span>
                  生成临时邮箱
                </button>
              </div>
              <div class="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    for="prefix-input"
                    class="mb-1 block text-xs font-medium text-on-surface-variant"
                    >前缀（可选）</label
                  >
                  <input
                    id="prefix-input"
                    v-model="addressPrefix"
                    type="text"
                    class="w-full rounded-xl border border-outline-variant/20 bg-surface px-3 py-2.5 text-sm outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/15 dark:bg-surface-container"
                    placeholder="my-app"
                  />
                </div>
                <div>
                  <label
                    for="domain-input"
                    class="mb-1 block text-xs font-medium text-on-surface-variant"
                    >域名（可选）</label
                  >
                  <input
                    id="domain-input"
                    v-model="domain"
                    type="text"
                    class="w-full rounded-xl border border-outline-variant/20 bg-surface px-3 py-2.5 text-sm outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/15 dark:bg-surface-container"
                    placeholder="默认域名"
                  />
                </div>
              </div>
            </template>

            <template v-else>
              <div class="flex flex-col gap-4 md:flex-row">
                <div class="relative min-w-0 flex-1">
                  <input
                    readonly
                    type="text"
                    :value="inbox!.address"
                    class="focus:ring-primary/20 w-full rounded-xl border-none bg-surface-container-highest px-5 py-4 font-headline text-lg font-bold text-primary outline-none focus:ring-2 md:text-xl dark:bg-surface-container-high"
                  />
                  <div class="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    <button
                      type="button"
                      class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10"
                      title="复制地址"
                      @click="copyText(inbox!.address, '地址已复制')"
                    >
                      <span
                        class="material-symbols-outlined text-[22px] leading-none"
                        aria-hidden="true"
                        >content_copy</span
                      >
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  :disabled="loading"
                  class="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-6 py-4 font-headline font-bold text-on-primary transition-all hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
                  @click="createAnotherInbox"
                >
                  <span
                    v-if="loading"
                    class="material-symbols-outlined animate-spin text-[22px] leading-none"
                    >progress_activity</span
                  >
                  <span
                    v-else
                    class="material-symbols-outlined text-[22px] leading-none"
                    aria-hidden="true"
                    >add_circle</span
                  >
                  新建并复制
                </button>
              </div>
              <div class="mt-6 flex flex-wrap items-center justify-between gap-3 px-1">
                <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                  <template v-if="setupInboxCodes.length">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="material-symbols-outlined shrink-0 text-primary"
                        style="font-size: 20px"
                        aria-hidden="true"
                        >key</span
                      >
                      <button
                        v-for="c in setupInboxCodes"
                        :key="`setup-${c.code}-${c.source}`"
                        type="button"
                        class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-mono text-sm font-semibold tracking-wider text-on-primary transition-all hover:brightness-110 active:scale-[0.98]"
                        @click="copyText(c.code, '验证码已复制')"
                      >
                        {{ c.code }}
                        <span
                          class="material-symbols-outlined text-[18px] opacity-80"
                          aria-hidden="true"
                          >content_copy</span
                        >
                      </button>
                    </div>
                  </template>
                  <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <div class="flex items-center gap-3">
                      <div class="bg-primary h-2.5 w-2.5 shrink-0 rounded-full pulse-animation" />
                      <span
                        class="font-label text-xs font-medium uppercase tracking-widest text-on-surface-variant"
                        >等待接收邮件…</span
                      >
                    </div>
                    <span
                      v-if="nextPollCountdownSec !== null"
                      class="font-label text-xs font-medium tabular-nums tracking-widest text-on-surface-variant/90"
                      aria-live="polite"
                      >{{ nextPollCountdownSec }}s 后检查</span
                    >
                  </div>
                  <span
                    v-if="unreadCount > 0"
                    class="font-label text-xs font-medium uppercase tracking-widest text-on-surface-variant"
                    >· {{ unreadCount }} 封未读</span
                  >
                </div>
                <!--<div
                  class="rounded-full bg-tertiary-container px-3 py-1 text-xs font-bold uppercase tracking-tighter text-on-tertiary-container"
                >
                  剩余 {{ expiresCountdown }}
                </div>-->
              </div>
              <div class="mt-4 flex flex-wrap gap-2 border-t border-outline-variant/15 pt-4">
                <button
                  type="button"
                  :disabled="loading"
                  class="rounded-xl border border-outline-variant/25 bg-surface-container-high px-4 py-2 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container-highest disabled:opacity-50 dark:border-outline-variant/40"
                  @click="refreshToken"
                >
                  刷新令牌
                </button>
                <button
                  type="button"
                  :disabled="loading"
                  class="rounded-xl border border-outline-variant/25 bg-surface px-4 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-low disabled:opacity-50 dark:border-outline-variant/40"
                  @click="clearInbox"
                >
                  清除会话
                </button>
              </div>
            </template>
          </div>
        </div>

        <div class="relative hidden lg:col-span-5 lg:block">
          <div
            class="h-full w-full rotate-3 transform overflow-hidden rounded-3xl shadow-2xl transition-transform duration-700 hover:rotate-0"
          >
            <img
              alt="抽象靛蓝与白色流体纹理"
              class="h-full min-h-[320px] w-full object-cover"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuBQnQEidMhFv5CwmgZ2ekh6KOsRLoXjEjyQCv9tEAU3jvC3njIyRmswZMy3guTXYrZjrwni03BbpPnYubdCvFQD0mkKfs4T6TcCRSvMNHGkrsEycuTkDDv3y7EXWdC9I8WC8XktAHy9vWLs5waZpuN1aGWSLdZryiYA8cAtbs2JxABZM7kQL0qRflmBtXbxnKHSBtxaxAqULDlSlVbehFjadnWwDI958YCEX0KaLEHA7PefMJKaDZp_JOhw8QgWKJtbem90IXEhDnI"
            />
          </div>
          <!--<div
            class="glass-effect absolute -bottom-6 -left-6 max-w-[240px] rounded-2xl p-6 shadow-xl"
          >
            <div class="mb-3 flex items-center gap-4">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20"
              >
                <span
                  class="material-symbols-outlined text-primary"
                  style="font-variation-settings: 'FILL' 1"
                  >verified_user</span
                >
              </div>
              <div class="font-headline text-sm font-bold text-on-surface">
                隐私优先
              </div>
            </div>
            <p class="text-xs leading-relaxed text-on-surface-variant">
              会话与邮件数据遵循服务条款；请仅用于合法用途。
            </p>
          </div>-->
        </div>
      </section>

      <!-- Inbox -->
      <section v-if="hasInbox" id="inbox" class="rounded-3xl bg-surface-container-low p-8 md:p-12">
        <div class="mb-10 flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div>
            <h2 class="mb-2 font-headline text-3xl font-extrabold tracking-tight">收件箱</h2>
            <p class="text-on-surface-variant">实时查看临时邮箱收到的邮件。</p>
          </div>
          <button
            type="button"
            class="rounded-xl border border-outline-variant/10 bg-surface-container-high px-4 py-2 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container-highest dark:border-outline-variant/30"
            @click="fetchMessages"
          >
            刷新列表
          </button>
        </div>

        <div v-if="visibleMessagesWithCodes.length" class="space-y-3">
          <div v-for="m in visibleMessagesWithCodes" :key="m.id">
            <div
              class="overflow-hidden rounded-2xl border transition-all"
              :class="
                selectedId === m.id
                  ? 'border-primary/35 shadow-md ring-1 ring-primary/20'
                  : m.seen
                    ? 'border-outline-variant/15 dark:border-outline-variant/30'
                    : 'border-primary/35 bg-primary-container/10 dark:border-primary/45'
              "
            >
              <div
                v-if="m._codes.length"
                class="flex flex-wrap items-center gap-2 border-b border-outline-variant/10 bg-primary-fixed/40 px-4 py-2.5 dark:bg-primary/15"
              >
                <span class="material-symbols-outlined text-primary" style="font-size: 20px"
                  >key</span
                >
                <button
                  v-for="c in m._codes"
                  :key="`${m.id}-${c.code}-${c.source}`"
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-mono text-sm font-semibold tracking-wider text-on-primary transition-all hover:brightness-110 active:scale-[0.98]"
                  @click.stop="copyText(c.code, '验证码已复制')"
                >
                  {{ c.code }}
                  <span class="material-symbols-outlined text-[18px] opacity-80">content_copy</span>
                </button>
              </div>

              <div
                class="group flex cursor-pointer flex-col gap-4 p-5 transition-all md:flex-row md:items-center"
                :class="
                  m.seen
                    ? 'bg-surface hover:bg-surface-container-high hover:scale-[1.01]'
                    : 'bg-transparent hover:bg-primary-container/20 hover:scale-[1.01]'
                "
                role="button"
                tabindex="0"
                @click="openMessage(m.id)"
                @keydown.enter="openMessage(m.id)"
              >
                <div
                  class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                  :class="
                    m.seen
                      ? 'bg-surface-container-highest text-on-surface-variant dark:bg-surface-container-high'
                      : 'bg-primary text-on-primary shadow-md'
                  "
                >
                  <span class="material-symbols-outlined">{{
                    m.seen ? "alternate_email" : "mark_email_unread"
                  }}</span>
                </div>
                <div class="min-w-0 flex-1">
                  <div class="mb-1 flex items-start justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-2">
                      <span
                        v-if="!m.seen"
                        class="bg-primary h-2 w-2 shrink-0 rounded-full"
                        aria-hidden="true"
                      />
                      <h4
                        class="truncate font-headline text-lg"
                        :class="
                          m.seen ? 'font-bold text-on-surface' : 'font-extrabold text-on-surface'
                        "
                      >
                        {{ m.subject || "(无主题)" }}
                      </h4>
                    </div>
                    <span
                      class="whitespace-nowrap font-label text-xs uppercase tracking-widest"
                      :class="m.seen ? 'text-on-surface-variant' : 'font-bold text-primary'"
                      >{{ formatRelativeTime(m.createdAt) }}</span
                    >
                  </div>
                  <p
                    class="truncate font-body text-sm"
                    :class="m.seen ? 'text-on-surface-variant' : 'font-semibold text-on-surface'"
                  >
                    {{ m.from?.name ? `${m.from.name} ` : "" }}{{ m.from?.address }}
                  </p>
                </div>
                <div
                  class="flex gap-2 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100"
                >
                  <button
                    type="button"
                    class="rounded-lg p-2 text-on-surface-variant transition-colors hover:text-primary"
                    aria-label="查看"
                    @click.stop="openMessage(m.id)"
                  >
                    <span class="material-symbols-outlined">visibility</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          v-else-if="messages.length > 0 && visibleMessagesWithCodes.length === 0"
          class="flex flex-col items-center justify-center py-16 text-center"
        >
          <div
            class="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-surface-container-highest"
          >
            <span class="material-symbols-outlined text-4xl text-outline-variant"
              >filter_alt_off</span
            >
          </div>
          <h3 class="mb-2 font-headline text-xl font-bold">已隐藏营销类邮件</h3>
          <p class="max-w-xs text-on-surface-variant">当前仅有欢迎或推广类邮件，已按规则过滤。</p>
        </div>

        <div v-else class="flex flex-col items-center justify-center py-16 text-center">
          <div
            class="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-surface-container-highest"
          >
            <span class="material-symbols-outlined animate-pulse text-4xl text-outline-variant"
              >inbox</span
            >
          </div>
          <h3 class="mb-2 font-headline text-xl font-bold">暂无邮件</h3>
          <p class="max-w-xs text-on-surface-variant">
            新邮件将自动出现在此列表，约每 {{ pollMs / 1000 }} 秒检查一次。
          </p>
        </div>

        <!-- Detail -->
        <Transition name="slide-fade">
          <div
            v-if="selectedId"
            class="border-outline-variant/15 mt-8 overflow-hidden rounded-2xl border bg-surface shadow-sm"
          >
            <div
              class="border-outline-variant/15 flex items-center justify-between border-b px-5 py-4 md:px-6"
            >
              <h3 class="font-headline text-base font-bold text-on-surface">邮件详情</h3>
              <button
                type="button"
                class="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container-low hover:text-on-surface"
                aria-label="关闭详情"
                @click="
                  selectedId = null;
                  detail = null;
                "
              >
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>

            <div class="px-5 py-5 md:px-6">
              <div v-if="detailLoading" class="space-y-3">
                <div class="skeleton h-5 w-3/4" />
                <div class="skeleton h-4 w-1/2" />
                <div class="skeleton mt-4 h-32 w-full" />
              </div>

              <template v-else-if="detail">
                <div v-if="verificationCodes.length" class="mb-4 flex flex-wrap gap-2">
                  <button
                    v-for="c in verificationCodes"
                    :key="c.code + c.source"
                    type="button"
                    class="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-primary px-5 py-2.5 font-mono text-lg font-semibold tracking-widest text-on-primary transition-all hover:brightness-110 active:scale-[0.98]"
                    @click="copyText(c.code, '验证码已复制')"
                  >
                    {{ c.code }}
                    <span class="material-symbols-outlined text-[20px] opacity-90"
                      >content_copy</span
                    >
                  </button>
                </div>

                <p class="text-base font-semibold leading-snug text-on-surface md:text-[17px]">
                  {{ detail.subject || "(无主题)" }}
                </p>

                <div
                  v-if="
                    verificationCodes.length === 0 &&
                    subjectHasVerificationMarker(detail.subject ?? '')
                  "
                  class="mt-4 flex items-start gap-2 rounded-xl border border-tertiary/20 bg-tertiary-container/50 px-3 py-2.5 text-sm text-on-tertiary-container"
                >
                  <span class="material-symbols-outlined shrink-0 text-tertiary">warning</span>
                  标题已含引导语，但未识别到验证码格式
                </div>
                <p
                  v-else-if="
                    verificationCodes.length === 0 &&
                    !subjectHasVerificationMarker(detail.subject ?? '')
                  "
                  class="mt-2 text-xs text-on-surface-variant"
                >
                  仅当标题包含「Please enter the following code」时从标题解析验证码
                </p>

                <div class="mt-5">
                  <div
                    class="mb-2 text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant"
                  >
                    正文预览
                  </div>
                  <pre
                    class="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-xl bg-surface-container-low p-4 font-mono text-[13px] leading-relaxed text-on-surface/85 md:text-sm dark:bg-surface-container"
                    >{{ detailPreview }}</pre
                  >
                </div>
              </template>
            </div>
          </div>
        </Transition>
      </section>
    </main>

    <footer
      class="w-full border-t border-outline-variant/10 bg-surface py-12 dark:bg-inverse-surface/50"
    >
      <div
        class="mx-auto flex max-w-screen-2xl flex-col items-center justify-between gap-6 px-8 md:flex-row"
      >
        <div class="font-headline text-lg font-bold text-on-surface-variant">YYDS Mail</div>
        <div
          class="flex flex-wrap justify-center gap-6 font-label text-[10px] font-semibold uppercase tracking-[0.2em] text-on-surface-variant md:gap-8"
        >
          <a
            class="transition-colors hover:text-primary hover:underline hover:decoration-2 hover:underline-offset-4"
            href="https://github.com/NicCraver/yyds-email"
            target="_blank"
            rel="noopener noreferrer"
            >GitHub</a
          >
          <a
            class="transition-colors hover:text-primary hover:underline hover:decoration-2 hover:underline-offset-4"
            href="https://vip.215.im/docs"
            target="_blank"
            rel="noopener noreferrer"
            >文档</a
          >
        </div>
      </div>
    </footer>
  </div>
</template>
