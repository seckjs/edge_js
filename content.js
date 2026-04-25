(function () {
  const BRIDGE_REQUEST_EVENT = "__cx_edge_bridge_request__";
  const BRIDGE_RESPONSE_EVENT = "__cx_edge_bridge_response__";
  const BRIDGE_TIMEOUT_MS = 30000;
  const REVIEW_SHARED = globalThis.CX_REVIEW_SHARED;
  const API_PROVIDER_PRESETS = REVIEW_SHARED.API_PROVIDER_PRESETS;
  const REVIEW_PANEL_SETTINGS_STORAGE_KEY = REVIEW_SHARED.STORAGE_KEYS.reviewSettings;
  const REVIEW_BATCH_QUEUE_STORAGE_KEY = REVIEW_SHARED.STORAGE_KEYS.reviewBatchQueue;
  const getSharedDefaultReviewSettings = REVIEW_SHARED.getDefaultReviewSettings;
  const getSharedProviderPreset = REVIEW_SHARED.getProviderPreset;
  const getSharedProviderModels = REVIEW_SHARED.getProviderModels;
  const inferSharedProviderFromEndpoint = REVIEW_SHARED.inferProviderFromEndpoint;
  let bridgeInjected = false;

  function safeText(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeText(value) {
    return safeText(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeMultilineText(value) {
    return safeText(value).replace(/\u00a0/g, " ").replace(/\r/g, "");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isVisible(node) {
    if (!node) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (!style) {
      return true;
    }
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    return node.getClientRects().length > 0;
  }

  function isDisabled(node) {
    if (!node) {
      return true;
    }
    if (node.disabled) {
      return true;
    }
    const className = String(node.className || "").toLowerCase();
    return (
      className.includes("disable") ||
      className.includes("disabled") ||
      className.includes("xl-disabled") ||
      String(node.getAttribute("aria-disabled") || "").toLowerCase() === "true"
    );
  }

  function dispatchClick(node) {
    if (!node) {
      return;
    }
    try {
      node.click();
      return;
    } catch (error) {
      // Fall through.
    }
    node.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
  }

  function resolveUrl(rawUrl) {
    const text = safeText(rawUrl);
    if (!text) {
      return "";
    }
    try {
      return new URL(text, window.location.href).href;
    } catch (error) {
      return text;
    }
  }

  function queryValue(keys, urlText) {
    const url = safeText(urlText) || window.location.href;
    try {
      const parsed = new URL(url, window.location.href);
      for (const key of keys) {
        const value = safeText(parsed.searchParams.get(key));
        if (value) {
          return value;
        }
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  function extractIdsFromUrl(urlText) {
    return {
      course_id: queryValue(["courseid", "courseId", "cid"], urlText),
      class_id: queryValue(["clazzid", "classid", "classId", "clazzId"], urlText),
      work_id: queryValue(["workid", "workId", "id"], urlText),
      workAnswerId: queryValue(["workAnswerId", "answerId", "answerid", "workanswerid"], urlText),
      cpi: queryValue(["cpi"], urlText),
    };
  }

  function getAttributeValue(node, names) {
    if (!node) {
      return "";
    }
    for (const name of names) {
      const value = safeText(node.getAttribute(name));
      if (value) {
        return value;
      }
    }
    return "";
  }

  function getDescendantValue(node, selectors) {
    if (!node) {
      return "";
    }
    for (const selector of selectors) {
      const target = node.matches && node.matches(selector) ? node : node.querySelector(selector);
      if (!target) {
        continue;
      }
      const value = normalizeText(target.value || target.getAttribute("value") || target.textContent || "");
      if (value) {
        return value;
      }
    }
    return "";
  }

  function extractIdsFromNode(node) {
    const result = {
      course_id: "",
      class_id: "",
      work_id: "",
      workAnswerId: "",
      cpi: "",
    };

    let current = node;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      const urlIds = extractIdsFromUrl(extractUrlFromAction(current));
      result.course_id =
        result.course_id ||
        urlIds.course_id ||
        getDescendantValue(current, [".courseId", "input[name='courseId']", "input[name='courseid']"]) ||
        getAttributeValue(current, ["courseid", "courseId", "data-courseid", "data-courseId"]);
      result.class_id =
        result.class_id ||
        urlIds.class_id ||
        getDescendantValue(current, [".clazzId", "input[name='clazzId']", "input[name='classId']", "input[name='clazzid']"]) ||
        getAttributeValue(current, [
          "clazzid",
          "clazzId",
          "classid",
          "classId",
          "data-clazzid",
          "data-classid",
          "data-classId",
        ]);
      result.work_id =
        result.work_id ||
        urlIds.work_id ||
        getAttributeValue(current, ["workid", "workId", "data-workid", "data-workId"]);
      result.workAnswerId =
        result.workAnswerId ||
        urlIds.workAnswerId ||
        getAttributeValue(current, [
          "workanswerid",
          "workAnswerId",
          "answerid",
          "answerId",
          "data-workanswerid",
          "data-workAnswerId",
        ]);
      result.cpi =
        result.cpi ||
        urlIds.cpi ||
        getDescendantValue(current, [".curPersonId", "input[name='cpi']", ".cpi"]) ||
        getAttributeValue(current, ["cpi", "data-cpi"]);
      current = current.parentElement;
    }

    return result;
  }

  function getInputValue(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      const value = normalizeText(node.value || node.getAttribute("value") || "");
      if (value) {
        return value;
      }
    }
    return "";
  }

  function getUrlWithParams(baseUrl, params) {
    const text = safeText(baseUrl);
    if (!text) {
      return "";
    }
    try {
      const url = new URL(text, window.location.href);
      Object.entries(params || {}).forEach(([key, value]) => {
        const normalized = safeText(value);
        if (normalized) {
          url.searchParams.set(key, normalized);
        }
      });
      return url.toString();
    } catch (error) {
      return "";
    }
  }

  function getPageIds() {
    const urlIds = extractIdsFromUrl(window.location.href);
    return {
      course_id:
        getInputValue(["#courseid", "#courseId", "input[name='courseid']", "input[name='courseId']"]) ||
        urlIds.course_id,
      class_id:
        getInputValue(["#clazzid", "#classId", "#classid", "input[name='clazzid']", "input[name='classId']"]) ||
        urlIds.class_id,
      work_id:
        getInputValue(["#workid", "#workId", "input[name='workid']", "input[name='workId']"]) ||
        urlIds.work_id,
      workAnswerId:
        getInputValue([
          "#workAnswerId",
          "input[name='workAnswerId']",
          "input[name='answerId']",
          "input[name='answerid']",
        ]) || urlIds.workAnswerId,
      cpi: getInputValue(["#cpi", "input[name='cpi']"]) || urlIds.cpi,
    };
  }

  function buildTeacherHomeworkListUrl() {
    const pageIds = getPageIds();
    const enc = getInputValue(["#enc", "input[name='enc']"]);
    const openc = getInputValue(["#openc", "input[name='openc']"]);
    const t = getInputValue(["#t", "input[name='t']"]);
    const homeworkNav =
      document.querySelector("li[dataname='zy'] a[data-url]") ||
      document.querySelector("#nav_50974 a[data-url]") ||
      document.querySelector("a[title='作业'][data-url]");

    if (!homeworkNav || !pageIds.course_id || !pageIds.class_id || !pageIds.cpi || !enc) {
      return "";
    }

    const baseUrl =
      safeText(homeworkNav.getAttribute("data-url")) ||
      safeText(homeworkNav.getAttribute("href")) ||
      "";

    return getUrlWithParams(baseUrl, {
      courseid: pageIds.course_id,
      clazzid: pageIds.class_id,
      courseId: pageIds.course_id,
      classId: pageIds.class_id,
      clazzId: pageIds.class_id,
      cpi: pageIds.cpi,
      enc,
      openc,
      t,
      ut: "t",
    });
  }

  function buildHomeworkListFetchUrl(pageNum, pageSize) {
    const fallbackUrl = buildTeacherHomeworkListUrl();
    let url;
    try {
      url = new URL(window.location.href);
    } catch (error) {
      url = null;
    }

    if (!url || !/\/work\/list/i.test(url.pathname)) {
      if (!fallbackUrl) {
        return "";
      }
      try {
        url = new URL(fallbackUrl, window.location.href);
      } catch (error) {
        return "";
      }
    }

    url.searchParams.set("pages", String(Math.max(1, Number(pageNum) || 1)));
    url.searchParams.set("size", String(Math.max(1, Number(pageSize) || 12)));
    return url.toString();
  }

  function getTimestampText() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return (
      String(now.getFullYear()) +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "_" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds())
    );
  }

  function buildFilename(prefix) {
    return `${prefix}-${getTimestampText()}.json`;
  }

  function getImageSrc(img) {
    if (!img) {
      return "";
    }
    return safeText(img.getAttribute("src") || img.src || "");
  }

  function isValidImage(src) {
    const text = safeText(src);
    if (!text || text.startsWith("data:") || text.includes("blank.gif")) {
      return false;
    }
    const uiIcons = ["eidt.png", "popClose.png", "dy_logo.png", "work/images/"];
    return !uiIcons.some((icon) => text.includes(icon));
  }

  function getSafeText(element) {
    if (!element) {
      return "";
    }
    const inner = normalizeMultilineText(element.innerText || "");
    if (inner) {
      return inner;
    }
    const html = String(element.innerHTML || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<div[^>]*>/gi, "\n");
    const temp = document.createElement("div");
    temp.innerHTML = html;
    return normalizeMultilineText(temp.textContent || "");
  }

  function extractUrlFromAction(node) {
    if (!node) {
      return "";
    }
    
    let current = node;
    for (let i = 0; i < 3 && current; i++) {
      const directAttrs = ["data", "href", "url", "data-url"];
      for (const attr of directAttrs) {
        const value = safeText(current.getAttribute(attr));
        if (!value) {
          continue;
        }
        if (/^javascript:/i.test(value)) {
          const matched = value.match(/(['"])(https?:\/\/.+?|\/.+?)\1/);
          if (matched && matched[2]) {
            return resolveUrl(matched[2]);
          }
          continue;
        }
        return resolveUrl(value);
      }
      const onclickText = safeText(current.getAttribute("onclick"));
      if (onclickText) {
        const matched = onclickText.match(/(['"])(https?:\/\/.+?|\/.+?)\1/);
        if (matched && matched[2]) {
          return resolveUrl(matched[2]);
        }
        const queryMatch = onclickText.match(/(workid=\d+[^'")\s]*)/i);
        if (queryMatch && queryMatch[1]) {
          return resolveUrl(`?${queryMatch[1].replace(/^[?&]/, "")}`);
        }
        const courseMatch = onclickText.match(
          /((?:courseid|courseId|clazzid|clazzId|classid|classId)=[^'")\s]+(?:[&?](?:courseid|courseId|clazzid|clazzId|classid|classId|cpi)=[^'")\s]+)+)/i
        );
        if (courseMatch && courseMatch[1]) {
          return resolveUrl(`?${courseMatch[1].replace(/^[?&]/, "")}`);
        }
      }
      current = current.parentElement;
    }
    return "";
  }

  function buildExport(kind, records, extra) {
    return {
      kind,
      generated_at: new Date().toISOString(),
      page_url: window.location.href,
      page_title: document.title,
      frame_url: window.location.href,
      frame_title: document.title,
      record_count: Array.isArray(records) ? records.length : 0,
      records,
      extra: extra || {},
    };
  }

  function uniqueBy(records, getKey) {
    const seen = new Set();
    const results = [];
    for (const record of records) {
      const key = safeText(getKey(record));
      if (key && seen.has(key)) {
        continue;
      }
      if (key) {
        seen.add(key);
      }
      results.push(record);
    }
    return results;
  }

  function isMeaningfulCourseText(text) {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 2 || normalized.length > 120) {
      return "";
    }

    const blocked = new Set([
      "课程",
      "进入课程",
      "进入",
      "更多",
      "管理",
      "编辑",
      "作业",
      "通知",
      "首页",
      "学习",
      "班级",
    ]);
    return blocked.has(normalized) ? "" : normalized;
  }

  function getCourseNameFromNode(node) {
    const selector =
      "[title], .course-name, .course_name, .Mcon1_name, .course-info [class*='name'], h3, h4, h5, .catalog_name, .textHidden, .overHidden2";
    const visited = new Set();
    const candidates = [];
    const pushText = (value) => {
      const text = isMeaningfulCourseText(value);
      if (text && !visited.has(text)) {
        visited.add(text);
        candidates.push(text);
      }
    };

    let current = node;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      Array.from(current.querySelectorAll(selector))
        .slice(0, 12)
        .forEach((child) => {
          pushText(child.getAttribute && child.getAttribute("title"));
          pushText(child.textContent || "");
          if (child.tagName && child.tagName.toLowerCase() === "img") {
            pushText(child.getAttribute("alt"));
          }
        });
      pushText(current.getAttribute && current.getAttribute("title"));
      pushText(current.textContent || "");
      current = current.parentElement;
    }

    return candidates[0] || "";
  }

  function findMyTeachTabNode() {
    const direct = document.querySelector("#myTeach");
    if (direct) {
      return direct;
    }
    return Array.from(document.querySelectorAll(".tab-item, .course-tab .tab-item, a, button, li, div")).find(
      (node) => isVisible(node) && normalizeText(node.textContent || "").includes("我教的课")
    );
  }

  function getVisibleTeachCourseCount() {
    return Array.from(document.querySelectorAll(".teachCourse")).filter(isVisible).length;
  }

  async function ensureTeachCourseTabVisible() {
    const teachCards = getVisibleTeachCourseCount();
    if (teachCards > 0) {
      return false;
    }

    const teachTab = findMyTeachTabNode();
    if (!teachTab) {
      return false;
    }

    const className = String(teachTab.className || "").toLowerCase();
    const isCurrent =
      className.includes("current") || String(teachTab.getAttribute("aria-selected") || "") === "true";
    if (!isCurrent) {
      dispatchClick(teachTab);
      await sleep(1500);
    }

    return getVisibleTeachCourseCount() > 0;
  }

  function getCourseEntryNode(node) {
    if (!node) {
      return null;
    }
    if (node.matches && node.matches("a[href*='courseId='], a[href*='courseid='], a[href*='edit=true']")) {
      return node;
    }
    return (
      node.querySelector("a[href*='courseId='], a[href*='courseid='], a[href*='edit=true']") ||
      node.querySelector("a[color1], a") ||
      node
    );
  }

  function getCourseAnchors() {
    const teacherCardSelectors = [
      ".teachCourse",
      "#courseList .teachCourse",
      "#normalCourseListDiv .teachCourse",
      "#topCourseListDiv .teachCourse",
    ];
    const teacherCards = teacherCardSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    if (teacherCards.length) {
      return Array.from(new Set(teacherCards));
    }

    const selectors = [
      "h3.inlineBlock a[href*='edit=true']",
      ".teachCourse a[href*='courseId='][href*='edit=true']",
      ".teachCourse a[href*='courseid='][href*='edit=true']",
      ".teachCourse a[href*='courseId=']",
      ".teachCourse a[href*='courseid=']",
      "a[href*='courseid='][href*='clazzid=']",
      "a[href*='courseId='][href*='classId=']",
      "a[href*='studentcourse'][href*='courseid=']",
      "a[href*='stucoursemiddle'][href*='courseid=']",
      "a[onclick*='courseid']",
      "a[onclick*='courseId']",
      "[onclick*='courseid'][onclick*='clazzid']",
      "[onclick*='courseId'][onclick*='classId']",
      "[data*='courseid='][data*='clazzid=']",
      "[data-url*='courseid='][data-url*='clazzid=']",
      "[dataurl*='courseid='][dataurl*='clazzid=']",
      "[onclick*='studentcourse']",
      "[onclick*='stucoursemiddle']",
    ];

    const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    return Array.from(new Set(nodes)).filter((node) => {
      if (!isVisible(node)) {
        return false;
      }
      const ids = extractIdsFromNode(node);
      const url = extractUrlFromAction(node);
      const hasCourseIdentity =
        (!!ids.course_id && !!ids.class_id) ||
        /courseid|clazzid|studentcourse|stucoursemiddle/i.test(url);
      return hasCourseIdentity && !ids.work_id && !!getCourseNameFromNode(node);
    });
  }

  function getReviewButtons() {
    return Array.from(document.querySelectorAll("a, button, .list_li_tit")).filter((node) => {
      const text = normalizeText(node.textContent || node.value || "");
      if (text.includes("批阅")) {
        // 如果元素包含太多文本，可能是它的父容器，我们只保留文本较短的元素
        if (text.length > 20) return false;
        
        // 如果它是一个外层包裹节点，且包含了真正的按钮，我们不选外层
        if (node.tagName.toLowerCase() !== "a" && node.tagName.toLowerCase() !== "button") {
           const hasInnerBtn = node.querySelector("a, button");
           if (hasInnerBtn && normalizeText(hasInnerBtn.textContent).includes("批阅")) {
             return false;
           }
        }
        return true;
      }
      const href = safeText(node.getAttribute("href"));
      const onclickText = safeText(node.getAttribute("onclick"));
      const classText = String(node.className || "").toLowerCase();
      if (node.tagName.toLowerCase() === "a" || node.tagName.toLowerCase() === "button" || node.classList.contains("list_li_tit")) {
        return (
          /review|mark|piyue/i.test(href) ||
          /mark|review|批阅/i.test(onclickText) ||
          /viewWork/i.test(onclickText) ||
          classText.includes("piyue")
        );
      }
      return false;
    });
  }

  function getHomeworkRows() {
    return Array.from(document.querySelectorAll(".taskList li[id^='work'], .taskList > ul > li"))
      .filter((row) => {
        const title = normalizeText(
          (row.querySelector(".list_li_tit, .taskTitle, .tit, .mark_title, .list_title") || row).textContent || ""
        );
        return !!title;
      });
  }

  function getQuestionContainers() {
    const exactSubjectiveNodes = Array.from(
      document.querySelectorAll("div.mark_item1:not(.objective)")
    ).filter((node) => {
      const hasScoreInput = !!node.querySelector(
        "input.questionScore[rid], .mark_answer_score input.questionScore[rid], input[name^='score'][rid]"
      );
      const hasAnswerBlock =
        !!node.querySelector("dd.stuAnswerWords, dl[id^='stuanswer_']") ||
        !!node.querySelector("dl[id^='correctanswer_']");
      const hasTitle = !!node.querySelector("h3.mark_name, h3[id^='questionStem_']");
      return hasTitle && hasScoreInput && hasAnswerBlock;
    });

    if (exactSubjectiveNodes.length) {
      return exactSubjectiveNodes;
    }

    const selectorGroups = [
      ".mark_item1",
      "[class^='mark_item'], [class*=' mark_item']",
      "div[id^='index_']",
      ".TiMu",
      ".questionLi",
    ];

    for (const selector of selectorGroups) {
      const rawNodes = Array.from(document.querySelectorAll(selector));
      if (!rawNodes.length) {
        continue;
      }
      const nodeSet = new Set(rawNodes);
      const filtered = rawNodes.filter((node) => {
        let parent = node.parentElement;
        while (parent) {
          if (nodeSet.has(parent)) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      });
      if (filtered.length) {
        return filtered;
      }
    }

    return [];
  }

  function isTeacherReviewPage() {
    const questionCount = getQuestionContainers().length;
    if (!questionCount) {
      return false;
    }

    const scoreCount = document.querySelectorAll(
      "input.questionScore, input[name^='score'], textarea[id^='answer'], textarea[name^='answer']"
    ).length;
    const hasStudentAnswer =
      !!document.querySelector(".stuAnswerWords") ||
      Array.from(document.querySelectorAll("dt")).some((node) =>
        normalizeText(node.textContent).includes("学生答案")
      );
    const hasCorrectAnswer =
      Array.from(document.querySelectorAll("dt")).some((node) =>
        normalizeText(node.textContent).includes("正确答案")
      );
    const hasSubmitButton = !!document.querySelector(
      "a[onclick*='markAction(1)'], button[onclick*='markAction(1)']"
    );

    return scoreCount > 0 && (hasStudentAnswer || hasCorrectAnswer || hasSubmitButton);
  }

  function getPendingReviewActionNode() {
    const rows = Array.from(document.querySelectorAll("ul.dataBody_td, tr"));
    for (const row of rows) {
      const rowText = normalizeText(row.textContent || "");
      if (!rowText || !rowText.includes("待批阅")) {
        continue;
      }
      const actionNode =
        row.querySelector("a[href*='review'], a[href*='mark'], a[onclick*='mark'], button, .cz_py") || null;
      if (!actionNode || !isVisible(actionNode) || isDisabled(actionNode)) {
        continue;
      }
      return actionNode;
    }

    return getReviewButtons().find((node) => {
      const row = node.closest && node.closest("ul.dataBody_td, tr");
      const rowText = normalizeText((row && row.textContent) || "");
      return rowText.includes("待批阅");
    }) || null;
  }

  function isPendingSubmissionStatus(statusText) {
    const text = normalizeText(statusText || "");
    return text.includes("待批") || text.includes("待批阅") || text.includes("未批");
  }

  function pickPendingSubmissionRecord(records) {
    return (Array.isArray(records) ? records : []).find((item) => {
      if (!safeText(item && item.url)) {
        return false;
      }
      return isPendingSubmissionStatus(item && item.status);
    }) || null;
  }

  function detectPageContext() {
    const courseAnchors = getCourseAnchors().length;
    const reviewButtons = getReviewButtons().length;
    const homeworkRows = getHomeworkRows().length;
    const submissionRows = document.querySelectorAll("ul.dataBody_td").length;
    const pageText = normalizeText((document.body && document.body.innerText) || "");
    const pageTitle = normalizeText(document.title || "");
    const hasSubmissionShell =
      !!document.querySelector("#page") ||
      pageText.includes("学号/工号") ||
      pageText.includes("按人批阅") ||
      pageText.includes("批阅列表");
    const isDeletedHomeworkPage =
      pageTitle.includes("提示") &&
      pageText.includes("作业已删除") &&
      !hasSubmissionShell;
    const isNoticePage =
      !hasSubmissionShell &&
      (pageTitle.includes("温馨提示") ||
        pageText.includes("您长时间没有操作") ||
        pageText.includes("没有此页面访问权限"));
    return {
      hostname: window.location.hostname,
      href: window.location.href,
      title: document.title,
      course_anchor_count: courseAnchors,
      review_button_count: reviewButtons,
      homework_row_count: homeworkRows,
      submission_block_count: submissionRows,
      is_deleted_homework_page: isDeletedHomeworkPage,
      is_notice_page: isNoticePage,
      can_extract_courses: courseAnchors > 0,
      can_extract_homeworks: reviewButtons > 0 || homeworkRows > 0 || !!findHomeworkTabNode(),
      can_extract_submissions: submissionRows > 0,
    };
  }

  function summarizeContext(context) {
    const supported = [];
    if (context.can_extract_courses) {
      supported.push("课程");
    }
    if (context.can_extract_homeworks) {
      supported.push("作业");
    }
    if (context.can_extract_submissions) {
      supported.push("提交");
    }
    return supported.length
      ? `当前页面可处理：${supported.join("、")}`
      : "当前页面没有识别到支持的超星模块";
  }

  function extractCourses() {
    const records = getCourseAnchors().map((anchor) => {
      const entryNode = getCourseEntryNode(anchor);
      const directUrl =
        extractUrlFromAction(entryNode) ||
        resolveUrl(
          (entryNode && (entryNode.getAttribute("href") || entryNode.getAttribute("data-url"))) ||
            anchor.getAttribute("href") ||
            anchor.getAttribute("data-url") ||
            ""
        );
      const nodeIds = extractIdsFromNode(anchor);
      const urlIds = extractIdsFromUrl(directUrl);
      const ids = {
        course_id: nodeIds.course_id || urlIds.course_id,
        class_id: nodeIds.class_id || urlIds.class_id,
        work_id: nodeIds.work_id || urlIds.work_id,
        workAnswerId: nodeIds.workAnswerId || urlIds.workAnswerId,
        cpi: nodeIds.cpi || urlIds.cpi,
      };
      const courseName = getCourseNameFromNode(anchor);
      let url = directUrl;
      if (!url && ids.course_id && ids.class_id) {
        const params = new URLSearchParams();
        params.set("courseid", ids.course_id);
        params.set("clazzid", ids.class_id);
        if (ids.cpi) {
          params.set("cpi", ids.cpi);
        }
        url = resolveUrl(`/mycourse/studentcourse?${params.toString()}`);
      }

      return {
        course_name: courseName,
        title: courseName,
        course_id: ids.course_id,
        class_id: ids.class_id,
        url,
      };
    });
    return uniqueBy(
      records.filter((item) => item.course_name && (item.url || (item.course_id && item.class_id))),
      (item) => `${item.course_id || ""}_${item.class_id || ""}_${item.url || item.course_name}`
    );
  }

  function findHomeworkTabNode() {
    const candidates = Array.from(document.querySelectorAll("span.nav_content, a, button, li, div"));
    return (
      candidates.find((node) => isVisible(node) && normalizeText(node.textContent).includes("作业")) || null
    );
  }

  async function ensureHomeworkTabVisible() {
    if (getReviewButtons().length > 0 || getHomeworkRows().length > 0) {
      return false;
    }
    const tabNode = findHomeworkTabNode();
    if (!tabNode) {
      return false;
    }
    dispatchClick(tabNode);
    await sleep(1200);
    return getReviewButtons().length > 0 || getHomeworkRows().length > 0;
  }

  function parseCount(rawText, regex) {
    const matched = normalizeText(rawText).match(regex);
    return matched ? safeText(matched[1]) : "";
  }

  function getHomeworkReviewClassId() {
    return (
      getInputValue(["#selectClassid", "input[name='selectClassid']"]) ||
      getInputValue(["#clazzid", "#classid", "#classId", "input[name='clazzid']", "input[name='classId']"]) ||
      "0"
    );
  }

  function getHomeworkActionNode(row) {
    if (!row) {
      return null;
    }

    return (
      row.querySelector("a.piyueBtn[href]") ||
      row.querySelector("a[href*='/work/mark']") ||
      row.querySelector(".wid15") ||
      row.querySelector("a[onclick*='viewWork']") ||
      row.querySelector(".list_li_tit") ||
      row.querySelector("a, button") ||
      row
    );
  }

  function parseHomeworkPageRecordsFromDocument(doc) {
    const pageIds = getPageIds();
    const rows = Array.from(doc.querySelectorAll(".taskList li[id^='work'], .taskList > ul > li"));
    const records = rows.map((row) => {
      const rowText = normalizeText(row.innerText || row.textContent || "");
      const rowItems = Array.from(row.querySelectorAll("li, td, span")).map((node) => normalizeText(node.textContent));
      const titleNode =
        row.querySelector(".list_li_tit, .taskTitle, .tit, .mark_title, .list_title") || row.firstElementChild || row;
      const actionNode = getHomeworkActionNode(row);
      const url = extractUrlFromAction(actionNode);
      const ids = extractIdsFromUrl(url);
      const homeworkName = normalizeText(titleNode.textContent || rowItems[0] || rowText.split("\n")[0] || "");
      const answerTime =
        normalizeText(
          (row.querySelector(".list_li_time span") && row.querySelector(".list_li_time span").textContent) || ""
        ).replace(/^作答时间[:：]\s*/, "") || parseCount(rowText, /作答时间[:：]?\s*([^\s].*?)(?:\s+\d+\s*待批|$)/);
      const className = normalizeText(
        (row.querySelector(".list_class") && row.querySelector(".list_class").textContent) || ""
      );

      let workId = ids.work_id;
      if (!workId && row.id && row.id.match(/work(\d+)/i)) {
        workId = row.id.match(/work(\d+)/i)[1];
      }
      if (!workId) {
        const titleOnclick = safeText((row.querySelector(".list_li_tit") || row).getAttribute("onclick"));
        const match = titleOnclick.match(/viewWork\(\s*['"][^'"]+['"]\s*,\s*['"]?(\d+)['"]?/i);
        if (match) {
          workId = match[1];
        }
      }
      if (!workId) {
        const actionHtml = row.innerHTML || "";
        const match = actionHtml.match(/(?:republish|deleteTask|mark)\s*\(\s*['"]?(\d+)['"]?/);
        if (match) workId = match[1];
      }

      return {
        course_id: pageIds.course_id,
        class_id: ids.class_id && ids.class_id !== "0" ? ids.class_id : pageIds.class_id,
        work_id: workId,
        homework_name: homeworkName,
        name: homeworkName,
        class_name: className,
        answer_time: answerTime,
        pending_count: parseCount(rowText, /(\d+)\s*待批/),
        submitted_count: parseCount(rowText, /(\d+)\s*已交/),
        unsubmitted_count: parseCount(rowText, /(\d+)\s*未交/),
        url:
          url ||
          (workId
            ? resolveUrl(
                `/mooc2-ans/work/mark?courseid=${pageIds.course_id}&clazzid=${getHomeworkReviewClassId()}&id=${workId}&cpi=${pageIds.cpi}`
              )
            : ""),
      };
    });

    return uniqueBy(
      records.filter((item) => item.homework_name && !item.homework_name.includes("下载中心位置指引查看详情")),
      (item) => item.work_id || item.url || item.homework_name
    );
  }

  async function fetchHomeworkListHtml(pageNum, pageSize) {
    const url = buildHomeworkListFetchUrl(pageNum, pageSize);
    if (!url) {
      throw new Error("未能构建作业列表地址");
    }
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`homework-list HTTP ${response.status}`);
    }
    return {
      url,
      html,
    };
  }

  async function fetchHomeworkPageRecords(payload) {
    const maxPages = Math.max(1, Number((payload && payload.maxPages) || 30));
    const pageSize = Math.max(
      1,
      Number((payload && payload.pageSize) || getInputValue(["#pageSize", "#prePageSize", "#initSize"]) || 12)
    );
    const allRecords = [];
    const seenKeys = new Set();

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
      const result = await fetchHomeworkListHtml(pageIndex, pageSize);
      const parser = new DOMParser();
      const doc = parser.parseFromString(String(result.html || ""), "text/html");
      const pageRecords = parseHomeworkPageRecordsFromDocument(doc);
      if (!pageRecords.length) {
        break;
      }

      let newCount = 0;
      pageRecords.forEach((record) => {
        const key = safeText(record.work_id || record.url || record.homework_name);
        if (key && seenKeys.has(key)) {
          return;
        }
        if (key) {
          seenKeys.add(key);
        }
        allRecords.push(record);
        newCount += 1;
      });

      if (newCount === 0 || pageRecords.length < pageSize) {
        break;
      }
    }

    return allRecords;
  }

  function extractHomeworkPageRecords() {
    return parseHomeworkPageRecordsFromDocument(document);
  }

  function getPaginationButton(targetPage) {
    // 首先在分页容器内搜索
    const paginationContainers = Array.from(
      document.querySelectorAll("#page, .pageDiv, .pagination, .paging, .pager, [class*='paginat']")
    ).filter(isVisible);
    
    const searchScopes = [...paginationContainers, document];
    
    for (const scope of searchScopes) {
      // 查找精确页码匹配
      const exactPage = Array.from(scope.querySelectorAll("a, button, span, li, div")).find((node) => {
        const text = normalizeText(node.textContent);
        const pageNum = String(targetPage);
        // 精确匹配数字或带有属性指示的页码
        return (
          (text === pageNum || text === `${pageNum}`) &&
          isVisible(node) &&
          !isDisabled(node)
        );
      });
      if (exactPage) {
        return exactPage;
      }
    }

    // 查找下一页按钮（多种表示方式）
    for (const scope of searchScopes) {
      const nextButton = Array.from(scope.querySelectorAll("a, button, span, li, div")).find((node) => {
        const text = normalizeText(node.textContent);
        const className = String(node.className || "").toLowerCase();
        const ariaLabel = String(node.getAttribute("aria-label") || "").toLowerCase();
        const title = String(node.getAttribute("title") || "").toLowerCase();
        
        return (
          isVisible(node) &&
          !isDisabled(node) &&
          (
            text.includes("下一页") ||
            text.includes(">>") ||
            text === ">" ||
            className.includes("next") ||
            className.includes("xl-nextpage") ||
            className.includes("pagination-next") ||
            ariaLabel.includes("next") ||
            title.includes("next")
          )
        );
      });
      if (nextButton) {
        return nextButton;
      }
    }
    
    return null;
  }

  async function collectPaginatedRecords(extractPageRecords, getKey, options) {
    const allRecords = [];
    const seenKeys = new Set();
    const seenSignatures = new Set();
    const paginate = !options || options.paginate !== false;
    const maxPages = Math.max(1, Number((options && options.maxPages) || 30));
    const waitMs = Math.max(300, Number((options && options.waitMs) || 1200));

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
      if (pageIndex > 1) {
        await sleep(waitMs);
      }

      const pageRecords = extractPageRecords();
      const signature = JSON.stringify(pageRecords.map((item) => getKey(item)).slice(0, 20));
      if (signature && seenSignatures.has(signature)) {
        break;
      }
      if (signature) {
        seenSignatures.add(signature);
      }

      for (const record of pageRecords) {
        const key = safeText(getKey(record));
        if (key && seenKeys.has(key)) {
          continue;
        }
        if (key) {
          seenKeys.add(key);
        }
        allRecords.push(record);
      }

      if (!paginate) {
        break;
      }

      const nextButton = getPaginationButton(pageIndex + 1);
      if (!nextButton) {
        break;
      }
      dispatchClick(nextButton);
    }

    return allRecords;
  }

  function getHomeworkTitle() {
    const titleNode =
      document.querySelector(".mark_title, .taskTitle, h1, h2, .showcontent h1, .top h2") || document.body;
    return normalizeText((titleNode && titleNode.textContent) || "");
  }

  function buildSubmissionListUrl(pageNum, pageSize) {
    const pageIds = getPageIds();
    const params = new URLSearchParams();
    const values = {
      courseid: pageIds.course_id,
      clazzid: pageIds.class_id,
      workid: pageIds.work_id,
      submit: getInputValue(["#submit", "input[name='submit']"]),
      status: getInputValue(["#status", "input[name='status']"]),
      groupId: getInputValue(["#groupId", "input[name='groupId']"]) || "0",
      cpi: pageIds.cpi,
      evaluation: getInputValue(["#evaluation", "input[name='evaluation']"]),
      sort: getInputValue(["#sort", "input[name='sort']"]) || "0",
      order: getInputValue(["#order", "input[name='order']"]) || "0",
      unEval: getInputValue(["#unEval", "input[name='unEval']"]),
      search: getInputValue(["#search", "input[name='search']"]),
      from: getInputValue(["#from", "input[name='from']"]),
      topicid: getInputValue(["#topicid", "input[name='topicid']"]),
      pages: String(Math.max(1, Number(pageNum) || 1)),
      size: String(Math.max(1, Number(pageSize) || 12)),
    };

    Object.entries(values).forEach(([key, value]) => {
      const normalized = safeText(value);
      if (normalized !== "") {
        params.set(key, normalized);
      }
    });

    return resolveUrl(`/mooc2-ans/work/mark-list?${params.toString()}`);
  }

  async function fetchSubmissionListHtml(pageNum, pageSize) {
    const url = buildSubmissionListUrl(pageNum, pageSize);
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`mark-list HTTP ${response.status}`);
    }
    return {
      url,
      html,
    };
  }

  function parseSubmissionListRecordsFromHtml(htmlText, pageUrl) {
    const pageIds = getPageIds();
    const homeworkName = getHomeworkTitle();
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(htmlText || ""), "text/html");
    const rows = Array.from(doc.querySelectorAll("ul.dataBody_td"));
    const records = rows.map((ul) => {
      const items = Array.from(ul.querySelectorAll("li"));
      const nameNode = ul.querySelector(".taskBody_name");
      const actionLi = items[8] || items[items.length - 1] || ul;
      const actionNode = actionLi.querySelector("a, button") || actionLi;
      const url = extractUrlFromAction(actionNode) || resolveUrl(pageUrl || "");
      const ids = extractIdsFromUrl(url);
      const studentName = normalizeText(
        (items[1] && items[1].textContent) ||
        (nameNode && nameNode.textContent) ||
        ""
      );

      return {
        course_id: pageIds.course_id,
        class_id: pageIds.class_id,
        work_id: ids.work_id || pageIds.work_id,
        answer_id: ids.workAnswerId || safeText(ul.getAttribute("id")),
        workAnswerId: ids.workAnswerId || safeText(ul.getAttribute("id")),
        homework_name: homeworkName,
        student_name: studentName,
        student_id: normalizeText((items[2] && items[2].textContent) || ""),
        submit_time: normalizeText((items[3] && items[3].textContent) || ""),
        ip_address: normalizeText((items[4] && items[4].textContent) || ""),
        status: normalizeText((items[5] && items[5].textContent) || ""),
        reviewer: normalizeText((items[6] && items[6].textContent) || ""),
        grade: normalizeText((items[7] && items[7].textContent) || ""),
        url,
      };
    });

    return uniqueBy(
      records.filter((item) => item.answer_id || item.student_name || item.url),
      (item) => item.answer_id || item.url || `${item.student_name}_${item.student_id}`
    );
  }

  async function fetchSubmissionPageRecords(payload) {
    const maxPages = Math.max(1, Number((payload && payload.maxPages) || 30));
    const pageSize = Math.max(
      1,
      Number((payload && payload.pageSize) || getInputValue(["#prePageSize", "#initSize"]) || 12)
    );
    const allRecords = [];
    const seenKeys = new Set();

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
      if (pageIndex > 1) {
        await sleep(Math.max(200, Number((payload && payload.waitMs) || 700)));
      }

      const result = await fetchSubmissionListHtml(pageIndex, pageSize);
      const pageRecords = parseSubmissionListRecordsFromHtml(result.html, result.url);
      if (!pageRecords.length) {
        break;
      }

      let newCount = 0;
      pageRecords.forEach((record) => {
        const key = safeText(record.answer_id || record.url || `${record.student_name}_${record.student_id}`);
        if (key && seenKeys.has(key)) {
          return;
        }
        if (key) {
          seenKeys.add(key);
        }
        allRecords.push(record);
        newCount += 1;
      });

      if (newCount === 0 || pageRecords.length < pageSize) {
        break;
      }
    }

    return allRecords;
  }

  function extractSubmissionPageRecords() {
    const pageIds = getPageIds();
    const homeworkName = getHomeworkTitle();
    const records = [];

    // 方式1：提取 ul.dataBody_td 结构（标准提交列表页面）
    const ulRows = Array.from(document.querySelectorAll("ul.dataBody_td"));
    if (ulRows.length > 0) {
      ulRows.forEach((ul) => {
        const items = Array.from(ul.querySelectorAll("li"));
        if (items.length < 2) return;
        
        const nameNode = ul.querySelector(".taskBody_name");
        const actionLi = items[8] || items[items.length - 1] || ul;
        const actionNode = actionLi.querySelector("a, button") || actionLi;
        const url = extractUrlFromAction(actionNode);
        const ids = extractIdsFromUrl(url);
        
        const studentName = normalizeText(
          (items[1] && items[1].textContent) || 
          (nameNode && nameNode.textContent) || 
          ""
        );
        
        const record = {
          course_id: pageIds.course_id,
          class_id: pageIds.class_id,
          work_id: ids.work_id || pageIds.work_id,
          answer_id: ids.workAnswerId,
          workAnswerId: ids.workAnswerId,
          homework_name: homeworkName,
          student_name: studentName,
          student_id: normalizeText((items[2] && items[2].textContent) || ""),
          submit_time: normalizeText((items[3] && items[3].textContent) || ""),
          ip_address: normalizeText((items[4] && items[4].textContent) || ""),
          status: normalizeText((items[5] && items[5].textContent) || ""),
          reviewer: normalizeText((items[6] && items[6].textContent) || ""),
          grade: normalizeText((items[7] && items[7].textContent) || ""),
          url,
        };
        
        if (record.student_name || record.student_id || record.url) {
          records.push(record);
        }
      });
      
      if (records.length > 0) {
        return uniqueBy(
          records,
          (item) => item.answer_id || item.url || `${item.student_name}_${item.student_id}`
        );
      }
    }

    // 方式2：提取 table tr 结构（兼容其他页面结构）
    const tableRows = Array.from(document.querySelectorAll("tr"));
    const fallback = [];
    
    tableRows.forEach((row) => {
      const tds = Array.from(row.querySelectorAll("td"));
      if (tds.length < 5) return;
      
      const actionNode =
        row.querySelector("a[href*='review'], a[href*='mark'], a[onclick*='mark'], button") || row;
      const url = extractUrlFromAction(actionNode);
      
      if (!url) return;
      
      const ids = extractIdsFromUrl(url);
      const studentName = normalizeText((tds[1] && tds[1].textContent) || "");
      
      fallback.push({
        course_id: pageIds.course_id,
        class_id: pageIds.class_id,
        work_id: ids.work_id || pageIds.work_id,
        answer_id: ids.workAnswerId,
        workAnswerId: ids.workAnswerId,
        homework_name: homeworkName,
        student_name: studentName,
        student_id: normalizeText((tds[2] && tds[2].textContent) || ""),
        submit_time: normalizeText((tds[3] && tds[3].textContent) || ""),
        ip_address: normalizeText((tds[4] && tds[4].textContent) || ""),
        status: normalizeText((tds[5] && tds[5].textContent) || "待批阅"),
        reviewer: normalizeText((tds[6] && tds[6].textContent) || ""),
        grade: normalizeText((tds[7] && tds[7].textContent) || ""),
        url,
      });
    });
    
    if (fallback.length > 0) {
      return uniqueBy(
        fallback,
        (item) => item.answer_id || item.url || `${item.student_name}_${item.student_id}`
      );
    }

    return [];
  }

  function extractNumber(value) {
    const text = safeText(value).replace(/，/g, ".").replace(/,/g, ".");
    if (!text) {
      return null;
    }
    const matches = text.match(/\d+(?:\.\d+)?/g);
    if (!matches || !matches.length) {
      return null;
    }
    const number = Number(matches[matches.length - 1]);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function readInputNumber(element) {
    if (!element) {
      return null;
    }
    const liveValue = extractNumber(element.value);
    if (liveValue !== null) {
      return liveValue;
    }
    return extractNumber(element.getAttribute("value"));
  }

  function getQuestionInternalId(container) {
    const ridElement = container.querySelector("input[rid]");
    if (ridElement) {
      const rid = safeText(ridElement.getAttribute("rid"));
      if (/^\d+$/.test(rid)) {
        return rid;
      }
    }
    const idPrefixes = ["questionStem_", "stuanswer_", "correctanswer_", "type_", "typeName_"];
    for (const prefix of idPrefixes) {
      const node = container.querySelector(`[id^="${prefix}"]`);
      if (!node || !node.id) {
        continue;
      }
      const matched = node.id.match(/(\d{4,})$/);
      if (matched) {
        return matched[1];
      }
    }
    const nameElement = container.querySelector("input[name^='score'], input[name^='qscore'], input[name^='perScore']");
    if (nameElement) {
      const matched = safeText(nameElement.getAttribute("name")).match(/(\d{4,})$/);
      if (matched) {
        return matched[1];
      }
    }
    return "";
  }

  function extractQuestionScore(container, titleNode) {
    const scoreCandidates = [];
    const pushScore = (value) => {
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        scoreCandidates.push(value);
      }
    };

    const qid = getQuestionInternalId(container);
    if (qid) {
      pushScore(readInputNumber(document.querySelector(`input[name="qscore${qid}"]`)));
      pushScore(readInputNumber(document.querySelector(`input[name="perScore${qid}"]`)));
      pushScore(readInputNumber(document.querySelector(`#fullScore${qid}`)));
      pushScore(readInputNumber(document.querySelector(`#moreScore${qid}`)));
      const stuAnswerBlock = document.querySelector(`#stuanswer_${qid}`);
      if (stuAnswerBlock) {
        pushScore(extractNumber(stuAnswerBlock.getAttribute("data2")));
      }
    }

    pushScore(readInputNumber(container.querySelector("input[name^='qscore']")));
    pushScore(readInputNumber(container.querySelector("input[name^='perScore']")));
    pushScore(readInputNumber(container.querySelector("input[id^='fullScore']")));
    pushScore(readInputNumber(container.querySelector("input[id^='moreScore']")));

    const localData2Node = container.querySelector(".mark_answer_key [data2]");
    if (localData2Node) {
      pushScore(extractNumber(localData2Node.getAttribute("data2")));
    }

    if (titleNode) {
      const titleText = getSafeText(titleNode).replace(/\u00a0/g, " ");
      const titleScoreMatch = titleText.match(/[（(][^）)]*?(\d+(?:\.\d+)?)\s*分[^）)]*[）)]/);
      if (titleScoreMatch) {
        pushScore(extractNumber(titleScoreMatch[1]));
      }
    }

    const scoreInput = container.querySelector("input[name^='score']:not([type='hidden'])");
    if (scoreInput) {
      pushScore(readInputNumber(scoreInput));
      pushScore(extractNumber(scoreInput.getAttribute("placeholder")));
    }

    return scoreCandidates.length ? scoreCandidates[0] : null;
  }

  function md5cycle(x, k) {
    let a = x[0];
    let b = x[1];
    let c = x[2];
    let d = x[3];

    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);

    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }

  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }

  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }

  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }

  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }

  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }

  function md51(s) {
    const txt = unescape(encodeURIComponent(s));
    const n = txt.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk(txt.substring(i - 64, i)));
    }
    const tail = new Array(16).fill(0);
    const remaining = txt.substring(i - 64);
    for (i = 0; i < remaining.length; i += 1) {
      tail[i >> 2] |= remaining.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (let j = 0; j < 16; j += 1) {
        tail[j] = 0;
      }
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }

  function md5blk(s) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] =
        s.charCodeAt(i) +
        (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) +
        (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  const hexChr = "0123456789abcdef".split("");

  function rhex(n) {
    let s = "";
    for (let j = 0; j < 4; j += 1) {
      s += hexChr[(n >> (j * 8 + 4)) & 0x0f] + hexChr[(n >> (j * 8)) & 0x0f];
    }
    return s;
  }

  function hex(x) {
    return x.map(rhex).join("");
  }

  function md5(text) {
    return hex(md51(String(text || "")));
  }

  function add32(a, b) {
    return (a + b) & 0xffffffff;
  }

  function findAnswerBlockByLabel(container, labelText) {
    const dtNodes = Array.from(container.querySelectorAll("dt"));
    for (const dt of dtNodes) {
      if (normalizeText(dt.textContent).includes(labelText)) {
        return dt.nextElementSibling;
      }
    }
    return null;
  }

  function isObjectiveQuestionText(text) {
    return text.includes("单选题") || text.includes("多选题") || text.includes("判断题");
  }

  function getQuestionTitleNode(container) {
    return (
      container.querySelector(".mark_name, .Py-m1-title, h3, .Bt, .tit") ||
      container.querySelector("[class*='title']")
    );
  }

  function createQuestionRecord(container, pageIds, sourceUrl) {
    const titleNode = getQuestionTitleNode(container);
    if (!titleNode) {
      return null;
    }
    const contentNode = titleNode.querySelector(".hiddenTitle") || titleNode;
    const qText = normalizeMultilineText(getSafeText(contentNode));
    if (!qText || isObjectiveQuestionText(qText)) {
      return null;
    }

    const qImages = Array.from(titleNode.querySelectorAll("img"))
      .map((img) => getImageSrc(img))
      .filter(isValidImage)
      .map(resolveUrl);

    let studentAnswerBlock = container.querySelector(".stuAnswerWords");
    if (!studentAnswerBlock) {
      studentAnswerBlock = findAnswerBlockByLabel(container, "学生答案");
    }

    const studentAnswerText = normalizeMultilineText(
      getSafeText(studentAnswerBlock)
        .replace(/^学生答案[:：]?\s*/, "")
        .replace(/^学生答案\s*/, "")
    );
    const studentAnswerImages = Array.from(
      (studentAnswerBlock && studentAnswerBlock.querySelectorAll("img")) || []
    )
      .map((img) => getImageSrc(img))
      .filter(isValidImage)
      .map(resolveUrl);

    const correctAnswerBlock = findAnswerBlockByLabel(container, "正确答案");
    const correctText = normalizeMultilineText(
      getSafeText(correctAnswerBlock)
        .replace(/^正确答案[:：]?\s*/, "")
        .replace(/^正确答案\s*/, "")
    );
    const correctImages = Array.from((correctAnswerBlock && correctAnswerBlock.querySelectorAll("img")) || [])
      .map((img) => getImageSrc(img))
      .filter(isValidImage)
      .map(resolveUrl);

    const questionScore = extractQuestionScore(container, titleNode);
    const questionHash = md5(`${qText.trim()}_${qImages.join("|")}`);

    return {
      course_id: pageIds.course_id,
      class_id: pageIds.class_id,
      homework_id: pageIds.work_id,
      work_id: pageIds.work_id,
      workAnswerId: pageIds.workAnswerId,
      answer_id: pageIds.workAnswerId,
      cpi: pageIds.cpi,
      source_url: sourceUrl,
      q_content: qText,
      q_images: qImages,
      correct_image: correctImages[0] || "",
      correct_images: correctImages,
      correct_text: correctText,
      student_answer_text: studentAnswerText,
      student_answer_images: studentAnswerImages,
      question_score: questionScore,
      question_hash_id: questionHash,
    };
  }

  function countLikelySubjectiveQuestions() {
    return getQuestionContainers().filter((container) => !!getQuestionTitleNode(container)).length;
  }

  function getReviewQuestionCacheKey() {
    return `${window.location.href}__${getQuestionContainers().length}`;
  }

  async function extractQuestionRecordsAsync() {
    const pageIds = getPageIds();
    const sourceUrl = window.location.href;
    const records = [];
    const containers = getQuestionContainers();

    for (let index = 0; index < containers.length; index += 1) {
      const record = createQuestionRecord(containers[index], pageIds, sourceUrl);
      if (record) {
        records.push(record);
      }
      if (index > 0 && index % 2 === 0) {
        await sleep(0);
      }
    }

    return uniqueBy(records, (item) => `${item.workAnswerId}_${item.question_hash_id}`);
  }

  function extractQuestionRecords() {
    const pageIds = getPageIds();
    const sourceUrl = window.location.href;
    const records = [];
    getQuestionContainers().forEach((container) => {
      const record = createQuestionRecord(container, pageIds, sourceUrl);
      if (record) {
        records.push(record);
      }
    });
    return uniqueBy(records, (item) => `${item.workAnswerId}_${item.question_hash_id}`);
  }

  function injectBridge() {
    if (bridgeInjected || window.__cxEdgeContentBridgeInjected) {
      return;
    }
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.dataset.cxEdgeBridge = "1";
    script.onload = () => {
      script.remove();
    };
    (document.head || document.documentElement || document.body).appendChild(script);
    bridgeInjected = true;
    window.__cxEdgeContentBridgeInjected = true;
  }

  function callBridge(action, payload, timeoutMs) {
    injectBridge();
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const timer = window.setTimeout(() => {
        window.removeEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
        reject(new Error("页面桥接脚本响应超时"));
      }, timeoutMs || BRIDGE_TIMEOUT_MS);

      function onResponse(event) {
        const detail = event && event.detail ? event.detail : {};
        if (detail.id !== id) {
          return;
        }
        window.clearTimeout(timer);
        window.removeEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
        if (!detail.ok) {
          reject(new Error(detail.error || "页面桥接脚本执行失败"));
          return;
        }
        resolve(detail.result);
      }

      window.addEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
      window.dispatchEvent(
        new CustomEvent(BRIDGE_REQUEST_EVENT, {
          detail: {
            id,
            action,
            payload: payload || {},
          },
        })
      );
    });
  }

  const REVIEW_AI_STATE = {
    panelHost: null,
    panelRoot: null,
    panelElements: null,
    running: false,
    cancelled: false,
    mountedForHref: "",
    lastContextSummary: "",
    summaryRequestId: 0,
    cachedQuestionKey: "",
    cachedQuestions: [],
    refreshTimer: null,
    persistTimer: null,
    autoLoopLastStartedKey: "",
    settingsHydrated: false,
  };

  const REVIEW_AUTO_LOOP_SESSION_KEY = "__cx_review_auto_loop__";
  const LEGACY_API_PROVIDER_PRESETS = [
    {
      id: "moonshot",
      label: "Moonshot / Kimi",
      endpoint: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
      models: [
        { label: "moonshot-v1-8k", value: "moonshot-v1-8k" },
        { label: "moonshot-v1-32k", value: "moonshot-v1-32k" },
        { label: "moonshot-v1-128k", value: "moonshot-v1-128k" },
        { label: "moonshot-v1-8k-vision-preview", value: "moonshot-v1-8k-vision-preview" },
        { label: "Kimi-K2.6", value: "kimi-k2.6" },
        { label: "Kimi-K2.5", value: "kimi-k2.5" },
        { label: "Kimi-K2-0905", value: "kimi-k2-0905-preview" },
        { label: "Kimi-K2-Thinking", value: "kimi-k2-thinking" },
      ],
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/v1",
      model: "DeepSeek-V3.1",
      models: [
        { label: "DeepSeek-V3.1", value: "DeepSeek-V3.1" },
        { label: "DeepSeek-V3.1-Terminus", value: "DeepSeek-V3.1-Terminus" },
        { label: "deepseek-chat", value: "deepseek-chat" },
        { label: "deepseek-reasoner", value: "deepseek-reasoner" },
      ],
    },
    {
      id: "openai",
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5.4",
      models: [
        { label: "GPT-5.4", value: "gpt-5.4" },
        { label: "GPT-5.3-Codex", value: "gpt-5.3-codex" },
        { label: "GPT-5.2", value: "gpt-5.2" },
        { label: "GPT-5.1", value: "gpt-5.1" },
        { label: "GPT-4.1", value: "gpt-4.1" },
        { label: "GPT-4.1-mini", value: "gpt-4.1-mini" },
        { label: "o4-mini", value: "o4-mini" },
      ],
    },
    {
      id: "gemini",
      label: "Google Gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-2.5-flash",
      models: [
        { label: "Gemini-3.1-Pro-Preview", value: "gemini-3.1-pro-preview" },
        { label: "Gemini-3-Flash-Preview", value: "gemini-3-flash-preview" },
        { label: "Gemini-2.5-Flash", value: "gemini-2.5-flash" },
        { label: "Gemini-2.5-Pro", value: "gemini-2.5-pro" },
      ],
    },
    {
      id: "zhipu",
      label: "智谱 GLM",
      endpoint: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.1",
      models: [
        { label: "GLM-5.1", value: "glm-5.1" },
        { label: "GLM-5V-Turbo", value: "glm-5v-turbo" },
        { label: "GLM-5", value: "glm-5" },
        { label: "GLM-4.7", value: "glm-4.7" },
        { label: "GLM-4.5-Air", value: "glm-4.5-air" },
      ],
    },
    {
      id: "minimax",
      label: "MiniMax",
      endpoint: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2.7",
      models: [
        { label: "MiniMax-M2.7", value: "MiniMax-M2.7" },
        { label: "MiniMax-M2.5", value: "MiniMax-M2.5" },
        { label: "MiniMax-M2.5-highspeed", value: "MiniMax-M2.5-highspeed" },
        { label: "MiniMax-Text-01", value: "MiniMax-Text-01" },
      ],
    },
    {
      id: "doubao",
      label: "火山引擎 / 豆包",
      endpoint: "https://operator.las.cn-beijing.volces.com/api/v1",
      model: "Doubao-Seed-2.0-Code",
      models: [
        { label: "Doubao-Seed-2.0-Code", value: "Doubao-Seed-2.0-Code" },
        { label: "Doubao-Seed-1.8", value: "Doubao-Seed-1.8" },
        { label: "Doubao-Seed-Code", value: "Doubao-Seed-Code" },
        { label: "Doubao-Pro-32k", value: "Doubao-Pro-32k" },
      ],
    },
    {
      id: "qwen",
      label: "阿里千问 / 百炼",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "Qwen3.5-Plus",
      models: [
        { label: "Qwen3.5-Plus", value: "Qwen3.5-Plus" },
        { label: "Qwen3-Coder-Next", value: "Qwen3-Coder-Next" },
        { label: "qwen-plus", value: "qwen-plus" },
        { label: "qwen-turbo", value: "qwen-turbo" },
        { label: "qwen-max", value: "qwen-max" },
      ],
    },
    {
      id: "custom",
      label: "自定义",
      endpoint: "",
      model: "",
      models: [],
    },
  ];

  function getDefaultReviewSettings() {
    return getSharedDefaultReviewSettings();
  }

  function getProviderPreset(providerId) {
    return getSharedProviderPreset(providerId);
  }

  function inferProviderFromEndpoint(endpoint) {
    return inferSharedProviderFromEndpoint(endpoint);
  }

  function getProviderModels(providerId) {
    return getSharedProviderModels(providerId);
  }

  function storageLocalGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result || {});
      });
    });
  }

  function storageLocalSet(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(data, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  async function getReviewBatchQueue() {
    try {
      const stored = await storageLocalGet([REVIEW_BATCH_QUEUE_STORAGE_KEY]);
      const queue = stored && stored[REVIEW_BATCH_QUEUE_STORAGE_KEY];
      if (!queue || !queue.active || !Array.isArray(queue.urls) || !queue.urls.length) {
        return null;
      }
      return {
        active: true,
        urls: queue.urls.map((item) => safeText(item)).filter(Boolean),
        currentIndex: Math.max(0, Number(queue.currentIndex) || 0),
        startedAt: safeText(queue.startedAt),
      };
    } catch (error) {
      return null;
    }
  }

  async function saveReviewBatchQueue(queue) {
    await storageLocalSet({
      [REVIEW_BATCH_QUEUE_STORAGE_KEY]: queue,
    });
  }

  async function clearReviewBatchQueue() {
    await storageLocalSet({
      [REVIEW_BATCH_QUEUE_STORAGE_KEY]: null,
    });
  }

  function getAutoLoopState() {
    try {
      const raw = window.sessionStorage.getItem(REVIEW_AUTO_LOOP_SESSION_KEY);
      if (!raw) {
        return { active: false };
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return { active: false };
      }
      return {
        active: !!parsed.active,
        startedAt: safeText(parsed.startedAt),
      };
    } catch (error) {
      return { active: false };
    }
  }

  function setAutoLoopState(active) {
    try {
      if (!active) {
        window.sessionStorage.removeItem(REVIEW_AUTO_LOOP_SESSION_KEY);
        return;
      }
      window.sessionStorage.setItem(
        REVIEW_AUTO_LOOP_SESSION_KEY,
        JSON.stringify({
          active: true,
          startedAt: new Date().toISOString(),
        })
      );
    } catch (error) {
      // Ignore session storage failures.
    }
  }

  function callBackgroundMessage(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload: payload || {} }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!response || response.ok === false) {
          reject(new Error((response && response.error) || "后台处理失败"));
          return;
        }
        resolve(response);
      });
    });
  }

  async function fetchStoredReviewSettings() {
    const response = await callBackgroundMessage("getReviewSettings", {});
    return Object.assign({}, getDefaultReviewSettings(), response.settings || {});
  }

  async function persistStoredReviewSettings(settings) {
    const response = await callBackgroundMessage("saveReviewSettings", settings || {});
    return Object.assign({}, getDefaultReviewSettings(), response.settings || {});
  }

  async function ensureReviewEndpointPermission(endpoint, requestIfMissing) {
    const response = await callBackgroundMessage("ensureAiEndpointPermission", {
      endpoint,
      requestIfMissing: !!requestIfMissing,
    });
    return response.result || { ok: true };
  }

  function extractJsonObject(text) {
    const trimmed = safeText(text);
    if (!trimmed) {
      throw new Error("AI 没有返回内容");
    }

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Fall through.
    }

    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const objectText = candidate.slice(firstBrace, lastBrace + 1);
      return JSON.parse(objectText);
    }

    throw new Error("AI 返回内容不是合法 JSON");
  }

  function normalizeAiReviewResult(aiContent, question) {
    const parsed = extractJsonObject(aiContent);
    const rawScore =
      parsed.grading_score ??
      parsed.score ??
      parsed.final_score ??
      parsed.total_score ??
      parsed.points;
    const rawComment =
      parsed.grading_comment ??
      parsed.comment ??
      parsed.feedback ??
      parsed.reason ??
      parsed.summary;

    let score = extractNumber(rawScore);
    if (score === null) {
      throw new Error("AI 返回里缺少 grading_score");
    }

    const fullScore = extractNumber(question.question_score);
    if (fullScore !== null && Number.isFinite(fullScore) && fullScore >= 0) {
      score = Math.max(0, Math.min(score, fullScore));
    } else {
      score = Math.max(0, Math.min(score, 100));
    }

    const comment = safeText(rawComment) || "AI 已完成批阅";
    return {
      grading_score: score,
      grading_comment: comment,
      raw: parsed,
    };
  }

  function formatPromptQuestion(question, index, total) {
    const qImages = Array.isArray(question.q_images) ? question.q_images : [];
    const answerImages = Array.isArray(question.student_answer_images) ? question.student_answer_images : [];
    const correctImages = Array.isArray(question.correct_images) ? question.correct_images : [];
    const fullScore = extractNumber(question.question_score);
    const fullScoreText = fullScore === null ? "未知" : String(fullScore);

    return [
      `当前是第 ${index + 1}/${total} 题。`,
      `题目满分: ${fullScoreText}`,
      "题目内容:",
      question.q_content || "",
      qImages.length ? `题目图片数量: ${qImages.length}（当前未传图片二进制，只提供文本上下文）` : "题目图片数量: 0",
      "学生答案:",
      question.student_answer_text || "",
      answerImages.length
        ? `学生答案图片数量: ${answerImages.length}（当前未传图片二进制）`
        : "学生答案图片数量: 0",
      "参考答案:",
      question.correct_text || "",
      correctImages.length
        ? `参考答案图片数量: ${correctImages.length}（当前未传图片二进制）`
        : "参考答案图片数量: 0",
    ].join("\n");
  }

  function buildAiMessages(question, config, index, total) {
    const fullScore = extractNumber(question.question_score);
    const scoreRule =
      fullScore === null
        ? "如果页面满分无法确定，请按 0-100 给出评分。"
        : `评分必须在 0 到 ${fullScore} 之间，可保留 1 位小数。`;

    const systemPrompt = [
      "你是一个超星教师批阅助手，负责批改主观题。",
      "请根据题目、学生答案、参考答案给出分数和简洁评语。",
      scoreRule,
      "只返回 JSON，不要输出 Markdown。",
      'JSON 格式固定为 {"grading_score": number, "grading_comment": string}.',
      "评语使用中文，简洁明确，适合直接填写到题目批语中。",
    ]
      .concat(config.extraPrompt ? [config.extraPrompt] : [])
      .join("\n");

    return [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: formatPromptQuestion(question, index, total),
      },
    ];
  }

  function getReviewPanelElements() {
    return REVIEW_AI_STATE.panelElements;
  }

  function switchReviewPanelPage(pageName) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    const target = safeText(pageName) || "home";
    Object.entries(elements.views || {}).forEach(([name, node]) => {
      if (!node) {
        return;
      }
      const active = name === target;
      node.hidden = !active;
    });
    Object.entries(elements.navTabs || {}).forEach(([name, node]) => {
      if (!node) {
        return;
      }
      node.dataset.active = name === target ? "true" : "false";
    });
  }

  function setReviewApiTestStatus(text, tone) {
    const elements = getReviewPanelElements();
    if (!elements || !elements.testStatus) {
      return;
    }
    elements.testStatus.textContent = text;
    elements.testStatus.dataset.tone = tone || "neutral";
  }

  function collectPersistedReviewSettings() {
    const elements = getReviewPanelElements();
    const defaults = getDefaultReviewSettings();
    if (!elements) {
      return defaults;
    }
    const endpoint = safeText(elements.endpoint.value);
    const selectedModelValue = safeText(elements.modelSelect.value);
    const customModelValue = safeText(elements.model.value);
    return {
      provider: safeText(elements.provider.value) || inferProviderFromEndpoint(endpoint),
      endpoint,
      apiKey: safeText(elements.apiKey.value),
      rememberApiKey: !!elements.rememberApiKey.checked,
      model:
        selectedModelValue && selectedModelValue !== "__custom__"
          ? selectedModelValue
          : customModelValue,
      timeoutSeconds: Number(elements.timeout.value),
      extraPrompt: safeText(elements.extraPrompt.value),
      autoFill: !!elements.autoFill.checked,
      autoSubmit: !!elements.autoSubmit.checked,
      submitMode: safeText(elements.submitMode.value) || "current",
    };
  }

  function syncModelControls(modelValue) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    const value = safeText(modelValue);
    const options = Array.from(elements.modelSelect.options || []);
    const matched = options.find((option) => option.value === value);
    if (matched) {
      elements.modelSelect.value = value;
      elements.model.value = value;
      elements.model.hidden = true;
      elements.model.placeholder = "";
      return;
    }
    elements.modelSelect.value = "__custom__";
    elements.model.hidden = false;
    elements.model.value = value;
    elements.model.placeholder = "请输入自定义模型名";
  }

  function populateModelOptions(providerId, preferredModel) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    const models = getProviderModels(providerId);
    elements.modelSelect.innerHTML = "";

    models.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      elements.modelSelect.appendChild(option);
    });

    const customOption = document.createElement("option");
    customOption.value = "__custom__";
    customOption.textContent = "自定义模型";
    elements.modelSelect.appendChild(customOption);

    syncModelControls(preferredModel || (models[0] && models[0].value) || "");
  }

  function applyReviewSettingsToPanel(settings) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    const merged = Object.assign({}, getDefaultReviewSettings(), settings || {});
    const providerValue =
      safeText(merged.provider) || inferProviderFromEndpoint(merged.endpoint) || "custom";
    elements.provider.value = providerValue;
    elements.endpoint.value = safeText(merged.endpoint);
    elements.apiKey.value = safeText(merged.apiKey);
    elements.rememberApiKey.checked = !!merged.rememberApiKey;
    populateModelOptions(providerValue, safeText(merged.model));
    elements.timeout.value = String(Number(merged.timeoutSeconds) || 20);
    elements.extraPrompt.value = safeText(merged.extraPrompt);
    elements.autoFill.checked = merged.autoFill !== false;
    elements.autoSubmit.checked = !!merged.autoSubmit;
    elements.submitMode.value = safeText(merged.submitMode) || "current";
    elements.submitMode.disabled = REVIEW_AI_STATE.running || !elements.autoSubmit.checked;
    setReviewApiTestStatus("尚未测试连接", "neutral");
  }

  async function hydrateReviewPanelSettings() {
    try {
      applyReviewSettingsToPanel(await fetchStoredReviewSettings());
    } catch (error) {
      appendReviewPanelLog(`读取面板设置失败：${error.message}`, "warn");
      applyReviewSettingsToPanel(getDefaultReviewSettings());
    } finally {
      REVIEW_AI_STATE.settingsHydrated = true;
    }
  }

  async function getStoredReviewSettings() {
    try {
      return await fetchStoredReviewSettings();
    } catch (error) {
      return getDefaultReviewSettings();
    }
  }

  function schedulePersistReviewSettings() {
    if (REVIEW_AI_STATE.persistTimer) {
      window.clearTimeout(REVIEW_AI_STATE.persistTimer);
    }
    REVIEW_AI_STATE.persistTimer = window.setTimeout(async () => {
      REVIEW_AI_STATE.persistTimer = null;
      try {
        await persistStoredReviewSettings(collectPersistedReviewSettings());
      } catch (error) {
        appendReviewPanelLog(`保存面板设置失败：${error.message}`, "warn");
      }
    }, 250);
  }

  function applyProviderPreset(providerId) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    const preset = getProviderPreset(providerId);
    elements.provider.value = preset.id;
    if (preset.endpoint) {
      elements.endpoint.value = preset.endpoint;
    }
    populateModelOptions(preset.id, preset.model);
    setReviewApiTestStatus("已切换预设，请点击测试连接。", "neutral");
    schedulePersistReviewSettings();
  }

  async function testReviewApiConnection() {
    const elements = getReviewPanelElements();
    if (!elements) {
      throw new Error("面板尚未初始化");
    }
    const config = readReviewPanelConfig();
    if (!config.endpoint) {
      throw new Error("请先填写 API 地址");
    }
    if (!config.apiKey) {
      throw new Error("请先填写 API Key");
    }
    if (!config.model) {
      throw new Error("请先填写模型名");
    }

    setReviewApiTestStatus("测试中...", "running");
    await ensureReviewEndpointPermission(config.endpoint, true);
    const response = await callBackgroundMessage("testAiEndpoint", {
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: Math.max(5000, Math.round((Number(config.timeoutSeconds) || 20) * 1000)),
    });
    const contentSnippet = safeText(response && response.content).slice(0, 40);
    setReviewApiTestStatus(
      contentSnippet ? `连接成功：${contentSnippet}` : "连接成功，可正常调用",
      "success"
    );
    appendReviewPanelLog("API 测试成功，可正常访问当前模型。", "success");
    return response;
  }

  function setReviewPanelBadge(text, tone) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    elements.badge.textContent = text;
    elements.badge.dataset.tone = tone || "neutral";
  }

  function appendReviewPanelLog(message, tone) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    const item = document.createElement("div");
    item.className = "log-item";
    item.dataset.tone = tone || "info";
    item.textContent = message;
    elements.log.prepend(item);
  }

  function clearReviewTaskList() {
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    elements.taskList.innerHTML = "";
  }

  function createTaskRow(question, index) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return null;
    }
    const row = document.createElement("div");
    row.className = "task-row";
    row.dataset.state = "pending";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = `第 ${index + 1} 题`;

    const snippet = document.createElement("div");
    snippet.className = "task-snippet";
    snippet.textContent = safeText(question.q_content || "").slice(0, 90) || "(题干为空)";

    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `满分: ${extractNumber(question.question_score) ?? "未知"}`;

    const result = document.createElement("div");
    result.className = "task-result";
    result.textContent = "等待处理";

    row.appendChild(title);
    row.appendChild(snippet);
    row.appendChild(meta);
    row.appendChild(result);
    elements.taskList.appendChild(row);
    return {
      row,
      title,
      snippet,
      meta,
      result,
    };
  }

  function updateTaskRow(taskRefs, state, text) {
    if (!taskRefs || !taskRefs.row) {
      return;
    }
    taskRefs.row.dataset.state = state || "pending";
    taskRefs.result.textContent = text || "";
  }

  function readReviewPanelConfig() {
    const elements = getReviewPanelElements();
    if (!elements) {
      throw new Error("面板尚未初始化");
    }
    return {
      endpoint: safeText(elements.endpoint.value),
      apiKey: safeText(elements.apiKey.value),
      rememberApiKey: !!elements.rememberApiKey.checked,
      model:
        safeText(elements.modelSelect.value) && safeText(elements.modelSelect.value) !== "__custom__"
          ? safeText(elements.modelSelect.value)
          : safeText(elements.model.value),
      timeoutSeconds: Number(elements.timeout.value),
      extraPrompt: safeText(elements.extraPrompt.value),
      autoFill: !!elements.autoFill.checked,
      autoSubmit: !!elements.autoSubmit.checked,
      submitMode: safeText(elements.submitMode.value) || "current",
    };
  }

  function setReviewPanelRunning(running) {
    REVIEW_AI_STATE.running = running;
    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }
    elements.start.disabled = running;
    elements.stop.disabled = !running;
    elements.refresh.disabled = running;
    elements.provider.disabled = running;
    elements.modelSelect.disabled = running;
    elements.endpoint.disabled = running;
    elements.apiKey.disabled = running;
    elements.rememberApiKey.disabled = running;
    elements.model.disabled = running;
    elements.timeout.disabled = running;
    elements.extraPrompt.disabled = running;
    elements.autoFill.disabled = running;
    elements.autoSubmit.disabled = running;
    elements.submitMode.disabled = running || !elements.autoSubmit.checked;
    elements.testButton.disabled = running;
  }

  async function updateReviewPanelSummary(forceRefresh) {
    const elements = getReviewPanelElements();
    if (!elements) {
      return 0;
    }

    const requestId = REVIEW_AI_STATE.summaryRequestId + 1;
    REVIEW_AI_STATE.summaryRequestId = requestId;
    elements.pageHint.textContent = `${document.title || "(无标题)"} | ${window.location.href}`;

    const quickCount = countLikelySubjectiveQuestions();
    elements.pageInfo.textContent =
      quickCount > 0 ? `检测到 ${quickCount} 个题块，正在识别题目...` : "正在识别题目...";

    await ensureReviewEndpointPermission(config.endpoint, true);
    const cacheKey = getReviewQuestionCacheKey();
    if (!forceRefresh && REVIEW_AI_STATE.cachedQuestionKey === cacheKey && REVIEW_AI_STATE.cachedQuestions.length) {
      elements.pageInfo.textContent = `已识别 ${REVIEW_AI_STATE.cachedQuestions.length} 道主观题`;
      return REVIEW_AI_STATE.cachedQuestions.length;
    }

    try {
      const questions = await extractQuestionRecordsAsync();
      if (REVIEW_AI_STATE.summaryRequestId !== requestId) {
        return questions.length;
      }
      REVIEW_AI_STATE.cachedQuestionKey = cacheKey;
      REVIEW_AI_STATE.cachedQuestions = questions;
      elements.pageInfo.textContent = `已识别 ${questions.length} 道主观题`;
      return questions.length;
    } catch (error) {
      if (REVIEW_AI_STATE.summaryRequestId === requestId) {
        elements.pageInfo.textContent = "题目识别失败";
        appendReviewPanelLog(`题目识别失败：${error.message}`, "error");
      }
      return 0;
    }
  }

  function maybeAutoRunContinuousReview() {
    const loopState = getAutoLoopState();
    if (!loopState.active || REVIEW_AI_STATE.running) {
      return;
    }

    if (!REVIEW_AI_STATE.settingsHydrated) {
      return;
    }

    const elements = getReviewPanelElements();
    if (!elements) {
      return;
    }

    const config = readReviewPanelConfig();
    const canContinue = config.autoFill && config.autoSubmit && config.submitMode === "next";
    if (!canContinue) {
      setAutoLoopState(false);
      REVIEW_AI_STATE.autoLoopLastStartedKey = "";
      return;
    }

    if (!safeText(config.apiKey)) {
      setAutoLoopState(false);
      setReviewPanelBadge("缺少密钥", "error");
      appendReviewPanelLog("连续批阅已停止：API Key 为空。", "error");
      return;
    }

    const pageKey = getReviewQuestionCacheKey();
    if (REVIEW_AI_STATE.autoLoopLastStartedKey === pageKey) {
      return;
    }

    if (countLikelySubjectiveQuestions() <= 0) {
      return;
    }

    REVIEW_AI_STATE.autoLoopLastStartedKey = pageKey;
    elements.progress.textContent = "检测到连续批阅任务，正在自动开始本页批改...";
    appendReviewPanelLog("已进入下一份，自动开始批改。", "info");
    startSequentialAiReview({ autoTriggered: true }).catch((error) => {
      appendReviewPanelLog(`自动开始失败：${error.message}`, "error");
      setAutoLoopState(false);
      REVIEW_AI_STATE.autoLoopLastStartedKey = "";
    });
  }

  async function maybeAutoEnterPendingReview() {
    const loopState = getAutoLoopState();
    if (!loopState.active || REVIEW_AI_STATE.running || isTeacherReviewPage()) {
      return;
    }

    const config = await getStoredReviewSettings();
    const canContinue = config.autoFill && config.autoSubmit && config.submitMode === "next";
    if (!canContinue) {
      setAutoLoopState(false);
      REVIEW_AI_STATE.autoLoopLastStartedKey = "";
      return;
    }

    const pageKey = `list:${window.location.href}`;
    if (REVIEW_AI_STATE.autoLoopLastStartedKey === pageKey) {
      return;
    }

    const currentUrl = safeText(window.location.href);
    let pendingRecord = pickPendingSubmissionRecord(extractSubmissionPageRecords());
    if (!pendingRecord) {
      try {
        const fetchedRecords = await fetchSubmissionPageRecords({ maxPages: 1, waitMs: 0 });
        pendingRecord = pickPendingSubmissionRecord(fetchedRecords);
      } catch (error) {
        // Ignore direct-fetch failure and fall back to DOM click.
      }
    }

    if (pendingRecord && safeText(pendingRecord.url) && safeText(pendingRecord.url) !== currentUrl) {
      REVIEW_AI_STATE.autoLoopLastStartedKey = pageKey;
      window.location.href = pendingRecord.url;
      return;
    }

    const actionNode = getPendingReviewActionNode();
    if (!actionNode) {
      const batchQueue = await getReviewBatchQueue();
      if (
        batchQueue &&
        batchQueue.active &&
        batchQueue.urls[batchQueue.currentIndex] &&
        safeText(batchQueue.urls[batchQueue.currentIndex]) === currentUrl
      ) {
        const nextIndex = batchQueue.currentIndex + 1;
        if (nextIndex < batchQueue.urls.length) {
          batchQueue.currentIndex = nextIndex;
          await saveReviewBatchQueue(batchQueue);
          REVIEW_AI_STATE.autoLoopLastStartedKey = "";
          window.location.href = batchQueue.urls[nextIndex];
          return;
        }
        await clearReviewBatchQueue();
        setAutoLoopState(false);
        REVIEW_AI_STATE.autoLoopLastStartedKey = "";
      }
      return;
    }

    REVIEW_AI_STATE.autoLoopLastStartedKey = pageKey;
    dispatchClick(actionNode);
    await sleep(300);
  }

  function destroyReviewPanel() {
    if (REVIEW_AI_STATE.panelHost) {
      REVIEW_AI_STATE.panelHost.remove();
    }
    REVIEW_AI_STATE.panelHost = null;
    REVIEW_AI_STATE.panelRoot = null;
    REVIEW_AI_STATE.panelElements = null;
    REVIEW_AI_STATE.mountedForHref = "";
  }

  function positionReviewPanelHost(host) {
    if (!host) {
      return;
    }
    const margin = 16;
    const desiredWidth = Math.min(446, Math.max(360, window.innerWidth - margin * 2));
    const left = Math.max(margin, window.innerWidth - desiredWidth - margin);
    const top = margin;
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  }

  function clampReviewPanelToViewport(host) {
    if (!host) {
      return;
    }
    const margin = 8;
    const rect = host.getBoundingClientRect();
    const currentLeft = Number.parseFloat(host.style.left || `${rect.left}`) || rect.left || margin;
    const currentTop = Number.parseFloat(host.style.top || `${rect.top}`) || rect.top || margin;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    host.style.left = `${clamp(currentLeft, margin, maxLeft)}px`;
    host.style.top = `${clamp(currentTop, margin, maxTop)}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  }

  function enableReviewPanelDrag(host, handle, elements) {
    if (!host || !handle || handle.dataset.dragBound === "1") {
      return;
    }
    handle.dataset.dragBound = "1";

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let pointerId = null;

    const interactiveSelector = "button, input, textarea, label, select, option, a";

    const onPointerMove = (event) => {
      if (!dragging) {
        return;
      }
      const nextLeft = baseLeft + (event.clientX - startX);
      const nextTop = baseTop + (event.clientY - startY);
      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      clampReviewPanelToViewport(host);
    };

    const stopDragging = () => {
      dragging = false;
      pointerId = null;
      handle.style.cursor = "grab";
      if (elements && elements.panel) {
        elements.panel.dataset.dragging = "false";
      }
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", stopDragging, true);
      window.removeEventListener("pointercancel", stopDragging, true);
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      if (event.target && event.target.closest && event.target.closest(interactiveSelector)) {
        return;
      }
      dragging = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      const rect = host.getBoundingClientRect();
      baseLeft = Number.parseFloat(host.style.left || `${rect.left}`) || rect.left || 0;
      baseTop = Number.parseFloat(host.style.top || `${rect.top}`) || rect.top || 0;
      host.style.left = `${baseLeft}px`;
      host.style.top = `${baseTop}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      handle.style.cursor = "grabbing";
      if (elements && elements.panel) {
        elements.panel.dataset.dragging = "true";
      }
      try {
        handle.setPointerCapture(pointerId);
      } catch (error) {
        // Ignore unsupported capture errors.
      }
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", stopDragging, true);
      window.addEventListener("pointercancel", stopDragging, true);
      event.preventDefault();
    });

    handle.style.cursor = "grab";
  }

  function ensureReviewPanel() {
    if (!isTeacherReviewPage()) {
      if (!REVIEW_AI_STATE.running) {
        destroyReviewPanel();
      }
      return null;
    }

    if (REVIEW_AI_STATE.panelHost) {
      void updateReviewPanelSummary(false);
      return REVIEW_AI_STATE.panelElements;
    }

    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "24px";
    host.style.top = "24px";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto";
    host.setAttribute("data-cx-edge-review-panel", "1");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * {
          box-sizing: border-box;
        }
        .panel {
          width: min(446px, calc(100vw - 20px));
          height: min(760px, calc(100vh - 20px));
          overflow: hidden;
          border: 1px solid rgba(27, 53, 87, 0.18);
          border-radius: 14px;
          background:
            linear-gradient(180deg, rgba(248, 251, 255, 0.98) 0%, rgba(240, 246, 252, 0.98) 100%);
          box-shadow: 0 18px 44px rgba(16, 37, 64, 0.24);
          color: #18324b;
          font: 13px/1.5 "Microsoft YaHei UI", "PingFang SC", sans-serif;
          display: flex;
          flex-direction: column;
          user-select: none;
        }
        .panel[data-dragging="true"] {
          box-shadow: 0 24px 54px rgba(16, 37, 64, 0.32);
        }
        .panel[data-collapsed="true"] {
          height: auto;
        }
        .head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(76, 99, 127, 0.14);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(242, 247, 252, 0.96) 100%);
        }
        .nav-bar {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(76, 99, 127, 0.12);
          background: rgba(248, 251, 255, 0.92);
        }
        .nav-tab {
          border: 1px solid rgba(59, 91, 124, 0.12);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.9);
          color: #4d6680;
          font: inherit;
          font-weight: 700;
          padding: 8px 10px;
          cursor: pointer;
        }
        .nav-tab[data-active="true"] {
          background: linear-gradient(180deg, #4b90e2 0%, #2d6fc0 100%);
          color: #fff;
          box-shadow: 0 8px 18px rgba(45, 111, 192, 0.18);
        }
        .head-main {
          min-width: 0;
          flex: 1 1 auto;
          padding: 4px 6px;
          border-radius: 10px;
          user-select: none;
        }
        .eyebrow {
          color: #4a75ac;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .title {
          margin: 2px 0 0;
          font-size: 17px;
          font-weight: 700;
        }
        .head-actions {
          display: flex;
          gap: 8px;
          flex: 0 0 auto;
        }
        .icon-btn,
        .action-btn {
          border: 0;
          border-radius: 10px;
          cursor: pointer;
          font: inherit;
        }
        .icon-btn {
          width: 30px;
          height: 30px;
          background: linear-gradient(180deg, #ffffff 0%, #eaf1f8 100%);
          color: #325d8c;
          font-weight: 700;
          border: 1px solid rgba(57, 88, 121, 0.18);
        }
        .body {
          flex: 1 1 auto;
          min-height: 0;
          padding: 12px;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          user-select: text;
        }
        .body[data-collapsed="true"] {
          display: none;
        }
        .view[hidden] {
          display: none !important;
        }
        .section {
          margin-top: 10px;
          padding: 12px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.88);
          border: 1px solid rgba(52, 82, 112, 0.10);
        }
        .section:first-of-type {
          margin-top: 0;
        }
        .notice {
          padding: 10px 12px;
          border-radius: 10px;
          background: linear-gradient(180deg, #f3f8fd 0%, #edf4fb 100%);
          color: #355d85;
          border: 1px solid rgba(74, 127, 183, 0.16);
        }
        .status-line {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          background: #edf2f7;
          color: #46627d;
        }
        .badge[data-tone="ready"] { background: #e7f7ec; color: #1e7b43; }
        .badge[data-tone="running"] { background: #fff4dd; color: #b56b00; }
        .badge[data-tone="error"] { background: #ffe6e6; color: #b03333; }
        .badge[data-tone="done"] { background: #eaf0ff; color: #3459b6; }
        .page-info {
          color: #567089;
          font-size: 12px;
          font-weight: 600;
        }
        .page-hint {
          margin-top: 6px;
          color: #7a8da0;
          font-size: 11px;
          word-break: break-all;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .field {
          display: block;
          margin-top: 10px;
        }
        .settings-inline {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 112px;
          gap: 8px;
          align-items: center;
        }
        .field-label {
          display: block;
          margin-bottom: 6px;
          color: #37536e;
          font-size: 12px;
          font-weight: 700;
        }
        .text-input,
        .text-area,
        .select-input {
          width: 100%;
          border: 1px solid rgba(58, 93, 129, 0.16);
          border-radius: 12px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.92);
          color: #1f3548;
          font: inherit;
          outline: none;
        }
        .text-input:focus,
        .text-area:focus {
          border-color: rgba(64, 129, 214, 0.55);
          box-shadow: 0 0 0 3px rgba(64, 129, 214, 0.12);
        }
        .text-area {
          min-height: 76px;
          resize: none;
        }
        .select-input {
          appearance: none;
        }
        .options {
          display: flex;
          flex-wrap: wrap;
          gap: 10px 14px;
          margin-top: 12px;
          color: #365066;
        }
        .option {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .button-row {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-top: 10px;
        }
        .action-btn {
          padding: 10px 12px;
          font-weight: 700;
          color: #fff;
          background: linear-gradient(180deg, #4b90e2 0%, #2d6fc0 100%);
          box-shadow: 0 10px 18px rgba(52, 104, 168, 0.18);
        }
        .action-btn.alt {
          background: linear-gradient(180deg, #7e93aa 0%, #5d7086 100%);
        }
        .action-btn.warn {
          background: linear-gradient(180deg, #e96e55 0%, #d5533b 100%);
        }
        .action-btn:disabled {
          cursor: not-allowed;
          opacity: 0.62;
          box-shadow: none;
        }
        .tiny-btn {
          border: 0;
          border-radius: 10px;
          cursor: pointer;
          font: inherit;
          font-weight: 700;
          padding: 10px 12px;
          color: #fff;
          background: linear-gradient(180deg, #4b90e2 0%, #2d6fc0 100%);
          box-shadow: 0 8px 18px rgba(45, 111, 192, 0.18);
        }
        .tiny-btn.alt {
          background: linear-gradient(180deg, #7e93aa 0%, #5d7086 100%);
        }
        .tiny-btn:disabled {
          cursor: not-allowed;
          opacity: 0.62;
          box-shadow: none;
        }
        .test-status {
          margin-top: 10px;
          padding: 9px 12px;
          border-radius: 10px;
          background: #f4f8fc;
          color: #4f6780;
        }
        .test-status[data-tone="running"] {
          background: #fff7e7;
          color: #9a6500;
        }
        .test-status[data-tone="success"] {
          background: #eefaf1;
          color: #256a43;
        }
        .test-status[data-tone="error"] {
          background: #fff0f0;
          color: #a03f3f;
        }
        .log-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 10px;
        }
        .progress {
          margin-top: 0;
          padding: 10px 12px;
          border-radius: 10px;
          background: linear-gradient(180deg, #f5f9fd 0%, #edf3f8 100%);
          color: #42627f;
          white-space: pre-wrap;
        }
        .task-list {
          margin-top: 0;
          display: grid;
          gap: 8px;
          max-height: 208px;
          overflow: auto;
        }
        .task-row {
          padding: 10px 12px;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid rgba(49, 86, 120, 0.08);
        }
        .task-row[data-state="running"] { border-color: rgba(234, 170, 65, 0.5); background: #fff9ee; }
        .task-row[data-state="success"] { border-color: rgba(70, 157, 96, 0.35); background: #f3fbf5; }
        .task-row[data-state="error"] { border-color: rgba(211, 84, 84, 0.35); background: #fff4f4; }
        .task-title { font-weight: 700; color: #214364; }
        .task-snippet {
          margin-top: 4px;
          color: #4f6780;
          font-size: 12px;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .task-meta {
          margin-top: 6px;
          color: #7b8ea1;
          font-size: 11px;
        }
        .task-result {
          margin-top: 8px;
          color: #1e3955;
          white-space: pre-wrap;
          font-size: 12px;
        }
        .log {
          margin-top: 0;
          display: grid;
          gap: 6px;
          max-height: 126px;
          overflow: auto;
        }
        .log-item {
          padding: 8px 10px;
          border-radius: 10px;
          background: #f4f8fc;
          color: #48627a;
          font-size: 12px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .log-item[data-tone="error"] { background: #fff0f0; color: #a03f3f; }
        .log-item[data-tone="success"] { background: #eefaf1; color: #256a43; }
        .log-item[data-tone="warn"] { background: #fff6e6; color: #9a6500; }
      </style>
      <div class="panel">
        <div class="head">
          <div class="head-main" id="dragHandle">
            <div class="eyebrow">Chaoxing AI Review</div>
            <div class="title">教师批阅助手</div>
          </div>
          <div class="head-actions">
            <button class="icon-btn" id="toggleBtn" type="button">-</button>
          </div>
        </div>
        <div class="nav-bar">
          <button class="nav-tab" id="homeTab" type="button" data-active="true">Home</button>
          <button class="nav-tab" id="settingsTab" type="button" data-active="false">设置</button>
          <button class="nav-tab" id="logsTab" type="button" data-active="false">日志</button>
        </div>
        <div class="body" id="panelBody">
          <div class="view" id="homeView">
            <div class="section">
              <div class="notice">已检测到教师批阅页。当前功能只在页面内存中逐题处理，不写入本地文件或数据库。</div>
              <div class="status-line" style="margin-top:10px;">
                <span class="badge" id="statusBadge" data-tone="ready">已识别</span>
                <span class="page-info" id="pageInfo">正在识别题目...</span>
              </div>
              <div class="page-hint" id="pageHint"></div>
            </div>
            <div class="section">
              <div class="progress" id="progressBox">等待开始</div>
            </div>
            <div class="section">
              <div class="button-row" style="margin-top:0;">
                <button class="action-btn" id="startBtn" type="button">开始逐题 AI</button>
                <button class="action-btn alt" id="refreshBtn" type="button">刷新识别</button>
                <button class="action-btn warn" id="stopBtn" type="button" disabled>停止</button>
              </div>
            </div>
            <div class="section">
              <div class="task-list" id="taskList"></div>
            </div>
          </div>
          <div class="view" id="settingsView" hidden>
            <div class="section">
              <label class="field" style="margin-top:0;">
                <span class="field-label">常用 API 地址</span>
                <div class="settings-inline">
                  <select class="text-input select-input" id="providerSelect"></select>
                  <button class="tiny-btn" id="testApiBtn" type="button">测试连接</button>
                </div>
              </label>
              <div class="test-status" id="testStatus" data-tone="neutral">尚未测试连接</div>
              <label class="field">
                <span class="field-label">AI 接口地址（OpenAI 兼容）</span>
                <input class="text-input" id="endpointInput" type="text" value="https://api.moonshot.cn/v1">
              </label>
              <label class="field">
                <span class="field-label">API Key</span>
                <input class="text-input" id="apiKeyInput" type="password" placeholder="请输入当前会话使用的 API Key">
              </label>
              <div class="options" style="margin-top:10px;">
                <label class="option"><input id="rememberApiKeyInput" type="checkbox">记住 API Key 到本地存储</label>
              </div>
            <label class="field">
              <span class="field-label">常用模型</span>
              <select class="text-input select-input" id="modelSelect"></select>
            </label>
              <label class="field">
                <span class="field-label">模型名</span>
                <input class="text-input" id="modelInput" type="text" value="kimi-k2.6" hidden>
              </label>
              <label class="field">
                <span class="field-label">请求超时（秒）</span>
                <input class="text-input" id="timeoutInput" type="number" min="5" max="300" step="1" value="20">
              </label>
              <label class="field">
                <span class="field-label">附加批改要求</span>
                <textarea class="text-area" id="extraPromptInput" placeholder="可选。例如：更严格扣分；评语控制在 50 字内。"></textarea>
              </label>
              <div class="options">
                <label class="option"><input id="autoFillInput" type="checkbox" checked>自动回填评分和批语</label>
                <label class="option"><input id="autoSubmitInput" type="checkbox">全部完成后自动提交当前页</label>
              </div>
              <label class="field">
                <span class="field-label">自动提交方式</span>
                <select class="text-input select-input" id="submitModeSelect">
                  <option value="current">提交当前页</option>
                  <option value="next">提交并进入下一份</option>
                </select>
              </label>
            </div>
          </div>
          <div class="view" id="logsView" hidden>
            <div class="section">
              <div class="log-toolbar">
                <span class="field-label" style="margin:0;">运行日志</span>
                <button class="tiny-btn alt" id="clearLogsBtn" type="button">清空日志</button>
              </div>
              <div class="log" id="logBox"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);

    const elements = {
      panel: shadow.querySelector(".panel"),
      body: shadow.getElementById("panelBody"),
      dragHandle: shadow.getElementById("dragHandle"),
      navTabs: {
        home: shadow.getElementById("homeTab"),
        settings: shadow.getElementById("settingsTab"),
        logs: shadow.getElementById("logsTab"),
      },
      views: {
        home: shadow.getElementById("homeView"),
        settings: shadow.getElementById("settingsView"),
        logs: shadow.getElementById("logsView"),
      },
      badge: shadow.getElementById("statusBadge"),
      pageInfo: shadow.getElementById("pageInfo"),
      pageHint: shadow.getElementById("pageHint"),
      provider: shadow.getElementById("providerSelect"),
      modelSelect: shadow.getElementById("modelSelect"),
      endpoint: shadow.getElementById("endpointInput"),
      apiKey: shadow.getElementById("apiKeyInput"),
      rememberApiKey: shadow.getElementById("rememberApiKeyInput"),
      model: shadow.getElementById("modelInput"),
      timeout: shadow.getElementById("timeoutInput"),
      extraPrompt: shadow.getElementById("extraPromptInput"),
      autoFill: shadow.getElementById("autoFillInput"),
      autoSubmit: shadow.getElementById("autoSubmitInput"),
      submitMode: shadow.getElementById("submitModeSelect"),
      testButton: shadow.getElementById("testApiBtn"),
      testStatus: shadow.getElementById("testStatus"),
      start: shadow.getElementById("startBtn"),
      refresh: shadow.getElementById("refreshBtn"),
      stop: shadow.getElementById("stopBtn"),
      progress: shadow.getElementById("progressBox"),
      taskList: shadow.getElementById("taskList"),
      log: shadow.getElementById("logBox"),
      clearLogs: shadow.getElementById("clearLogsBtn"),
      toggle: shadow.getElementById("toggleBtn"),
    };

    REVIEW_AI_STATE.panelHost = host;
    REVIEW_AI_STATE.panelRoot = shadow;
    REVIEW_AI_STATE.panelElements = elements;
    REVIEW_AI_STATE.mountedForHref = window.location.href;
    positionReviewPanelHost(host);
    clampReviewPanelToViewport(host);
    enableReviewPanelDrag(host, elements.dragHandle, elements);
    API_PROVIDER_PRESETS.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      elements.provider.appendChild(option);
    });
    switchReviewPanelPage("home");

    let collapsed = false;
    elements.toggle.addEventListener("click", () => {
      collapsed = !collapsed;
      elements.body.dataset.collapsed = collapsed ? "true" : "false";
      elements.panel.dataset.collapsed = collapsed ? "true" : "false";
      elements.toggle.textContent = collapsed ? "+" : "-";
      window.setTimeout(() => clampReviewPanelToViewport(host), 0);
    });

    Object.entries(elements.navTabs).forEach(([pageName, button]) => {
      if (!button) {
        return;
      }
      button.addEventListener("click", () => {
        switchReviewPanelPage(pageName);
      });
    });

    elements.refresh.addEventListener("click", () => {
      REVIEW_AI_STATE.cachedQuestionKey = "";
      REVIEW_AI_STATE.cachedQuestions = [];
      void updateReviewPanelSummary(true);
      appendReviewPanelLog("已刷新当前页识别结果。", "info");
    });

    elements.stop.addEventListener("click", () => {
      REVIEW_AI_STATE.cancelled = true;
      REVIEW_AI_STATE.autoLoopLastStartedKey = "";
      setAutoLoopState(false);
      setReviewPanelBadge("正在停止", "running");
      elements.progress.textContent = "已请求停止，当前题处理结束后会中断。";
      appendReviewPanelLog("用户请求停止逐题 AI 批阅。", "warn");
    });

    elements.provider.addEventListener("change", () => {
      applyProviderPreset(elements.provider.value);
    });

    elements.modelSelect.addEventListener("change", () => {
      if (elements.modelSelect.value === "__custom__") {
        elements.model.hidden = false;
        elements.model.value = "";
        elements.model.placeholder = "请输入自定义模型名";
      } else {
        elements.model.hidden = true;
        elements.model.value = elements.modelSelect.value;
        elements.model.placeholder = "";
      }
      setReviewApiTestStatus("模型已切换，请重新测试连接。", "neutral");
      schedulePersistReviewSettings();
    });

    elements.testButton.addEventListener("click", async () => {
      try {
        await testReviewApiConnection();
      } catch (error) {
        setReviewApiTestStatus(error.message, "error");
        appendReviewPanelLog(`API 测试失败：${error.message}`, "error");
      }
    });

    [elements.endpoint, elements.apiKey, elements.model, elements.timeout, elements.extraPrompt].forEach((node) => {
      node.addEventListener("input", () => {
        if (node === elements.endpoint) {
          elements.provider.value = inferProviderFromEndpoint(elements.endpoint.value);
          populateModelOptions(elements.provider.value, safeText(elements.model.value));
          setReviewApiTestStatus("API 地址已修改，请重新测试连接。", "neutral");
        }
        if (node === elements.apiKey) {
          setReviewApiTestStatus("API Key 已修改，请重新测试连接。", "neutral");
        }
        if (node === elements.model) {
          syncModelControls(elements.model.value);
          setReviewApiTestStatus("模型名已修改，请重新测试连接。", "neutral");
        }
        schedulePersistReviewSettings();
      });
    });
    [elements.autoFill, elements.autoSubmit].forEach((node) => {
      node.addEventListener("change", () => {
        elements.submitMode.disabled = REVIEW_AI_STATE.running || !elements.autoSubmit.checked;
        schedulePersistReviewSettings();
      });
    });
    elements.rememberApiKey.addEventListener("change", () => {
      schedulePersistReviewSettings();
    });
    elements.submitMode.addEventListener("change", () => {
      schedulePersistReviewSettings();
    });

    elements.clearLogs.addEventListener("click", () => {
      elements.log.innerHTML = "";
      appendReviewPanelLog("日志已清空。", "info");
    });

    elements.start.addEventListener("click", async () => {
      try {
        await startSequentialAiReview();
      } catch (error) {
        setReviewPanelBadge("执行失败", "error");
        elements.progress.textContent = error.message;
        appendReviewPanelLog(error.message, "error");
      }
    });

    void hydrateReviewPanelSettings();
    void updateReviewPanelSummary(true);
    setReviewPanelBadge("已识别", "ready");
    appendReviewPanelLog("已检测到教师批阅页，可开始逐题 AI 处理。", "success");
    return elements;
  }

  async function applySingleAiResult(question, normalizedResult) {
    return callBridge("applyGradingRows", {
      rows: [
        {
          question_hash_id: question.question_hash_id,
          q_content: question.q_content,
          grading_score: normalizedResult.grading_score,
          grading_comment: normalizedResult.grading_comment,
        },
      ],
      submitAfterApply: false,
    });
  }

  async function startSequentialAiReview(options) {
    const opts = options || {};
    const elements = ensureReviewPanel();
    if (!elements) {
      throw new Error("当前页面不是教师批阅页，无法启动逐题 AI。");
    }
    if (REVIEW_AI_STATE.running) {
      throw new Error("逐题 AI 批阅正在运行中。");
    }

    const config = readReviewPanelConfig();
    if (!config.endpoint) {
      throw new Error("请填写 AI 接口地址。");
    }
    if (!config.apiKey) {
      throw new Error("请填写 API Key。");
    }
    if (!config.model) {
      throw new Error("请填写模型名。");
    }

    const cacheKey = getReviewQuestionCacheKey();
    let questions =
      REVIEW_AI_STATE.cachedQuestionKey === cacheKey && REVIEW_AI_STATE.cachedQuestions.length
        ? REVIEW_AI_STATE.cachedQuestions
        : [];

    if (!questions.length) {
      elements.progress.textContent = "正在解析当前页题目，请稍候...";
      await sleep(0);
      questions = await extractQuestionRecordsAsync();
      REVIEW_AI_STATE.cachedQuestionKey = cacheKey;
      REVIEW_AI_STATE.cachedQuestions = questions;
    }

    if (!questions.length) {
      throw new Error("当前页没有识别到可批改的主观题。");
    }

    const continuousMode = config.autoFill && config.autoSubmit && config.submitMode === "next";
    if (opts.autoTriggered && !continuousMode) {
      setAutoLoopState(false);
      REVIEW_AI_STATE.autoLoopLastStartedKey = "";
      throw new Error("连续批阅条件不满足（需开启自动回填、自动提交并选择“提交并进入下一份”）");
    }
    if (continuousMode) {
      setAutoLoopState(true);
    } else if (!opts.autoTriggered) {
      setAutoLoopState(false);
      REVIEW_AI_STATE.autoLoopLastStartedKey = "";
    }

    REVIEW_AI_STATE.cancelled = false;
    REVIEW_AI_STATE.autoLoopLastStartedKey = cacheKey;
    setReviewPanelRunning(true);
    clearReviewTaskList();
    elements.log.innerHTML = "";
    setReviewPanelBadge("执行中", "running");
    elements.progress.textContent = `共 ${questions.length} 题，准备开始逐题调用 AI。`;
    appendReviewPanelLog(`开始逐题 AI 批阅，共 ${questions.length} 题。`, "info");

    try {
      let failureCount = 0;
      for (let index = 0; index < questions.length; index += 1) {
        if (REVIEW_AI_STATE.cancelled) {
          elements.progress.textContent = `已在第 ${index + 1} 题前停止。`;
          appendReviewPanelLog("逐题 AI 批阅已中止。", "warn");
          setReviewPanelBadge("已停止", "error");
          return;
        }

        const question = questions[index];
        const taskRefs = createTaskRow(question, index);
        updateTaskRow(taskRefs, "running", "正在请求 AI...");
        elements.progress.textContent = `正在处理第 ${index + 1}/${questions.length} 题`;

        try {
          const aiResponse = await callBackgroundMessage("callAiChat", {
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            model: config.model,
            temperature: 0.2,
            timeoutMs: Math.max(5000, Math.round((Number(config.timeoutSeconds) || 20) * 1000)),
            messages: buildAiMessages(question, config, index, questions.length),
          });

          const normalizedResult = normalizeAiReviewResult(aiResponse.content, question);
          let fillSummary = "未回填";

          if (config.autoFill) {
            const fillResult = await applySingleAiResult(question, normalizedResult);
            fillSummary = `回填 ${Number(fillResult && fillResult.filled_count) || 0} 项`;
          }

          updateTaskRow(
            taskRefs,
            "success",
            `得分: ${normalizedResult.grading_score}\n评语: ${normalizedResult.grading_comment}\n${fillSummary}`
          );
          appendReviewPanelLog(`第 ${index + 1} 题已完成 AI 处理。`, "success");
        } catch (error) {
          failureCount += 1;
          updateTaskRow(taskRefs, "error", error.message);
          appendReviewPanelLog(`第 ${index + 1} 题处理失败：${error.message}`, "error");
        }
      }

      if (config.autoSubmit && config.autoFill && !REVIEW_AI_STATE.cancelled && failureCount === 0) {
        const submitLabel = config.submitMode === "next" ? "提交并进入下一份" : "提交当前页";
        elements.progress.textContent = `题目处理完成，正在${submitLabel}...`;
        const submitResult = await callBridge("submitCurrentPage", {
          mode: config.submitMode || "current",
        });
        if (submitResult && submitResult.ok) {
          appendReviewPanelLog(`已自动执行${submitLabel}。`, "success");
          if (config.submitMode === "next") {
            elements.progress.textContent = "已提交，等待进入下一份并自动继续...";
          } else {
            setAutoLoopState(false);
          }
        } else {
          const submitMessage = safeText(submitResult && submitResult.message) || "未知原因";
          appendReviewPanelLog(
            `${submitLabel}未确认成功：${submitMessage}`,
            "warn"
          );
          if (config.submitMode === "next" && /markAction\(0\)|未找到提交按钮|下一份/.test(submitMessage)) {
            setAutoLoopState(false);
            REVIEW_AI_STATE.autoLoopLastStartedKey = "";
            setReviewPanelBadge("已结束", "done");
            elements.progress.textContent = "未检测到“提交并进入下一份”按钮，连续批阅已停止。";
            appendReviewPanelLog("已到最后一份，连续批阅任务自动结束。", "success");
            return;
          }
          if (config.submitMode !== "next") {
            setAutoLoopState(false);
          }
        }
      } else if (config.autoSubmit && failureCount > 0) {
        appendReviewPanelLog("存在处理失败的题目，已跳过自动提交。", "warn");
        if (config.submitMode === "next") {
          setAutoLoopState(false);
          REVIEW_AI_STATE.autoLoopLastStartedKey = "";
        }
      }

      if (!REVIEW_AI_STATE.cancelled) {
        setReviewPanelBadge("已完成", "done");
        elements.progress.textContent = `逐题 AI 批阅结束，共处理 ${questions.length} 题。`;
        appendReviewPanelLog("逐题 AI 批阅已全部完成。", "success");
      }
    } finally {
      if (REVIEW_AI_STATE.cancelled) {
        setAutoLoopState(false);
        REVIEW_AI_STATE.autoLoopLastStartedKey = "";
      }
      REVIEW_AI_STATE.cancelled = false;
      setReviewPanelRunning(false);
      void updateReviewPanelSummary(true);
    }
  }

  function refreshReviewPanelMount() {
    if (!isTeacherReviewPage()) {
      void maybeAutoEnterPendingReview();
      if (!REVIEW_AI_STATE.running) {
        destroyReviewPanel();
      }
      return;
    }

    const summary = getReviewQuestionCacheKey();
    if (!REVIEW_AI_STATE.panelHost || REVIEW_AI_STATE.lastContextSummary !== summary) {
      ensureReviewPanel();
      REVIEW_AI_STATE.lastContextSummary = summary;
      REVIEW_AI_STATE.cachedQuestionKey = "";
      REVIEW_AI_STATE.cachedQuestions = [];
      void updateReviewPanelSummary(true);
    }
    clampReviewPanelToViewport(REVIEW_AI_STATE.panelHost);
    maybeAutoRunContinuousReview();
  }

  async function handleInspect() {
    const context = detectPageContext();
    return {
      ok: true,
      handled: true,
      count: Object.values(context).filter(Boolean).length,
      priority: 1,
      data: context,
      export: buildExport("inspect", [context], {}),
      filename: buildFilename("chaoxing-context"),
      summary: summarizeContext(context),
      frameUrl: window.location.href,
    };
  }

  async function handleExtractCourses() {
    await ensureTeachCourseTabVisible();
    const records = extractCourses();
    if (!records.length) {
      return {
        ok: false,
        handled: false,
      };
    }
    return {
      ok: true,
      handled: true,
      count: records.length,
      priority: 10 + records.length,
      data: records,
      export: buildExport("courses", records, {}),
      filename: buildFilename("chaoxing-courses"),
      summary: `成功抓取 ${records.length} 门课程`,
      frameUrl: window.location.href,
    };
  }

  async function handleExtractHomeworks(payload) {
    try {
      const fetchedRecords = await fetchHomeworkPageRecords(payload);
      if (fetchedRecords.length) {
        return {
          ok: true,
          handled: true,
          count: fetchedRecords.length,
          priority: 25 + fetchedRecords.length,
          data: fetchedRecords,
          export: buildExport("homeworks", fetchedRecords, { page_ids: getPageIds(), source: "direct-fetch" }),
          filename: buildFilename("chaoxing-homeworks"),
          summary: `成功抓取 ${fetchedRecords.length} 条作业记录`,
          frameUrl: window.location.href,
        };
      }
    } catch (error) {
      // Fall back to page-driven extraction below.
    }

    await ensureHomeworkTabVisible();
    const records = await collectPaginatedRecords(
      extractHomeworkPageRecords,
      (item) => item.work_id || item.url || item.homework_name,
      payload
    );
    if (!records.length) {
      return {
        ok: false,
        handled: false,
      };
    }
    return {
      ok: true,
      handled: true,
      count: records.length,
      priority: 20 + records.length,
      data: records,
      export: buildExport("homeworks", records, { page_ids: getPageIds() }),
      filename: buildFilename("chaoxing-homeworks"),
      summary: `成功抓取 ${records.length} 条作业记录`,
      frameUrl: window.location.href,
    };
  }

  async function handleResolveHomeworkListUrl() {
    const url = buildTeacherHomeworkListUrl();
    if (!url) {
      return {
        ok: false,
        handled: false,
      };
    }
    return {
      ok: true,
      handled: true,
      count: 1,
      priority: 15,
      data: {
        url,
        page_ids: getPageIds(),
      },
      export: buildExport("homework-list-url", [{ url }], { page_ids: getPageIds() }),
      filename: buildFilename("chaoxing-homework-list-url"),
      summary: "已解析课程作业列表地址",
      frameUrl: window.location.href,
    };
  }

  async function handleExtractSubmissions(payload) {
    try {
      const fetchedRecords = await fetchSubmissionPageRecords(payload);
      if (fetchedRecords.length) {
        return {
          ok: true,
          handled: true,
          count: fetchedRecords.length,
          priority: 35 + fetchedRecords.length,
          data: fetchedRecords,
          export: buildExport("submissions", fetchedRecords, { page_ids: getPageIds(), source: "direct-fetch" }),
          filename: buildFilename("chaoxing-submissions"),
          summary: `成功抓取 ${fetchedRecords.length} 条提交记录`,
          frameUrl: window.location.href,
        };
      }
    } catch (error) {
      // Fall back to page-driven extraction below.
    }

    try {
      await callBridge("loadSubmissionList", {
        page: 1,
        timeoutMs: (payload && payload.timeoutMs) || 12000,
      });
    } catch (error) {
      // Ignore bridge load failures and fall back to DOM retries.
    }
    const records = await collectPaginatedRecords(
      extractSubmissionPageRecords,
      (item) => item.answer_id || item.url || `${item.student_name}_${item.student_id}`,
      payload
    );
    if (!records.length) {
      return {
        ok: false,
        handled: false,
      };
    }
    return {
      ok: true,
      handled: true,
      count: records.length,
      priority: 30 + records.length,
      data: records,
      export: buildExport("submissions", records, { page_ids: getPageIds() }),
      filename: buildFilename("chaoxing-submissions"),
      summary: `成功抓取 ${records.length} 条提交记录`,
      frameUrl: window.location.href,
    };
  }

  async function handleExtractQuestions() {
    const records = extractQuestionRecords();
    if (!records.length) {
      return {
        ok: false,
        handled: false,
      };
    }
    return {
      ok: true,
      handled: true,
      count: records.length,
      priority: 40 + records.length,
      data: records,
      export: buildExport("questions", records, { page_ids: getPageIds() }),
      filename: buildFilename("chaoxing-questions"),
      summary: `成功抓取 ${records.length} 道主观题`,
      frameUrl: window.location.href,
    };
  }

  async function handleApplyGrading(payload) {
    const result = await callBridge("applyGradingRows", payload || {});
    return {
      ok: true,
      handled: true,
      count: Number(result && result.filled_count) || 0,
      priority: 50 + (Number(result && result.filled_count) || 0),
      data: result,
      export: buildExport("apply-grading-result", [result], {}),
      filename: buildFilename("chaoxing-apply-result"),
      summary: `已回填 ${Number(result && result.filled_count) || 0} 题，未匹配 ${Number(
        result && result.unmatched_count
      ) || 0} 题`,
      frameUrl: window.location.href,
    };
  }

  async function handleSubmitCurrentPage() {
    const result = await callBridge("submitCurrentPage", {});
    const ok = !!(result && result.ok);
    return {
      ok: true,
      handled: true,
      count: ok ? 1 : 0,
      priority: ok ? 80 : 60,
      data: result,
      export: buildExport("submit-current-page", [result], {}),
      filename: buildFilename("chaoxing-submit-result"),
      summary: ok ? "当前页提交成功" : `当前页提交未确认成功：${safeText(result && result.message)}`,
      frameUrl: window.location.href,
    };
  }

  async function handleStartAutoReviewFlow() {
    const config = await getStoredReviewSettings();
    if (!safeText(config.endpoint)) {
      throw new Error("请先填写 AI 接口地址");
    }
    if (!safeText(config.apiKey)) {
      throw new Error("请先填写 API Key");
    }
    if (!safeText(config.model)) {
      throw new Error("请先填写模型名");
    }
    if (!config.autoFill || !config.autoSubmit || safeText(config.submitMode) !== "next") {
      throw new Error("请先开启自动填写、自动提交，并选择“提交并进入下一份”");
    }

    setAutoLoopState(true);
    REVIEW_AI_STATE.autoLoopLastStartedKey = "";

    if (isTeacherReviewPage()) {
      ensureReviewPanel();
      applyReviewSettingsToPanel(config);
      REVIEW_AI_STATE.settingsHydrated = true;
      window.setTimeout(() => {
        startSequentialAiReview({ autoTriggered: true }).catch((error) => {
          appendReviewPanelLog(`自动启动失败：${error.message}`, "error");
          setAutoLoopState(false);
          REVIEW_AI_STATE.autoLoopLastStartedKey = "";
        });
      }, 0);
      return {
        ok: true,
        handled: true,
        count: 1,
        priority: 90,
        data: { mode: "detail" },
        summary: "已在批改详情页启动 AI 批阅",
        frameUrl: window.location.href,
      };
    }

    window.setTimeout(() => {
      maybeAutoEnterPendingReview().catch(() => {
        setAutoLoopState(false);
        REVIEW_AI_STATE.autoLoopLastStartedKey = "";
      });
    }, 0);
    return {
      ok: true,
      handled: true,
      count: 1,
      priority: 70,
      data: { mode: "list" },
      summary: "已在批阅列表页启动自动进入与连续批阅",
      frameUrl: window.location.href,
    };
  }

  async function runAction(action, payload) {
    switch (action) {
      case "inspect":
        return handleInspect();
      case "extractCourses":
        return handleExtractCourses();
      case "extractHomeworks":
        return handleExtractHomeworks(payload);
      case "resolveHomeworkListUrl":
        return handleResolveHomeworkListUrl();
      case "extractSubmissions":
        return handleExtractSubmissions(payload);
      case "extractQuestions":
        return handleExtractQuestions();
      case "applyGrading":
        return handleApplyGrading(payload);
      case "submitCurrentPage":
        return handleSubmitCurrentPage();
      case "startAutoReviewFlow":
        return handleStartAutoReviewFlow();
      default:
        return {
          ok: false,
          handled: false,
          error: `不支持的操作: ${action}`,
        };
    }
  }

  function scheduleReviewPanelRefresh() {
    if (REVIEW_AI_STATE.refreshTimer) {
      return;
    }
    REVIEW_AI_STATE.refreshTimer = window.setTimeout(() => {
      REVIEW_AI_STATE.refreshTimer = null;
      try {
        refreshReviewPanelMount();
      } catch (error) {
        // Ignore transient page refresh errors.
      }
    }, 80);
  }

  function bindReviewPanelLifecycle() {
    if (window.__cxEdgeReviewLifecycleBound) {
      return;
    }
    window.__cxEdgeReviewLifecycleBound = true;

    const notifyRouteChange = () => {
      scheduleReviewPanelRefresh();
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function () {
      const result = originalPushState.apply(this, arguments);
      notifyRouteChange();
      return result;
    };
    history.replaceState = function () {
      const result = originalReplaceState.apply(this, arguments);
      notifyRouteChange();
      return result;
    };

    REVIEW_AI_STATE.lifecycleObserver = new MutationObserver(() => {
      scheduleReviewPanelRefresh();
    });
    REVIEW_AI_STATE.lifecycleObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[REVIEW_PANEL_SETTINGS_STORAGE_KEY] || REVIEW_AI_STATE.running) {
        return;
      }
      void hydrateReviewPanelSettings();
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        scheduleReviewPanelRefresh();
      }, { once: true });
    } else {
      scheduleReviewPanelRefresh();
    }

    window.addEventListener("hashchange", notifyRouteChange);
    window.addEventListener("popstate", notifyRouteChange);
    window.addEventListener("focus", notifyRouteChange);
    window.addEventListener("beforeunload", () => {
      if (REVIEW_AI_STATE.refreshTimer) {
        window.clearTimeout(REVIEW_AI_STATE.refreshTimer);
        REVIEW_AI_STATE.refreshTimer = null;
      }
      if (REVIEW_AI_STATE.lifecycleObserver) {
        REVIEW_AI_STATE.lifecycleObserver.disconnect();
        REVIEW_AI_STATE.lifecycleObserver = null;
      }
    });
  }

  if (window === window.top) {
    bindReviewPanelLifecycle();
    scheduleReviewPanelRefresh();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "runAction") {
      return false;
    }
    runAction(message.action, message.payload || {})
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          handled: false,
          error: error.message,
          frameUrl: window.location.href,
        });
      });
    return true;
  });
})();
