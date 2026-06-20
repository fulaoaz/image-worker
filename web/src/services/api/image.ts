import axios from "axios";

import { buildApiUrl, resolveModelRequestConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

export type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ChatCompletionPayload = {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    if (Math.max(w, h) / Math.min(w, h) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return { width: w, height: h };
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }
    const images =
        payload.data
            ?.map(resolveImageDataUrl)
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new Error("接口没有返回图片");
    }

    return images;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number } | string>(error)) {
        const responseData = error.response?.data;
        if (typeof responseData === "string") return readTextError(responseData, error.response?.status, fallback);
        return responseData?.msg || responseData?.error?.message || readStatusError(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 413) return "请求体过大（413），图片超过网关限制；请重试，系统会仅在超限时压缩兜底";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    if (status === 502 || status === 503 || status === 504) return `上游网关暂不可用（${status}），请稍后重试`;
    return status ? `${fallback}：${status}` : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    if (config.serverManaged) return `/api/ai-proxy${path}`;
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: Pick<AiConfig, "apiKey" | "channelId" | "serverManaged">, contentType?: string) {
    return {
        ...(config.serverManaged ? { "x-ai-channel-id": config.channelId || "" } : { Authorization: `Bearer ${config.apiKey}` }),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiProxyUrl(config: Pick<AiConfig, "model" | "channelId">, action?: "generateContent" | "streamGenerateContent") {
    const path = action ? `/api/ai-proxy/gemini/${action}` : "/api/ai-proxy/models";
    const suffix = action === "streamGenerateContent" ? "&alt=sse" : "";
    return `${path}?model=${encodeURIComponent(geminiModelName(config.model))}${suffix}`;
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return readTextError(text, response.status, fallback);
    }
}

function readTextError(text: string, status: number | undefined, fallback: string) {
    const trimmed = text.trim();
    if (/^(?:<!doctype\s+html|<html[\s>])/i.test(trimmed)) {
        return `${readStatusError(status, fallback)}；上游代理返回了 HTML 错误页，请检查网关限制、代理或模型服务状态`;
    }
    return trimmed.slice(0, 300) || readStatusError(status, fallback);
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

async function requestChatCompletionResponse(config: AiConfig, messages: AiTextMessage[], maxTokens: number, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/chat/completions"), {
        method: "POST",
        headers: aiHeaders(config, "application/json"),
        body: JSON.stringify({ model: config.model, messages, max_tokens: maxTokens, stream: false }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    const payload = (await response.json()) as ChatCompletionPayload;
    validateChatCompletionPayload(payload);
    return { content: (payload.choices || []).map((choice) => chatMessageText(choice.message?.content)).join(""), toolCalls: [] };
}

function validateChatCompletionPayload(payload: ChatCompletionPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function chatMessageText(content: string | Array<{ type?: string; text?: string }> | undefined) {
    if (!content) return "";
    if (typeof content === "string") return content;
    return content.map((item) => item.text || "").join("");
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(config.serverManaged ? geminiProxyUrl(config, "streamGenerateContent") : `${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: config.serverManaged ? { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" } : geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        config.serverManaged ? geminiProxyUrl(config, "generateContent") : geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
            contents: [{ role: "user", parts }],
        },
        { headers: config.serverManaged ? aiHeaders(config, "application/json") : geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error("Gemini 接口没有返回图片");
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    try {
        const response = await axios.post<ImageApiResponse>(
            aiApiUrl(requestConfig, "/images/generations"),
            {
                model: requestConfig.model,
                prompt: withSystemPrompt(requestConfig, prompt),
                n,
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                response_format: "b64_json",
                output_format: IMAGE_OUTPUT_FORMAT,
            },
            {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
            },
        );
        const images = parseImagePayload(response.data);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    if (requestConfig.apiFormat === "gemini") {
        if (mask) throw new Error("Gemini 调用格式暂不支持蒙版编辑");
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    formData.set("n", String(n));
    formData.set("response_format", "b64_json");
    formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));
    if (mask) formData.set("mask", dataUrlToFile(mask));

    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/edits"), formData, { headers: aiHeaders(requestConfig), signal: options?.signal });
        const images = parseImagePayload(response.data);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    try {
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        }
        const answer = (await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
        }, onDelta, options)).content || "没有返回内容";
        if (answer === "没有返回内容") onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestEditableSvgConversion(config: AiConfig, image: ReferenceImage, meta: { width: number; height: number; title?: string }, options?: RequestOptions) {
    const requestConfig = { ...resolveModelRequestConfig(config, config.model || config.textModel || config.imageModel), systemPrompt: "" };
    const prompt = buildEditableSvgPrompt(meta);
    const messages: ResponseInputMessage[] = [
        {
            role: "user",
            content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: image.dataUrl } },
            ],
        },
    ];

    try {
        const result =
            requestConfig.apiFormat === "gemini"
                ? await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages, { generationConfig: { maxOutputTokens: 16000 } }), undefined, options)
                : await requestOpenAiEditableSvgConversion(requestConfig, messages, options);
        return extractSvgMarkup(result.content || "");
    } catch (error) {
        throw new Error(readAxiosError(error, "转成可编辑 SVG 失败"));
    }
}

async function requestOpenAiEditableSvgConversion(config: AiConfig, messages: ResponseInputMessage[], options?: RequestOptions) {
    try {
        return await requestStreamingResponse(
            config,
            {
                model: config.model,
                input: toResponseInput(messages),
                max_output_tokens: 16000,
            },
            undefined,
            options,
        );
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return requestChatCompletionResponse(config, messages.filter((message): message is AiTextMessage => !("type" in message)), 16000, options);
    }
}

function buildEditableSvgPrompt(meta: { width: number; height: number; title?: string }) {
    const width = Math.max(1, Math.round(meta.width || 1024));
    const height = Math.max(1, Math.round(meta.height || 1024));
    const title = meta.title?.trim() || "Editable image";
    return `请把这张图片重建为可编辑的语义 SVG，而不是把像素点铺成马赛克矩形。目标是让用户后续可以在网页里点选、拖动和修改每一个图形/文字对象。

要求：
1. 只返回一个完整的 <svg>...</svg>，不要 Markdown 代码块、解释或额外文字。
2. SVG 必须设置 xmlns、width="${width}"、height="${height}"、viewBox="0 0 ${width} ${height}"。
3. 尽量把画面拆成语义元素：<text> 用于所有可见文字，<path>/<rect>/<circle>/<ellipse>/<line>/<polyline>/<polygon> 用于图形、箭头、连线、图标和区域。
4. 不要使用 <image>、base64 位图、foreignObject、script 或外部资源。不能把原图嵌进去。
5. 对流程图、机制图、信息图，保留标题、标签、箭头方向、连线关系和主要颜色；文字不确定时也要尽量按图片内容 OCR/近似转写。
6. 相近图形可用 <g> 分组，但每个重要图形和每段文字都要保持为单独可选元素。
7. 使用简洁样式，允许近似，不追求像素级完全一致；优先保证对象可编辑、可拖动、文字可修改。

标题：${title}`;
}

function extractSvgMarkup(text: string) {
    const fenced = text.match(/```(?:svg|xml)?\s*([\s\S]*?<svg[\s\S]*?<\/svg>)\s*```/i)?.[1];
    const source = fenced || text;
    const start = source.search(/<svg[\s>]/i);
    const end = source.toLowerCase().lastIndexOf("</svg>");
    if (start < 0 || end < start) throw new Error("模型没有返回可编辑 SVG，请换用支持视觉理解的模型后重试");
    return source.slice(start, end + "</svg>".length).trim();
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    try {
        if (requestConfig.apiFormat === "gemini") {
            return await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages, toGeminiToolOptions(tools, toolChoice)), onDelta, options);
        }
        return await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
            tools: tools.map(toResponseTool),
            tool_choice: toolChoice,
            parallel_tool_calls: false,
        }, onDelta, options);
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "channelId" | "serverManaged" | "model">) {
    try {
        if (config.apiFormat === "gemini") {
            const geminiConfig = { ...defaultGeminiConfig, ...config };
            const response = await axios.get<GeminiPayload>(config.serverManaged ? geminiProxyUrl(geminiConfig) : geminiApiUrl(geminiConfig), { headers: config.serverManaged ? aiHeaders(geminiConfig, "application/json") : geminiHeaders(geminiConfig) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(config.serverManaged ? "/api/ai-proxy/models" : buildApiUrl(config.baseUrl, "/models"), {
            headers: config.serverManaged
                ? { "x-ai-channel-id": config.channelId || "", "x-ai-method": "GET" }
                : {
                      Authorization: `Bearer ${config.apiKey}`,
                  },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export async function fetchChannelModels(channel: ModelChannel) {
    return fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat, channelId: channel.id, serverManaged: channel.serverManaged, model: "" });
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
