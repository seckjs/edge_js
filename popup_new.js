let activeTabId = null;
let latestDownload = null;

const pageMetaEl = document.getElementById("pageMeta");
const statusBoxEl = document.getElementById("statusBox");
const resultMetaEl = document.getElementById("resultMeta");
const resultOutputEl = document.getElementById("resultOutput");

const actionButtons = [
  "inspectBtn",
  "extractCoursesBtn",
  "extractHomeworksBtn",
  "downloadBtn",
].map((id) => document.getElementById(id));

function setBusy(busy) {
  actionButtons.forEach((button) => {
    if (button) {
      button.disabled = busy;
    }
  });
}

function setStatus(message) {
  statusBoxEl.textContent = message;
}

function setResult(payload, metaText) {
  latestDownload = payload || null;
  resultOutputEl.value = payload ? JSON.stringify(payload, null, 2) : "";
  resultMetaEl.textContent = metaText || (payload ? "已生成结果" : "暂无数据");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length ? tabs[0] : null;
}

async function runAction(action, payload) {
  if (!activeTabId) {
    throw new Error("没有找到当前标签页。");
  }
  const response = await chrome.runtime.sendMessage({
    type: "runTabAction",
    tabId: activeTabId,
    action,
    payload: payload || {},
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "操作失败");
  }
  return response;
}

async function downloadLatest() {
  if (!latestDownload) {
    throw new Error("当前还没有可下载的数据。");
  }
  const payload = latestDownload.export || latestDownload.payload || latestDownload;
  const filename =
    latestDownload.filename ||
    (latestDownload.export && latestDownload.export.kind
      ? `chaoxing-${latestDownload.export.kind}.json`
      : "chaoxing-export.json");
  const response = await chrome.runtime.sendMessage({
    type: "downloadJson",
    filename,
    data: payload,
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "下载失败");
  }
  setStatus(`下载任务已创建，ID: ${response.downloadId}`);
}

async function handleInspect() {
  const response = await runAction("inspect");
  const best = response.best;
  const context = best && best.data ? best.data : {};
  setResult(
    {
      action: "inspect",
      frame_url: best ? best.frameUrl : "",
      context,
      filename: "chaoxing-context.json",
    },
    "页面识别完成"
  );
  setStatus(best.summary || "已识别当前页面。");
}

async function handleExtract(action, label) {
  const response = await runAction(action, { paginate: true });
  const best = response.best;
  setResult(
    {
      action,
      frame_url: best.frameUrl,
      summary: best.summary || "",
      export: best.export,
      filename: best.filename,
    },
    `${label} ${best.count || 0} 条`
  );
  setStatus(best.summary || `${label}完成，共 ${best.count || 0} 条。`);
}

function bindEvents() {
  document.getElementById("inspectBtn").addEventListener("click", async () => {
    setBusy(true);
    setStatus("正在识别页面...");
    try {
      await handleInspect();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("extractCoursesBtn").addEventListener("click", async () => {
    setBusy(true);
    setStatus("正在抓取课程列表...");
    try {
      await handleExtract("extractCourses", "课程");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("extractHomeworksBtn").addEventListener("click", async () => {
    setBusy(true);
    setStatus("正在抓取作业列表...");
    try {
      await handleExtract("extractHomeworks", "作业");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("downloadBtn").addEventListener("click", async () => {
    setBusy(true);
    try {
      await downloadLatest();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  });
}

async function updatePageMeta() {
  const tab = await getActiveTab();
  if (!tab) {
    pageMetaEl.textContent = "无法获取当前页面信息";
    return;
  }

  activeTabId = tab.id;
  const url = tab.url || "";
  const isChaoxing = url.includes("chaoxing.com");
  
  if (isChaoxing) {
    pageMetaEl.textContent = `✓ 已识别超星页面 | ${tab.title}`;
  } else {
    pageMetaEl.textContent = `当前页面：${tab.title}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  updatePageMeta();
  bindEvents();
});
