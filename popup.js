const REVIEW_SHARED = globalThis.CX_REVIEW_SHARED;
const AUTO_EXTRACT_STORAGE_KEY = REVIEW_SHARED.STORAGE_KEYS.autoExtract;
const REVIEW_SETTINGS_STORAGE_KEY = REVIEW_SHARED.STORAGE_KEYS.reviewSettings;
const REVIEW_BATCH_QUEUE_STORAGE_KEY = REVIEW_SHARED.STORAGE_KEYS.reviewBatchQueue;
const PLUGIN_GATEWAY_CONFIG = REVIEW_SHARED.PLUGIN_GATEWAY_CONFIG;
const getSharedDefaultReviewSettings = REVIEW_SHARED.getDefaultReviewSettings;
const getSharedGatewayBaseUrl = REVIEW_SHARED.getGatewayBaseUrl;
const getSharedModelOptions = REVIEW_SHARED.getModelOptions;
const getSharedProviderPreset = REVIEW_SHARED.getProviderPreset;
const getSharedProviderPresets = REVIEW_SHARED.getProviderPresets;
const getSharedProviderModels = REVIEW_SHARED.getProviderModels;
const inferSharedProviderFromEndpoint = REVIEW_SHARED.inferProviderFromEndpoint;
const isSharedCustomApiMode = REVIEW_SHARED.isCustomApiMode;
const isSharedGatewayConfigured = REVIEW_SHARED.isGatewayConfigured;
const readSharedReviewSettings = REVIEW_SHARED.readReviewSettingsFromStorage;
const writeSharedReviewSettings = REVIEW_SHARED.writeReviewSettingsToStorage;

const API_PROVIDER_PRESETS = getSharedProviderPresets();
const LEGACY_API_PROVIDER_PRESETS = [
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    endpoint: "https://api.moonshot.cn/v1",
    model: "kimi-k2.5",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-k2.5", "kimi-k2-thinking"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    model: "DeepSeek-V3.1",
    models: ["DeepSeek-V3.1", "deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5.4",
    models: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-4.1"],
  },
  {
    id: "custom",
    label: "自定义",
    endpoint: "",
    model: "",
    models: [],
  },
];

let activeTabId = null;
let settingsPersistTimer = null;
let settingsHydrating = false;
let selectedPendingUrls = new Set();

const pageMetaEl = document.getElementById("pageMeta");
const statusBoxEl = document.getElementById("statusBox");
const homeSummaryEl = document.getElementById("homeSummary");
const pendingHomeworkListEl = document.getElementById("pendingHomeworkList");
const selectAllPendingInputEl = document.getElementById("selectAllPendingInput");
const batchReviewBtnEl = document.getElementById("batchReviewBtn");
const autoResultMetaEl = document.getElementById("autoResultMeta");
const logSummaryCardsEl = document.getElementById("logSummaryCards");
const courseProgressInfoEl = document.getElementById("courseProgressInfo");
const logCourseMetaEl = document.getElementById("logCourseMeta");
const testStatusEl = document.getElementById("testStatus");
const authStatusMetaEl = document.getElementById("authStatusMeta");

const viewEls = {
  home: document.getElementById("homeView"),
  logs: document.getElementById("logsView"),
  settings: document.getElementById("settingsView"),
};

const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));

const settingsEls = {
  connectionMode: document.getElementById("connectionModeSelect"),
  gatewaySection: document.getElementById("gatewaySettingsSection"),
  customApiSection: document.getElementById("customApiSettingsSection"),
  gatewayBaseUrl: document.getElementById("gatewayBaseUrlInput"),
  licenseKey: document.getElementById("licenseKeyInput"),
  rememberLicense: document.getElementById("rememberLicenseInput"),
  provider: document.getElementById("providerSelect"),
  endpoint: document.getElementById("endpointInput"),
  apiKey: document.getElementById("apiKeyInput"),
  rememberApiKey: document.getElementById("rememberApiKeyInput"),
  modelSelect: document.getElementById("modelSelect"),
  model: document.getElementById("modelInput"),
  timeout: document.getElementById("timeoutInput"),
  extraPrompt: document.getElementById("extraPromptInput"),
  autoFill: document.getElementById("autoFillInput"),
  autoSubmit: document.getElementById("autoSubmitInput"),
  submitMode: document.getElementById("submitModeSelect"),
  testGatewayBtn: document.getElementById("testApiBtn"),
};

function setStatus(message) {
  statusBoxEl.textContent = message || "准备就绪";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeText(value) {
  return String(value == null ? "" : value).trim();
}

function getDefaultReviewSettings() {
  return getSharedDefaultReviewSettings();
}

function getConnectionModeValue(value) {
  return isSharedCustomApiMode(value) ? "custom_api" : "plugin_gateway";
}

function isGatewayModeSelected(value) {
  return getConnectionModeValue(value) !== "custom_api";
}

function getProviderPreset(providerId) {
  return getSharedProviderPreset(providerId);
}

function getProviderModels(providerId) {
  return getSharedProviderModels(providerId);
}

function inferProviderFromEndpoint(endpoint) {
  return inferSharedProviderFromEndpoint(endpoint);
}

function getGatewayBaseUrlText() {
  const configuredValue = safeText(settingsEls.gatewayBaseUrl && settingsEls.gatewayBaseUrl.value);
  if (configuredValue) {
    return configuredValue;
  }
  if (!isSharedGatewayConfigured("")) {
    return "";
  }
  try {
    return getSharedGatewayBaseUrl(configuredValue);
  } catch (error) {
    return configuredValue || safeText(PLUGIN_GATEWAY_CONFIG.gatewayBaseUrl);
  }
}

async function fetchPluginAuthState(refresh, interactive, forceRefresh) {
  const response = await chrome.runtime.sendMessage({
    type: "getPluginAuthState",
    payload: {
      refresh: !!refresh,
      interactive: !!interactive,
      forceRefresh: !!forceRefresh,
    },
  });
  if (!response || response.ok === false) {
    throw new Error((response && response.error) || "读取插件授权状态失败");
  }
  return response.state || {};
}

function populateProviderOptions() {
  if (!settingsEls.provider) {
    return;
  }
  settingsEls.provider.innerHTML = API_PROVIDER_PRESETS.map((item) => {
    return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`;
  }).join("");
}

function formatAuthSummary(state) {
  if (!state || !state.configured) {
    return "请先填写插件网关地址。";
  }
  if (!state.licenseConfigured) {
    return "尚未填写插件授权码。";
  }
  if (state.sessionActive) {
    return `授权已生效${state.sessionExpiresAt ? `，会话到期：${new Date(state.sessionExpiresAt).toLocaleString("zh-CN")}` : ""}`;
  }
  if (state.registered) {
    return "设备已注册，但当前会话尚未激活。";
  }
  return state.lastError || "尚未完成设备注册。";
}

function renderPluginAuthState(state) {
  setTestStatus(formatAuthSummary(state), state && state.sessionActive ? "success" : state && state.lastError ? "error" : "neutral");
  if (!authStatusMetaEl) {
    return;
  }
  const deviceText = state && state.deviceId ? `设备 ID：${state.deviceId}` : "设备尚未注册";
  const gatewayText = `网关：${escapeHtml(safeText(state && state.gatewayBaseUrl) || getGatewayBaseUrlText())}`;
  authStatusMetaEl.innerHTML = `${gatewayText}<br>${escapeHtml(deviceText)}`;
}

function renderCustomApiState(state) {
  const providerText = safeText((state && state.provider) || (settingsEls.provider && settingsEls.provider.value) || "custom");
  const endpointText = safeText((state && state.endpoint) || (settingsEls.endpoint && settingsEls.endpoint.value));
  setTestStatus(
    safeText(state && state.message) || (endpointText ? "自定义 API 模式已可测试。" : "请先配置自定义 API 地址。"),
    state && state.ok ? "success" : "neutral"
  );
  if (!authStatusMetaEl) {
    return;
  }
  authStatusMetaEl.innerHTML = `提供方：${escapeHtml(providerText)}<br>接口地址：${escapeHtml(endpointText || "未配置")}`;
}

function syncConnectionModeUi(mode, options) {
  const resolvedMode = getConnectionModeValue(mode || (settingsEls.connectionMode && settingsEls.connectionMode.value));
  const gatewayMode = isGatewayModeSelected(resolvedMode);
  if (settingsEls.connectionMode) {
    settingsEls.connectionMode.value = resolvedMode;
  }
  if (settingsEls.gatewaySection) {
    settingsEls.gatewaySection.hidden = !gatewayMode;
  }
  if (settingsEls.customApiSection) {
    settingsEls.customApiSection.hidden = gatewayMode;
  }
  if (settingsEls.testGatewayBtn) {
    settingsEls.testGatewayBtn.textContent = gatewayMode ? "校验授权" : "测试连接";
  }
  if (options && options.state) {
    if (gatewayMode) {
      renderPluginAuthState(options.state);
    } else {
      renderCustomApiState(options.state);
    }
    return;
  }
  if (!gatewayMode) {
    renderCustomApiState({
      provider: safeText(settingsEls.provider && settingsEls.provider.value) || inferProviderFromEndpoint(settingsEls.endpoint && settingsEls.endpoint.value),
      endpoint: safeText(settingsEls.endpoint && settingsEls.endpoint.value),
      message: "自定义 API 模式会使用你自己的接口地址和 API 密钥。",
    });
  } else {
    setTestStatus("准备好后请校验插件网关授权。", "neutral");
    if (authStatusMetaEl) {
      authStatusMetaEl.textContent = "当前模式使用固定插件网关和短期会话。";
    }
  }
}

function getCourseProgressKey(item) {
  const courseId = safeText(item && item.course_id);
  const classId = safeText(item && item.class_id);
  if (courseId && classId) {
    return `${courseId}_${classId}`;
  }
  return courseId || safeText(item && item.url) || safeText(item && item.course_name);
}

function dedupeCourseProgress(items) {
  const map = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const key = getCourseProgressKey(item);
    if (!key) {
      return;
    }
    const previous = map.get(key);
    const previousTime = previous && previous.updated_at ? Date.parse(previous.updated_at) || 0 : 0;
    const currentTime = item && item.updated_at ? Date.parse(item.updated_at) || 0 : 0;
    if (!previous || currentTime >= previousTime) {
      map.set(key, item);
    }
  });
  return Array.from(map.values());
}

function sumCourseProgress(items, field) {
  return (Array.isArray(items) ? items : []).reduce((total, item) => total + Number((item && item[field]) || 0), 0);
}

function getProgressTone(status) {
  const text = safeText(status);
  if (text.includes("失败")) {
    return "#d14343";
  }
  if (text.includes("完成") || text.includes("抓完") || text.includes("暂无")) {
    return "#2e7d32";
  }
  if (text.includes("中") || text.includes("解析") || text.includes("进入")) {
    return "#1565c0";
  }
  return "#7c6248";
}

function getTopCourseSummaries(items, field, formatter) {
  return (Array.isArray(items) ? items : [])
    .slice()
    .sort((a, b) => Number((b && b[field]) || 0) - Number((a && a[field]) || 0))
    .filter((item) => Number((item && item[field]) || 0) > 0)
    .slice(0, 3)
    .map((item) => `<div>• ${escapeHtml(item.course_name || "未命名课程")} - ${escapeHtml(formatter(item))}</div>`)
    .join("");
}

function setView(view) {
  Object.entries(viewEls).forEach(([key, node]) => {
    node.classList.toggle("active", key === view);
  });
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
}

function renderEmptyState(target, text) {
  target.innerHTML = `<div class="empty-state">${escapeHtml(text)}</div>`;
}

async function waitForTabComplete(tabId, timeoutMs) {
  const timeout = Math.max(3000, Number(timeoutMs) || 15000);
  const currentTab = await chrome.tabs.get(tabId);
  if (currentTab && currentTab.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    let done = false;
    const timer = window.setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("页面加载超时"));
    }, timeout);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (done || updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      done = true;
      window.clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function runTabActionFromPopup(tabId, action, payload) {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(
          tabId,
          {
            type: "runAction",
            action,
            payload: payload || {},
          },
          { frameId: 0 },
          (result) => {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve(result);
          }
        );
      });
      if (response && response.ok && response.handled !== false) {
        return response;
      }
      lastError = new Error((response && response.error) || "标签页动作未被处理");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("标签页动作执行失败");
}

function updateBatchReviewState() {
  const count = selectedPendingUrls.size;
  batchReviewBtnEl.disabled = count === 0;
  batchReviewBtnEl.textContent = count ? `AI 一键批阅 (${count})` : "AI 一键批阅";
}

function updateSelectAllState(items) {
  const availableUrls = (Array.isArray(items) ? items : []).map((item) => safeText(item && item.url)).filter(Boolean);
  if (!availableUrls.length) {
    selectAllPendingInputEl.checked = false;
    selectAllPendingInputEl.indeterminate = false;
    return;
  }
  const selectedCount = availableUrls.filter((url) => selectedPendingUrls.has(url)).length;
  selectAllPendingInputEl.checked = selectedCount === availableUrls.length;
  selectAllPendingInputEl.indeterminate = selectedCount > 0 && selectedCount < availableUrls.length;
}

function renderCourseProgress(items) {
  if (!Array.isArray(items) || !items.length) {
    logCourseMetaEl.textContent = "暂无课程数据";
    renderEmptyState(courseProgressInfoEl, "还没有课程进度数据。");
    return;
  }

  logCourseMetaEl.textContent = `${items.length} 门课程`;
  courseProgressInfoEl.innerHTML = items
    .map((item) => {
      const status = escapeHtml(item.status || "等待抓取");
      const currentHomework = safeText(item.current_homework_name);
      const lastError = safeText(item.last_error);
      return `
        <article class="progress-card">
          <div class="progress-top">
            <div class="progress-name">${escapeHtml(item.course_name || "未命名课程")}</div>
            <div class="progress-status" style="color:${getProgressTone(item.status)}">${status}</div>
          </div>
          <div class="progress-meta">
            作业 ${Number(item.homework_done_count || 0)}/${Number(item.homework_count || 0)}
            · 跳过 ${Number(item.skipped_homework_count || 0)}
            · 提交 ${Number(item.submission_count || 0)} 条
          </div>
          ${currentHomework ? `<div class="progress-extra info">当前作业：${escapeHtml(currentHomework)}</div>` : ""}
          ${lastError ? `<div class="progress-extra error">失败原因：${escapeHtml(lastError)}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

function renderHomeworks(data) {
  const records = data && data.homeworks && Array.isArray(data.homeworks.records) ? data.homeworks.records : [];
  const pendingItems = records
    .filter((item) => Number(item && item.pending_count) > 0 && safeText(item && item.url))
    .sort((a, b) => Number(b.pending_count || 0) - Number(a.pending_count || 0));

  selectedPendingUrls = new Set(
    Array.from(selectedPendingUrls).filter((url) => pendingItems.some((item) => safeText(item && item.url) === url))
  );

  homeSummaryEl.textContent = pendingItems.length ? `${pendingItems.length} 个待批作业` : "当前没有待批作业";
  updateSelectAllState(pendingItems);
  updateBatchReviewState();

  if (!pendingItems.length) {
    renderEmptyState(pendingHomeworkListEl, "当前没有未批改完的作业。");
    return;
  }

  pendingHomeworkListEl.innerHTML = pendingItems
    .map((item) => {
      const pending = Number(item.pending_count || 0);
      const submitted = Number(item.submitted_count || 0);
      const unsubmitted = Number(item.unsubmitted_count || 0);
      const url = safeText(item.url);
      const checked = selectedPendingUrls.has(url);
      return `
        <article class="pending-card${checked ? " selected" : ""}">
          <label class="pending-select">
            <input class="pending-checkbox" type="checkbox" data-url="${escapeHtml(url)}" ${checked ? "checked" : ""}>
          </label>
          <div class="pending-main">
            <div class="pending-course">${escapeHtml(item.course_name || "未命名课程")}</div>
            <div class="pending-homework">${escapeHtml(item.homework_name || item.name || "未命名作业")}</div>
            <div class="pending-stats">
              <div class="pending-big">${pending}</div>
              <div class="pending-label">待批</div>
              <div class="pending-meta">
                <span>${submitted} 已交</span>
                <span>${unsubmitted} 未交</span>
              </div>
            </div>
          </div>
          <button class="primary-btn review-btn" type="button" data-url="${escapeHtml(url)}">批阅</button>
        </article>
      `;
    })
    .join("");

  pendingHomeworkListEl.querySelectorAll(".pending-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const url = safeText(checkbox.dataset.url);
      if (!url) {
        return;
      }
      if (checkbox.checked) {
        selectedPendingUrls.add(url);
      } else {
        selectedPendingUrls.delete(url);
      }
      updateSelectAllState(pendingItems);
      updateBatchReviewState();
      const card = checkbox.closest(".pending-card");
      if (card) {
        card.classList.toggle("selected", checkbox.checked);
      }
    });
  });

  pendingHomeworkListEl.querySelectorAll(".review-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const url = button.dataset.url;
      if (!url) {
        return;
      }
      try {
        if (typeof activeTabId === "number") {
          await chrome.tabs.update(activeTabId, { url, active: true });
        } else {
          await chrome.tabs.create({ url, active: true });
        }
        window.close();
      } catch (error) {
        setStatus(`打开批阅页失败：${error.message}`);
      }
    });
  });
}

function renderLogs(data) {
  const courseProgress = dedupeCourseProgress(
    Array.isArray(data && data.context && data.context.course_progress) ? data.context.course_progress : []
  );
  const totalHomeworkCount = sumCourseProgress(courseProgress, "homework_count") || 0;
  const skippedHomeworkCount = sumCourseProgress(courseProgress, "skipped_homework_count");
  const totalSubmissionCount =
    sumCourseProgress(courseProgress, "submission_count") ||
    (data && data.submissions && Array.isArray(data.submissions.records) ? data.submissions.records.length : 0);

  const statusLabel =
    data && data.status === "running"
      ? "自动抓取中"
      : data && data.status === "failed"
        ? "自动抓取失败"
        : data && data.status === "completed"
          ? "自动抓取完成"
          : "最后更新";

  autoResultMetaEl.textContent = data && data.timestamp
    ? `${statusLabel}: ${new Date(data.timestamp).toLocaleString("zh-CN")} · 提交总数 ${totalSubmissionCount}`
    : "暂无自动抓取数据";

  if (!data) {
    renderEmptyState(logSummaryCardsEl, "还没有自动抓取日志。");
    renderCourseProgress([]);
    return;
  }

  const homeworkPreview =
    getTopCourseSummaries(courseProgress, "homework_count", (item) => {
      return `作业 ${Number(item.homework_done_count || 0)}/${Number(item.homework_count || 0)}`;
    }) || "<div>• 暂无作业汇总</div>";

  const submissionPreview =
    getTopCourseSummaries(courseProgress, "submission_count", (item) => {
      return `提交 ${Number(item.submission_count || 0)} 条`;
    }) || "<div>• 暂无提交汇总</div>";

  logSummaryCardsEl.innerHTML = `
    <article class="summary-card homework">
      <h3 class="summary-title">📝 作业汇总 (${totalHomeworkCount} 个作业)</h3>
      <p class="summary-note">${skippedHomeworkCount ? `已跳过 ${skippedHomeworkCount} 个` : "与上方课程进度口径一致"}</p>
      <div class="summary-items">
        ${homeworkPreview}
        ${totalHomeworkCount > 3 ? `<div>... 还有 ${totalHomeworkCount - 3} 个作业</div>` : ""}
      </div>
    </article>
    <article class="summary-card submission">
      <h3 class="summary-title">✓ 提交汇总 (${totalSubmissionCount} 条提交)</h3>
      <p class="summary-note">与上方课程进度口径一致</p>
      <div class="summary-items">
        ${submissionPreview}
        ${totalSubmissionCount > 3 ? `<div>... 还有 ${totalSubmissionCount - 3} 条提交</div>` : ""}
      </div>
    </article>
  `;

  renderCourseProgress(courseProgress);
}

async function getStoredAutoData() {
  const result = await chrome.storage.local.get([AUTO_EXTRACT_STORAGE_KEY]);
  return result && result[AUTO_EXTRACT_STORAGE_KEY] ? result[AUTO_EXTRACT_STORAGE_KEY] : null;
}

async function refreshAutoData() {
  const data = await getStoredAutoData();
  renderHomeworks(data);
  renderLogs(data);
}

async function handleBatchReviewLegacyUnused() {
  const urls = Array.from(selectedPendingUrls).filter(Boolean);
  if (!urls.length) {
    setStatus("请先选择要批阅的作业");
    return;
  }
  await flushPendingSettingsSave();
  const config = await readSharedReviewSettings();
  if (!safeText(config.apiKey)) {
    setStatus("请先在设置里填写 API 密钥");
    setView("settings");
    return;
  }
  if (!config.autoFill || !config.autoSubmit || safeText(config.submitMode) !== "next") {
    setStatus("请先在设置里开启自动填写、自动提交，并选择“提交并进入下一份”");
    setView("settings");
    return;
  }

  try {
    const permissionResult = await ensureSharedAiEndpointPermission(config.endpoint, { requestIfMissing: true });
    if (!permissionResult.ok) {
      throw new Error("未获得当前 AI 地址的访问权限");
    }
    const [firstUrl] = urls;
    await chrome.storage.local.set({
      [REVIEW_BATCH_QUEUE_STORAGE_KEY]: {
        active: true,
        urls,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
      },
    });
    let firstTabId = null;
    if (typeof activeTabId === "number") {
      const updated = await chrome.tabs.update(activeTabId, { url: firstUrl, active: true });
      firstTabId = updated && updated.id;
    } else {
      const created = await chrome.tabs.create({ url: firstUrl, active: true });
      firstTabId = created && created.id;
    }

    if (typeof firstTabId === "number") {
      await waitForTabComplete(firstTabId, 20000);
      await runTabActionFromPopup(firstTabId, "startAutoReviewFlow", {});
    }

    setStatus(`已启动串行批阅，共 ${urls.length} 个作业，当前作业完成后会自动进入下一个`);
    window.close();
  } catch (error) {
    setStatus(`批量打开批阅页失败：${error.message}`);
  }
}

function setTestStatus(message, tone) {
  testStatusEl.textContent = message;
  testStatusEl.dataset.tone = tone || "neutral";
}

function populateProviderOptions() {
  settingsEls.provider.innerHTML = API_PROVIDER_PRESETS.map((item) => {
    return `<option value="${item.id}">${escapeHtml(item.label)}</option>`;
  }).join("");
}

function populateModelOptionsLegacyUnused(providerId, preferredModel) {
  const nextPreset = getProviderPreset(providerId);
  const nextModels = getSharedProviderModels(providerId);
  const nextOptions = [...nextModels, { value: "__custom__", label: "自定义模型" }];
  settingsEls.modelSelect.innerHTML = nextOptions
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
    .join("");

  if (preferredModel && nextModels.some((item) => item.value === preferredModel)) {
    settingsEls.modelSelect.value = preferredModel;
    settingsEls.model.value = preferredModel;
  } else {
    settingsEls.modelSelect.value = "__custom__";
    settingsEls.model.value = preferredModel || nextPreset.model || "";
  }
  return;

  const preset = getProviderPreset(providerId);
  const models = getSharedProviderModels(providerId);
  const options = [...models, { value: "__custom__", label: "自定义模型" }];
  settingsEls.modelSelect.innerHTML = options
    .map((value) => {
      const label = value === "__custom__" ? "自定义模型" : value;
      return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  if (preferredModel && models.includes(preferredModel)) {
    settingsEls.modelSelect.value = preferredModel;
    settingsEls.model.value = preferredModel;
  } else {
    settingsEls.modelSelect.value = "__custom__";
    settingsEls.model.value = preferredModel || preset.model || "";
  }
}

function getSettingsPayloadLegacyUnused() {
  const selectedModel = safeText(settingsEls.modelSelect.value);
  const typedModel = safeText(settingsEls.model.value);
  return {
    provider: safeText(settingsEls.provider.value) || inferProviderFromEndpoint(settingsEls.endpoint.value),
    endpoint: safeText(settingsEls.endpoint.value),
    apiKey: safeText(settingsEls.apiKey.value),
    rememberApiKey: !!settingsEls.rememberApiKey.checked,
    model: selectedModel && selectedModel !== "__custom__" ? selectedModel : typedModel,
    timeoutSeconds: Number(settingsEls.timeout.value),
    extraPrompt: safeText(settingsEls.extraPrompt.value),
    autoFill: !!settingsEls.autoFill.checked,
    autoSubmit: !!settingsEls.autoSubmit.checked,
    submitMode: safeText(settingsEls.submitMode.value) || "current",
  };
}

async function saveSettingsLegacyUnused() {
  if (settingsHydrating) {
    return;
  }
  const payload = getSettingsPayload();
  await writeSharedReviewSettings(payload);
  setStatus("设置已保存");
}

function syncSubmitModeDisabledLegacyUnused() {
  settingsEls.submitMode.disabled = !settingsEls.autoSubmit.checked;
}

function scheduleSaveSettingsLegacyUnused() {
  if (settingsHydrating) {
    return;
  }
  if (settingsPersistTimer) {
    window.clearTimeout(settingsPersistTimer);
  }
  settingsPersistTimer = window.setTimeout(() => {
    settingsPersistTimer = null;
    saveSettings().catch((error) => {
      setStatus(`保存设置失败：${error.message}`);
    });
  }, 250);
}

async function flushPendingSettingsSaveLegacyUnused() {
  if (!settingsPersistTimer) {
    return;
  }
  window.clearTimeout(settingsPersistTimer);
  settingsPersistTimer = null;
  await saveSettings();
}

async function hydrateSettingsLegacyUnused() {
  settingsHydrating = true;
  populateProviderOptions();

  const merged = await readSharedReviewSettings();
  const providerValue = safeText(merged.provider) || inferProviderFromEndpoint(merged.endpoint) || "moonshot";

  settingsEls.provider.value = providerValue;
  settingsEls.endpoint.value = safeText(merged.endpoint);
  settingsEls.apiKey.value = safeText(merged.apiKey);
  settingsEls.rememberApiKey.checked = !!merged.rememberApiKey;
  populateModelOptions(providerValue, safeText(merged.model));
  settingsEls.timeout.value = String(Number(merged.timeoutSeconds) || 20);
  settingsEls.extraPrompt.value = safeText(merged.extraPrompt);
  settingsEls.autoFill.checked = !!merged.autoFill;
  settingsEls.autoSubmit.checked = !!merged.autoSubmit;
  settingsEls.submitMode.value = safeText(merged.submitMode) || "current";
  syncSubmitModeDisabled();
  setTestStatus("尚未测试连接", "neutral");
  settingsHydrating = false;
}

async function testCurrentSettingsLegacyUnused() {
  const payload = getSettingsPayload();
  if (!payload.endpoint) {
    setTestStatus("请先填写 AI 接口地址", "error");
    return;
  }
  if (!payload.apiKey) {
    setTestStatus("请先填写 API 密钥", "error");
    return;
  }
  if (!payload.model) {
    setTestStatus("请先填写模型名", "error");
    return;
  }

  settingsEls.testApiBtn.disabled = true;
  setTestStatus("正在测试连接...", "neutral");
  try {
    const permissionResult = await ensureSharedAiEndpointPermission(payload.endpoint, { requestIfMissing: true });
    if (!permissionResult.ok) {
      throw new Error("未获得当前 AI 地址的访问权限");
    }
    const response = await chrome.runtime.sendMessage({
      type: "testAiEndpoint",
      payload: Object.assign({}, payload, {
        timeoutMs: Math.max(5000, Math.round((Number(payload.timeoutSeconds) || 20) * 1000)),
      }),
    });
    if (!response || response.ok === false) {
      throw new Error((response && response.error) || "测试失败");
    }
    setTestStatus(`连接成功：${payload.model}`, "success");
    setStatus("AI 接口连接正常");
  } catch (error) {
    setTestStatus(`测试失败：${error.message}`, "error");
    setStatus(`AI 接口测试失败：${error.message}`);
  } finally {
    settingsEls.testApiBtn.disabled = false;
  }
}

function bindSettingsEventsLegacyUnused() {
  settingsEls.provider.addEventListener("change", async () => {
    const preset = getProviderPreset(settingsEls.provider.value);
    settingsEls.endpoint.value = preset.endpoint || settingsEls.endpoint.value;
    populateModelOptions(preset.id, preset.model);
    setTestStatus("已切换预设，请重新测试连接。", "neutral");
    scheduleSaveSettings();
  });

  settingsEls.modelSelect.addEventListener("change", async () => {
    if (settingsEls.modelSelect.value !== "__custom__") {
      settingsEls.model.value = settingsEls.modelSelect.value;
    } else {
      settingsEls.model.value = "";
    }
    setTestStatus("模型已切换，请重新测试连接。", "neutral");
    scheduleSaveSettings();
  });

  [settingsEls.endpoint, settingsEls.apiKey, settingsEls.model, settingsEls.timeout, settingsEls.extraPrompt].forEach((node) => {
    node.addEventListener("input", async () => {
      if (node === settingsEls.endpoint) {
        const nextProvider = inferProviderFromEndpoint(settingsEls.endpoint.value);
        if (nextProvider !== settingsEls.provider.value) {
          settingsEls.provider.value = nextProvider;
          populateModelOptions(nextProvider, settingsEls.model.value);
        }
      }
      setTestStatus("配置已修改，请重新测试连接。", "neutral");
      scheduleSaveSettings();
    });
  });

  [settingsEls.rememberApiKey, settingsEls.autoFill, settingsEls.autoSubmit, settingsEls.submitMode].forEach((node) => {
    node.addEventListener("change", async () => {
      syncSubmitModeDisabled();
      scheduleSaveSettings();
    });
  });

  settingsEls.testApiBtn.addEventListener("click", () => {
    testCurrentSettings().catch((error) => {
      setTestStatus(`测试失败：${error.message}`, "error");
    });
  });
}

async function handleBatchReview() {
  const urls = Array.from(selectedPendingUrls).filter(Boolean);
  if (!urls.length) {
    setStatus("请先选择要批阅的作业");
    return;
  }
  await flushPendingSettingsSave();
  const config = await readSharedReviewSettings();
  if (!safeText(config.licenseKey)) {
    setStatus("请先在设置里填写插件授权码");
    setView("settings");
    return;
  }
  if (!config.autoFill || !config.autoSubmit || safeText(config.submitMode) !== "next") {
    setStatus("请先开启自动回填、自动提交，并选择“提交并进入下一份”模式");
    setView("settings");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "refreshPluginGatewaySession",
      payload: {
        timeoutMs: Math.max(5000, Math.round((Number(config.timeoutSeconds) || 20) * 1000)),
      },
    });
    if (!response || response.ok === false) {
      throw new Error((response && response.error) || "插件授权校验失败");
    }

    const [firstUrl] = urls;
    await chrome.storage.local.set({
      [REVIEW_BATCH_QUEUE_STORAGE_KEY]: {
        active: true,
        urls,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
      },
    });
    let firstTabId = null;
    if (typeof activeTabId === "number") {
      const updated = await chrome.tabs.update(activeTabId, { url: firstUrl, active: true });
      firstTabId = updated && updated.id;
    } else {
      const created = await chrome.tabs.create({ url: firstUrl, active: true });
      firstTabId = created && created.id;
    }

    if (typeof firstTabId === "number") {
      await waitForTabComplete(firstTabId, 20000);
      await runTabActionFromPopup(firstTabId, "startAutoReviewFlow", {});
    }

    renderPluginAuthState(await fetchPluginAuthState(true, false, false));
    setStatus(`已启动串行批阅，共 ${urls.length} 个作业，当前页完成后会自动进入下一份`);
    window.close();
  } catch (error) {
    setStatus(`批量打开批阅页失败：${error.message}`);
  }
}

function populateModelOptions(preferredModel) {
  const nextModels = getSharedModelOptions();
  const nextOptions = [...nextModels, { value: "__custom__", label: "自定义模型" }];
  settingsEls.modelSelect.innerHTML = nextOptions
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
    .join("");

  if (preferredModel && nextModels.some((item) => item.value === preferredModel)) {
    settingsEls.modelSelect.value = preferredModel;
    settingsEls.model.value = preferredModel;
    settingsEls.model.hidden = true;
  } else {
    settingsEls.modelSelect.value = "__custom__";
    settingsEls.model.value = preferredModel || getDefaultReviewSettings().model || "";
    settingsEls.model.hidden = false;
  }
}

function getSettingsPayload() {
  const selectedModel = safeText(settingsEls.modelSelect.value);
  const typedModel = safeText(settingsEls.model.value);
  return {
    licenseKey: safeText(settingsEls.licenseKey.value),
    rememberLicense: !!settingsEls.rememberLicense.checked,
    model: selectedModel && selectedModel !== "__custom__" ? selectedModel : typedModel,
    timeoutSeconds: Number(settingsEls.timeout.value),
    extraPrompt: safeText(settingsEls.extraPrompt.value),
    autoFill: !!settingsEls.autoFill.checked,
    autoSubmit: !!settingsEls.autoSubmit.checked,
    submitMode: safeText(settingsEls.submitMode.value) || "current",
  };
}

async function saveSettings() {
  if (settingsHydrating) {
    return;
  }
  const payload = getSettingsPayload();
  await writeSharedReviewSettings(payload);
  setStatus("设置已保存");
}

function syncSubmitModeDisabled() {
  settingsEls.submitMode.disabled = !settingsEls.autoSubmit.checked;
}

function scheduleSaveSettings() {
  if (settingsHydrating) {
    return;
  }
  if (settingsPersistTimer) {
    window.clearTimeout(settingsPersistTimer);
  }
  settingsPersistTimer = window.setTimeout(() => {
    settingsPersistTimer = null;
    saveSettings().catch((error) => {
      setStatus(`保存设置失败：${error.message}`);
    });
  }, 250);
}

async function flushPendingSettingsSave() {
  if (!settingsPersistTimer) {
    return;
  }
  window.clearTimeout(settingsPersistTimer);
  settingsPersistTimer = null;
  await saveSettings();
}

async function hydrateSettings() {
  settingsHydrating = true;
  const merged = await readSharedReviewSettings();

  const gatewayText = getGatewayBaseUrlText();
  settingsEls.gatewayBaseUrl.value = gatewayText;
  settingsEls.gatewayBaseUrl.title = gatewayText;
  settingsEls.licenseKey.value = safeText(merged.licenseKey);
  settingsEls.rememberLicense.checked = !!merged.rememberLicense;
  populateModelOptions(safeText(merged.model));
  settingsEls.timeout.value = String(Number(merged.timeoutSeconds) || 20);
  settingsEls.extraPrompt.value = safeText(merged.extraPrompt);
  settingsEls.autoFill.checked = !!merged.autoFill;
  settingsEls.autoSubmit.checked = !!merged.autoSubmit;
  settingsEls.submitMode.value = safeText(merged.submitMode) || "current";
  syncSubmitModeDisabled();
  renderPluginAuthState(await fetchPluginAuthState(false, false, false));
  settingsHydrating = false;
}

async function testCurrentSettings() {
  await flushPendingSettingsSave();
  const payload = getSettingsPayload();
  if (!isSharedGatewayConfigured()) {
    throw new Error("请先填写插件网关地址");
  }
  if (!payload.licenseKey) {
    throw new Error("请先填写插件授权码");
  }
  if (!payload.model) {
    throw new Error("请先填写模型名");
  }

  settingsEls.testGatewayBtn.disabled = true;
  setTestStatus("正在校验插件授权...", "neutral");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "refreshPluginGatewaySession",
      payload: {
        timeoutMs: Math.max(5000, Math.round((Number(payload.timeoutSeconds) || 20) * 1000)),
      },
    });
    if (!response || response.ok === false) {
      throw new Error((response && response.error) || "授权校验失败");
    }
    renderPluginAuthState(await fetchPluginAuthState(true, false, false));
    setStatus(response.message || "插件网关授权正常");
  } catch (error) {
    renderPluginAuthState(await fetchPluginAuthState(false, false, false).catch(() => ({ lastError: error.message })));
    setStatus(`插件网关校验失败：${error.message}`);
    throw error;
  } finally {
    settingsEls.testGatewayBtn.disabled = false;
  }
}

function bindSettingsEvents() {
  settingsEls.modelSelect.addEventListener("change", async () => {
    if (settingsEls.modelSelect.value !== "__custom__") {
      settingsEls.model.value = settingsEls.modelSelect.value;
      settingsEls.model.hidden = true;
    } else {
      settingsEls.model.hidden = false;
      settingsEls.model.value = "";
    }
    setTestStatus("模型已切换，请在需要时重新校验授权。", "neutral");
    scheduleSaveSettings();
  });

  [settingsEls.licenseKey, settingsEls.model, settingsEls.timeout, settingsEls.extraPrompt].forEach((node) => {
    node.addEventListener("input", async () => {
      if (node === settingsEls.licenseKey) {
        setTestStatus("授权码已修改，请重新校验授权。", "neutral");
      } else if (node === settingsEls.model) {
        setTestStatus("模型已修改，请在需要时重新校验授权。", "neutral");
      }
      scheduleSaveSettings();
    });
  });

  [settingsEls.rememberLicense, settingsEls.autoFill, settingsEls.autoSubmit, settingsEls.submitMode].forEach((node) => {
    node.addEventListener("change", async () => {
      syncSubmitModeDisabled();
      scheduleSaveSettings();
    });
  });

  settingsEls.testGatewayBtn.addEventListener("click", () => {
    testCurrentSettings().catch((error) => {
      setTestStatus(`授权校验失败：${error.message}`, "error");
    });
  });
}

async function handleBatchReview() {
  const urls = Array.from(selectedPendingUrls).filter(Boolean);
  if (!urls.length) {
    setStatus("请至少选择一份作业。");
    return;
  }

  await flushPendingSettingsSave();
  const config = await readSharedReviewSettings();
  const connectionMode = getConnectionModeValue(config.connectionMode);

  if (!config.autoFill || !config.autoSubmit || safeText(config.submitMode) !== "next") {
    setStatus("请先启用自动填写、自动提交，并选择“提交并进入下一份”。");
    setView("settings");
    return;
  }

  if (connectionMode === "custom_api") {
    if (!safeText(config.endpoint)) {
      setStatus("请先配置自定义 API 地址。");
      setView("settings");
      return;
    }
    if (!safeText(config.apiKey)) {
      setStatus("请先配置自定义 API 密钥。");
      setView("settings");
      return;
    }
  } else if (!safeText(config.licenseKey)) {
    setStatus("请先填写插件授权码。");
    setView("settings");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: connectionMode === "custom_api" ? "testAiEndpoint" : "refreshPluginGatewaySession",
      payload: Object.assign(
        {
          connectionMode,
          timeoutMs: Math.max(5000, Math.round((Number(config.timeoutSeconds) || 20) * 1000)),
        },
        connectionMode === "custom_api"
          ? {
              provider: safeText(config.provider) || inferProviderFromEndpoint(config.endpoint),
              endpoint: safeText(config.endpoint),
              apiKey: safeText(config.apiKey),
              model: safeText(config.model),
            }
          : {}
      ),
    });

    if (!response || response.ok === false) {
      throw new Error((response && response.error) || "连接检查失败。");
    }

    const [firstUrl] = urls;
    await chrome.storage.local.set({
      [REVIEW_BATCH_QUEUE_STORAGE_KEY]: {
        active: true,
        urls,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
      },
    });

    let firstTabId = null;
    if (typeof activeTabId === "number") {
      const updated = await chrome.tabs.update(activeTabId, { url: firstUrl, active: true });
      firstTabId = updated && updated.id;
    } else {
      const created = await chrome.tabs.create({ url: firstUrl, active: true });
      firstTabId = created && created.id;
    }

    if (typeof firstTabId === "number") {
      await waitForTabComplete(firstTabId, 20000);
      await runTabActionFromPopup(firstTabId, "startAutoReviewFlow", {});
    }

    if (connectionMode === "custom_api") {
      syncConnectionModeUi(connectionMode, {
        state: {
          ok: true,
          provider: safeText(config.provider) || inferProviderFromEndpoint(config.endpoint),
          endpoint: safeText(config.endpoint),
          message: "自定义 API 测试通过。",
        },
      });
    } else {
      syncConnectionModeUi(connectionMode, {
        state: await fetchPluginAuthState(true, false, false),
      });
    }

    setStatus(`已开始批量批阅，共 ${urls.length} 份作业。`);
    window.close();
  } catch (error) {
    setStatus(`启动批量批阅失败：${error.message}`);
  }
}

function populateModelOptions(preferredModel) {
  const connectionMode = getConnectionModeValue(settingsEls.connectionMode && settingsEls.connectionMode.value);
  const providerId =
    safeText(settingsEls.provider && settingsEls.provider.value) ||
    inferProviderFromEndpoint(settingsEls.endpoint && settingsEls.endpoint.value) ||
    "custom";
  const nextModels = getSharedModelOptions(connectionMode, providerId);
  const nextOptions = [...nextModels, { value: "__custom__", label: "自定义模型" }];
  settingsEls.modelSelect.innerHTML = nextOptions
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
    .join("");

  if (preferredModel && nextModels.some((item) => item.value === preferredModel)) {
    settingsEls.modelSelect.value = preferredModel;
    settingsEls.model.value = preferredModel;
    settingsEls.model.hidden = true;
  } else {
    settingsEls.modelSelect.value = "__custom__";
    settingsEls.model.value = preferredModel || getDefaultReviewSettings().model || "";
    settingsEls.model.hidden = false;
  }
}

function getSettingsPayload() {
  const selectedModel = safeText(settingsEls.modelSelect.value);
  const typedModel = safeText(settingsEls.model.value);
  const connectionMode = getConnectionModeValue(settingsEls.connectionMode && settingsEls.connectionMode.value);
  return {
    connectionMode,
    gatewayBaseUrl: safeText(settingsEls.gatewayBaseUrl.value),
    provider:
      connectionMode === "custom_api"
        ? safeText(settingsEls.provider.value) || inferProviderFromEndpoint(settingsEls.endpoint.value)
        : "plugin_gateway",
    endpoint: connectionMode === "custom_api" ? safeText(settingsEls.endpoint.value) : "",
    apiKey: connectionMode === "custom_api" ? safeText(settingsEls.apiKey.value) : "",
    rememberApiKey: connectionMode === "custom_api" ? !!settingsEls.rememberApiKey.checked : false,
    licenseKey: safeText(settingsEls.licenseKey.value),
    rememberLicense: !!settingsEls.rememberLicense.checked,
    model: selectedModel && selectedModel !== "__custom__" ? selectedModel : typedModel,
    timeoutSeconds: Number(settingsEls.timeout.value),
    extraPrompt: safeText(settingsEls.extraPrompt.value),
    autoFill: !!settingsEls.autoFill.checked,
    autoSubmit: !!settingsEls.autoSubmit.checked,
    submitMode: safeText(settingsEls.submitMode.value) || "current",
  };
}

async function saveSettings() {
  if (settingsHydrating) {
    return;
  }
  await writeSharedReviewSettings(getSettingsPayload());
  setStatus("设置已保存。");
}

function syncSubmitModeDisabled() {
  settingsEls.submitMode.disabled = !settingsEls.autoSubmit.checked;
}

function scheduleSaveSettings() {
  if (settingsHydrating) {
    return;
  }
  if (settingsPersistTimer) {
    window.clearTimeout(settingsPersistTimer);
  }
  settingsPersistTimer = window.setTimeout(() => {
    settingsPersistTimer = null;
    saveSettings().catch((error) => {
      setStatus(`保存设置失败：${error.message}`);
    });
  }, 250);
}

async function flushPendingSettingsSave() {
  if (!settingsPersistTimer) {
    return;
  }
  window.clearTimeout(settingsPersistTimer);
  settingsPersistTimer = null;
  await saveSettings();
}

async function hydrateSettings() {
  settingsHydrating = true;
  const merged = await readSharedReviewSettings();
  populateProviderOptions();

  const gatewayText = safeText(merged.gatewayBaseUrl) || getGatewayBaseUrlText();
  settingsEls.gatewayBaseUrl.value = gatewayText;
  settingsEls.gatewayBaseUrl.title = gatewayText;
  settingsEls.connectionMode.value = getConnectionModeValue(merged.connectionMode);
  settingsEls.licenseKey.value = safeText(merged.licenseKey);
  settingsEls.rememberLicense.checked = !!merged.rememberLicense;
  settingsEls.provider.value = safeText(merged.provider) || inferProviderFromEndpoint(merged.endpoint) || "custom";
  settingsEls.endpoint.value = safeText(merged.endpoint);
  settingsEls.apiKey.value = safeText(merged.apiKey);
  settingsEls.rememberApiKey.checked = !!merged.rememberApiKey;
  populateModelOptions(safeText(merged.model));
  settingsEls.timeout.value = String(Number(merged.timeoutSeconds) || 20);
  settingsEls.extraPrompt.value = safeText(merged.extraPrompt);
  settingsEls.autoFill.checked = !!merged.autoFill;
  settingsEls.autoSubmit.checked = !!merged.autoSubmit;
  settingsEls.submitMode.value = safeText(merged.submitMode) || "current";
  syncSubmitModeDisabled();

  if (isGatewayModeSelected(merged.connectionMode)) {
    syncConnectionModeUi(merged.connectionMode, {
      state: await fetchPluginAuthState(false, false, false),
    });
  } else {
    syncConnectionModeUi(merged.connectionMode, {
      state: {
        provider: safeText(merged.provider) || inferProviderFromEndpoint(merged.endpoint),
        endpoint: safeText(merged.endpoint),
        message: "自定义 API 模式会使用你自己的接口地址和 API 密钥。",
      },
    });
  }

  settingsHydrating = false;
}

async function testCurrentSettings() {
  await flushPendingSettingsSave();
  const payload = getSettingsPayload();
  const gatewayMode = isGatewayModeSelected(payload.connectionMode);

  if (!payload.model) {
    throw new Error("请先填写模型名。");
  }

  settingsEls.testGatewayBtn.disabled = true;
  setTestStatus(gatewayMode ? "正在校验插件网关授权..." : "正在测试自定义 API...", "neutral");

  try {
    let response;
    if (gatewayMode) {
      if (!isSharedGatewayConfigured(payload.gatewayBaseUrl)) {
        throw new Error("请先填写插件网关地址。");
      }
      if (!payload.licenseKey) {
        throw new Error("请先填写插件授权码。");
      }
      response = await chrome.runtime.sendMessage({
        type: "refreshPluginGatewaySession",
        payload: {
          connectionMode: payload.connectionMode,
          timeoutMs: Math.max(5000, Math.round((Number(payload.timeoutSeconds) || 20) * 1000)),
        },
      });
      if (!response || response.ok === false) {
        throw new Error((response && response.error) || "插件网关授权失败。");
      }
      syncConnectionModeUi(payload.connectionMode, {
        state: await fetchPluginAuthState(true, false, false),
      });
      setStatus(response.message || "插件网关授权已就绪。");
    } else {
      if (!payload.endpoint) {
        throw new Error("请先填写自定义 API 地址。");
      }
      if (!payload.apiKey) {
        throw new Error("请先填写自定义 API 密钥。");
      }
      response = await chrome.runtime.sendMessage({
        type: "testAiEndpoint",
        payload: {
          connectionMode: payload.connectionMode,
          provider: payload.provider,
          endpoint: payload.endpoint,
          apiKey: payload.apiKey,
          model: payload.model,
          timeoutMs: Math.max(5000, Math.round((Number(payload.timeoutSeconds) || 20) * 1000)),
        },
      });
      if (!response || response.ok === false) {
        throw new Error((response && response.error) || "自定义 API 测试失败。");
      }
      syncConnectionModeUi(payload.connectionMode, {
        state: {
          ok: true,
          provider: payload.provider,
          endpoint: payload.endpoint,
          message: `自定义 API 已就绪：${payload.model}`,
        },
      });
      setStatus("自定义 API 连接已就绪。");
    }
  } catch (error) {
    if (gatewayMode) {
      syncConnectionModeUi(payload.connectionMode, {
        state: await fetchPluginAuthState(false, false, false).catch(() => ({ lastError: error.message })),
      });
    } else {
      syncConnectionModeUi(payload.connectionMode, {
        state: {
          ok: false,
          provider: payload.provider,
          endpoint: payload.endpoint,
          message: error.message,
        },
      });
    }
    throw error;
  } finally {
    settingsEls.testGatewayBtn.disabled = false;
  }
}

function bindSettingsEvents() {
  settingsEls.connectionMode.addEventListener("change", () => {
    const mode = getConnectionModeValue(settingsEls.connectionMode.value);
    if (mode === "custom_api") {
      const preset = getProviderPreset(safeText(settingsEls.provider.value) || "moonshot");
      if (!safeText(settingsEls.endpoint.value) && safeText(preset.endpoint)) {
        settingsEls.endpoint.value = preset.endpoint;
      }
    }
    populateModelOptions(safeText(settingsEls.model.value));
    syncConnectionModeUi(mode);
    setTestStatus(mode === "custom_api" ? "已切换到自定义 API 模式。" : "已切换到插件网关模式。", "neutral");
    scheduleSaveSettings();
  });

  settingsEls.provider.addEventListener("change", () => {
    const preset = getProviderPreset(settingsEls.provider.value);
    if (safeText(preset.endpoint)) {
      settingsEls.endpoint.value = preset.endpoint;
    }
    populateModelOptions(safeText(settingsEls.model.value) || safeText(preset.model));
    syncConnectionModeUi("custom_api");
    setTestStatus("接口提供方已变更，请重新测试自定义 API。", "neutral");
    scheduleSaveSettings();
  });

  settingsEls.modelSelect.addEventListener("change", () => {
    if (settingsEls.modelSelect.value !== "__custom__") {
      settingsEls.model.value = settingsEls.modelSelect.value;
      settingsEls.model.hidden = true;
    } else {
      settingsEls.model.hidden = false;
      settingsEls.model.value = "";
    }
    scheduleSaveSettings();
  });

  [settingsEls.gatewayBaseUrl, settingsEls.licenseKey, settingsEls.endpoint, settingsEls.apiKey, settingsEls.model, settingsEls.timeout, settingsEls.extraPrompt].forEach((node) => {
    node.addEventListener("input", () => {
      const gatewayMode = isGatewayModeSelected(settingsEls.connectionMode.value);
      if (node === settingsEls.gatewayBaseUrl && gatewayMode) {
        setTestStatus("插件网关地址已变更，请重新校验授权。", "neutral");
      }
      if (node === settingsEls.endpoint && !gatewayMode) {
        const inferredProvider = inferProviderFromEndpoint(settingsEls.endpoint.value);
        if (inferredProvider && inferredProvider !== "custom") {
          settingsEls.provider.value = inferredProvider;
        }
        syncConnectionModeUi("custom_api");
      }
      if (node === settingsEls.licenseKey && gatewayMode) {
        setTestStatus("插件授权码已变更，请重新校验。", "neutral");
      } else if ((node === settingsEls.endpoint || node === settingsEls.apiKey) && !gatewayMode) {
        setTestStatus("自定义 API 设置已变更，请重新测试。", "neutral");
      }
      scheduleSaveSettings();
    });
  });

  [settingsEls.rememberLicense, settingsEls.rememberApiKey, settingsEls.autoFill, settingsEls.autoSubmit, settingsEls.submitMode].forEach((node) => {
    node.addEventListener("change", () => {
      syncSubmitModeDisabled();
      scheduleSaveSettings();
    });
  });

  settingsEls.testGatewayBtn.addEventListener("click", () => {
    testCurrentSettings().catch((error) => {
      setTestStatus(error.message, "error");
      setStatus(error.message);
    });
  });
}

async function updatePageMeta() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs.length ? tabs[0] : null;
  if (!tab) {
    pageMetaEl.textContent = "无法获取当前页面信息";
    return;
  }

  activeTabId = tab.id;
  const isChaoxing = safeText(tab.url).includes("chaoxing.com");
  pageMetaEl.textContent = isChaoxing ? "已识别超星页面" : `当前页面：${safeText(tab.title) || "未命名标签页"}`;
}

function bindTabEvents() {
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setView(button.dataset.view);
    });
  });

  selectAllPendingInputEl.addEventListener("change", () => {
    const checkboxes = Array.from(pendingHomeworkListEl.querySelectorAll(".pending-checkbox"));
    checkboxes.forEach((checkbox) => {
      checkbox.checked = selectAllPendingInputEl.checked;
      const url = safeText(checkbox.dataset.url);
      if (!url) {
        return;
      }
      if (selectAllPendingInputEl.checked) {
        selectedPendingUrls.add(url);
      } else {
        selectedPendingUrls.delete(url);
      }
      const card = checkbox.closest(".pending-card");
      if (card) {
        card.classList.toggle("selected", checkbox.checked);
      }
    });
    updateSelectAllState(
      checkboxes.map((checkbox) => ({
        url: checkbox.dataset.url,
      }))
    );
    updateBatchReviewState();
  });

  batchReviewBtnEl.addEventListener("click", () => {
    handleBatchReview().catch((error) => {
      setStatus(`一键批阅失败：${error.message}`);
    });
  });
}

function bindStorageRefresh() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes[AUTO_EXTRACT_STORAGE_KEY]) {
      refreshAutoData().catch((error) => setStatus(`刷新日志失败：${error.message}`));
    }
    if (changes[REVIEW_SETTINGS_STORAGE_KEY] && !settingsHydrating) {
      hydrateSettings().catch((error) => setStatus(`同步设置失败：${error.message}`));
    }
  });
}

function startAutoRefresh() {
  return;
}

function stopAutoRefresh() {
  return;
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    setView("home");
    updateBatchReviewState();
    bindTabEvents();
    bindSettingsEvents();
    bindStorageRefresh();
    await updatePageMeta();
    await hydrateSettings();
    await refreshAutoData();
  } catch (error) {
    setStatus(`初始化失败：${error.message}`);
  }
});

window.addEventListener("beforeunload", () => {
  if (settingsPersistTimer) {
    window.clearTimeout(settingsPersistTimer);
    settingsPersistTimer = null;
  }
});
