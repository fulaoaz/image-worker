import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
const SERVER_CONFIG_FILE_NAME = "ai-model-channels.json";

export function getServerModelChannels(): ServerModelChannel[] {
    const storedChannels = readStoredServerModelChannels();
    const channels = storedChannels ?? readEnvServerModelChannels();
    return channels.filter(isCompleteChannel);
}

export function getAdminServerModelChannels(): ServerModelChannel[] {
    return readStoredServerModelChannels() ?? readEnvServerModelChannels();
}

export async function saveAdminServerModelChannels(channels: unknown): Promise<ServerModelChannel[]> {
    const normalizedChannels = normalizeChannelList(channels);
    const filePath = serverConfigFilePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
        filePath,
        `${JSON.stringify(
            {
                version: 1,
                updatedAt: new Date().toISOString(),
                channels: normalizedChannels,
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    return normalizedChannels;
}

export function getPublicServerModelChannels(): PublicServerModelChannel[] {
    return getServerModelChannels().map(({ apiKey: _apiKey, ...channel }) => ({ ...channel, apiKey: "" }));
}

export function getServerChannel(id: string) {
    return getServerModelChannels().find((channel) => channel.id === id);
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

function readEnvServerModelChannels(): ServerModelChannel[] {
    const jsonChannels = parseJsonChannels(process.env.AI_MODEL_CHANNELS || process.env.SERVER_AI_MODEL_CHANNELS || "");
    const envChannels = parseIndexedChannels();
    const singleChannel = parseSingleChannel();
    return normalizeChannelList([...jsonChannels, ...envChannels, ...singleChannel]);
}

function serverConfigFilePath() {
    const dataDir = process.env.IMAGE_WORKER_DATA_DIR || process.env.DATA_DIR || path.join(process.cwd(), "..", "data");
    return path.join(dataDir, SERVER_CONFIG_FILE_NAME);
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

function parseJsonChannels(value: string): ServerModelChannel[] {
    if (!value.trim()) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return normalizeChannelList(parsed);
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
        models: parseModels(record.models),
    };
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

function isCompleteChannel(channel: ServerModelChannel) {
    return Boolean(channel.baseUrl && channel.apiKey && channel.models.length);
}

function parseModels(value: unknown) {
    const rawModels = Array.isArray(value) ? value : stringValue(value).split(",");
    return Array.from(new Set(rawModels.map((item) => String(item).trim()).filter(Boolean)));
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
