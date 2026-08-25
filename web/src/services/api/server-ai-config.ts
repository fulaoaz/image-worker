import type { ModelChannel } from "@/stores/use-config-store";

type ServerAiConfigResponse = { channels?: ModelChannel[]; error?: string };

export async function fetchPublicServerModelChannels() {
    const response = await fetch("/api/ai-config", { cache: "no-store" });
    if (!response.ok) throw new Error(`服务器渠道请求失败（${response.status}）`);
    const payload = (await response.json()) as ServerAiConfigResponse;
    return Array.isArray(payload.channels) ? payload.channels : [];
}

export async function fetchAdminServerModelChannels(token: string) {
    return requestAdminConfig("GET", token);
}

export async function saveAdminServerModelChannels(token: string, channels: ModelChannel[]) {
    return requestAdminConfig("POST", token, channels);
}

async function requestAdminConfig(method: "GET" | "POST", token: string, channels?: ModelChannel[]) {
    const response = await fetch("/api/admin/ai-config", {
        method,
        headers: { "x-admin-token": token.trim(), ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify({ channels }) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as ServerAiConfigResponse;
    if (!response.ok) throw new Error(payload.error || "服务器配置请求失败");
    return Array.isArray(payload.channels) ? payload.channels : [];
}
