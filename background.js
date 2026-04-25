importScripts("review-shared.js");

const {
  STORAGE_KEYS,
  ensureAiEndpointPermission,
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
    return response || { ok: false, handled: false, frameId, error: "Empty response" };
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

async function callAiChat(payload) {
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
    throw new Error("This AI endpoint has not been authorized yet. Please test the connection from the extension popup first.");
  }

  if (!apiKey) {
    throw new Error("AI API Key 不能为空");
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
          return `AI request timed out after ${timeoutMs}ms`;
        }
        const data = parseJsonSafely(context.text);
        const apiMessage =
          safeText(data && data.error && (data.error.message || data.error.code)) ||
          safeText(data && data.message) ||
          safeText(context.text);
        const status = Number(context.response && context.response.status);
        if (status === 401 || status === 403) {
          return apiMessage || `AI endpoint rejected the API key (HTTP ${status})`;
        }
        if (status === 429) {
          return apiMessage || "AI endpoint is rate limited right now (HTTP 429)";
        }
        if (status) {
          return apiMessage || `AI endpoint returned HTTP ${status}`;
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

async function testAiEndpoint(payload) {
  return callAiChat({
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

async function getReviewSettings() {
  return {
    ok: true,
    settings: await readReviewSettingsFromStorage(),
  };
}

async function saveReviewSettings(payload) {
  return {
    ok: true,
    settings: await writeReviewSettingsToStorage(payload || {}),
  };
}

async function ensureCustomAiEndpointPermission(payload) {
  try {
    const result = await ensureAiEndpointPermission(payload && payload.endpoint, {
      requestIfMissing: !!(payload && payload.requestIfMissing),
    });
    if (!result.ok) {
      return {
        ok: false,
        error: "The current AI endpoint has not been authorized.",
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
        error: "Please open the extension popup and use Test Connection once to grant this custom AI endpoint.",
      };
    }
    return {
      ok: false,
      error: message || "Failed to request AI endpoint permission",
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "Invalid message" });
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

  if (message.type === "ensureAiEndpointPermission") {
    ensureCustomAiEndpointPermission(message.payload || {})
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
