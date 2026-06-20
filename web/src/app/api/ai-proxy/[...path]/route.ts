import { NextRequest } from "next/server";

import { getServerChannel, serverAiApiUrl, serverGeminiApiUrl, type ServerModelChannel } from "@/lib/server-ai-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AI_PROXY_TIMEOUT_MS = 300000;
const HOP_BY_HOP_HEADERS = new Set(["connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade"]);

export async function GET(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
    return proxyRequest(request, context, "GET");
}

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
    return proxyRequest(request, context, "POST");
}

async function proxyRequest(request: NextRequest, context: { params: Promise<{ path?: string[] }> }, fallbackMethod: string) {
    const { path = [] } = await context.params;
    const channelId = request.headers.get("x-ai-channel-id") || "";
    const channel = getServerChannel(channelId);
    if (!channel) return new Response("Server AI channel not found", { status: 404 });

    const endpoint = `/${path.join("/")}`;
    const url = proxyUrl(channel, endpoint, request.nextUrl.searchParams);
    if (!url) return new Response("Unsupported server AI proxy endpoint", { status: 400 });

    const headers = new Headers();
    if (channel.apiFormat === "gemini") {
        headers.set("x-goog-api-key", channel.apiKey);
    } else {
        headers.set("Authorization", `Bearer ${channel.apiKey}`);
    }
    const contentType = request.headers.get("content-type") || "";
    if (contentType) headers.set("Content-Type", contentType);
    const accept = request.headers.get("accept");
    if (accept) headers.set("Accept", accept);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_PROXY_TIMEOUT_MS);
    try {
        const method = (request.headers.get("x-ai-method") || fallbackMethod).toUpperCase();
        if (!isAllowedMethod(endpoint, method)) return new Response("Unsupported server AI proxy method", { status: 400 });
        const body = await proxyBody(request, contentType, method);
        if (!isAllowedModel(channel, endpoint, request.nextUrl.searchParams, body, contentType)) return new Response("Unsupported server AI proxy model", { status: 400 });
        const response = await fetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
        });
        return new Response(response.body, { status: response.status, headers: responseHeaders(response.headers) });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return new Response("AI proxy timeout", { status: 504 });
        return new Response(error instanceof Error ? error.message : "AI proxy error", { status: 502 });
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

async function proxyBody(request: NextRequest, contentType: string, method: string) {
    if (method === "GET" || method === "HEAD") return undefined;
    if (!contentType.toLowerCase().includes("application/json")) return await request.arrayBuffer();
    return JSON.stringify(await request.json());
}

function isAllowedModel(channel: ServerModelChannel, endpoint: string, searchParams: URLSearchParams, body: BodyInit | undefined, contentType: string) {
    if (endpoint === "/models" || isTaskReadEndpoint(endpoint)) return true;
    const model = channel.apiFormat === "gemini" ? searchParams.get("model") || "" : modelFromBody(body, contentType);
    return Boolean(model && channel.models.includes(model));
}

function isTaskReadEndpoint(endpoint: string) {
    return /^\/videos\/[^/]+$/.test(endpoint) || /^\/videos\/[^/]+\/content$/.test(endpoint) || /^\/contents\/generations\/tasks\/[^/]+$/.test(endpoint);
}

function modelFromBody(body: BodyInit | undefined, contentType: string) {
    const text = bodyText(body);
    if (!text) return "";
    if (contentType.toLowerCase().includes("multipart/form-data")) return multipartField(text, "model");
    try {
        const payload = JSON.parse(text) as { model?: unknown };
        return typeof payload.model === "string" ? payload.model : "";
    } catch {
        return "";
    }
}

function bodyText(body: BodyInit | undefined) {
    if (typeof body === "string") return body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return "";
}

function multipartField(body: string, name: string) {
    const match = body.match(new RegExp(`name="${name}"\r?\n\r?\n([^\r\n]*)`));
    return match?.[1] || "";
}

function responseHeaders(headers: Headers) {
    const result = new Headers();
    headers.forEach((value, key) => {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) result.set(key, value);
    });
    return result;
}
