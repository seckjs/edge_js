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

  function cloneProviderPreset(item) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const id = safeText(item.id);
    if (!id) {
      return null;
    }
    return {
      id,
      label: safeText(item.label) || id,
      endpoint: safeText(item.endpoint),
      model: safeText(item.model),
      models: (Array.isArray(item.models) ? item.models : []).map(cloneModelOption).filter(Boolean),
    };
  }

  const STORAGE_KEYS = {
    autoExtract: "lastAutoExtractData",
    reviewSettings: "review_ai_panel_settings",
    reviewSettingsSession: "review_ai_panel_settings_session",
    reviewBatchQueue: "review_ai_batch_queue",
    autoCrawlRuntime: "cx_auto_crawl_runtime_v1",
    pluginGatewayAuthState: "cx_plugin_gateway_auth_state_v1",
    pluginGatewaySession: "cx_plugin_gateway_session_v1",
  };

  const REVIEW_MODEL_OPTIONS = [
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
    { label: "GPT-5.2", value: "gpt-5.2" },
    { label: "GPT-4.1", value: "gpt-4.1" },
    { label: "Kimi K2.6", value: "kimi-k2.6" },
    { label: "DeepSeek V3.1", value: "DeepSeek-V3.1" },
    { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
    { label: "GLM-5.1", value: "glm-5.1" },
    { label: "Qwen3.5 Plus", value: "Qwen3.5-Plus" },
    { label: "Doubao Seed 2.0 Code", value: "Doubao-Seed-2.0-Code" },
    { label: "MiniMax M2.7", value: "MiniMax-M2.7" },
  ]
    .map(cloneModelOption)
    .filter(Boolean);

  const REVIEW_API_PROVIDER_PRESETS = [
    {
      id: "moonshot",
      label: "Moonshot / Kimi",
      endpoint: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
      models: [
        { label: "Kimi K2.6", value: "kimi-k2.6" },
        { label: "Kimi K2.5", value: "kimi-k2.5" },
        { label: "Kimi K2 Thinking", value: "kimi-k2-thinking" },
      ],
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/v1",
      model: "DeepSeek-V3.1",
      models: [
        { label: "DeepSeek V3.1", value: "DeepSeek-V3.1" },
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
        { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
        { label: "GPT-5.2", value: "gpt-5.2" },
        { label: "GPT-4.1", value: "gpt-4.1" },
      ],
    },
    {
      id: "gemini",
      label: "Google Gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-2.5-flash",
      models: [
        { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
        { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
      ],
    },
    {
      id: "zhipu",
      label: "GLM",
      endpoint: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.1",
      models: [
        { label: "GLM-5.1", value: "glm-5.1" },
        { label: "GLM-5", value: "glm-5" },
      ],
    },
    {
      id: "minimax",
      label: "MiniMax",
      endpoint: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2.7",
      models: [
        { label: "MiniMax M2.7", value: "MiniMax-M2.7" },
        { label: "MiniMax M2.5", value: "MiniMax-M2.5" },
      ],
    },
    {
      id: "doubao",
      label: "Doubao",
      endpoint: "https://operator.las.cn-beijing.volces.com/api/v1",
      model: "Doubao-Seed-2.0-Code",
      models: [
        { label: "Doubao Seed 2.0 Code", value: "Doubao-Seed-2.0-Code" },
        { label: "Doubao Seed 1.8", value: "Doubao-Seed-1.8" },
      ],
    },
    {
      id: "qwen",
      label: "Qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "Qwen3.5-Plus",
      models: [
        { label: "Qwen3.5 Plus", value: "Qwen3.5-Plus" },
        { label: "qwen-plus", value: "qwen-plus" },
        { label: "qwen-max", value: "qwen-max" },
      ],
    },
    {
      id: "custom",
      label: "Custom",
      endpoint: "",
      model: "",
      models: [],
    },
  ]
    .map(cloneProviderPreset)
    .filter(Boolean);

  const PLUGIN_GATEWAY_CONFIG = {
    gatewayBaseUrl: "https://your-plugin-gateway.example.com",
    registerPath: "/plugin/devices/register",
    sessionPath: "/plugin/session",
    healthPath: "/plugin/health",
    chatPath: "/plugin/v1/chat/completions",
    audience: "chaoxing-edge-plugin",
    channel: "edge",
    signatureVersion: "v1",
    sessionRefreshWindowSeconds: 45,
    requestSkewSeconds: 60,
  };

  function isGatewayMode(mode) {
    return safeText(mode) !== "custom_api";
  }

  function isCustomApiMode(mode) {
    return safeText(mode) === "custom_api";
  }

  function getProviderPreset(providerId) {
    const targetId = safeText(providerId);
    const matched = REVIEW_API_PROVIDER_PRESETS.find((item) => item.id === targetId);
    return cloneProviderPreset(matched || REVIEW_API_PROVIDER_PRESETS[REVIEW_API_PROVIDER_PRESETS.length - 1]);
  }

  function getProviderPresets() {
    return REVIEW_API_PROVIDER_PRESETS.map(cloneProviderPreset).filter(Boolean);
  }

  function getProviderModels(providerId) {
    return (getProviderPreset(providerId).models || []).map(cloneModelOption).filter(Boolean);
  }

  function inferProviderFromEndpoint(endpoint) {
    const text = safeText(endpoint).toLowerCase();
    if (!text) {
      return "custom";
    }
    const matched = REVIEW_API_PROVIDER_PRESETS.find((item) => {
      const presetText = safeText(item.endpoint).toLowerCase();
      return presetText && text.includes(presetText.replace(/\/+$/, ""));
    });
    return matched ? matched.id : "custom";
  }

  function getDefaultReviewSettings() {
    return {
      connectionMode: "plugin_gateway",
      gatewayBaseUrl: "",
      provider: "moonshot",
      endpoint: getProviderPreset("moonshot").endpoint,
      apiKey: "",
      rememberApiKey: false,
      licenseKey: "",
      rememberLicense: false,
      model: "gpt-5.4",
      timeoutSeconds: 20,
      extraPrompt: "",
      autoFill: true,
      autoSubmit: false,
      submitMode: "current",
    };
  }

  function getModelOptions(connectionMode, providerId) {
    if (isCustomApiMode(connectionMode)) {
      const providerModels = getProviderModels(providerId);
      if (providerModels.length) {
        return providerModels.map(cloneModelOption).filter(Boolean);
      }
    }
    return REVIEW_MODEL_OPTIONS.map(cloneModelOption).filter(Boolean);
  }

  function getDefaultModel() {
    return getDefaultReviewSettings().model;
  }

  function isPlaceholderGatewayBaseUrl(urlText) {
    const text = safeText(urlText).toLowerCase();
    return !text || text.includes("example.com") || text.includes("your-plugin-gateway");
  }

  function parseAllowedRemoteUrl(rawUrl, emptyMessage, invalidMessage) {
    const input = safeText(rawUrl);
    if (!input) {
      throw new Error(emptyMessage);
    }

    let url;
    try {
      url = new URL(input);
    } catch (error) {
      throw new Error(invalidMessage);
    }

    const host = safeText(url.hostname).toLowerCase();
    const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
      throw new Error("Remote API must use HTTPS (HTTP is only allowed for localhost)");
    }

    url.hash = "";
    url.search = "";
    return url;
  }

  function normalizeGatewayBaseUrl(rawUrl) {
    const url = parseAllowedRemoteUrl(
      rawUrl,
      "Plugin gateway URL is empty",
      "Plugin gateway URL is not a valid URL"
    );
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  }

  function normalizeAiEndpoint(rawUrl) {
    const url = parseAllowedRemoteUrl(
      rawUrl,
      "AI endpoint URL is empty",
      "AI endpoint URL is not a valid URL"
    );
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

  function getEffectiveGatewayBaseUrl(rawUrl) {
    const candidate = safeText(rawUrl);
    return candidate || safeText(PLUGIN_GATEWAY_CONFIG.gatewayBaseUrl);
  }

  function getGatewayBaseUrl(rawUrl) {
    return normalizeGatewayBaseUrl(getEffectiveGatewayBaseUrl(rawUrl));
  }

  function isGatewayConfigured(rawUrl) {
    return !isPlaceholderGatewayBaseUrl(getEffectiveGatewayBaseUrl(rawUrl));
  }

  function buildGatewayUrl(path, rawBaseUrl) {
    const baseUrl = getGatewayBaseUrl(rawBaseUrl);
    const normalizedPath = safeText(path).replace(/^\/*/, "/");
    return `${baseUrl}${normalizedPath}`;
  }

  function buildOriginPatternFromUrl(rawUrl) {
    const url = parseAllowedRemoteUrl(rawUrl, "Remote API URL is empty", "Remote API URL is not a valid URL");
    return `${url.protocol}//${url.host}/*`;
  }

  function buildGatewayOriginPattern(rawBaseUrl) {
    const url = new URL(normalizeGatewayBaseUrl(rawBaseUrl));
    return `${url.protocol}//${url.host}/*`;
  }

  function normalizeReviewSettings(rawSettings) {
    const defaults = getDefaultReviewSettings();
    const merged = Object.assign({}, defaults, rawSettings || {});
    const timeoutSource =
      merged.timeoutSeconds !== undefined && merged.timeoutSeconds !== null && merged.timeoutSeconds !== ""
        ? merged.timeoutSeconds
        : merged.timeout;
    const parsedTimeoutSeconds = Number(timeoutSource);
    const connectionMode = isCustomApiMode(merged.connectionMode) ? "custom_api" : "plugin_gateway";
    const endpoint = safeText(merged.endpoint);
    const inferredProvider = inferProviderFromEndpoint(endpoint);
    const provider =
      connectionMode === "custom_api"
        ? safeText(merged.provider) || inferredProvider || defaults.provider
        : "plugin_gateway";
    const preset = getProviderPreset(provider === "plugin_gateway" ? inferredProvider : provider);
    const model = safeText(merged.model) || preset.model || defaults.model;
    return {
      connectionMode,
      gatewayBaseUrl: safeText(merged.gatewayBaseUrl),
      provider,
      endpoint: connectionMode === "custom_api" ? endpoint : safeText(merged.endpoint),
      apiKey: safeText(merged.apiKey),
      rememberApiKey: !!merged.rememberApiKey,
      licenseKey: safeText(merged.licenseKey),
      rememberLicense: !!merged.rememberLicense,
      model,
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
      Object.assign({}, localSettings || {}, sessionSettings || {}, {
        licenseKey: safeText(sessionSettings.licenseKey) || safeText(localSettings.licenseKey),
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
          licenseKey: merged.rememberLicense ? merged.licenseKey : "",
          apiKey: merged.rememberApiKey ? merged.apiKey : "",
          updatedAt,
        }),
      }),
      sessionArea.set({
        [STORAGE_KEYS.reviewSettingsSession]: {
          licenseKey: merged.rememberLicense ? "" : merged.licenseKey,
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

  async function ensureOriginPermission(pattern, options) {
    const requestIfMissing = !!(options && options.requestIfMissing);
    if (!pattern) {
      throw new Error("Unable to resolve the requested origin");
    }

    const alreadyGranted = await hasOriginPermission(pattern);
    if (alreadyGranted) {
      return {
        ok: true,
        pattern,
        granted: true,
        requested: false,
      };
    }

    if (!requestIfMissing) {
      return {
        ok: false,
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
      pattern,
      granted,
      requested: true,
    };
  }

  async function ensureGatewayPermission(rawBaseUrl, options) {
    const normalizedBaseUrl = normalizeGatewayBaseUrl(rawBaseUrl || PLUGIN_GATEWAY_CONFIG.gatewayBaseUrl);
    const pattern = buildGatewayOriginPattern(normalizedBaseUrl);
    const result = await ensureOriginPermission(pattern, options);
    return Object.assign({}, result, {
      baseUrl: normalizedBaseUrl,
    });
  }

  async function ensureAiEndpointPermission(rawUrl, options) {
    const normalizedEndpoint = normalizeAiEndpoint(rawUrl);
    const pattern = buildOriginPatternFromUrl(normalizedEndpoint);
    const result = await ensureOriginPermission(pattern, options);
    return Object.assign({}, result, {
      endpoint: normalizedEndpoint,
    });
  }

  global.CX_REVIEW_SHARED = {
    STORAGE_KEYS,
    PLUGIN_GATEWAY_CONFIG: Object.freeze(Object.assign({}, PLUGIN_GATEWAY_CONFIG)),
    REVIEW_MODEL_OPTIONS: getModelOptions(),
    REVIEW_API_PROVIDER_PRESETS: getProviderPresets(),
    buildGatewayOriginPattern,
    buildGatewayUrl,
    buildOriginPatternFromUrl,
    ensureAiEndpointPermission,
    ensureGatewayPermission,
    getDefaultModel,
    getDefaultReviewSettings,
    getGatewayBaseUrl,
    getModelOptions,
    getProviderModels,
    getProviderPreset,
    getProviderPresets,
    inferProviderFromEndpoint,
    isCustomApiMode,
    isGatewayConfigured,
    isGatewayMode,
    normalizeAiEndpoint,
    normalizeGatewayBaseUrl,
    normalizeReviewSettings,
    readReviewSettingsFromStorage,
    safeText,
    writeReviewSettingsToStorage,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
