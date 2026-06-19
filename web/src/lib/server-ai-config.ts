type ApiCallFormat = "openai" | "gemini";

export type ServerModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: string[];
};

export type PublicServerModelChannel = Omit<ServerModelChannel, "apiKey"> & { apiKey: "" };

const DEFAULT_SERVER_PROVIDER_ID = "server";

export function getServerModelChannels(): ServerModelChannel[] {
    const jsonChannels = parseJsonChannels(process.env.AI_MODEL_CHANNELS || process.env.SERVER_AI_MODEL_CHANNELS || "");
    const envChannels = parseIndexedChannels();
    const singleChannel = parseSingleChannel();
    return [...jsonChannels, ...envChannels, ...singleChannel].filter((channel) => channel.baseUrl && channel.apiKey && channel.models.length);
}

export function getPublicServerModelChannels(): PublicServerModelChannel[] {
    return getServerModelChannels().map(({ apiKey: _apiKey, ...channel }) => ({ ...channel, apiKey: "" }));
}

export function getServerChannel(id: string) {
    return getServerModelChannels().find((channel) => channel.id === id);
}

export function serverAiApiUrl(channel: Pick<ServerModelChannel, "baseUrl">, path: string) {
    let normalizedBaseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}

export function serverGeminiApiUrl(channel: Pick<ServerModelChannel, "baseUrl">, model: string, action?: "generateContent" | "streamGenerateContent") {
    const normalizedBaseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const baseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(model.trim().replace(/^models\//, ""))}:${action}`;
}

function parseJsonChannels(value: string): ServerModelChannel[] {
    if (!value.trim()) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.map((item, index) => normalizeChannel(item, `server-${index + 1}`)).filter((item): item is ServerModelChannel => Boolean(item));
    } catch {
        return [];
    }
}

function parseIndexedChannels() {
    const channels: ServerModelChannel[] = [];
    for (let index = 1; index <= 20; index += 1) {
        const prefix = `AI_PROVIDER_${index}_`;
        const channel = normalizeChannel(
            {
                id: process.env[`${prefix}ID`],
                name: process.env[`${prefix}NAME`],
                baseUrl: process.env[`${prefix}BASE_URL`],
                apiKey: process.env[`${prefix}API_KEY`],
                apiFormat: process.env[`${prefix}API_FORMAT`],
                models: process.env[`${prefix}MODELS`],
            },
            `server-${index}`,
        );
        if (channel) channels.push(channel);
    }
    return channels;
}

function parseSingleChannel() {
    const channel = normalizeChannel(
        {
            id: process.env.AI_PROVIDER_ID || DEFAULT_SERVER_PROVIDER_ID,
            name: process.env.AI_PROVIDER_NAME || "服务器渠道",
            baseUrl: process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL,
            apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
            apiFormat: process.env.AI_API_FORMAT,
            models: process.env.AI_MODELS,
        },
        DEFAULT_SERVER_PROVIDER_ID,
    );
    return channel ? [channel] : [];
}

function normalizeChannel(value: unknown, fallbackId: string): ServerModelChannel | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const apiFormat = record.apiFormat === "gemini" ? "gemini" : "openai";
    return {
        id: stringValue(record.id) || fallbackId,
        name: stringValue(record.name) || "服务器渠道",
        baseUrl: stringValue(record.baseUrl),
        apiKey: stringValue(record.apiKey),
        apiFormat,
        models: parseModels(record.models),
    };
}

function parseModels(value: unknown) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    return stringValue(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
