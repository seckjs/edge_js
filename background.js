importScripts("review-shared.js");

const {
  STORAGE_KEYS,
  PLUGIN_GATEWAY_CONFIG,
  buildGatewayUrl,
  ensureAiEndpointPermission,
  ensureGatewayPermission,
  getGatewayBaseUrl,
  isGatewayConfigured,
  normalizeAiEndpoint,
  readReviewSettingsFromStorage,
  writeReviewSettingsToStorage,
} = self.CX_REVIEW_SHARED;

function promisifyChrome(method, context, ...args) {
  return new Promise((resolve, reject) => {
    method.call(context, ...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

async function getAllFrames(tabId) {
  try {
    const frames = await promisifyChrome(
      chrome.webNavigation.getAllFrames,
      chrome.webNavigation,
      { tabId }
    );
    return Array.isArray(frames) && frames.length
      ? frames
      : [{ frameId: 0, parentFrameId: -1, url: "" }];
  } catch (error) {
    return [{ frameId: 0, parentFrameId: -1, url: "", error: error.message }];
  }
}

async function sendMessageToFrame(tabId, frameId, payload) {
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, payload, { frameId }, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result);
      });
    });
    return response || { ok: false, handled: false, frameId, error: "空响应" };
  } catch (error) {
    return { ok: false, handled: false, frameId, error: error.message };
  }
}

function scoreResponse(response) {
  const priority = Number(response && response.priority) || 0;
  const count = Number(response && response.count) || 0;
  return priority * 1000 + count;
}

async function runTabAction(tabId, action, payload) {
  const frames = await getAllFrames(tabId);
  const responses = await Promise.all(
    frames.map(async (frame) => {
      const response = await sendMessageToFrame(tabId, frame.frameId, {
        type: "runAction",
        action,
        payload: payload || {},
      });
      return {
        frameId: frame.frameId,
        frameUrl: frame.url || "",
        response,
      };
    })
  );

  const valid = responses
    .map((entry) => {
      const merged = Object.assign({}, entry.response || {}, {
        frameId: entry.frameId,
        frameUrl: (entry.response && entry.response.frameUrl) || entry.frameUrl || "",
      });
      return merged;
    })
    .filter((item) => item && item.ok && item.handled !== false);

  if (!valid.length) {
    return {
      ok: false,
      action,
      error: "当前标签页没有找到可处理的超星页面内容。",
      responses,
    };
  }

  valid.sort((a, b) => scoreResponse(b) - scoreResponse(a));
  const best = valid[0];

  return {
    ok: true,
    action,
    best,
    candidates: valid.map((item) => ({
      frameId: item.frameId,
      frameUrl: item.frameUrl,
      count: item.count || 0,
      priority: item.priority || 0,
      summary: item.summary || "",
    })),
  };
}

async function downloadJson(filename, data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await promisifyChrome(
      chrome.downloads.download,
      chrome.downloads,
      {
        url,
        filename,
        saveAs: true,
      }
    );
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true, downloadId };
  } catch (error) {
    URL.revokeObjectURL(url);
    return { ok: false, error: error.message };
  }
}

function safeText(value) {
  return String(value == null ? "" : value).trim();
}

const PLUGIN_AUTH_STATE_STORAGE_KEY = STORAGE_KEYS.pluginGatewayAuthState;
const PLUGIN_SESSION_STORAGE_KEY = STORAGE_KEYS.pluginGatewaySession;
const AUTH_KEY_DB_NAME = "cx-plugin-auth-db";
const AUTH_KEY_DB_VERSION = 1;
const AUTH_KEY_STORE_NAME = "keys";
const AUTH_KEY_PAIR_ID = "device-key-pair";
const AUTH_REQUEST_RETRY_COUNT = 2;
const AUTH_REQUEST_TIMEOUT_MS = 15000;

const AUTO_EXTRACT_STORAGE_KEY = STORAGE_KEYS.autoExtract;
const AUTO_CRAWL_RUNTIME_STORAGE_KEY = STORAGE_KEYS.autoCrawlRuntime;
const AUTO_CRAWL_TRIGGER_COOLDOWN_MS = 2 * 60 * 1000;
const AUTO_CRAWL_PAGE_WAIT_MS = 900;
const AUTO_CRAWL_RETRY_INTERVAL_MS = 900;
const AUTO_CRAWL_FAST_INTERVAL_MS = 700;
const AUTO_CRAWL_PAGINATION_WAIT_MS = 700;
const AUTO_CRAWL_COURSE_URL = "https://mooc2-ans.chaoxing.com/visit/interaction";
const AUTO_CRAWL_HOMEWORK_LIST_URL = "https://mooc2-ans.chaoxing.com/mooc2-ans/work/list";
const AUTO_CRAWL_MARK_LIST_URL = "https://mooc2-ans.chaoxing.com/mooc2-ans/work/mark-list";
const AUTO_CRAWL_LIST_PAGE_SIZE = 100;
const AUTO_CRAWL_REQUEST_TIMEOUT_MS = 15000;
const AUTO_CRAWL_REQUEST_RETRY_COUNT = 2;

const autoCrawlJobs = new Map();
let autoCrawlRunning = false;
let lastAutoCrawlStartedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAttemptError(error) {
  const message = safeText(error && error.message);
  return message || String(error || "未知错误");
}

function isChaoxingUrl(url) {
  const text = safeText(url).toLowerCase();
  return text.includes("chaoxing.com") || text.includes("chaoxing.com.cn");
}

function isLoginLandingUrl(url) {
  const text = safeText(url).toLowerCase();
  return text.includes("://i.chaoxing.com/base") || text.includes("://i.chaoxing.com.cn/base");
}

function buildAggregateExport(kind, records, extra) {
  const normalizedRecords = Array.isArray(records) ? records : [];
  return {
    kind,
    generated_at: new Date().toISOString(),
    page_url: "",
    page_title: "",
    frame_url: "",
    frame_title: "",
    record_count: normalizedRecords.length,
    records: normalizedRecords,
    extra: extra || {},
  };
}

function uniqueRecords(records, getKey) {
  const seen = new Set();
  const result = [];
  for (const record of Array.isArray(records) ? records : []) {
    const key = safeText(getKey(record));
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    result.push(record);
  }
  return result;
}

function buildCourseProgressEntry(record) {
  return {
    course_name: safeText(record && (record.course_name || record.title)),
    course_id: safeText(record && record.course_id),
    class_id: safeText(record && record.class_id),
    url: safeText(record && record.url),
    status: "等待抓取",
    stage: "queued",
    homework_count: 0,
    homework_done_count: 0,
    skipped_homework_count: 0,
    submission_count: 0,
    current_homework_name: "",
    last_error: "",
    updated_at: new Date().toISOString(),
  };
}

function getCurrentHomeworkKey(job) {
  return homeworkKey(job && job.currentHomework);
}

function ensureCourseProgress(job, course) {
  const key = courseKey(course);
  if (!key) {
    return null;
  }

  if (!job.courseProgressMap[key]) {
    job.courseProgressMap[key] = buildCourseProgressEntry(course);
    job.courseProgressOrder.push(key);
  }

  return job.courseProgressMap[key];
}

function updateCourseProgress(job, course, patch) {
  const entry = ensureCourseProgress(job, course);
  if (!entry) {
    return null;
  }

  Object.assign(entry, patch || {}, {
    updated_at: new Date().toISOString(),
  });
  return entry;
}

function getCourseProgressList(job) {
  return job.courseProgressOrder
    .map((key) => job.courseProgressMap[key])
    .filter(Boolean)
    .map((entry) => Object.assign({}, entry));
}

function courseKey(record) {
  const explicitKey = safeText(record && (record._courseKey || record.progress_key));
  if (explicitKey) {
    return explicitKey;
  }

  const courseId = safeText(record && record.course_id);
  const classId = safeText(record && record.class_id);
  const pairKey = [courseId, classId].filter(Boolean).join("_");
  return (
    safeText(pairKey) ||
    safeText(courseId) ||
    safeText(record && record.url) ||
    safeText(record && record.course_name) ||
    safeText(record && record.title)
  );
}

function attachStableCourseKeys(records) {
  return (Array.isArray(records) ? records : []).map((record) => {
    const nextRecord = Object.assign({}, record);
    nextRecord._courseKey = courseKey(nextRecord);
    return nextRecord;
  });
}

function homeworkKey(record) {
  return safeText(
    safeText(record && record.work_id) ||
      safeText(record && record.url) ||
      `${safeText(record && record.course_id)}_${safeText(record && record.homework_name)}`
  );
}

function submissionKey(record) {
  return safeText(
    safeText(record && (record.answer_id || record.workAnswerId)) ||
      safeText(record && record.url) ||
      `${safeText(record && record.work_id)}_${safeText(record && record.student_id)}_${safeText(
        record && record.student_name
      )}`
  );
}

function mergeExportRecords(kind, previousExport, incomingRecords, keySelector, extra) {
  const previousRecords =
    previousExport && Array.isArray(previousExport.records) ? previousExport.records : [];
  const mergedRecords = uniqueRecords([...previousRecords, ...(incomingRecords || [])], keySelector);
  if (!mergedRecords.length && !previousRecords.length && !(incomingRecords || []).length) {
    return null;
  }
  const mergedExtra = Object.assign({}, (previousExport && previousExport.extra) || {}, extra || {});
  return buildAggregateExport(kind, mergedRecords, mergedExtra);
}

async function getStoredAutoExtractData() {
  const result = await promisifyChrome(
    chrome.storage.local.get,
    chrome.storage.local,
    [AUTO_EXTRACT_STORAGE_KEY]
  );
  return (result && result[AUTO_EXTRACT_STORAGE_KEY]) || null;
}

async function saveStoredAutoExtractData(payload) {
  await promisifyChrome(chrome.storage.local.set, chrome.storage.local, {
    [AUTO_EXTRACT_STORAGE_KEY]: payload,
  });
}

function cloneAutoCrawlRecord(record) {
  return record && typeof record === "object" ? Object.assign({}, record) : null;
}

function serializeAutoCrawlJob(job) {
  if (!job || typeof job !== "object") {
    return null;
  }

  return {
    sourceTabId: typeof job.sourceTabId === "number" ? job.sourceTabId : null,
    stage: safeText(job.stage) || "loading_courses",
    startedAt: safeText(job.startedAt) || new Date().toISOString(),
    courseProgressMap: job.courseProgressMap && typeof job.courseProgressMap === "object" ? job.courseProgressMap : {},
    courseProgressOrder: Array.isArray(job.courseProgressOrder) ? job.courseProgressOrder.slice() : [],
    skippedHomeworkKeys: Array.from(job.skippedHomeworkKeys || []),
    currentCourse: cloneAutoCrawlRecord(job.currentCourse),
    currentHomework: cloneAutoCrawlRecord(job.currentHomework),
    courseQueue: Array.isArray(job.courseQueue) ? job.courseQueue.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    homeworkQueue: Array.isArray(job.homeworkQueue) ? job.homeworkQueue.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    courses: Array.isArray(job.courses) ? job.courses.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    homeworks: Array.isArray(job.homeworks) ? job.homeworks.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    submissions: Array.isArray(job.submissions) ? job.submissions.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    errors: Array.isArray(job.errors) ? job.errors.slice(-100) : [],
  };
}

function hydrateAutoCrawlJob(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return {
    sourceTabId: typeof payload.sourceTabId === "number" ? payload.sourceTabId : null,
    crawlTabId: null,
    crawlWindowId: null,
    stage: safeText(payload.stage) || "loading_courses",
    startedAt: safeText(payload.startedAt) || new Date().toISOString(),
    processing: false,
    courseProgressMap:
      payload.courseProgressMap && typeof payload.courseProgressMap === "object" ? payload.courseProgressMap : {},
    courseProgressOrder: Array.isArray(payload.courseProgressOrder) ? payload.courseProgressOrder.slice() : [],
    skippedHomeworkKeys: new Set(
      (Array.isArray(payload.skippedHomeworkKeys) ? payload.skippedHomeworkKeys : []).map((item) => safeText(item)).filter(Boolean)
    ),
    currentCourse: cloneAutoCrawlRecord(payload.currentCourse),
    currentHomework: cloneAutoCrawlRecord(payload.currentHomework),
    courseQueue: Array.isArray(payload.courseQueue) ? payload.courseQueue.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    homeworkQueue:
      Array.isArray(payload.homeworkQueue) ? payload.homeworkQueue.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    courses: Array.isArray(payload.courses) ? payload.courses.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    homeworks: Array.isArray(payload.homeworks) ? payload.homeworks.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    submissions:
      Array.isArray(payload.submissions) ? payload.submissions.map(cloneAutoCrawlRecord).filter(Boolean) : [],
    errors: Array.isArray(payload.errors) ? payload.errors.slice() : [],
  };
}

async function loadAutoCrawlRuntimeState() {
  const result = await promisifyChrome(chrome.storage.session.get, chrome.storage.session, [AUTO_CRAWL_RUNTIME_STORAGE_KEY]);
  return (result && result[AUTO_CRAWL_RUNTIME_STORAGE_KEY]) || null;
}

async function saveAutoCrawlRuntimeState(job) {
  await promisifyChrome(chrome.storage.session.set, chrome.storage.session, {
    [AUTO_CRAWL_RUNTIME_STORAGE_KEY]: {
      running: !!job,
      lastStartedAt: Number(lastAutoCrawlStartedAt) || 0,
      job: job ? serializeAutoCrawlJob(job) : null,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function clearAutoCrawlRuntimeState() {
  await saveAutoCrawlRuntimeState(null);
}

async function recoverInterruptedAutoExtractState() {
  const runtime = await loadAutoCrawlRuntimeState();
  lastAutoCrawlStartedAt = Number(runtime && runtime.lastStartedAt) || 0;

  if (runtime && runtime.running && runtime.job) {
    const restoredJob = hydrateAutoCrawlJob(runtime.job);
    if (restoredJob) {
      autoCrawlRunning = true;
      void runInvisibleAutoCrawl(restoredJob);
      return;
    }
  }

  const previous = await getStoredAutoExtractData();
  if (!previous || previous.status !== "running") {
    return;
  }

  const next = Object.assign({}, previous, {
    timestamp: new Date().toISOString(),
    status: "failed",
    stage: "interrupted",
    context: Object.assign({}, previous.context || {}, {
      status: "failed",
      stage: "interrupted",
      error_message: "浏览器或插件重启，自动抓取已中断",
    }),
  });
  await saveStoredAutoExtractData(next);
}

function getResultExport(result) {
  return result && result.best && result.best.export ? result.best.export : null;
}

function getResultRecords(result) {
  const exportPayload = getResultExport(result);
  return exportPayload && Array.isArray(exportPayload.records) ? exportPayload.records : [];
}

function getResultData(result) {
  return result && result.best && result.best.data ? result.best.data : null;
}

function resolveAutoCrawlUrl(rawUrl) {
  const text = safeText(rawUrl);
  if (!text) {
    return "";
  }
  try {
    return new URL(text, AUTO_CRAWL_COURSE_URL).toString();
  } catch (error) {
    return text;
  }
}

function decodeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value) {
  return safeText(decodeHtml(String(value == null ? "" : value).replace(/<[^>]+>/g, " "))).replace(/\s+/g, " ");
}

function firstMatch(text, pattern, groupIndex) {
  const matched = String(text || "").match(pattern);
  if (!matched) {
    return "";
  }
  return safeText(matched[groupIndex == null ? 1 : groupIndex]);
}

function parseJsonSafely(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    return null;
  }
}

async function legacyFetchTextWithRetryUnused(url, init, options) {
  const retryCount = Math.max(1, Number((options && options.retryCount) || 1));
  const timeoutMs = Math.max(3000, Number((options && options.timeoutMs) || AUTO_CRAWL_REQUEST_TIMEOUT_MS));
  const retryDelayMs = Math.max(150, Number((options && options.retryDelayMs) || 400));
  const shouldRetry =
    options && typeof options.shouldRetry === "function"
      ? options.shouldRetry
      : (context) => !!context.isAbort || !!context.isNetworkError;
  const buildErrorMessage =
    options && typeof options.buildErrorMessage === "function"
      ? options.buildErrorMessage
      : (context) => {
          if (context.isAbort) {
            return `请求超时（${timeoutMs}ms）`;
          }
          if (context.response) {
            return `HTTP ${context.response.status}`;
          }
          return formatAttemptError(context.error);
        };
  let lastError = null;

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    let text = "";
    try {
      response = await fetch(
        url,
        Object.assign({}, init || {}, {
          signal: controller.signal,
        })
      );
      text = await response.text();
      if (!response.ok) {
        const httpError = new Error(buildErrorMessage({ response, text, attempt, retryCount, timeoutMs }));
        httpError.response = response;
        httpError.responseText = text;
        throw httpError;
      }
      return {
        url: response.url || url,
        text,
        status: response.status,
        response,
      };
    } catch (error) {
      const isAbort = error && (error.name === "AbortError" || /abort|timeout/i.test(formatAttemptError(error)));
      const isHttpError = !!(error && error.response);
      const context = {
        error,
        response: isHttpError ? error.response : response,
        text: isHttpError ? error.responseText || text : text,
        isAbort,
        isNetworkError: !isAbort && !isHttpError,
        attempt,
        retryCount,
        timeoutMs,
      };
      lastError = new Error(buildErrorMessage(context));
      if (attempt < retryCount && shouldRetry(context)) {
        await sleep(retryDelayMs);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("请求失败");
}

async function legacyFetchTextWithCredentialsUnused(url, init, options) {
  return fetchTextWithRetry(
    url,
    Object.assign({ credentials: "include" }, init || {}),
    Object.assign(
      {
        retryCount: AUTO_CRAWL_REQUEST_RETRY_COUNT,
        timeoutMs: AUTO_CRAWL_REQUEST_TIMEOUT_MS,
        shouldRetry: (context) =>
          !!context.isAbort ||
          !!context.isNetworkError ||
          !!(context.response && context.response.status >= 500),
      },
      options || {}
    )
  );

  const retryCount = Math.max(1, Number((options && options.retryCount) || AUTO_CRAWL_REQUEST_RETRY_COUNT));
  const timeoutMs = Math.max(3000, Number((options && options.timeoutMs) || AUTO_CRAWL_REQUEST_TIMEOUT_MS));
  let lastError = null;

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        url,
        Object.assign({ credentials: "include", signal: controller.signal }, init || {})
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return {
        url: response.url || url,
        text,
        status: response.status,
      };
    } catch (error) {
      const isAbort = error && (error.name === "AbortError" || /abort|timeout/i.test(formatAttemptError(error)));
      lastError = new Error(isAbort ? `请求超时（${timeoutMs}ms）` : formatAttemptError(error));
      if (attempt < retryCount) {
        await sleep(400);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("请求失败");
}

// Canonical retry helpers. These override the legacy copies above so new callers
// share the same timeout and retry behavior.
async function fetchTextWithRetry(url, init, options) {
  const retryCount = Math.max(1, Number((options && options.retryCount) || 1));
  const timeoutMs = Math.max(3000, Number((options && options.timeoutMs) || AUTO_CRAWL_REQUEST_TIMEOUT_MS));
  const retryDelayMs = Math.max(150, Number((options && options.retryDelayMs) || 400));
  const shouldRetry =
    options && typeof options.shouldRetry === "function"
      ? options.shouldRetry
      : (context) => !!context.isAbort || !!context.isNetworkError;
  const buildErrorMessage =
    options && typeof options.buildErrorMessage === "function"
      ? options.buildErrorMessage
      : (context) => {
          if (context.isAbort) {
            return `Request timed out after ${timeoutMs}ms`;
          }
          if (context.response) {
            return `HTTP ${context.response.status}`;
          }
          return formatAttemptError(context.error);
        };
  let lastError = null;

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    let text = "";
    try {
      response = await fetch(
        url,
        Object.assign({}, init || {}, {
          signal: controller.signal,
        })
      );
      text = await response.text();
      if (!response.ok) {
        const httpError = new Error(buildErrorMessage({ response, text, attempt, retryCount, timeoutMs }));
        httpError.response = response;
        httpError.responseText = text;
        throw httpError;
      }
      return {
        url: response.url || url,
        text,
        status: response.status,
        response,
      };
    } catch (error) {
      const isAbort = error && (error.name === "AbortError" || /abort|timeout/i.test(formatAttemptError(error)));
      const isHttpError = !!(error && error.response);
      const context = {
        error,
        response: isHttpError ? error.response : response,
        text: isHttpError ? error.responseText || text : text,
        isAbort,
        isNetworkError: !isAbort && !isHttpError,
        attempt,
        retryCount,
        timeoutMs,
      };
      lastError = new Error(buildErrorMessage(context));
      if (attempt < retryCount && shouldRetry(context)) {
        await sleep(retryDelayMs);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Request failed");
}

async function fetchTextWithCredentials(url, init, options) {
  return fetchTextWithRetry(
    url,
    Object.assign({ credentials: "include" }, init || {}),
    Object.assign(
      {
        retryCount: AUTO_CRAWL_REQUEST_RETRY_COUNT,
        timeoutMs: AUTO_CRAWL_REQUEST_TIMEOUT_MS,
        shouldRetry: (context) =>
          !!context.isAbort ||
          !!context.isNetworkError ||
          !!(context.response && context.response.status >= 500),
      },
      options || {}
    )
  );
}

async function postFormWithCredentials(url, formData) {
  const params = new URLSearchParams();
  Object.entries(formData || {}).forEach(([key, value]) => {
    params.set(key, String(value == null ? "" : value));
  });
  return fetchTextWithCredentials(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: params.toString(),
  });
}

function parseTeachCoursesFromHtml(htmlText) {
  const regex =
    /<div class="course clearfix\s+teachCourse"[\s\S]*?<input[^>]*class="clazzId"[^>]*value="([^"]*)"[\s\S]*?<input[^>]*class="curPersonId"[^>]*value="([^"]*)"[\s\S]*?<input[^>]*class="courseId"[^>]*value="([^"]*)"[\s\S]*?<a class="color1" href="([^"]+)"[\s\S]*?<span class="course-name[^"]*"[^>]*title="([^"]+)"/gi;
  const records = [];
  for (const match of String(htmlText || "").matchAll(regex)) {
    const course = {
      course_name: decodeHtml(match[5]),
      title: decodeHtml(match[5]),
      course_id: safeText(match[3]),
      class_id: safeText(match[1]),
      cpi: safeText(match[2]),
      url: resolveAutoCrawlUrl(match[4]),
    };
    records.push(course);
  }
  return uniqueRecords(records.filter((item) => item.course_id && item.url), courseKey);
}

function parseCoursePageContext(htmlText, course) {
  const text = String(htmlText || "");
  return Object.assign({}, course || {}, {
    course_name:
      firstMatch(text, /<title>\s*([^<]+)\s*<\/title>/i) ||
      safeText(course && (course.course_name || course.title)),
    course_id:
      firstMatch(text, /id="courseid"[^>]*value="([^"]+)"/i) ||
      safeText(course && course.course_id),
    class_id:
      firstMatch(text, /id="clazzid"[^>]*value="([^"]+)"/i) ||
      safeText(course && course.class_id),
    cpi:
      firstMatch(text, /id="cpi"[^>]*value="([^"]+)"/i) ||
      safeText(course && course.cpi),
    enc: firstMatch(text, /id="enc"[^>]*value="([^"]+)"/i),
    openc: firstMatch(text, /id="openc"[^>]*value="([^"]+)"/i),
    t: firstMatch(text, /id="t"[^>]*value="([^"]+)"/i),
  });
}

function buildInvisibleHomeworkListUrl(course, pageNum, pageSize) {
  const url = new URL(AUTO_CRAWL_HOMEWORK_LIST_URL);
  const size = Math.max(1, Number(pageSize) || AUTO_CRAWL_LIST_PAGE_SIZE);
  const page = Math.max(1, Number(pageNum) || 1);
  const values = {
    courseid: safeText(course && course.course_id),
    clazzid: safeText(course && course.class_id),
    courseId: safeText(course && course.course_id),
    classId: safeText(course && course.class_id),
    clazzId: safeText(course && course.class_id),
    cpi: safeText(course && course.cpi),
    enc: safeText(course && course.enc),
    openc: safeText(course && course.openc),
    t: safeText(course && course.t),
    ut: "t",
    pages: String(page),
    size: String(size),
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function parseHomeworkRowsFromHtml(htmlText, course) {
  const blocks = String(htmlText || "").match(/<li id="work\d+"[\s\S]*?<\/li>/gi) || [];
  const records = blocks.map((block) => {
    const taskId = firstMatch(block, /<li id="work(\d+)"/i);
    const titleText = stripHtml(firstMatch(block, /<h2 class="list_li_tit[\s\S]*?>([\s\S]*?)<\/h2>/i));
    const buttonHref =
      firstMatch(
        block,
        /<a[^>]*class="[^"]*piyueBtn[^"]*"[^>]*href="([^"]+)"/i
      ) ||
      firstMatch(
        block,
        /<a[^>]*href="([^"]+)"[^>]*class="[^"]*piyueBtn[^"]*"/i
      );
    const viewWorkMatch = block.match(/viewWork\(\s*'[^']*'\s*,\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/i);
    const actualWorkId = safeText(viewWorkMatch && viewWorkMatch[1]);
    const reviewClassId = safeText(viewWorkMatch && viewWorkMatch[2]);
    const pendingCount = Number(firstMatch(block, /<em[^>]*>(\d+)<\/em>\s*待批/i) || 0);
    const submittedCount = Number(firstMatch(block, /<span>\s*(\d+)\s*已交<\/span>/i) || 0);
    const unsubmittedCount = Number(firstMatch(block, /<span>\s*(\d+)\s*未交<\/span>/i) || 0);
    const answerTime = stripHtml(firstMatch(block, /作答时间[:：]\s*([^<]+)/i));

    return {
      course_name: safeText(course && course.course_name),
      course_id: safeText(course && course.course_id),
      class_id: safeText(course && course.class_id),
      cpi: safeText(course && course.cpi),
      task_id: taskId,
      work_id: actualWorkId || taskId,
      review_class_id: reviewClassId || safeText(course && course.class_id) || "0",
      homework_name: titleText,
      name: titleText,
      answer_time: answerTime,
      pending_count: String(pendingCount),
      submitted_count: String(submittedCount),
      unsubmitted_count: String(unsubmittedCount),
      url:
        (safeText(buttonHref).toLowerCase() !== "javascript:;" ? resolveAutoCrawlUrl(buttonHref) : "") ||
        resolveAutoCrawlUrl(
          `/mooc2-ans/work/mark?courseid=${safeText(course && course.course_id)}&clazzid=${
            reviewClassId || "0"
          }&id=${taskId}&cpi=${safeText(course && course.cpi)}`
        ),
    };
  });

  return uniqueRecords(
    records.filter((item) => item.homework_name && item.url),
    (item) => item.task_id || item.work_id || item.url || item.homework_name
  );
}

function buildInvisibleMarkListUrl(course, homework, pageNum, pageSize) {
  const url = new URL(AUTO_CRAWL_MARK_LIST_URL);
  const size = Math.max(1, Number(pageSize) || AUTO_CRAWL_LIST_PAGE_SIZE);
  const page = Math.max(1, Number(pageNum) || 1);
  const values = {
    courseid: safeText(course && course.course_id),
    clazzid: safeText(homework && homework.review_class_id) || safeText(course && course.class_id),
    workid: safeText(homework && homework.work_id),
    submit: "true",
    status: "0",
    groupId: "0",
    cpi: safeText(course && course.cpi),
    evaluation: "0",
    sort: "0",
    order: "0",
    unEval: "false",
    from: "",
    topicid: "0",
    pages: String(page),
    size: String(size),
  };
  Object.entries(values).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function parseSubmissionRowsFromHtml(htmlText, course, homework) {
  const blocks = String(htmlText || "").match(/<ul class="dataBody_td"[^>]*>[\s\S]*?<\/ul>/gi) || [];
  const records = blocks.map((block) => {
    const answerId = firstMatch(block, /<ul class="dataBody_td"[^>]*id="([^"]+)"/i);
    const items = Array.from(block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)).map((match) =>
      stripHtml(match[1])
    );
    const actionUrl = firstMatch(block, /class="cz_py"[^>]*data="([^"]+)"/i);
    return {
      course_name: safeText(course && course.course_name),
      course_id: safeText(course && course.course_id),
      class_id: safeText(course && course.class_id),
      work_id: safeText(homework && homework.work_id),
      answer_id: answerId,
      workAnswerId: answerId,
      homework_name: safeText(homework && homework.homework_name),
      student_name: safeText(items[1]),
      student_id: safeText(items[2]),
      submit_time: safeText(items[3]),
      ip_address: safeText(items[4]),
      status: safeText(items[5]),
      reviewer: safeText(items[6]),
      grade: safeText(items[7]),
      url: resolveAutoCrawlUrl(actionUrl),
    };
  });

  return uniqueRecords(
    records.filter((item) => item.answer_id || item.student_name),
    submissionKey
  );
}

async function fetchTaughtCoursesInBackground() {
  const result = await postFormWithCredentials("https://mooc2-ans.chaoxing.com/visit/courselistdata", {
    courseType: "0",
    courseFolderId: "0",
    query: "",
    pageHeader: "",
    single: "0",
    superstarClass: "0",
    isFirefly: "0",
  });
  return parseTeachCoursesFromHtml(result.text);
}

async function fetchCourseContextInBackground(course) {
  const result = await fetchTextWithCredentials(course.url, { method: "GET" });
  return parseCoursePageContext(result.text, course);
}

async function fetchHomeworksForCourseInBackground(course, onPage) {
  const allRecords = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page += 1) {
    const result = await fetchTextWithCredentials(
      buildInvisibleHomeworkListUrl(course, page, AUTO_CRAWL_LIST_PAGE_SIZE),
      { method: "GET" }
    );
    const pageRecords = parseHomeworkRowsFromHtml(result.text, course);
    if (!pageRecords.length) {
      break;
    }
    let newCount = 0;
    pageRecords.forEach((record) => {
      const key = safeText(record.task_id || record.work_id || record.url);
      if (key && seen.has(key)) {
        return;
      }
      if (key) {
        seen.add(key);
      }
      allRecords.push(record);
      newCount += 1;
    });
    if (typeof onPage === "function") {
      await onPage({
        page,
        newCount,
        totalCount: allRecords.length,
      });
    }
    if (newCount === 0 || pageRecords.length < AUTO_CRAWL_LIST_PAGE_SIZE) {
      break;
    }
  }
  return allRecords;
}

async function fetchSubmissionsForHomeworkInBackground(course, homework, onPage) {
  const allRecords = [];
  const seen = new Set();
  for (let page = 1; page <= 200; page += 1) {
    const result = await fetchTextWithCredentials(
      buildInvisibleMarkListUrl(course, homework, page, AUTO_CRAWL_LIST_PAGE_SIZE),
      { method: "GET" }
    );
    const pageRecords = parseSubmissionRowsFromHtml(result.text, course, homework);
    if (!pageRecords.length) {
      break;
    }
    let newCount = 0;
    pageRecords.forEach((record) => {
      const key = submissionKey(record);
      if (key && seen.has(key)) {
        return;
      }
      if (key) {
        seen.add(key);
      }
      allRecords.push(record);
      newCount += 1;
    });
    if (typeof onPage === "function") {
      await onPage({
        page,
        newCount,
        totalCount: allRecords.length,
      });
    }
    if (newCount === 0 || pageRecords.length < AUTO_CRAWL_LIST_PAGE_SIZE) {
      break;
    }
  }
  return allRecords;
}

async function resumeInvisibleAutoCrawl(job) {
  if (!job || job.processing) {
    return;
  }

  job.processing = true;
  try {
    while (true) {
      if (!job.currentCourse) {
        while (job.courseQueue.length) {
          const nextCourse = job.courseQueue.shift();
          if (!nextCourse || !safeText(nextCourse.url)) {
            continue;
          }
          job.currentCourse = Object.assign({}, nextCourse);
          job.currentHomework = null;
          job.homeworkQueue = [];
          job.stage = "loading_course_homeworks";
          updateCourseProgress(job, job.currentCourse, {
            status: "读取课程上下文中",
            stage: "loading_course_homeworks",
            current_homework_name: "",
            last_error: "",
          });
          await persistAutoExtractSnapshot(job, "running", "");
          break;
        }

        if (!job.currentCourse) {
          await finishAutoCrawl(job, "completed", "");
          return;
        }
      }

      if (job.stage === "loading_courses") {
        job.stage = "loading_course_homeworks";
      }

      if (job.stage === "loading_course_homeworks" || job.stage === "loading_homework_list_page") {
        let courseContext;
        try {
          courseContext = await fetchCourseContextInBackground(job.currentCourse);
        } catch (error) {
          await skipCurrentCourse(job, `课程页面读取失败：${error.message}`, { manualAdvance: true });
          job.currentCourse = null;
          job.currentHomework = null;
          job.homeworkQueue = [];
          continue;
        }

        job.currentCourse = Object.assign({}, courseContext, {
          _courseKey: safeText(job.currentCourse && job.currentCourse._courseKey) || courseKey(courseContext),
        });
        updateCourseProgress(job, job.currentCourse, {
          status: "抓取作业列表中",
          stage: "loading_homework_list_page",
          current_homework_name: "",
          last_error: "",
        });
        await persistAutoExtractSnapshot(job, "running", "");

        let homeworks = [];
        try {
          homeworks = await fetchHomeworksForCourseInBackground(job.currentCourse, async (progress) => {
            updateCourseProgress(job, job.currentCourse, {
              status: `抓取作业列表中（第 ${progress.page} 页）`,
              stage: "loading_homework_list_page",
            });
            await persistAutoExtractSnapshot(job, "running", "");
          });
        } catch (error) {
          await skipCurrentCourse(job, `作业列表抓取失败：${error.message}`, { manualAdvance: true });
          job.currentCourse = null;
          job.currentHomework = null;
          job.homeworkQueue = [];
          continue;
        }

        job.homeworks = uniqueRecords([...(job.homeworks || []), ...homeworks], homeworkKey);
        const actionableHomeworks = homeworks.filter((item) => safeText(item && item.url));
        updateCourseProgress(job, job.currentCourse, {
          status: actionableHomeworks.length ? "作业已抓取" : "暂无作业",
          stage: "homeworks_loaded",
          homework_count: actionableHomeworks.length,
          homework_done_count: 0,
          skipped_homework_count: 0,
          submission_count: 0,
          current_homework_name: "",
          last_error: "",
        });
        job.homeworkQueue = actionableHomeworks.map((item) => Object.assign({}, item));
        job.currentHomework = null;
        job.stage = "loading_homework_submissions";
        await persistAutoExtractSnapshot(job, "running", "");
      }

      if (!job.currentHomework) {
        while (job.homeworkQueue.length) {
          const nextHomework = job.homeworkQueue.shift();
          if (!nextHomework || !safeText(nextHomework.url)) {
            continue;
          }
          job.currentHomework = Object.assign({}, nextHomework);
          job.stage = "loading_homework_submissions";
          updateCourseProgress(job, job.currentCourse, {
            status: "抓取作业提交中",
            stage: "loading_homework_submissions",
            current_homework_name: safeText(nextHomework.homework_name || nextHomework.name),
          });
          await persistAutoExtractSnapshot(job, "running", "");
          break;
        }
      }

      if (!job.currentHomework) {
        updateCourseProgress(job, job.currentCourse, {
          status: "已完成",
          stage: "completed",
          current_homework_name: "",
        });
        job.currentCourse = null;
        job.stage = "loading_course_homeworks";
        await persistAutoExtractSnapshot(job, "running", "");
        continue;
      }

      let submissions = [];
      const baseSubmissionCount = Number(
        (ensureCourseProgress(job, job.currentCourse) && ensureCourseProgress(job, job.currentCourse).submission_count) || 0
      );

      try {
        submissions = await fetchSubmissionsForHomeworkInBackground(
          job.currentCourse,
          job.currentHomework,
          async (progress) => {
            updateCourseProgress(job, job.currentCourse, {
              status: `抓取作业提交中（第 ${progress.page} 页）`,
              stage: "loading_homework_submissions",
              current_homework_name: safeText(
                job.currentHomework && (job.currentHomework.homework_name || job.currentHomework.name)
              ),
              submission_count: baseSubmissionCount + Number(progress.totalCount || 0),
            });
            await persistAutoExtractSnapshot(job, "running", "");
          }
        );
      } catch (error) {
        await skipCurrentHomework(job, `提交列表抓取失败：${error.message}`, {
          excludeFromCount: false,
          manualAdvance: true,
        });
        continue;
      }

      if (submissions.length) {
        job.submissions = uniqueRecords([...(job.submissions || []), ...submissions], submissionKey);
      }

      const courseProgress = ensureCourseProgress(job, job.currentCourse);
      if (courseProgress) {
        const nextDoneCount = Number(courseProgress.homework_done_count || 0) + 1;
        updateCourseProgress(job, job.currentCourse, {
          status:
            nextDoneCount >= Number(courseProgress.homework_count || 0) ? "该课提交已抓完" : "抓取作业提交中",
          stage: "loading_homework_submissions",
          homework_done_count: nextDoneCount,
          skipped_homework_count: Number(courseProgress.skipped_homework_count || 0),
          submission_count: baseSubmissionCount + submissions.length,
          current_homework_name: "",
        });
      }

      job.currentHomework = null;
      await persistAutoExtractSnapshot(job, "running", "");
    }
  } catch (error) {
    job.errors.push(error.message);
    await finishAutoCrawl(job, "failed", error.message);
  } finally {
    job.processing = false;
  }
}

async function runInvisibleAutoCrawl(job) {
  if (
    (job.currentCourse || job.currentHomework) ||
    (Array.isArray(job.courseQueue) && job.courseQueue.length > 0) ||
    (Array.isArray(job.homeworkQueue) && job.homeworkQueue.length > 0) ||
    (Array.isArray(job.courses) && job.courses.length > 0)
  ) {
    await resumeInvisibleAutoCrawl(job);
    return;
  }

  try {
    const courses = await fetchTaughtCoursesInBackground();
    if (!courses.length) {
      throw new Error("未获取到我教的课");
    }

    job.courses = attachStableCourseKeys(uniqueRecords(courses, courseKey));
    job.courseQueue = job.courses.map((item) => Object.assign({}, item));
    job.courseProgressMap = {};
    job.courseProgressOrder = [];
    job.courses.forEach((course) => {
      updateCourseProgress(job, course, {
        status: "等待抓取",
        stage: "queued",
        homework_count: 0,
        homework_done_count: 0,
        skipped_homework_count: 0,
        submission_count: 0,
        current_homework_name: "",
        last_error: "",
      });
    });
    await persistAutoExtractSnapshot(job, "running", "");

    for (const baseCourse of job.courses) {
      if (job.courseQueue.length) {
        job.courseQueue.shift();
      }
      job.currentCourse = Object.assign({}, baseCourse);
      job.currentHomework = null;
      updateCourseProgress(job, job.currentCourse, {
        status: "读取课程上下文中",
        stage: "loading_course_homeworks",
        current_homework_name: "",
        last_error: "",
      });
      await persistAutoExtractSnapshot(job, "running", "");

      let courseContext;
      try {
      courseContext = await fetchCourseContextInBackground(job.currentCourse);
      } catch (error) {
        await skipCurrentCourse(job, `课程页读取失败：${error.message}`, { manualAdvance: true });
        continue;
      }
      job.currentCourse = Object.assign({}, courseContext, {
        _courseKey: safeText(job.currentCourse && job.currentCourse._courseKey) || courseKey(courseContext),
      });

      updateCourseProgress(job, job.currentCourse, {
        status: "抓取作业列表中",
        stage: "loading_homework_list_page",
      });
      await persistAutoExtractSnapshot(job, "running", "");

      let homeworks = [];
      try {
        homeworks = await fetchHomeworksForCourseInBackground(job.currentCourse, async (progress) => {
          updateCourseProgress(job, job.currentCourse, {
            status: `抓取作业列表中（第${progress.page}页）`,
            stage: "loading_homework_list_page",
          });
          await persistAutoExtractSnapshot(job, "running", "");
        });
      } catch (error) {
        await skipCurrentCourse(job, `作业列表抓取失败：${error.message}`, { manualAdvance: true });
        continue;
      }

      job.homeworks = uniqueRecords([...job.homeworks, ...homeworks], homeworkKey);
      const actionableHomeworks = homeworks.filter((item) => safeText(item && item.url));
      updateCourseProgress(job, job.currentCourse, {
        status: actionableHomeworks.length ? "作业已抓取" : "暂无作业",
        stage: "homeworks_loaded",
        homework_count: actionableHomeworks.length,
        homework_done_count: 0,
        skipped_homework_count: 0,
        submission_count: 0,
        current_homework_name: "",
        last_error: "",
      });
      job.homeworkQueue = actionableHomeworks.map((item) => Object.assign({}, item));
      await persistAutoExtractSnapshot(job, "running", "");

      for (const homework of actionableHomeworks) {
        if (job.homeworkQueue.length) {
          job.homeworkQueue.shift();
        }
        job.currentHomework = homework;
        updateCourseProgress(job, job.currentCourse, {
          status: "抓取作业提交中",
          stage: "loading_homework_submissions",
          current_homework_name: safeText(homework.homework_name || homework.name),
        });
        await persistAutoExtractSnapshot(job, "running", "");

        let submissions = [];
        const baseSubmissionCount = Number(
          (ensureCourseProgress(job, job.currentCourse) && ensureCourseProgress(job, job.currentCourse).submission_count) ||
            0
        );
        try {
          submissions = await fetchSubmissionsForHomeworkInBackground(
            job.currentCourse,
            homework,
            async (progress) => {
              updateCourseProgress(job, job.currentCourse, {
                status: `抓取作业提交中（第${progress.page}页）`,
                stage: "loading_homework_submissions",
                current_homework_name: safeText(homework.homework_name || homework.name),
                submission_count: baseSubmissionCount + Number(progress.totalCount || 0),
              });
              await persistAutoExtractSnapshot(job, "running", "");
            }
          );
        } catch (error) {
          await skipCurrentHomework(job, `提交列表抓取失败：${error.message}`, {
            excludeFromCount: false,
            manualAdvance: true,
          });
          continue;
        }

        if (submissions.length) {
          job.submissions = uniqueRecords([...job.submissions, ...submissions], submissionKey);
        }
        const courseProgress = ensureCourseProgress(job, job.currentCourse);
        if (courseProgress) {
          const nextDoneCount = Number(courseProgress.homework_done_count || 0) + 1;
          updateCourseProgress(job, job.currentCourse, {
            status:
              nextDoneCount >= Number(courseProgress.homework_count || 0)
                ? "该课提交已抓完"
                : "抓取作业提交中",
            stage: "loading_homework_submissions",
            homework_done_count: nextDoneCount,
            skipped_homework_count: Number(courseProgress.skipped_homework_count || 0),
            submission_count: baseSubmissionCount + submissions.length,
            current_homework_name: "",
          });
        }
        await persistAutoExtractSnapshot(job, "running", "");
      }

      updateCourseProgress(job, job.currentCourse, {
        status: "已完成",
        stage: "completed",
        current_homework_name: "",
      });
      job.currentHomework = null;
      await persistAutoExtractSnapshot(job, "running", "");
    }

    await finishAutoCrawl(job, "completed", "");
  } catch (error) {
    job.errors.push(error.message);
    await finishAutoCrawl(job, "failed", error.message);
  }
}

function isDeletedHomeworkContext(context) {
  return !!(context && context.is_deleted_homework_page);
}

function isInvalidNoticeContext(context) {
  return !!(context && context.is_notice_page);
}

async function createHiddenTab(url) {
  const popupWindow = await promisifyChrome(chrome.windows.create, chrome.windows, {
    url,
    focused: false,
    state: "minimized",
    type: "popup",
  });
  const tabs = popupWindow && Array.isArray(popupWindow.tabs) ? popupWindow.tabs : [];
  const firstTab = tabs.length ? tabs[0] : null;
  if (!firstTab || typeof firstTab.id !== "number") {
    throw new Error("未能创建后台抓取窗口");
  }
  return {
    id: firstTab.id,
    windowId: popupWindow.id,
  };
}

async function updateTabUrl(tabId, url) {
  return promisifyChrome(chrome.tabs.update, chrome.tabs, tabId, { url });
}

async function closeTabQuietly(tabId) {
  try {
    await promisifyChrome(chrome.tabs.remove, chrome.tabs, tabId);
  } catch (error) {
    // Ignore missing/closed tabs.
  }
}

async function closeWindowQuietly(windowId) {
  if (typeof windowId !== "number") {
    return;
  }
  try {
    await promisifyChrome(chrome.windows.remove, chrome.windows, windowId);
  } catch (error) {
    // Ignore missing/closed windows.
  }
}

async function closeCrawlTargetQuietly(job) {
  if (job && typeof job.crawlWindowId === "number") {
    await closeWindowQuietly(job.crawlWindowId);
    return;
  }
  if (job && typeof job.crawlTabId === "number") {
    await closeTabQuietly(job.crawlTabId);
  }
}

function buildAutoExtractSnapshot(job, status, errorMessage) {
  const courseProgress = getCourseProgressList(job);
  return {
    timestamp: new Date().toISOString(),
    status,
    stage: job.stage,
    source: "login-auto-crawl",
    context: {
      source_tab_id: job.sourceTabId,
      crawl_tab_id: job.crawlTabId,
      crawl_window_id: job.crawlWindowId,
      status,
      stage: job.stage,
      started_at: job.startedAt,
      current_course: job.currentCourse
        ? {
            course_name: job.currentCourse.course_name || job.currentCourse.title || "",
            course_id: job.currentCourse.course_id || "",
            class_id: job.currentCourse.class_id || "",
            url: job.currentCourse.url || "",
          }
        : null,
      current_homework: job.currentHomework
        ? {
            homework_name: job.currentHomework.homework_name || job.currentHomework.name || "",
            work_id: job.currentHomework.work_id || "",
            url: job.currentHomework.url || "",
          }
        : null,
      remaining_course_count: job.courseQueue.length,
      remaining_homework_count: job.homeworkQueue.length,
      crawled_course_count: job.courses.length,
      crawled_homework_count: job.homeworks.length,
      crawled_submission_count: job.submissions.length,
      course_progress: courseProgress,
      errors: job.errors.slice(-20),
      error_message: safeText(errorMessage),
    },
    courses: buildAggregateExport("courses", job.courses, {
      source: "login-auto-crawl",
      status,
    }),
    homeworks: buildAggregateExport("homeworks", job.homeworks, {
      source: "login-auto-crawl",
      status,
    }),
    submissions: buildAggregateExport("submissions", job.submissions, {
      source: "login-auto-crawl",
      status,
    }),
  };
}

async function persistAutoExtractSnapshot(job, status, errorMessage) {
  const snapshot = buildAutoExtractSnapshot(job, status, errorMessage);
  await saveStoredAutoExtractData(snapshot);
  if (status === "running") {
    await saveAutoCrawlRuntimeState(job);
  }
}

async function runTabActionWithRetries(tabId, action, payload, options) {
  const attempts = Math.max(1, Number((options && options.attempts) || 5));
  const intervalMs = Math.max(300, Number((options && options.intervalMs) || AUTO_CRAWL_RETRY_INTERVAL_MS));
  const requireRecords = !!(options && options.requireRecords);
  let lastResult = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(intervalMs);
    }
    try {
      lastResult = await runTabAction(tabId, action, payload || {});
    } catch (error) {
      lastResult = { ok: false, error: error.message };
    }

    const records = getResultRecords(lastResult);
    if (lastResult && lastResult.ok) {
      if (!requireRecords || records.length) {
        return lastResult;
      }
    }
  }

  return lastResult;
}

async function moveToNextCourse(job) {
  while (job.courseQueue.length) {
    const nextCourse = job.courseQueue.shift();
    if (!nextCourse || !safeText(nextCourse.url)) {
      continue;
    }

    job.currentCourse = nextCourse;
    job.currentHomework = null;
    job.homeworkQueue = [];
    job.stage = "loading_course_homeworks";
    updateCourseProgress(job, nextCourse, {
      status: "进入课程中",
      stage: "loading_course_homeworks",
      current_homework_name: "",
      last_error: "",
    });
    console.log(
      `[Chaoxing Extension] 开始抓取课程作业: ${safeText(
        nextCourse.course_name || nextCourse.title || nextCourse.url
      )}`
    );
    await persistAutoExtractSnapshot(job, "running", "");
    await updateTabUrl(job.crawlTabId, nextCourse.url);
    return true;
  }

  await finishAutoCrawl(job, "completed", "");
  return false;
}

async function moveToNextHomework(job) {
  while (job.homeworkQueue.length) {
    const nextHomework = job.homeworkQueue.shift();
    if (!nextHomework || !safeText(nextHomework.url)) {
      continue;
    }

    job.currentHomework = nextHomework;
    job.stage = "loading_homework_submissions";
    updateCourseProgress(job, job.currentCourse, {
      status: "抓取作业提交中",
      stage: "loading_homework_submissions",
      current_homework_name: safeText(nextHomework.homework_name || nextHomework.name),
    });
    console.log(
      `[Chaoxing Extension] 开始抓取提交信息: ${safeText(
        nextHomework.homework_name || nextHomework.name || nextHomework.url
      )}`
    );
    await persistAutoExtractSnapshot(job, "running", "");
    await updateTabUrl(job.crawlTabId, nextHomework.url);
    return true;
  }

  updateCourseProgress(job, job.currentCourse, {
    status: "已完成",
    stage: "completed",
    current_homework_name: "",
  });
  job.currentHomework = null;
  return moveToNextCourse(job);
}

function removeHomeworkFromAggregate(job, homework) {
  const targetKey = homeworkKey(homework);
  if (!targetKey) {
    return;
  }
  job.homeworks = (job.homeworks || []).filter((item) => homeworkKey(item) !== targetKey);
}

async function skipCurrentHomework(job, errorMessage, options) {
  const message = safeText(errorMessage) || "当前作业抓取失败";
  const shouldExclude = !options || options.excludeFromCount !== false;
  const currentHomeworkKey = getCurrentHomeworkKey(job);
  if (currentHomeworkKey) {
    if (!job.skippedHomeworkKeys) {
      job.skippedHomeworkKeys = new Set();
    }
    if (job.skippedHomeworkKeys.has(currentHomeworkKey)) {
      job.currentHomework = null;
      await moveToNextHomework(job);
      return;
    }
    job.skippedHomeworkKeys.add(currentHomeworkKey);
  }
  const courseProgress = ensureCourseProgress(job, job.currentCourse);
  if (courseProgress) {
    const currentCount = Number(courseProgress.homework_count || 0);
    const skippedCount = Number(courseProgress.skipped_homework_count || 0) + 1;
    updateCourseProgress(job, job.currentCourse, {
      status: "跳过异常作业",
      stage: "skipped_homework",
      homework_count: shouldExclude ? Math.max(0, currentCount - 1) : currentCount,
      skipped_homework_count: skippedCount,
      current_homework_name: "",
      last_error: message,
    });
  }
  if (shouldExclude) {
    removeHomeworkFromAggregate(job, job.currentHomework);
  }
  job.errors.push(message);
  const skippedName = safeText(
    job.currentHomework && (job.currentHomework.homework_name || job.currentHomework.name)
  );
  console.warn(
    `[Chaoxing Extension] 跳过作业: ${skippedName || "(未知作业)"}，原因: ${message}`
  );
  await persistAutoExtractSnapshot(job, "running", message);
  job.currentHomework = null;
  if (options && options.manualAdvance) {
    return;
  }
  await moveToNextHomework(job);
}

async function skipCurrentCourse(job, errorMessage, options) {
  const message = safeText(errorMessage) || "当前课程抓取失败";
  job.errors.push(message);
  updateCourseProgress(job, job.currentCourse, {
    status: "抓取失败",
    stage: "failed",
    last_error: message,
    current_homework_name: "",
  });
  await persistAutoExtractSnapshot(job, "running", message);
  job.currentHomework = null;
  if (options && options.manualAdvance) {
    return;
  }
  await moveToNextCourse(job);
}

async function finishAutoCrawl(job, status, errorMessage) {
  await persistAutoExtractSnapshot(job, status, errorMessage);
  await closeCrawlTargetQuietly(job);
  autoCrawlJobs.delete(job.crawlTabId);
  autoCrawlRunning = false;
  await clearAutoCrawlRuntimeState();
  if (errorMessage) {
    console.error("[Chaoxing Extension] 自动抓取结束:", errorMessage);
  } else {
    console.log("[Chaoxing Extension] 自动抓取结束");
  }
}

async function processAutoCrawlStep(tabId) {
  const job = autoCrawlJobs.get(tabId);
  if (!job || job.processing) {
    return;
  }

  job.processing = true;
  try {
    await sleep(AUTO_CRAWL_PAGE_WAIT_MS);

    if (job.stage === "loading_courses") {
      const coursesResult = await runTabActionWithRetries(tabId, "extractCourses", {}, {
        attempts: 6,
        intervalMs: 1200,
        requireRecords: true,
      });
      const courseRecords = getResultRecords(coursesResult);

      if (!courseRecords.length) {
        const errorMessage =
          (coursesResult && coursesResult.error) || "课程页未抓到课程记录，自动抓取已停止";
        job.errors.push(errorMessage);
        await finishAutoCrawl(job, "failed", errorMessage);
        return;
      }

      job.courses = attachStableCourseKeys(
        uniqueRecords(
          courseRecords.map((item) => Object.assign({}, item)),
          courseKey
        )
      );
      job.courseProgressMap = {};
      job.courseProgressOrder = [];
      job.courses.forEach((course) => {
        updateCourseProgress(job, course, {
          status: "等待抓取",
          stage: "queued",
          homework_count: 0,
          homework_done_count: 0,
          skipped_homework_count: 0,
          submission_count: 0,
          current_homework_name: "",
          last_error: "",
        });
      });
      job.courseQueue = job.courses
        .map((item) => Object.assign({}, item))
        .filter((item) => safeText(item && item.url));
      console.log(`[Chaoxing Extension] 成功抓取 ${job.courses.length} 门课程`);
      await persistAutoExtractSnapshot(job, "running", "");

      await moveToNextCourse(job);
      return;
    }

    if (job.stage === "loading_course_homeworks") {
      updateCourseProgress(job, job.currentCourse, {
        status: "解析作业地址中",
        stage: "loading_course_homeworks",
      });
      const homeworkListUrlResult = await runTabActionWithRetries(
        tabId,
        "resolveHomeworkListUrl",
        {},
        {
          attempts: 2,
          intervalMs: AUTO_CRAWL_FAST_INTERVAL_MS,
          requireRecords: false,
        }
      );
      const homeworkListData = getResultData(homeworkListUrlResult);
      const homeworkListUrl = safeText(homeworkListData && homeworkListData.url);

      if (!homeworkListUrl) {
        const errorMessage =
          (homeworkListUrlResult && homeworkListUrlResult.error) || "未能解析课程作业列表地址";
        await skipCurrentCourse(job, errorMessage);
        return;
      }

      job.stage = "loading_homework_list_page";
      updateCourseProgress(job, job.currentCourse, {
        status: "进入作业列表中",
        stage: "loading_homework_list_page",
      });
      await persistAutoExtractSnapshot(job, "running", "");
      await updateTabUrl(job.crawlTabId, homeworkListUrl);
      return;
    }

    if (job.stage === "loading_homework_list_page") {
      const homeworksResult = await runTabActionWithRetries(
        tabId,
        "extractHomeworks",
        { paginate: true, waitMs: AUTO_CRAWL_PAGINATION_WAIT_MS },
        {
          attempts: 6,
          intervalMs: 1200,
          requireRecords: true,
        }
      );
      const homeworks = getResultRecords(homeworksResult).map((item) =>
        Object.assign({}, item, {
          course_name:
            safeText(item && item.course_name) ||
            safeText(job.currentCourse && (job.currentCourse.course_name || job.currentCourse.title)),
          course_url: safeText(job.currentCourse && job.currentCourse.url),
        })
      );

      if (homeworks.length) {
        job.homeworks = uniqueRecords([...job.homeworks, ...homeworks], homeworkKey);
      }

      const actionableHomeworks = homeworks.filter((item) => safeText(item && item.url));

      updateCourseProgress(job, job.currentCourse, {
        status: actionableHomeworks.length ? "作业已抓取" : "暂无作业",
        stage: "homeworks_loaded",
        homework_count: actionableHomeworks.length,
        homework_done_count: 0,
        skipped_homework_count: 0,
        submission_count: 0,
        current_homework_name: "",
        last_error: "",
      });

      job.homeworkQueue = actionableHomeworks;
      console.log(
        `[Chaoxing Extension] 课程 ${safeText(
          job.currentCourse && (job.currentCourse.course_name || job.currentCourse.title)
        )} 抓取到 ${actionableHomeworks.length} 条有效作业记录`
      );
      await persistAutoExtractSnapshot(job, "running", "");

      if (job.homeworkQueue.length) {
        await moveToNextHomework(job);
      } else {
        await moveToNextCourse(job);
      }
      return;
    }

    if (job.stage === "loading_homework_submissions") {
      const submissionsResult = await runTabActionWithRetries(
        tabId,
        "extractSubmissions",
        { paginate: true, waitMs: AUTO_CRAWL_PAGINATION_WAIT_MS },
        {
          attempts: 7,
          intervalMs: 1500,
          requireRecords: false,
        }
      );
      const submissions = getResultRecords(submissionsResult).map((item) =>
        Object.assign({}, item, {
          course_name:
            safeText(item && item.course_name) ||
            safeText(job.currentCourse && (job.currentCourse.course_name || job.currentCourse.title)),
          course_url: safeText(job.currentCourse && job.currentCourse.url),
          homework_name:
            safeText(item && item.homework_name) ||
            safeText(job.currentHomework && (job.currentHomework.homework_name || job.currentHomework.name)),
          homework_url: safeText(job.currentHomework && job.currentHomework.url),
        })
      );

      if (submissions.length) {
        job.submissions = uniqueRecords([...job.submissions, ...submissions], submissionKey);
        const courseProgress = ensureCourseProgress(job, job.currentCourse);
        if (courseProgress) {
          const nextDoneCount = Number(courseProgress.homework_done_count || 0) + 1;
          updateCourseProgress(job, job.currentCourse, {
            status:
              nextDoneCount >= Number(courseProgress.homework_count || 0)
                ? "该课提交已抓完"
                : "抓取作业提交中",
            stage: "loading_homework_submissions",
            homework_done_count: nextDoneCount,
            skipped_homework_count: Number(courseProgress.skipped_homework_count || 0),
            submission_count: Number(courseProgress.submission_count || 0) + submissions.length,
            current_homework_name: "",
          });
        }

        console.log(
          `[Chaoxing Extension] 作业 ${safeText(
            job.currentHomework && (job.currentHomework.homework_name || job.currentHomework.name)
          )} 抓取到 ${submissions.length} 条提交记录`
        );
        await persistAutoExtractSnapshot(job, "running", "");
        await moveToNextHomework(job);
        return;
      }

      const inspectResult = await runTabActionWithRetries(tabId, "inspect", {}, {
        attempts: 2,
        intervalMs: AUTO_CRAWL_FAST_INTERVAL_MS,
        requireRecords: false,
      });
      const pageContext = getResultData(inspectResult) || {};
      if (isDeletedHomeworkContext(pageContext)) {
        await skipCurrentHomework(job, "作业已删除，已自动跳过");
        return;
      }
      if (isInvalidNoticeContext(pageContext)) {
        await skipCurrentHomework(job, "当前作业页无访问权限或已失效，已自动跳过");
        return;
      }

      await skipCurrentHomework(
        job,
        (submissionsResult && submissionsResult.error) || "未能加载学生提交列表，已自动跳过",
        { excludeFromCount: false }
      );
      return;
    }
  } catch (error) {
    if (job.currentCourse && job.stage !== "loading_courses") {
      await skipCurrentCourse(job, error.message);
    } else {
      job.errors.push(error.message);
      await finishAutoCrawl(job, "failed", error.message);
    }
    return;
  } finally {
    const currentJob = autoCrawlJobs.get(tabId);
    if (currentJob) {
      currentJob.processing = false;
    }
  }
}

async function startAutoCrawl(sourceTabId) {
  if (autoCrawlRunning) {
    return;
  }

  const now = Date.now();
  if (now - lastAutoCrawlStartedAt < AUTO_CRAWL_TRIGGER_COOLDOWN_MS) {
    return;
  }

  autoCrawlRunning = true;
  lastAutoCrawlStartedAt = now;

  const job = {
    sourceTabId,
    crawlTabId: null,
    crawlWindowId: null,
    stage: "loading_courses",
    startedAt: new Date().toISOString(),
    processing: false,
    courseProgressMap: {},
    courseProgressOrder: [],
    skippedHomeworkKeys: new Set(),
    currentCourse: null,
    currentHomework: null,
    courseQueue: [],
    homeworkQueue: [],
    courses: [],
    homeworks: [],
    submissions: [],
    errors: [],
  };

  console.log("[Chaoxing Extension] 已启动后台无界面自动抓取");
  await persistAutoExtractSnapshot(job, "running", "");
  void runInvisibleAutoCrawl(job);
}

function normalizeAiEndpointLegacyUnused(rawUrl) {
  const input = safeText(rawUrl);
  if (!input) {
    throw new Error("AI 接口地址不能为空");
  }

  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error("AI 接口地址不是合法 URL");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) {
    return url.toString();
  }
  if (path.endsWith("/v1")) {
    url.pathname = `${path}/chat/completions`;
    return url.toString();
  }
  if (!path) {
    url.pathname = "/v1/chat/completions";
    return url.toString();
  }
  url.pathname = `${path}/chat/completions`;
  return url.toString();
}

async function callAiChatLegacyUnused(payload) {
  const endpoint = normalizeAiEndpoint(payload && payload.endpoint);
  const permissionState = await ensureAiEndpointPermission(endpoint, { requestIfMissing: false });
  const apiKey = safeText(payload && payload.apiKey);
  const model = safeText(payload && payload.model);
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const temperature =
    payload && typeof payload.temperature === "number" ? payload.temperature : null;
  const timeoutMs = Math.max(5000, Number((payload && payload.timeoutMs) || 20000));
  const retryCount = Math.max(1, Number((payload && payload.retryCount) || 2));

  if (!permissionState.ok) {
    throw new Error("当前 AI 接口尚未授权，请先在扩展弹窗中测试一次连接。");
  }

  if (!apiKey) {
    throw new Error("AI API 密钥不能为空");
  }
  if (!model) {
    throw new Error("AI 模型名不能为空");
  }
  if (!messages.length) {
    throw new Error("AI 请求消息不能为空");
  }

  const endpointLower = endpoint.toLowerCase();
  const modelLower = model.toLowerCase();
  const isMoonshotK2Family =
    endpointLower.includes("moonshot.cn") && /^kimi-k2(?:\.5|-|$)/.test(modelLower);

  const requestBody = Object.assign(
    {
      model,
      messages,
    },
    typeof payload.max_tokens === "number" ? { max_tokens: payload.max_tokens } : {},
    typeof temperature === "number" && !isMoonshotK2Family ? { temperature } : {}
  );

  const result = await fetchTextWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    {
      timeoutMs,
      retryCount,
      shouldRetry: (context) => {
        if (context.isAbort || context.isNetworkError) {
          return true;
        }
        const status = Number(context.response && context.response.status);
        return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
      },
      buildErrorMessage: (context) => {
        if (context.isAbort) {
          return `AI 请求超时，已等待 ${timeoutMs}ms`;
        }
        const data = parseJsonSafely(context.text);
        const apiMessage =
          safeText(data && data.error && (data.error.message || data.error.code)) ||
          safeText(data && data.message) ||
          safeText(context.text);
        const status = Number(context.response && context.response.status);
        if (status === 401 || status === 403) {
          return apiMessage || `AI 接口拒绝了当前 API 密钥（HTTP ${status}）`;
        }
        if (status === 429) {
          return apiMessage || "AI 接口当前触发限流（HTTP 429）";
        }
        if (status) {
          return apiMessage || `AI 接口返回 HTTP ${status}`;
        }
        return apiMessage || formatAttemptError(context.error);
      },
    }
  );

  const rawText = result.text;
  const data = parseJsonSafely(rawText);

  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content =
    safeText(choice && choice.message && choice.message.content) ||
    safeText(data && data.output_text) ||
    "";

  return {
    ok: true,
    endpoint,
    model,
    content,
    rawText,
    usage: data && data.usage ? data.usage : null,
  };
}

async function testAiEndpointLegacyUnused(payload) {
  return callAiChatLegacyUnused({
    endpoint: payload && payload.endpoint,
    apiKey: payload && payload.apiKey,
    model: payload && payload.model,
    timeoutMs: payload && payload.timeoutMs,
    temperature: 0,
    max_tokens: 8,
    messages: [
      {
        role: "system",
        content: "You are a connectivity checker. Reply briefly with JSON.",
      },
      {
        role: "user",
        content: 'Return {"ok":true,"message":"pong"}',
      },
    ],
  });
}

async function getReviewSettingsLegacyUnused() {
  return {
    ok: true,
    settings: await readReviewSettingsFromStorage(),
  };
}

async function saveReviewSettingsLegacyUnused(payload) {
  return {
    ok: true,
    settings: await writeReviewSettingsToStorage(payload || {}),
  };
}

async function ensureCustomAiEndpointPermissionLegacyUnused(payload) {
  try {
    const result = await ensureAiEndpointPermission(payload && payload.endpoint, {
      requestIfMissing: !!(payload && payload.requestIfMissing),
    });
    if (!result.ok) {
      return {
        ok: false,
        error: "当前 AI 接口尚未授权。",
      };
    }
    return {
      ok: true,
      result,
    };
  } catch (error) {
    const message = safeText(error && error.message);
    if (/gesture/i.test(message)) {
      return {
        ok: false,
        error: "请打开扩展弹窗，并使用一次“测试连接”来授权这个自定义 AI 接口。",
      };
    }
    return {
      ok: false,
      error: message || "请求 AI 接口权限失败",
    };
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToText(base64Url) {
  const normalized = safeText(base64Url).replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = normalized + (padding ? "=".repeat(4 - padding) : "");
  return atob(padded);
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
  return bytesToBase64Url(new Uint8Array(digest));
}

function createRequestNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function buildCanonicalRequestText(method, path, timestamp, nonce, bodyHash) {
  return [String(method || "GET").toUpperCase(), safeText(path), safeText(timestamp), safeText(nonce), safeText(bodyHash)].join("\n");
}

function openAuthKeyDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUTH_KEY_DB_NAME, AUTH_KEY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTH_KEY_STORE_NAME)) {
        db.createObjectStore(AUTH_KEY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error((request.error && request.error.message) || "打开授权密钥数据库失败"));
  });
}

async function idbGetValue(key) {
  const db = await openAuthKeyDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(AUTH_KEY_STORE_NAME, "readonly");
      const request = transaction.objectStore(AUTH_KEY_STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error((request.error && request.error.message) || "IndexedDB 读取失败"));
    });
  } finally {
    db.close();
  }
}

async function idbPutValue(key, value) {
  const db = await openAuthKeyDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(AUTH_KEY_STORE_NAME, "readwrite");
      const request = transaction.objectStore(AUTH_KEY_STORE_NAME).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error((request.error && request.error.message) || "IndexedDB 写入失败"));
    });
  } finally {
    db.close();
  }
}

async function getOrCreateDeviceKeyPair() {
  const existing = await idbGetValue(AUTH_KEY_PAIR_ID);
  if (existing && existing.publicKey && existing.privateKey) {
    return existing;
  }

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign", "verify"]
  );
  await idbPutValue(AUTH_KEY_PAIR_ID, keyPair);
  return keyPair;
}

async function exportDevicePublicKeySpki(keyPair) {
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return bytesToBase64Url(new Uint8Array(spki));
}

async function signWithDeviceKey(keyPair, canonicalText) {
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: { name: "SHA-256" },
    },
    keyPair.privateKey,
    new TextEncoder().encode(String(canonicalText || ""))
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function getStoredPluginAuthState() {
  const result = await promisifyChrome(chrome.storage.local.get, chrome.storage.local, [PLUGIN_AUTH_STATE_STORAGE_KEY]);
  return (result && result[PLUGIN_AUTH_STATE_STORAGE_KEY]) || {};
}

async function saveStoredPluginAuthState(state) {
  const nextState = Object.assign({}, state || {}, {
    updatedAt: new Date().toISOString(),
  });
  await promisifyChrome(chrome.storage.local.set, chrome.storage.local, {
    [PLUGIN_AUTH_STATE_STORAGE_KEY]: nextState,
  });
  return nextState;
}

async function clearStoredPluginAuthState() {
  await promisifyChrome(chrome.storage.local.set, chrome.storage.local, {
    [PLUGIN_AUTH_STATE_STORAGE_KEY]: {},
  });
}

async function getStoredPluginSession() {
  const result = await promisifyChrome(chrome.storage.session.get, chrome.storage.session, [PLUGIN_SESSION_STORAGE_KEY]);
  return (result && result[PLUGIN_SESSION_STORAGE_KEY]) || null;
}

async function saveStoredPluginSession(session) {
  const nextSession = Object.assign({}, session || {}, {
    updatedAt: new Date().toISOString(),
  });
  await promisifyChrome(chrome.storage.session.set, chrome.storage.session, {
    [PLUGIN_SESSION_STORAGE_KEY]: nextSession,
  });
  return nextSession;
}

async function clearStoredPluginSession() {
  await promisifyChrome(chrome.storage.session.set, chrome.storage.session, {
    [PLUGIN_SESSION_STORAGE_KEY]: null,
  });
}

function parseJwtPayload(token) {
  const text = safeText(token);
  if (!text) {
    return null;
  }
  const parts = text.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    return JSON.parse(base64UrlToText(parts[1]));
  } catch (error) {
    return null;
  }
}

function resolveSessionExpiryIso(token, data) {
  const direct = safeText(data && (data.expires_at || data.expiresAt));
  if (direct) {
    return direct;
  }
  const payload = parseJwtPayload(token);
  const exp = Number(payload && payload.exp);
  if (Number.isFinite(exp) && exp > 0) {
    return new Date(exp * 1000).toISOString();
  }
  return "";
}

function isPluginSessionUsable(session) {
  if (!session || !safeText(session.accessToken) || !safeText(session.expiresAt)) {
    return false;
  }
  const expiresAtMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  const refreshWindowMs = Math.max(10, Number(PLUGIN_GATEWAY_CONFIG.sessionRefreshWindowSeconds) || 45) * 1000;
  return expiresAtMs - Date.now() > refreshWindowMs;
}

function getGatewayFriendlyError(text, status, fallback) {
  const data = parseJsonSafely(text);
  const message =
    safeText(data && data.error && (data.error.message || data.error.code)) ||
    safeText(data && (data.message || data.code)) ||
    safeText(text);
  if (message) {
    return message;
  }
  if (status === 401 || status === 403) {
    return "插件网关拒绝了当前授权";
  }
  if (status === 429) {
    return "插件网关当前触发限流";
  }
  if (status) {
    return `插件网关返回 HTTP ${status}`;
  }
  return fallback || "插件网关请求失败";
}

function getRuntimeMetadata() {
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : { version: "" };
  return {
    extensionId: safeText(chrome.runtime.id),
    extensionVersion: safeText(manifest && manifest.version),
    extensionName: safeText(manifest && manifest.name),
    audience: safeText(PLUGIN_GATEWAY_CONFIG.audience),
    channel: safeText(PLUGIN_GATEWAY_CONFIG.channel) || "edge",
  };
}

function resolveConfiguredGatewayBaseUrl(settings) {
  const rawGatewayBaseUrl = safeText(settings && settings.gatewayBaseUrl);
  return getGatewayBaseUrl(rawGatewayBaseUrl);
}

function ensurePluginGatewayConfigured(settings) {
  if (!isGatewayConfigured(safeText(settings && settings.gatewayBaseUrl))) {
    throw new Error("使用插件授权前，请先填写插件网关地址。");
  }
  return resolveConfiguredGatewayBaseUrl(settings);
}

async function ensurePluginGatewayAccess(baseUrl, interactive) {
  const permissionResult = await ensureGatewayPermission(baseUrl, {
    requestIfMissing: !!interactive,
  });
  if (!permissionResult.ok) {
    throw new Error(
      interactive
        ? "插件网关权限未授予。"
        : "插件网关访问权限尚未授予，请打开扩展弹窗并先测试一次连接。"
    );
  }
  return permissionResult;
}

async function buildSignedGatewayHeaders(method, path, bodyText, deviceId) {
  const keyPair = await getOrCreateDeviceKeyPair();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = createRequestNonce();
  const bodyHash = await sha256Base64Url(bodyText);
  const canonicalText = buildCanonicalRequestText(method, path, timestamp, nonce, bodyHash);
  const signature = await signWithDeviceKey(keyPair, canonicalText);
  const headers = {
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Body-SHA256": bodyHash,
    "X-Signature-Version": safeText(PLUGIN_GATEWAY_CONFIG.signatureVersion) || "v1",
    "X-Signature": signature,
  };
  if (safeText(deviceId)) {
    headers["X-Device-Id"] = safeText(deviceId);
  }
  return headers;
}

async function gatewayFetchJson(path, options) {
  const opts = options || {};
  const method = String(opts.method || "POST").toUpperCase();
  const jsonBody = Object.prototype.hasOwnProperty.call(opts, "jsonBody") ? opts.jsonBody : null;
  const bodyText = jsonBody == null ? "" : JSON.stringify(jsonBody);
  const baseUrl = safeText(opts.baseUrl);
  const headers = Object.assign({}, opts.headers || {}, await buildSignedGatewayHeaders(method, path, bodyText, opts.deviceId));
  if (bodyText) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchTextWithRetry(
    buildGatewayUrl(path, baseUrl),
    {
      method,
      headers,
      body: bodyText || undefined,
    },
    {
      timeoutMs: Math.max(5000, Number(opts.timeoutMs) || AUTH_REQUEST_TIMEOUT_MS),
      retryCount: Math.max(1, Number(opts.retryCount) || AUTH_REQUEST_RETRY_COUNT),
      shouldRetry: (context) => {
        if (context.isAbort || context.isNetworkError) {
          return true;
        }
        const status = Number(context.response && context.response.status);
        return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
      },
      buildErrorMessage: (context) => {
        if (context.isAbort) {
          return `插件网关请求超时，已等待 ${Math.max(5000, Number(opts.timeoutMs) || AUTH_REQUEST_TIMEOUT_MS)}ms`;
        }
        const status = Number(context.response && context.response.status);
        return getGatewayFriendlyError(context.text, status, formatAttemptError(context.error));
      },
    }
  );

  return {
    text: response.text,
    data: parseJsonSafely(response.text),
    status: response.status,
    url: response.url,
  };
}

async function computeLicenseHash(licenseKey) {
  return sha256Base64Url(safeText(licenseKey));
}

async function registerPluginGatewayDevice(options) {
  const opts = options || {};
  const settings = opts.settings || (await readReviewSettingsFromStorage());
  const licenseKey = safeText(settings.licenseKey);
  const gatewayBaseUrl = ensurePluginGatewayConfigured(settings);
  if (!licenseKey) {
    throw new Error("请先在扩展弹窗中填写插件授权码。");
  }

  await ensurePluginGatewayAccess(gatewayBaseUrl, !!opts.interactive);
  const runtime = getRuntimeMetadata();
  const keyPair = await getOrCreateDeviceKeyPair();
  const publicKeySpki = await exportDevicePublicKeySpki(keyPair);
  const licenseHash = await computeLicenseHash(licenseKey);
  const currentState = opts.authState || (await getStoredPluginAuthState());

  if (
    !opts.force &&
    safeText(currentState.deviceId) &&
    safeText(currentState.licenseHash) === licenseHash &&
    safeText(currentState.gatewayBaseUrl) === gatewayBaseUrl
  ) {
    return currentState;
  }

  const response = await gatewayFetchJson(PLUGIN_GATEWAY_CONFIG.registerPath, {
    method: "POST",
    baseUrl: gatewayBaseUrl,
    headers: {
      Authorization: `License ${licenseKey}`,
    },
    jsonBody: {
      public_key: publicKeySpki,
      extension_id: runtime.extensionId,
      extension_version: runtime.extensionVersion,
      extension_name: runtime.extensionName,
      audience: runtime.audience,
      channel: runtime.channel,
    },
  });

  const data = response.data || {};
  const deviceId = safeText(data.device_id || data.deviceId);
  if (!deviceId) {
    throw new Error("插件网关在注册时没有返回 device_id。");
  }

  return saveStoredPluginAuthState({
    deviceId,
    registeredAt: safeText(data.registered_at || data.registeredAt) || new Date().toISOString(),
    publicKeySpki,
    licenseHash,
    gatewayBaseUrl,
    lastError: "",
    lastValidatedAt: new Date().toISOString(),
  });
}

async function requestPluginGatewaySession(options) {
  const opts = options || {};
  const settings = opts.settings || (await readReviewSettingsFromStorage());
  const licenseKey = safeText(settings.licenseKey);
  const gatewayBaseUrl = ensurePluginGatewayConfigured(settings);
  if (!licenseKey) {
    throw new Error("请先在扩展弹窗中填写插件授权码。");
  }

  await ensurePluginGatewayAccess(gatewayBaseUrl, !!opts.interactive);
  const authState =
    opts.authState ||
    (await registerPluginGatewayDevice({
      interactive: !!opts.interactive,
      settings,
      force: !!opts.forceRegister,
    }));
  const runtime = getRuntimeMetadata();
  const response = await gatewayFetchJson(PLUGIN_GATEWAY_CONFIG.sessionPath, {
    method: "POST",
    baseUrl: gatewayBaseUrl,
    deviceId: authState.deviceId,
    headers: {
      Authorization: `License ${licenseKey}`,
    },
    jsonBody: {
      device_id: authState.deviceId,
      extension_id: runtime.extensionId,
      extension_version: runtime.extensionVersion,
      audience: runtime.audience,
      channel: runtime.channel,
    },
    timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
  });

  const data = response.data || {};
  const accessToken = safeText(data.access_token || data.accessToken || data.token);
  if (!accessToken) {
    throw new Error("插件网关没有返回访问令牌。");
  }

  const session = await saveStoredPluginSession({
    accessToken,
    deviceId: authState.deviceId,
    issuedAt: new Date().toISOString(),
    expiresAt: resolveSessionExpiryIso(accessToken, data),
    sessionId: safeText(data.session_id || data.sessionId),
    userId: safeText(data.user_id || data.userId),
  });

  await saveStoredPluginAuthState(
    Object.assign({}, authState, {
      lastError: "",
      lastValidatedAt: new Date().toISOString(),
    })
  );

  return {
    authState,
    session,
    data,
  };
}

async function ensurePluginGatewaySession(options) {
  const opts = options || {};
  const settings = opts.settings || (await readReviewSettingsFromStorage());
  const gatewayBaseUrl = ensurePluginGatewayConfigured(settings);
  if (!safeText(settings.licenseKey)) {
    throw new Error("请先在扩展弹窗中填写插件授权码。");
  }

  await ensurePluginGatewayAccess(gatewayBaseUrl, !!opts.interactive);
  let authState = await getStoredPluginAuthState();
  const licenseHash = await computeLicenseHash(settings.licenseKey);
  if (
    !safeText(authState.deviceId) ||
    safeText(authState.licenseHash) !== licenseHash ||
    safeText(authState.gatewayBaseUrl) !== gatewayBaseUrl ||
    !!opts.forceRegister
  ) {
    authState = await registerPluginGatewayDevice({
      interactive: !!opts.interactive,
      settings,
      authState,
      force: true,
    });
  }

  let session = await getStoredPluginSession();
  if (
    !opts.forceRefresh &&
    session &&
    safeText(session.deviceId) === safeText(authState.deviceId) &&
    isPluginSessionUsable(session)
  ) {
    return {
      settings,
      authState,
      session,
      gatewayBaseUrl,
    };
  }

  const refreshed = await requestPluginGatewaySession({
    interactive: !!opts.interactive,
    settings,
    authState,
  });

  return {
    settings,
    authState: refreshed.authState,
    session: refreshed.session,
    gatewayBaseUrl,
  };
}

async function getPluginAuthState(options) {
  const opts = options || {};
  const settings = await readReviewSettingsFromStorage();
  let authState = await getStoredPluginAuthState();
  let session = await getStoredPluginSession();
  let lastError = safeText(authState && authState.lastError);

  if (opts.refresh) {
    try {
      const ensured = await ensurePluginGatewaySession({
        interactive: !!opts.interactive,
        forceRefresh: !!opts.forceRefresh,
      });
      authState = ensured.authState;
      session = ensured.session;
      lastError = "";
    } catch (error) {
      lastError = safeText(error && error.message);
      authState = await saveStoredPluginAuthState(
        Object.assign({}, authState || {}, {
          lastError,
        })
      );
    }
  }

  return {
    ok: true,
    state: {
      configured: isGatewayConfigured(safeText(settings && settings.gatewayBaseUrl)),
      gatewayBaseUrl:
        safeText(settings && settings.gatewayBaseUrl) ||
        (isGatewayConfigured("") ? getGatewayBaseUrl("") : ""),
      extensionId: safeText(chrome.runtime.id),
      licenseConfigured: !!safeText(settings.licenseKey),
      registered: !!safeText(authState && authState.deviceId),
      deviceId: safeText(authState && authState.deviceId),
      lastValidatedAt: safeText(authState && authState.lastValidatedAt),
      sessionActive: !!(session && isPluginSessionUsable(session)),
      sessionExpiresAt: safeText(session && session.expiresAt),
      lastError,
    },
  };
}

async function testPluginGatewayConnection(payload) {
  const settings = await readReviewSettingsFromStorage();
  if (!safeText(settings.licenseKey)) {
    throw new Error("请先在扩展弹窗中填写插件授权码。");
  }

  const ensured = await ensurePluginGatewaySession({
    interactive: true,
    forceRefresh: true,
  });

  let healthMessage = "插件网关授权已就绪。";
  if (safeText(PLUGIN_GATEWAY_CONFIG.healthPath)) {
    try {
      const health = await gatewayFetchJson(PLUGIN_GATEWAY_CONFIG.healthPath, {
        method: "GET",
        deviceId: ensured.authState.deviceId,
        headers: {
          Authorization: `Bearer ${ensured.session.accessToken}`,
        },
        timeoutMs: Math.max(5000, Number(payload && payload.timeoutMs) || 8000),
        retryCount: 1,
      });
      const data = health.data || {};
      healthMessage =
        safeText(data.message || data.status) ||
        (health.status ? `插件网关健康检查返回 HTTP ${health.status}` : healthMessage);
    } catch (error) {
      if (!/404/.test(safeText(error && error.message))) {
        throw error;
      }
    }
  }

  return {
    ok: true,
    gatewayBaseUrl: ensured.gatewayBaseUrl,
    deviceId: ensured.authState.deviceId,
    sessionExpiresAt: ensured.session.expiresAt,
    message: healthMessage,
  };
}

function getConnectionModeFromPayload(payload, settings) {
  const rawMode = safeText(payload && payload.connectionMode) || safeText(settings && settings.connectionMode);
  return rawMode === "custom_api" ? "custom_api" : "plugin_gateway";
}

async function callAiChat(payload) {
  const settings = await readReviewSettingsFromStorage();
  const connectionMode = getConnectionModeFromPayload(payload, settings);
  if (connectionMode === "custom_api") {
    return callAiChatLegacyUnused(Object.assign({}, settings || {}, payload || {}, { connectionMode }));
  }

  const model = safeText(payload && payload.model);
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const temperature = payload && typeof payload.temperature === "number" ? payload.temperature : null;
  const timeoutMs = Math.max(5000, Number((payload && payload.timeoutMs) || 20000));
  const retryCount = Math.max(1, Number((payload && payload.retryCount) || 2));

  if (!model) {
    throw new Error("AI 模型不能为空");
  }
  if (!messages.length) {
    throw new Error("AI 请求消息不能为空");
  }

  const requestBody = Object.assign(
    {
      model,
      messages,
      client: {
        extension_id: chrome.runtime.id,
        extension_version: safeText(chrome.runtime.getManifest && chrome.runtime.getManifest().version),
        channel: safeText(PLUGIN_GATEWAY_CONFIG.channel) || "edge",
      },
    },
    typeof payload.max_tokens === "number" ? { max_tokens: payload.max_tokens } : {},
    typeof temperature === "number" ? { temperature } : {}
  );

  let ensured = await ensurePluginGatewaySession({
    interactive: false,
  });

  async function doRequest(sessionInfo) {
    return gatewayFetchJson(PLUGIN_GATEWAY_CONFIG.chatPath, {
      method: "POST",
      baseUrl: sessionInfo.gatewayBaseUrl,
      deviceId: sessionInfo.authState.deviceId,
      headers: {
        Authorization: `Bearer ${sessionInfo.session.accessToken}`,
      },
      jsonBody: requestBody,
      timeoutMs,
      retryCount,
    });
  }

  let result;
  try {
    result = await doRequest(ensured);
  } catch (error) {
    const message = safeText(error && error.message).toLowerCase();
    if (message.includes("http 401") || message.includes("http 403") || message.includes("authorization")) {
      await clearStoredPluginSession();
      ensured = await ensurePluginGatewaySession({
        interactive: false,
        forceRefresh: true,
      });
      result = await doRequest(ensured);
    } else {
      throw error;
    }
  }

  const rawText = result.text;
  const data = result.data || parseJsonSafely(rawText);
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content =
    safeText(choice && choice.message && choice.message.content) ||
    safeText(data && data.output_text) ||
    "";

  return {
    ok: true,
    endpoint: buildGatewayUrl(PLUGIN_GATEWAY_CONFIG.chatPath, ensured.gatewayBaseUrl),
    model,
    content,
    rawText,
    usage: data && data.usage ? data.usage : null,
    deviceId: ensured.authState.deviceId,
    sessionExpiresAt: ensured.session.expiresAt,
  };
}

async function testAiEndpoint(payload) {
  const settings = await readReviewSettingsFromStorage();
  const connectionMode = getConnectionModeFromPayload(payload, settings);
  if (connectionMode === "custom_api") {
    return testAiEndpointLegacyUnused(Object.assign({}, settings || {}, payload || {}, { connectionMode }));
  }
  return testPluginGatewayConnection(payload);
}

async function getReviewSettings() {
  return {
    ok: true,
    settings: await readReviewSettingsFromStorage(),
  };
}

async function saveReviewSettings(payload) {
  const previous = await readReviewSettingsFromStorage();
  const settings = await writeReviewSettingsToStorage(payload || {});
  if (
    safeText(previous.licenseKey) !== safeText(settings.licenseKey) ||
    safeText(previous.connectionMode) !== safeText(settings.connectionMode) ||
    safeText(previous.gatewayBaseUrl) !== safeText(settings.gatewayBaseUrl)
  ) {
    await clearStoredPluginSession();
    await clearStoredPluginAuthState();
  }
  return {
    ok: true,
    settings,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "无效消息" });
    return false;
  }

  if (message.type === "runTabAction") {
    runTabAction(message.tabId, message.action, message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "downloadJson") {
    downloadJson(message.filename, message.data)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "callAiChat") {
    callAiChat(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "testAiEndpoint") {
    testAiEndpoint(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "getPluginAuthState") {
    getPluginAuthState(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ensureAiEndpointPermission") {
    ensureCustomAiEndpointPermissionLegacyUnused(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "getReviewSettings") {
    getReviewSettings()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "saveReviewSettings") {
    saveReviewSettings(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "refreshPluginGatewaySession") {
    testPluginGatewayConnection(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  if (autoCrawlJobs.has(tabId)) {
    processAutoCrawlStep(tabId).catch((error) => {
      console.error("[Chaoxing Extension] 处理后台自动抓取步骤失败:", error);
    });
    return;
  }

  if (tab.url && isChaoxingUrl(tab.url)) {
    chrome.action.setBadgeText({ tabId: tabId, text: '✓' });
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#00FF00' });

    if (isLoginLandingUrl(tab.url)) {
      startAutoCrawl(tabId).catch((error) => {
        console.error("[Chaoxing Extension] 启动后台自动抓取失败:", error);
      });
    }
  } else {
    chrome.action.setBadgeText({ tabId: tabId, text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!autoCrawlJobs.has(tabId)) {
    return;
  }

  autoCrawlJobs.delete(tabId);
  autoCrawlRunning = false;
});

recoverInterruptedAutoExtractState().catch((error) => {
  console.error("[Chaoxing Extension] 恢复自动抓取状态失败:", error);
});
