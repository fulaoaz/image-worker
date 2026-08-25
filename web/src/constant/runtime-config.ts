// Runtime configuration access layer.
// Priority: window.__RUNTIME_CONFIG__ (injected by the container entrypoint) > build-time VITE_ variables > defaults.
// This supports both configuring the same image with docker run -e and injecting values during custom builds.
//
// Each analytics provider has its own variable; configured providers are enabled independently and all are disabled by default.
// Only GA4 and Baidu are supported. Both accept IDs only, and script URLs are assembled in code without arbitrary scripts or inline JavaScript.

type RuntimeConfig = {
    ANALYTICS_GA4_ID?: string; // GA4 measurement ID (G-XXXX)
    ANALYTICS_BAIDU_ID?: string; // Baidu Analytics site ID
    AI_CHANNELS?: string; // 预置模型渠道 JSON 数组，部署方用环境变量下发，见 readRuntimeAiChannels
};

// 运行期预置的模型渠道。
// 纯静态部署没有服务端运行时，渠道由容器环境变量注入 config.js，浏览器首次初始化配置时并入。
// 注意：注入值会下发到浏览器，与「密钥只留服务端」不是同一安全等级，仅适合部署方自己可信的场景。
export type RuntimeAiChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    models: string[];
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
    return fallback;
}

export const ANALYTICS_GA4_ID = read("ANALYTICS_GA4_ID", import.meta.env.VITE_ANALYTICS_GA4_ID);
export const ANALYTICS_BAIDU_ID = read("ANALYTICS_BAIDU_ID", import.meta.env.VITE_ANALYTICS_BAIDU_ID);

// 解析注入的渠道 JSON。单个渠道字段不合法时跳过该项，不让一处笔误清空全部预置渠道。
export function readRuntimeAiChannels(): RuntimeAiChannel[] {
    const raw = read("AI_CHANNELS", import.meta.env.VITE_AI_CHANNELS);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.map(toRuntimeAiChannel).filter((channel): channel is RuntimeAiChannel => channel !== null);
    } catch {
        console.warn("AI_CHANNELS 不是合法 JSON，已忽略运行期预置渠道");
        return [];
    }
}

function toRuntimeAiChannel(value: unknown, index: number): RuntimeAiChannel | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    const baseUrl = trimmedString(item.baseUrl);
    if (!baseUrl) return null;
    const models = Array.isArray(item.models) ? item.models.map(trimmedString).filter(Boolean) : [];
    return {
        id: trimmedString(item.id) || `runtime-${index + 1}`,
        name: trimmedString(item.name) || `Runtime channel ${index + 1}`,
        baseUrl,
        apiKey: trimmedString(item.apiKey),
        apiFormat: item.apiFormat === "gemini" ? "gemini" : "openai",
        models,
    };
}

function trimmedString(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
