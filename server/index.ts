import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { extname, join, resolve, sep } from "node:path";

import { getAdminServerModelChannels, getPublicServerModelChannels, getServerChannel, saveAdminServerModelChannels, serverAiApiUrl, serverGeminiApiUrl, type ServerModelChannel } from "./ai-config";

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = resolve(process.env.IMAGE_WORKER_STATIC_DIR || "/app/web");
const AI_PROXY_TIMEOUT_MS = 300_000;
const HOP_BY_HOP_HEADERS = new Set(["connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade"]);

Bun.serve({
    port: Number.isFinite(PORT) ? PORT : 3000,
    fetch: handleRequest,
});

async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return text("ok");
    if (url.pathname === "/config.js") return runtimeConfigResponse();
    if (url.pathname === "/api/ai-config" && request.method === "GET") return json({ channels: getPublicServerModelChannels() });
    if (url.pathname === "/api/admin/ai-config") return adminConfigResponse(request);
    if (url.pathname.startsWith("/api/ai-proxy/")) return proxyRequest(request, url);
    if (url.pathname.startsWith("/api/")) return text("Not Found", 404);
    return staticResponse(request, url.pathname);
}

async function adminConfigResponse(request: Request) {
    if (!hasAdminAccess(request)) return json({ error: "管理员 Token 不正确，或服务器未配置 ADMIN_TOKEN" }, 401);
    if (request.method === "GET") return json({ channels: getAdminServerModelChannels() });
    if (request.method !== "POST") return text("Method Not Allowed", 405, { Allow: "GET, POST" });
    try {
        const payload = (await request.json()) as { channels?: unknown };
        const channels = await saveAdminServerModelChannels(payload.channels || []);
        return json({ ok: true, channels });
    } catch (error) {
        return json({ error: error instanceof Error ? error.message : "保存服务器配置失败" }, 400);
    }
}

async function proxyRequest(request: Request, url: URL) {
    const channelId = request.headers.get("x-ai-channel-id") || "";
    const channel = getServerChannel(channelId);
    if (!channel) return text("Server AI channel not found", 404);

    const endpoint = `/${url.pathname.slice("/api/ai-proxy/".length)}`;
    const method = request.method.toUpperCase();
    if (!isAllowedMethod(endpoint, method)) return text("Unsupported server AI proxy method", 400);

    const contentType = request.headers.get("content-type") || "";
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    if (!isAllowedModel(channel, endpoint, url.searchParams, body, contentType)) return text("Unsupported server AI proxy model", 400);

    const targetUrl = proxyUrl(channel, endpoint, url.searchParams);
    if (!targetUrl) return text("Unsupported server AI proxy endpoint", 400);

    const headers = new Headers();
    if (channel.apiFormat === "gemini") headers.set("x-goog-api-key", channel.apiKey);
    else headers.set("Authorization", `Bearer ${channel.apiKey}`);
    if (contentType) headers.set("Content-Type", contentType);
    const accept = request.headers.get("accept");
    if (accept) headers.set("Accept", accept);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_PROXY_TIMEOUT_MS);
    try {
        const response = await fetch(targetUrl, { method, headers, body, signal: controller.signal });
        return new Response(response.body, { status: response.status, headers: responseHeaders(response.headers) });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return text("AI proxy timeout", 504);
        return text(error instanceof Error ? error.message : "AI proxy error", 502);
    } finally {
        clearTimeout(timer);
    }
}

function proxyUrl(channel: ServerModelChannel, endpoint: string, searchParams: URLSearchParams) {
    if (channel.apiFormat === "gemini") {
        const model = searchParams.get("model") || "";
        if (endpoint === "/models") return serverGeminiApiUrl(channel, "");
        if (!model) return "";
        if (endpoint === "/gemini/generateContent") return serverGeminiApiUrl(channel, model, "generateContent");
        if (endpoint === "/gemini/streamGenerateContent") return `${serverGeminiApiUrl(channel, model, "streamGenerateContent")}?alt=${encodeURIComponent(searchParams.get("alt") || "sse")}`;
        return "";
    }
    if (endpoint === "/models" || endpoint === "/responses" || endpoint === "/chat/completions" || endpoint === "/images/generations" || endpoint === "/images/edits" || endpoint === "/videos" || endpoint === "/audio/speech" || endpoint === "/contents/generations/tasks") return serverAiApiUrl(channel, endpoint);
    if (/^\/videos\/[^/]+$/.test(endpoint) || /^\/videos\/[^/]+\/content$/.test(endpoint) || /^\/contents\/generations\/tasks\/[^/]+$/.test(endpoint)) return serverAiApiUrl(channel, endpoint);
    return "";
}

function isAllowedMethod(endpoint: string, method: string) {
    if (endpoint === "/models" || /^\/videos\/[^/]+$/.test(endpoint) || /^\/videos\/[^/]+\/content$/.test(endpoint) || /^\/contents\/generations\/tasks\/[^/]+$/.test(endpoint)) return method === "GET";
    return method === "POST";
}

function isAllowedModel(channel: ServerModelChannel, endpoint: string, searchParams: URLSearchParams, body: ArrayBuffer | undefined, contentType: string) {
    if (endpoint === "/models" || isTaskReadEndpoint(endpoint)) return true;
    const model = channel.apiFormat === "gemini" ? searchParams.get("model") || "" : modelFromBody(body, contentType);
    return Boolean(model && channel.models.some((item) => item.name === model));
}

function isTaskReadEndpoint(endpoint: string) {
    return /^\/videos\/[^/]+$/.test(endpoint) || /^\/videos\/[^/]+\/content$/.test(endpoint) || /^\/contents\/generations\/tasks\/[^/]+$/.test(endpoint);
}

function modelFromBody(body: ArrayBuffer | undefined, contentType: string) {
    if (!body) return "";
    const textValue = new TextDecoder().decode(body);
    if (contentType.toLowerCase().includes("multipart/form-data")) return multipartField(textValue, "model");
    try {
        const payload = JSON.parse(textValue) as { model?: unknown };
        return typeof payload.model === "string" ? payload.model : "";
    } catch {
        return "";
    }
}

function multipartField(body: string, name: string) {
    const match = body.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`));
    return match?.[1] || "";
}

function responseHeaders(headers: Headers) {
    const result = new Headers();
    headers.forEach((value, key) => {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) result.set(key, value);
    });
    return result;
}

function hasAdminAccess(request: Request) {
    const configured = process.env.ADMIN_TOKEN || "";
    const token = request.headers.get("x-admin-token") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!configured || configured.length !== token.length) return false;
    const configuredBytes = Buffer.from(configured);
    const tokenBytes = Buffer.from(token);
    return configuredBytes.length === tokenBytes.length && timingSafeEqual(configuredBytes, tokenBytes);
}

function runtimeConfigResponse() {
    const value = {
        ANALYTICS_GA4_ID: sanitizeAnalyticsId(process.env.ANALYTICS_GA4_ID),
        ANALYTICS_BAIDU_ID: sanitizeAnalyticsId(process.env.ANALYTICS_BAIDU_ID),
    };
    return new Response(`window.__RUNTIME_CONFIG__ = ${JSON.stringify(value)};\n`, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } });
}

function sanitizeAnalyticsId(value: string | undefined) {
    return (value || "").replace(/[^A-Za-z0-9-]/g, "");
}

function staticResponse(request: Request, pathname: string) {
    if (request.method !== "GET" && request.method !== "HEAD") return text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
    const decodedPath = safelyDecodePath(pathname);
    const requestedPath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const filePath = resolve(STATIC_DIR, requestedPath);
    if (isStaticPath(filePath)) {
        const file = Bun.file(filePath);
        if (file.size) return new Response(request.method === "HEAD" ? null : file);
    }
    if (extname(requestedPath)) return text("Not Found", 404);
    const index = Bun.file(join(STATIC_DIR, "index.html"));
    return index.size ? new Response(request.method === "HEAD" ? null : index) : text("Application files are unavailable", 503);
}

function safelyDecodePath(pathname: string) {
    try {
        return decodeURIComponent(pathname);
    } catch {
        return "/";
    }
}

function isStaticPath(filePath: string) {
    return filePath === STATIC_DIR || filePath.startsWith(`${STATIC_DIR}${sep}`);
}

function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function text(value: string, status = 200, headers?: HeadersInit) {
    return new Response(value, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}
