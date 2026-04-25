(function () {
  if (window.__cxEdgePageBridgeLoaded) {
    return;
  }
  window.__cxEdgePageBridgeLoaded = true;

  const REQUEST_EVENT = "__cx_edge_bridge_request__";
  const RESPONSE_EVENT = "__cx_edge_bridge_response__";
  const SAVE_REVIEW_REQUEST_PATTERN = "/work/library/save-review";
  const submitRequestWaiters = new Map();
  let submitRequestObserverInstalled = false;
  let submitRequestWaiterId = 0;

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

  function parseJsonSafely(text) {
    try {
      return text ? JSON.parse(text) : null;
    } catch (error) {
      return null;
    }
  }

  async function fetchTextWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 12000));
    try {
      const response = await fetch(
        url,
        Object.assign({}, init || {}, {
          signal: controller.signal,
        })
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
      if (error && error.name === "AbortError") {
        throw new Error("Request timed out");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
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

  function normalizeTextForMatch(value) {
    return normalizeText(value);
  }

  function getQuestionContainers() {
    const candidates = [];
    const selectors = [
      ".mark_item1",
      "[class^='mark_item'], [class*=' mark_item']",
      "div[id^='index_']",
      ".TiMu",
      ".questionLi",
    ];
    selectors.forEach((selector) => {
      Array.from(document.querySelectorAll(selector)).forEach((node) => candidates.push(node));
    });
    return Array.from(new Set(candidates));
  }

  function getQuestionId(container) {
    const scoreByRid = container.querySelector("input.questionScore[rid], input[name^='score'][rid]");
    if (scoreByRid) {
      const rid = safeText(scoreByRid.getAttribute("rid"));
      if (rid) {
        return rid;
      }
    }

    const ridElem = container.querySelector("input[rid]");
    if (ridElem) {
      const rid = safeText(ridElem.getAttribute("rid"));
      if (rid) {
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

    const namedInput = container.querySelector("input[name^='score'], input[name^='qscore'], input[name^='perScore']");
    if (namedInput) {
      const fromName = safeText(namedInput.getAttribute("name")).match(/(\d{4,})$/);
      if (fromName) {
        return fromName[1];
      }
      const fromId = safeText(namedInput.id).match(/(\d{4,})$/);
      if (fromId) {
        return fromId[1];
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

    const qid = getQuestionId(container);
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

  function extractPageQuestions() {
    const questions = [];
    getQuestionContainers().forEach((container, index) => {
      const titleElem =
        container.querySelector(".mark_name, .Py-m1-title, h3, .Bt, .tit") || container.querySelector("[class*='title']");
      if (!titleElem) {
        return;
      }
      const contentDiv = titleElem.querySelector(".hiddenTitle") || titleElem;
      const questionText = normalizeMultilineText(getSafeText(contentDiv));
      if (!questionText) {
        return;
      }
      if (questionText.includes("单选题") || questionText.includes("多选题") || questionText.includes("判断题")) {
        return;
      }

      const qImages = Array.from(titleElem.querySelectorAll("img"))
        .map((img) => getImageSrc(img))
        .filter(isValidImage)
        .map(resolveUrl);

      const rid = getQuestionId(container);
      if (!rid) {
        return;
      }

      questions.push({
        rid,
        question_text: questionText,
        question_images: qImages,
        question_hash_id: md5(`${questionText.trim()}_${qImages.join("|")}`),
        full_score: extractQuestionScore(container, titleElem),
        index: container.getAttribute("index") || String(index + 1),
        q_name: container.getAttribute("name") || "",
      });
    });
    return questions;
  }

  function toNumber(value) {
    if (value == null || value === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function toScoreText(value) {
    const num = toNumber(value);
    if (num === null) {
      return "";
    }
    const fixed = (Math.round(num * 10) / 10).toFixed(1);
    return fixed.replace(/\.0$/, "");
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function applyFillPayload(entries) {
    const result = { filled: 0, missing: [] };

    for (const item of entries) {
      const rid = safeText(item.rid);
      if (!rid) {
        result.missing.push(rid);
        continue;
      }

      const scoreInput =
        document.querySelector(`input.questionScore[rid="${rid}"]`) ||
        document.querySelector(`input[name="score${rid}"]`) ||
        document.querySelector(`#score${rid}`) ||
        document.querySelector(`#obj_score${rid}`);

      if (!scoreInput) {
        result.missing.push(rid);
        continue;
      }

      const scoreText = toScoreText(item.score);
      if (!scoreText) {
        result.missing.push(rid);
        continue;
      }

      scoreInput.value = scoreText;
      ["input", "keyup", "change", "blur"].forEach((eventName) => {
        scoreInput.dispatchEvent(new Event(eventName, { bubbles: true }));
      });

      const comment = String(item.comment || "");
      const textarea =
        document.querySelector(`textarea#answer${rid}`) ||
        document.querySelector(`textarea[name="answer${rid}"]`);
      if (textarea) {
        textarea.value = comment;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        const box = textarea.closest(".kark_comment");
        if (box) {
          const inputBox = box.querySelector(".kark_comment_input");
          const editBox = box.querySelector(".kark_comment_edit");
          if (inputBox) {
            inputBox.style.display = "none";
          }
          if (editBox) {
            editBox.style.display = "block";
          }
        }
      }

      if (window.UE) {
        try {
          const editor = window.UE.getEditor(`answer${rid}`);
          if (editor && typeof editor.setContent === "function") {
            const safe = escapeHtml(comment);
            const html = safe ? `<p>${safe.replace(/\n+/g, "</p><p>")}</p>` : "";
            editor.setContent(html);
          }
        } catch (error) {
          // Ignore editor errors.
        }
      }

      if (typeof window.updateMarkChange === "function") {
        window.updateMarkChange();
      }
      result.filled += 1;
    }

    if (typeof window.refresh === "function") {
      window.refresh();
    }
    if (typeof window.refreshObjScore === "function") {
      window.refreshObjScore();
    }
    return result;
  }

  function buildQuestionMaps(pageQuestions) {
    const byHash = new Map();
    const byText = new Map();

    pageQuestions.forEach((question) => {
      const hash = safeText(question.question_hash_id);
      const textKey = normalizeTextForMatch(question.question_text);
      if (hash) {
        if (!byHash.has(hash)) {
          byHash.set(hash, []);
        }
        byHash.get(hash).push(question);
      }
      if (textKey) {
        if (!byText.has(textKey)) {
          byText.set(textKey, []);
        }
        byText.get(textKey).push(question);
      }
    });

    return { byHash, byText };
  }

  function findQuestionTarget(row, maps, usedRids) {
    const hashKey = safeText(row.question_hash_id);
    if (hashKey && maps.byHash.has(hashKey)) {
      const target = maps.byHash.get(hashKey).find((candidate) => !usedRids.has(candidate.rid));
      if (target) {
        return target;
      }
    }

    const textKey = normalizeTextForMatch(row.q_content || row.question_text || "");
    if (textKey && maps.byText.has(textKey)) {
      const target = maps.byText.get(textKey).find((candidate) => !usedRids.has(candidate.rid));
      if (target) {
        return target;
      }
    }

    return null;
  }

  function legacyWaitForSubmitRequestUnused(timeoutMs) {
    return new Promise((resolve) => {
      const requestPattern = "/work/library/save-review";
      let settled = false;

      const settle = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(payload);
      };

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      const originalFetch = window.fetch;

      function cleanup() {
        XMLHttpRequest.prototype.open = originalOpen;
        XMLHttpRequest.prototype.send = originalSend;
        if (originalFetch) {
          window.fetch = originalFetch;
        }
      }

      XMLHttpRequest.prototype.open = function (method, url) {
        this.__cxEdgeMeta = {
          method: safeText(method).toUpperCase(),
          url: safeText(url),
        };
        return originalOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function () {
        const meta = this.__cxEdgeMeta || {};
        if (meta.method === "POST" && meta.url.includes(requestPattern)) {
          this.addEventListener("load", () => {
            let data = null;
            try {
              data = JSON.parse(this.responseText || "{}");
            } catch (error) {
              data = null;
            }
            settle({
              ok: !!(data && data.status),
              status: this.status,
              source: "xhr",
              data,
              message: safeText((data && data.msg) || "") || `HTTP ${this.status}`,
            });
          });
          this.addEventListener("error", () => {
            settle({
              ok: false,
              status: this.status || 0,
              source: "xhr",
              message: "提交请求失败（XHR error）",
            });
          });
        }
        return originalSend.apply(this, arguments);
      };

      if (typeof originalFetch === "function") {
        window.fetch = async function () {
          const response = await originalFetch.apply(this, arguments);
          try {
            const input = arguments[0];
            const init = arguments[1] || {};
            const method = safeText((init && init.method) || "GET").toUpperCase();
            const url =
              typeof input === "string"
                ? input
                : safeText(input && input.url);
            if (method === "POST" && safeText(url).includes(requestPattern)) {
              let data = null;
              try {
                data = JSON.parse(await response.clone().text());
              } catch (error) {
                data = null;
              }
              settle({
                ok: !!(data && data.status) || response.ok,
                status: response.status,
                source: "fetch",
                data,
                message: safeText((data && data.msg) || "") || `HTTP ${response.status}`,
              });
            }
          } catch (error) {
            // Ignore fetch inspection errors.
          }
          return response;
        };
      }

      window.setTimeout(() => {
        settle({
          ok: false,
          timeout: true,
          source: "timeout",
          message: "未捕获到保存请求，可能页面前端实现已变化",
        });
      }, Math.max(5000, Number(timeoutMs) || 30000));
    });
  }

  function isSaveReviewRequest(method, url) {
    return (
      safeText(method).toUpperCase() === "POST" &&
      resolveUrl(url).includes(SAVE_REVIEW_REQUEST_PATTERN)
    );
  }

  function buildSubmitRequestPayload(source, status, data, fallbackMessage, extra) {
    const normalizedStatus = Number(status) || 0;
    const explicitStatus =
      data && typeof data === "object" && typeof data.status === "boolean"
        ? data.status
        : null;
    const message =
      safeText(data && typeof data === "object" && (data.msg || data.message || data.error)) ||
      safeText(fallbackMessage) ||
      (normalizedStatus ? `HTTP ${normalizedStatus}` : "Save review request failed");
    return Object.assign(
      {
        ok: explicitStatus === null ? normalizedStatus >= 200 && normalizedStatus < 300 : explicitStatus,
        status: normalizedStatus,
        source,
        data: data && typeof data === "object" ? data : null,
        message,
      },
      extra || {}
    );
  }

  function notifySubmitRequestWaiters(payload) {
    if (!submitRequestWaiters.size) {
      return;
    }
    const waiters = Array.from(submitRequestWaiters.values());
    submitRequestWaiters.clear();
    waiters.forEach((settle) => {
      try {
        settle(payload);
      } catch (error) {
        // Ignore waiter cleanup errors.
      }
    });
  }

  function installSubmitRequestObserver() {
    if (submitRequestObserverInstalled) {
      return;
    }
    submitRequestObserverInstalled = true;

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__cxEdgeSubmitMeta = {
        method: safeText(method).toUpperCase(),
        url: resolveUrl(url),
      };
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const meta = this.__cxEdgeSubmitMeta || {};
      if (isSaveReviewRequest(meta.method, meta.url)) {
        this.addEventListener("load", () => {
          const data = parseJsonSafely(this.responseText || "");
          notifySubmitRequestWaiters(
            buildSubmitRequestPayload("xhr", this.status, data, "", {
              url: meta.url,
            })
          );
        });
        this.addEventListener("error", () => {
          notifySubmitRequestWaiters({
            ok: false,
            status: this.status || 0,
            source: "xhr",
            url: meta.url,
            message: "Save review request failed (XHR error)",
          });
        });
        this.addEventListener("abort", () => {
          notifySubmitRequestWaiters({
            ok: false,
            status: this.status || 0,
            source: "xhr",
            url: meta.url,
            message: "Save review request was aborted",
          });
        });
      }
      return originalSend.apply(this, arguments);
    };

    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch;
      window.fetch = async function () {
        const input = arguments[0];
        const init = arguments[1] || {};
        const method = safeText((init && init.method) || (input && input.method) || "GET").toUpperCase();
        const url =
          typeof input === "string"
            ? input
            : safeText(input && input.url);
        const observed = isSaveReviewRequest(method, url);
        try {
          const response = await originalFetch.apply(this, arguments);
          if (observed) {
            const data = parseJsonSafely(await response.clone().text());
            notifySubmitRequestWaiters(
              buildSubmitRequestPayload("fetch", response.status, data, "", {
                url: resolveUrl(response.url || url),
              })
            );
          }
          return response;
        } catch (error) {
          if (observed) {
            notifySubmitRequestWaiters({
              ok: false,
              status: 0,
              source: "fetch",
              url: resolveUrl(url),
              message: safeText(error && error.message) || "Save review request failed",
            });
          }
          throw error;
        }
      };
    }
  }

  function waitForSubmitRequest(timeoutMs) {
    installSubmitRequestObserver();
    return new Promise((resolve) => {
      submitRequestWaiterId += 1;
      const waiterId = `waiter-${Date.now()}-${submitRequestWaiterId}`;
      let settled = false;
      const settle = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        submitRequestWaiters.delete(waiterId);
        window.clearTimeout(timer);
        resolve(payload);
      };
      const timer = window.setTimeout(() => {
        settle({
          ok: false,
          timeout: true,
          source: "timeout",
          message: "Save review request was not observed before timeout",
        });
      }, Math.max(5000, Number(timeoutMs) || 30000));
      submitRequestWaiters.set(waiterId, settle);
    });
  }

  async function submitCurrentPage(timeoutMs, mode) {
    const submitMode = safeText(mode) || "current";
    const actionFlag = submitMode === "next" ? "markAction(0)" : "markAction(1)";
    const submitBtn =
      document.querySelector(`a[onclick*='${actionFlag}']`) ||
      document.querySelector(`button[onclick*='${actionFlag}']`);
    if (!submitBtn) {
      return { ok: false, mode: submitMode, message: `未找到提交按钮（${actionFlag}）` };
    }

    const waiter = waitForSubmitRequest(timeoutMs);
    submitBtn.click();

    const confirmDeadline = Date.now() + 5000;
    while (Date.now() < confirmDeadline) {
      const confirmBtn = document.querySelector("#confirmPop2 .confirmHref");
      if (confirmBtn && isVisible(confirmBtn)) {
        confirmBtn.click();
        break;
      }
      await sleep(200);
    }

    const result = await waiter;
    return Object.assign({ mode: submitMode }, result || {});
  }

  function countSubmissionRows() {
    const ulRows = document.querySelectorAll("ul.dataBody_td");
    if (ulRows.length) {
      return ulRows.length;
    }

    const tableRows = Array.from(document.querySelectorAll("tr")).filter((row) => {
      const tds = row.querySelectorAll("td");
      if (tds.length < 5) {
        return false;
      }
      const text = normalizeText(row.textContent || "");
      return text.includes("待批") || text.includes("已批") || text.includes("学号") || text.includes("提交");
    });
    return tableRows.length;
  }

  function readPageValue(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      const value = safeText(node.value || node.getAttribute("value") || "");
      if (value) {
        return value;
      }
    }
    return "";
  }

  function buildMarkListUrl(payload) {
    const page = Math.max(1, Number((payload && payload.page) || 1));
    const size = Math.max(
      1,
      Number((payload && payload.size) || readPageValue(["#prePageSize", "#initSize"]) || 12)
    );
    const params = new URLSearchParams();
    const pairs = {
      courseid: readPageValue(["#courseid"]),
      clazzid: readPageValue(["#clazzid", "#classid", "#classId"]),
      workid: readPageValue(["#workid"]),
      submit: readPageValue(["#submit"]),
      status: readPageValue(["#status"]),
      groupId: readPageValue(["#groupId"]) || "0",
      cpi: readPageValue(["#cpi"]),
      evaluation: readPageValue(["#evaluation"]),
      sort: readPageValue(["#sort"]) || "0",
      order: readPageValue(["#order"]) || "0",
      unEval: readPageValue(["#unEval"]),
      search: readPageValue(["#search"]),
      from: readPageValue(["#from"]),
      topicid: readPageValue(["#topicid"]),
      pages: String(page),
      size: String(size),
    };

    Object.entries(pairs).forEach(([key, value]) => {
      if (value !== "") {
        params.set(key, value);
      }
    });

    return `/mooc2-ans/work/mark-list?${params.toString()}`;
  }

  async function legacyFetchSubmissionListHtmlUnused(payload) {
    const url = buildMarkListUrl(payload || {});
    const response = await fetch(url, {
      credentials: "include",
      method: "GET",
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

  async function legacyLoadSubmissionListUnused(payload) {
    const timeoutMs = Math.max(3000, Number((payload && payload.timeoutMs) || 12000));
    const targetPage = Math.max(1, Number((payload && payload.page) || 1));
    const pageSize = Math.max(
      1,
      Number((payload && payload.size) || readPageValue(["#prePageSize", "#initSize"]) || 12)
    );

    if (countSubmissionRows() > 0) {
      return { ok: true, loaded: true, row_count: countSubmissionRows(), source: "existing" };
    }

    if (typeof window.searchMarkList === "function") {
      try {
        window.searchMarkList(targetPage, pageSize);
      } catch (error) {
        // Ignore invocation errors and continue polling.
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rowCount = countSubmissionRows();
      if (rowCount > 0) {
        return { ok: true, loaded: true, row_count: rowCount, source: "searchMarkList" };
      }
      await sleep(300);
    }

    try {
      const result = await fetchSubmissionListHtml({
        page: targetPage,
        size: pageSize,
      });
      const dataBody = document.querySelector(".dataBody");
      if (dataBody) {
        replaceSubmissionListHtml(result.html);
      }
      const rowCount = countSubmissionRows();
      if (rowCount > 0) {
        return {
          ok: true,
          loaded: true,
          row_count: rowCount,
          source: "directFetch",
          url: result.url,
        };
      }
    } catch (error) {
      return {
        ok: false,
        loaded: false,
        row_count: 0,
        source: "directFetchError",
        message: error.message || String(error),
      };
    }

    return { ok: false, loaded: false, row_count: 0, source: "timeout" };
  }

  function replaceSubmissionListHtml(html) {
    const target = document.querySelector(".dataBody");
    if (!target) {
      return false;
    }

    const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
    const sourceContainer = parsed.querySelector(".dataBody");
    const sourceNodes = sourceContainer && sourceContainer.children.length
      ? Array.from(sourceContainer.children)
      : Array.from(parsed.querySelectorAll("ul.dataBody_td, tr"));

    if (!sourceNodes.length) {
      return false;
    }

    const fragment = document.createDocumentFragment();
    sourceNodes.forEach((node) => {
      if (!(node instanceof Element)) {
        return;
      }
      if (safeText(node.tagName).toUpperCase() === "SCRIPT") {
        return;
      }
      fragment.appendChild(document.importNode(node, true));
    });

    if (!fragment.childNodes.length) {
      return false;
    }

    target.replaceChildren(fragment);
    return true;
  }

  async function fetchSubmissionListHtml(payload) {
    const url = buildMarkListUrl(payload || {});
    const result = await fetchTextWithTimeout(
      url,
      {
        credentials: "include",
        method: "GET",
      },
      Math.max(3000, Number((payload && payload.timeoutMs) || 12000))
    );
    return {
      url: result.url || url,
      html: result.text || "",
    };
  }

  async function loadSubmissionList(payload) {
    const timeoutMs = Math.max(3000, Number((payload && payload.timeoutMs) || 12000));
    const targetPage = Math.max(1, Number((payload && payload.page) || 1));
    const pageSize = Math.max(
      1,
      Number((payload && payload.size) || readPageValue(["#prePageSize", "#initSize"]) || 12)
    );

    if (countSubmissionRows() > 0) {
      return { ok: true, loaded: true, row_count: countSubmissionRows(), source: "existing" };
    }

    if (typeof window.searchMarkList === "function") {
      try {
        window.searchMarkList(targetPage, pageSize);
      } catch (error) {
        // Ignore invocation errors and continue polling.
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rowCount = countSubmissionRows();
      if (rowCount > 0) {
        return { ok: true, loaded: true, row_count: rowCount, source: "searchMarkList" };
      }
      await sleep(300);
    }

    try {
      const result = await fetchSubmissionListHtml({
        page: targetPage,
        size: pageSize,
        timeoutMs,
      });
      if (!replaceSubmissionListHtml(result.html)) {
        return {
          ok: false,
          loaded: false,
          row_count: 0,
          source: "directFetchParse",
          message: "Fetched mark-list HTML did not contain a recognizable submission list",
          url: result.url,
        };
      }
      const rowCount = countSubmissionRows();
      if (rowCount > 0) {
        return {
          ok: true,
          loaded: true,
          row_count: rowCount,
          source: "directFetch",
          url: result.url,
        };
      }
    } catch (error) {
      return {
        ok: false,
        loaded: false,
        row_count: 0,
        source: "directFetchError",
        message: error.message || String(error),
      };
    }

    return { ok: false, loaded: false, row_count: 0, source: "timeout" };
  }

  async function applyGradingRows(payload) {
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    const pageQuestions = extractPageQuestions();
    const maps = buildQuestionMaps(pageQuestions);
    const usedRids = new Set();
    const fillEntries = [];
    const unmatched = [];

    rows.forEach((row) => {
      if (!row || typeof row !== "object") {
        return;
      }
      const target = findQuestionTarget(row, maps, usedRids);
      if (!target) {
        unmatched.push(row);
        return;
      }

      const gradingScore = toNumber(row.grading_score);
      if (gradingScore === null) {
        unmatched.push(row);
        return;
      }

      let submitScore = gradingScore;
      const fullScore = toNumber(target.full_score);
      if (fullScore !== null && fullScore >= 0) {
        if (gradingScore > fullScore + 1e-6) {
          submitScore = (fullScore * clamp(gradingScore, 0, 100)) / 100;
        }
        submitScore = clamp(submitScore, 0, fullScore);
      } else {
        submitScore = Math.max(submitScore, 0);
      }

      usedRids.add(target.rid);
      fillEntries.push({
        rid: target.rid,
        score: submitScore,
        comment: safeText(row.grading_comment || row.comment || ""),
        question_hash_id: safeText(row.question_hash_id),
        q_content: safeText(row.q_content || row.question_text || ""),
      });
    });

    const fillResult = applyFillPayload(fillEntries);
    let submitResult = null;
    if (payload && payload.submitAfterApply) {
      submitResult = await submitCurrentPage(
        payload.timeoutMs || 30000,
        payload.submitMode || "current"
      );
    }

    return {
      input_row_count: rows.length,
      page_question_count: pageQuestions.length,
      matched_count: fillEntries.length,
      filled_count: fillResult.filled,
      missing_rids: fillResult.missing,
      unmatched_count: unmatched.length,
      unmatched,
      submit_result: submitResult,
    };
  }

  async function handleAction(action, payload) {
    switch (action) {
      case "loadSubmissionList":
        return loadSubmissionList(payload || {});
      case "applyGradingRows":
        return applyGradingRows(payload || {});
      case "submitCurrentPage":
        return submitCurrentPage(
          (payload && payload.timeoutMs) || 30000,
          (payload && payload.mode) || "current"
        );
      default:
        throw new Error(`不支持的桥接动作: ${action}`);
    }
  }

  function respond(id, ok, result, error) {
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          id,
          ok,
          result: result || null,
          error: error || "",
        },
      })
    );
  }

  window.addEventListener(REQUEST_EVENT, (event) => {
    const detail = event && event.detail ? event.detail : {};
    const id = detail.id;
    Promise.resolve(handleAction(detail.action, detail.payload || {}))
      .then((result) => {
        respond(id, true, result, "");
      })
      .catch((error) => {
        respond(id, false, null, error.message || String(error));
      });
  });
})();
