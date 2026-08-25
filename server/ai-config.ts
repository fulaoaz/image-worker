import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type ApiCallFormat = "openai" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";

export type ServerChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
};

export type ServerModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ServerChannelModel[];
};

export type PublicServerModelChannel = Omit<ServerModelChannel, "apiKey" | "models"> & {
    apiKey: "";
    models: ServerChannelModel[];
    serverManaged: true;
};

const SERVER_CONFIG_FILE_NAME = "ai-model-channels.json";
const DEFAULT_SERVER_PROVIDER_ID = "server";

export function getAdminServerModelChannels() {
    return readStoredServerModelChannels() ?? readEnvServerModelChannels();
}

export function getServerModelChannels() {
    return getAdminServerModelChannels().filter((channel) => Boolean(channel.baseUrl && channel.apiKey && channel.models.length));
}

export function getPublicServerModelChannels(): PublicServerModelChannel[] {
    return getServerModelChannels().map(({ apiKey: _apiKey, models, ...channel }) => ({
        ...channel,
        apiKey: "",
        models: models.map(({ script: _script, ...model }) => model),
        serverManaged: true,
    }));
}

export function getServerChannel(id: string) {
    return getServerModelChannels().find((channel) => channel.id === id);
}

export async function saveAdminServerModelChannels(value: unknown) {
    const channels = normalizeChannelList(value);
    const filePath = serverConfigFilePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
        filePath,
        `${JSON.stringify(
            {
                version: 1,
                updatedAt: new Date().toISOString(),
                channels,
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    return channels;
}

export function serverAiApiUrl(channel: Pick<ServerModelChannel, "baseUrl">, pathValue: string) {
    let normalizedBaseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${pathValue}`;
}

export function serverGeminiApiUrl(channel: Pick<ServerModelChannel, "baseUrl">, model: string, action?: "generateContent" | "streamGenerateContent") {
    const normalizedBaseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const baseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(model.trim().replace(/^models\//, ""))}:${action}`;
}

function readStoredServerModelChannels(): ServerModelChannel[] | null {
    const filePath = serverConfigFilePath();
    if (!existsSync(filePath)) return null;
    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { channels?: unknown };
        return normalizeChannelList(parsed.channels);
    } catch {
        return [];
    }
}

function readEnvServerModelChannels() {
    const jsonChannels = parseJsonChannels(process.env.AI_MODEL_CHANNELS || process.env.SERVER_AI_MODEL_CHANNELS || process.env.AI_CHANNELS || "");
    const indexedChannels = parseIndexedChannels();
    const singleChannel = parseSingleChannel();
    return normalizeChannelList([...jsonChannels, ...indexedChannels, ...singleChannel]);
}

function parseJsonChannels(value: string): ServerModelChannel[] {
    if (!value.trim()) return [];
    try {
        return normalizeChannelList(JSON.parse(value));
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

function normalizeChannelList(value: unknown): ServerModelChannel[] {
    const items = Array.isArray(value) ? value : [];
    const usedIds = new Set<string>();
    return items
        .map((item, index) => normalizeChannel(item, `server-${index + 1}`))
        .filter((item): item is ServerModelChannel => Boolean(item))
        .map((channel) => {
            const baseId = normalizeId(channel.id, "server");
            let id = baseId;
            let suffix = 2;
            while (usedIds.has(id)) {
                id = `${baseId}-${suffix}`;
                suffix += 1;
            }
            usedIds.add(id);
            return { ...channel, id };
        });
}

function normalizeChannel(value: unknown, fallbackId: string): ServerModelChannel | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const apiFormat = record.apiFormat === "gemini" ? "gemini" : "openai";
    return {
        id: normalizeId(stringValue(record.id), fallbackId),
        name: stringValue(record.name) || "服务器渠道",
        baseUrl: stringValue(record.baseUrl),
        apiKey: stringValue(record.apiKey),
        apiFormat,
        models: parseModels(record.models, apiFormat),
    };
}

function parseModels(value: unknown, apiFormat: ApiCallFormat): ServerChannelModel[] {
    const rawModels = Array.isArray(value) ? value : stringValue(value).split(",");
    const seen = new Set<string>();
    const models: ServerChannelModel[] = [];
    for (const item of rawModels) {
        const record = typeof item === "object" && item ? (item as Record<string, unknown>) : null;
        const rawName = (record ? stringValue(record.name) : String(item || "")).trim();
        const name = apiFormat === "gemini" ? rawName.replace(/^models\//, "") : rawName;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = isCapability(record?.capability) ? record?.capability : guessCapability(name);
        const script = stringValue(record?.script);
        models.push({ name, capability, ...(script ? { script } : {}) });
    }
    return models;
}

function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (["video", "sora", "veo", "kling", "wan", "hailuo"].some((keyword) => value.includes(keyword))) return "video";
    if (["audio", "tts", "speech", "voice", "music", "sound"].some((keyword) => value.includes(keyword))) return "audio";
    if (["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"].some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function isCapability(value: unknown): value is ModelCapability {
    return value === "image" || value === "video" || value === "text" || value === "audio";
}

function normalizeId(value: string, fallbackId: string) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
    return normalized || fallbackId;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const pathName = url.pathname.replace(/\/+$/, "");
        const lowerPath = pathName.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = pathName.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}

function serverConfigFilePath() {
    const dataDir = process.env.IMAGE_WORKER_DATA_DIR || process.env.DATA_DIR || "/app/data";
    return path.join(dataDir, SERVER_CONFIG_FILE_NAME);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
