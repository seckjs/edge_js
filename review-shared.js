(function (global) {
  function safeText(value) {
    return String(value == null ? "" : value).trim();
  }

  function cloneModelOption(item) {
    if (item && typeof item === "object") {
      const value = safeText(item.value || item.label);
      if (!value) {
        return null;
      }
      return {
        label: safeText(item.label) || value,
        value,
      };
    }

    const value = safeText(item);
    if (!value) {
      return null;
    }
    return {
      label: value,
      value,
    };
  }

  const STORAGE_KEYS = {
    autoExtract: "lastAutoExtractData",
    reviewSettings: "review_ai_panel_settings",
    reviewSettingsSession: "review_ai_panel_settings_session",
    reviewBatchQueue: "review_ai_batch_queue",
    autoCrawlRuntime: "cx_auto_crawl_runtime_v1",
  };

  const API_PROVIDER_PRESETS = [
    {
      id: "moonshot",
      label: "Moonshot / Kimi",
      endpoint: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
      models: [
        "moonshot-v1-8k",
        "moonshot-v1-32k",
        "moonshot-v1-128k",
        "moonshot-v1-8k-vision-preview",
        "kimi-k2.6",
        "kimi-k2.5",
        "kimi-k2-0905-preview",
        "kimi-k2-thinking",
      ],
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/v1",
      model: "DeepSeek-V3.1",
      models: [
        "DeepSeek-V3.1",
        "DeepSeek-V3.1-Terminus",
        "deepseek-chat",
        "deepseek-reasoner",
      ],
    },
    {
      id: "openai",
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5.4",
      models: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.1", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    },
    {
      id: "gemini",
      label: "Google Gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-2.5-flash",
      models: [
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
      ],
    },
    {
      id: "zhipu",
      label: "Zhipu GLM",
      endpoint: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.1",
      models: ["glm-5.1", "glm-5v-turbo", "glm-5", "glm-4.7", "glm-4.5-air"],
    },
    {
      id: "minimax",
      label: "MiniMax",
      endpoint: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2.7",
      models: ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-Text-01"],
    },
    {
      id: "doubao",
      label: "Doubao",
      endpoint: "https://operator.las.cn-beijing.volces.com/api/v1",
      model: "Doubao-Seed-2.0-Code",
      models: ["Doubao-Seed-2.0-Code", "Doubao-Seed-1.8", "Doubao-Seed-Code", "Doubao-Pro-32k"],
    },
    {
      id: "qwen",
      label: "Qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "Qwen3.5-Plus",
      models: ["Qwen3.5-Plus", "Qwen3-Coder-Next", "qwen-plus", "qwen-turbo", "qwen-max"],
    },
    {
      id: "custom",
      label: "Custom",
      endpoint: "",
      model: "",
      models: [],
    },
  ].map((preset) =>
    Object.assign({}, preset, {
      models: (preset.models || []).map(cloneModelOption).filter(Boolean),
    })
  );

  function getDefaultReviewSettings() {
    return {
      provider: "moonshot",
      endpoint: "https://api.moonshot.cn/v1",
      apiKey: "",
      rememberApiKey: false,
      model: "kimi-k2.6",
      timeoutSeconds: 20,
      extraPrompt: "",
      autoFill: true,
      autoSubmit: false,
      submitMode: "current",
    };
  }

  function getProviderPreset(providerId) {
    return API_PROVIDER_PRESETS.find((item) => item.id === providerId) || API_PROVIDER_PRESETS[0];
  }

  function getProviderModels(providerId) {
    return getProviderPreset(providerId).models.map((item) => Object.assign({}, item));
  }

  function inferProviderFromEndpoint(endpoint) {
    const text = safeText(endpoint).toLowerCase();
    if (!text) {
      return "custom";
    }
    const matched = API_PROVIDER_PRESETS.find((item) => item.endpoint && text.startsWith(item.endpoint.toLowerCase()));
    return matched ? matched.id : "custom";
  }

  function normalizeAiEndpoint(rawUrl) {
    const input = safeText(rawUrl);
    if (!input) {
      throw new Error("AI endpoint cannot be empty");
    }

    let url;
    try {
      url = new URL(input);
    } catch (error) {
      throw new Error("AI endpoint is not a valid URL");
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

  function buildAiOriginPattern(rawUrl) {
    const input = safeText(rawUrl);
    if (!input) {
      return "";
    }
    let url;
    try {
      url = new URL(input);
    } catch (error) {
      try {
        url = new URL(normalizeAiEndpoint(input));
      } catch (nestedError) {
        return "";
      }
    }
    return `${url.protocol}//${url.host}/*`;
  }

  const BUILTIN_AI_HOST_PATTERNS = Array.from(
    new Set(
      API_PROVIDER_PRESETS.map((item) => buildAiOriginPattern(item.endpoint)).filter(Boolean)
    )
  );

  function normalizeReviewSettings(rawSettings) {
    const defaults = getDefaultReviewSettings();
    const merged = Object.assign({}, defaults, rawSettings || {});
    const provider = safeText(merged.provider) || inferProviderFromEndpoint(merged.endpoint) || defaults.provider;
    const preset = getProviderPreset(provider);
    const timeoutSource =
      merged.timeoutSeconds !== undefined && merged.timeoutSeconds !== null && merged.timeoutSeconds !== ""
        ? merged.timeoutSeconds
        : merged.timeout;
    const parsedTimeoutSeconds = Number(timeoutSource);
    return {
      provider,
      endpoint: safeText(merged.endpoint) || preset.endpoint || defaults.endpoint,
      apiKey: safeText(merged.apiKey),
      rememberApiKey: !!merged.rememberApiKey,
      model: safeText(merged.model) || preset.model || defaults.model,
      timeoutSeconds:
        Number.isFinite(parsedTimeoutSeconds) && parsedTimeoutSeconds > 0
          ? Math.max(5, Math.min(parsedTimeoutSeconds, 300))
          : defaults.timeoutSeconds,
      extraPrompt: safeText(merged.extraPrompt),
      autoFill: merged.autoFill !== false,
      autoSubmit: !!merged.autoSubmit,
      submitMode: safeText(merged.submitMode) || defaults.submitMode,
    };
  }

  async function getStorageArea(areaName) {
    const area = global.chrome && global.chrome.storage ? global.chrome.storage[areaName] : null;
    if (!area) {
      throw new Error(`chrome.storage.${areaName} is unavailable`);
    }
    return area;
  }

  async function readReviewSettingsFromStorage() {
    const localArea = await getStorageArea("local");
    const sessionArea = await getStorageArea("session");
    const [localResult, sessionResult] = await Promise.all([
      localArea.get([STORAGE_KEYS.reviewSettings]),
      sessionArea.get([STORAGE_KEYS.reviewSettingsSession]),
    ]);
    const localSettings = (localResult && localResult[STORAGE_KEYS.reviewSettings]) || {};
    const sessionSettings = (sessionResult && sessionResult[STORAGE_KEYS.reviewSettingsSession]) || {};
    return normalizeReviewSettings(
      Object.assign({}, localSettings || {}, {
        apiKey: safeText(sessionSettings.apiKey) || safeText(localSettings.apiKey),
      })
    );
  }

  async function writeReviewSettingsToStorage(rawSettings) {
    const merged = normalizeReviewSettings(rawSettings);
    const localArea = await getStorageArea("local");
    const sessionArea = await getStorageArea("session");
    const updatedAt = new Date().toISOString();
    await Promise.all([
      localArea.set({
        [STORAGE_KEYS.reviewSettings]: Object.assign({}, merged, {
          apiKey: merged.rememberApiKey ? merged.apiKey : "",
          updatedAt,
        }),
      }),
      sessionArea.set({
        [STORAGE_KEYS.reviewSettingsSession]: {
          apiKey: merged.rememberApiKey ? "" : merged.apiKey,
          updatedAt,
        },
      }),
    ]);
    return merged;
  }

  async function hasOriginPermission(pattern) {
    if (!pattern || !global.chrome || !global.chrome.permissions || typeof global.chrome.permissions.contains !== "function") {
      return false;
    }
    return !!(await global.chrome.permissions.contains({ origins: [pattern] }));
  }

  async function ensureAiEndpointPermission(rawEndpoint, options) {
    const normalizedEndpoint = normalizeAiEndpoint(rawEndpoint);
    const pattern = buildAiOriginPattern(normalizedEndpoint);
    const requestIfMissing = !!(options && options.requestIfMissing);

    if (!pattern) {
      throw new Error("Unable to resolve the AI endpoint origin");
    }

    if (BUILTIN_AI_HOST_PATTERNS.includes(pattern)) {
      return {
        ok: true,
        endpoint: normalizedEndpoint,
        pattern,
        granted: true,
        requested: false,
      };
    }

    const alreadyGranted = await hasOriginPermission(pattern);
    if (alreadyGranted) {
      return {
        ok: true,
        endpoint: normalizedEndpoint,
        pattern,
        granted: true,
        requested: false,
      };
    }

    if (!requestIfMissing) {
      return {
        ok: false,
        endpoint: normalizedEndpoint,
        pattern,
        granted: false,
        requested: false,
      };
    }

    if (!global.chrome || !global.chrome.permissions || typeof global.chrome.permissions.request !== "function") {
      throw new Error("The permissions API is unavailable");
    }

    const granted = !!(await global.chrome.permissions.request({ origins: [pattern] }));
    return {
      ok: granted,
      endpoint: normalizedEndpoint,
      pattern,
      granted,
      requested: true,
    };
  }

  global.CX_REVIEW_SHARED = {
    STORAGE_KEYS,
    API_PROVIDER_PRESETS,
    BUILTIN_AI_HOST_PATTERNS,
    buildAiOriginPattern,
    ensureAiEndpointPermission,
    getDefaultReviewSettings,
    getProviderModels,
    getProviderPreset,
    inferProviderFromEndpoint,
    normalizeAiEndpoint,
    normalizeReviewSettings,
    readReviewSettingsFromStorage,
    safeText,
    writeReviewSettingsToStorage,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
