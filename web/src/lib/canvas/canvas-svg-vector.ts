import type { CanvasNodeData } from "@/types/canvas";

import { ocrLinesToSvgText, recognizeImageLines } from "./canvas-ocr";
import type { TraceProfile } from "./canvas-vtracer.worker";

export type EditableSvgTraceOptions = {
    title?: string;
    signal?: AbortSignal;
    maxLongEdge?: number;
    ocr?: boolean;
};

export type EditableSvgTraceResult = {
    svg: string;
    width: number;
    height: number;
    sampledWidth: number;
    sampledHeight: number;
};

const DEFAULT_TRACE_MAX_LONG_EDGE = 1280;
const SAFE_TRACE_MAX_LONG_EDGE = 760;
const TRACE_TIMEOUT_MS = 45000;
const SAFE_TRACE_TIMEOUT_MS = 30000;
let traceRequestId = 0;

export function svgToDataUrl(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function svgToBlob(svg: string) {
    return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

export function dataUrlToSvgText(dataUrl: string) {
    const match = dataUrl.match(/^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
    if (!match) return "";
    if (!match[1]) return decodeURIComponent(match[2] || "");
    const binary = atob(match[2] || "");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

// 位图转可编辑 SVG：先按 detailed 描摹，失败或超时再降级到 safe，避免复杂图片卡住。
export async function rasterImageToEditableSvg(source: string, options: EditableSvgTraceOptions = {}): Promise<EditableSvgTraceResult> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const image = await loadImage(source);
    const width = Math.max(1, image.naturalWidth || image.width || 1);
    const height = Math.max(1, image.naturalHeight || image.height || 1);
    const traced = await traceWithFallback(image, width, height, options);
    const annotated = annotateTracedSvg(traced.svg, { width, height, viewBoxWidth: traced.sampledWidth, viewBoxHeight: traced.sampledHeight, title: options.title || "Editable image" });
    // 文字图层默认开启：本机识别，识别失败不影响已经描摹出来的矢量结果。
    const textLayer = options.ocr === false ? "" : await recognizeSvgTextLayer(image, { sampledWidth: traced.sampledWidth, sampledHeight: traced.sampledHeight, signal: options.signal });
    return {
        svg: textLayer ? appendSvgTextLayer(annotated, textLayer) : annotated,
        width,
        height,
        sampledWidth: traced.sampledWidth,
        sampledHeight: traced.sampledHeight,
    };
}

// 文字识别是增强项：识别失败或超时只记录日志并返回空图层，不能连带丢掉已描摹好的矢量结果。
async function recognizeSvgTextLayer(image: HTMLImageElement, meta: { sampledWidth: number; sampledHeight: number; signal?: AbortSignal }) {
    try {
        const lines = await recognizeImageLines(image.src, { signal: meta.signal });
        const width = Math.max(1, image.naturalWidth || image.width || 1);
        const height = Math.max(1, image.naturalHeight || image.height || 1);
        return ocrLinesToSvgText(lines, { width, height, viewBoxWidth: meta.sampledWidth, viewBoxHeight: meta.sampledHeight });
    } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn("本机文字识别失败，已跳过文字图层", error);
        return "";
    }
}

// 把 OCR 文字包进独立分组，方便用户在编辑器里整体识别、单独调整或删除。
function appendSvgTextLayer(svg: string, textLayer: string) {
    const document = parseSvg(svg);
    const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
    wrapper.setAttribute("id", "editable-ocr-text");
    wrapper.setAttribute("data-editable-layer", "ocr-text");
    wrapper.innerHTML = textLayer;
    document.documentElement.appendChild(wrapper);
    return sanitizeEditableSvg(new XMLSerializer().serializeToString(document.documentElement));
}

async function traceWithFallback(image: HTMLImageElement, width: number, height: number, options: EditableSvgTraceOptions) {
    const primary = sampleSize(width, height, options.maxLongEdge || DEFAULT_TRACE_MAX_LONG_EDGE, 512, 1800);
    try {
        const data = imageToImageData(image, primary.sampledWidth, primary.sampledHeight);
        return { svg: await traceInWorker(data, primary, options.signal, "detailed", TRACE_TIMEOUT_MS), ...primary };
    } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn("VTracer detailed conversion failed, retrying safe profile", error);
    }
    const safe = sampleSize(width, height, Math.min(options.maxLongEdge || DEFAULT_TRACE_MAX_LONG_EDGE, SAFE_TRACE_MAX_LONG_EDGE), 384, SAFE_TRACE_MAX_LONG_EDGE);
    const data = imageToImageData(image, safe.sampledWidth, safe.sampledHeight);
    return { svg: await traceInWorker(data, safe, options.signal, "safe", SAFE_TRACE_TIMEOUT_MS), ...safe };
}

function sampleSize(width: number, height: number, maxLongEdgeValue: number, minLongEdge: number, hardMaxLongEdge: number) {
    const maxLongEdge = Math.max(minLongEdge, Math.min(hardMaxLongEdge, Math.round(maxLongEdgeValue)));
    const scale = Math.min(1, maxLongEdge / Math.max(width, height));
    return { sampledWidth: Math.max(1, Math.round(width * scale)), sampledHeight: Math.max(1, Math.round(height * scale)) };
}

function traceInWorker(imageData: ImageData, size: { sampledWidth: number; sampledHeight: number }, signal: AbortSignal | undefined, profile: TraceProfile, timeoutMs: number) {
    return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const id = ++traceRequestId;
        let settled = false;
        let worker: Worker | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            worker?.terminate();
            callback();
        };
        const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));

        try {
            worker = new Worker(new URL("./canvas-vtracer.worker.ts", import.meta.url), { type: "module" });
        } catch (error) {
            return reject(error instanceof Error ? error : new Error("VTracer Worker 启动失败"));
        }

        worker.onmessage = (event: MessageEvent<{ id: number; type: "done"; svg: string } | { id: number; type: "error"; error: string }>) => {
            if (event.data.id !== id) return;
            finish(() => (event.data.type === "done" ? resolve(event.data.svg) : reject(new Error(event.data.error || "VTracer 转换失败"))));
        };
        worker.onerror = (event) => finish(() => reject(new Error(event.message || "VTracer Worker 运行失败")));
        worker.onmessageerror = () => finish(() => reject(new Error("VTracer Worker 返回结果失败")));
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => finish(() => reject(new Error("本机描摹耗时过长，已自动切换低负载模式"))), timeoutMs);

        try {
            worker.postMessage({ id, type: "trace", width: size.sampledWidth, height: size.sampledHeight, rgba: imageData.data, profile }, [imageData.data.buffer]);
        } catch (error) {
            finish(() => reject(error instanceof Error ? error : new Error("VTracer Worker 发送图片失败")));
        }
    });
}

function imageToImageData(image: HTMLImageElement, width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器不支持本地图片描摹");
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
}

function annotateTracedSvg(svg: string, meta: { width: number; height: number; viewBoxWidth: number; viewBoxHeight: number; title: string }) {
    const document = parseSvg(sanitizeEditableSvg(svg));
    const root = document.documentElement;
    root.setAttribute("width", String(meta.width));
    root.setAttribute("height", String(meta.height));
    root.setAttribute("viewBox", `0 0 ${meta.viewBoxWidth} ${meta.viewBoxHeight}`);
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", meta.title);
    document.querySelector("title")?.remove();
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = meta.title;
    root.prepend(title);
    return sanitizeEditableSvg(new XMLSerializer().serializeToString(root));
}

function loadImage(source: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片读取失败，无法转成可编辑 SVG"));
        image.src = source;
    });
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}

// 已描摹出矢量源码，或本身就是 SVG 图片的节点，才能直接进可视化编辑。
export function isEditableSvgNode(node: CanvasNodeData) {
    return Boolean(node.metadata?.editableSvg || node.metadata?.mimeType?.includes("svg") || node.metadata?.content?.startsWith("data:image/svg+xml"));
}

// 从 SVG 源码读取尺寸：优先 width/height，其次 viewBox。
// 不用 <img> 探测，因为只有 viewBox 的 SVG 读不到 naturalWidth，会被回落成默认值导致节点比例错。
export function readSvgSize(svg: string) {
    try {
        const root = parseSvg(svg).documentElement;
        const width = parseSvgLength(root.getAttribute("width"));
        const height = parseSvgLength(root.getAttribute("height"));
        if (width && height) return { width, height };
        const [, , viewBoxWidth, viewBoxHeight] = (root.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
        if (viewBoxWidth > 0 && viewBoxHeight > 0) return { width: viewBoxWidth, height: viewBoxHeight };
    } catch {
        // 源码非法时交给调用方回退到节点当前尺寸
    }
    return null;
}

function parseSvgLength(value: string | null) {
    const size = Number.parseFloat(value || "");
    return Number.isFinite(size) && size > 0 ? size : 0;
}

export function parseSvg(svg: string) {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (document.querySelector("parsererror")) throw new Error("SVG 格式不正确，请检查标签是否闭合");
    if (document.documentElement?.tagName.toLowerCase() !== "svg") throw new Error("请输入完整的 <svg> 内容");
    return document;
}

// 渲染前统一清理：移除可执行内容和事件属性，避免画布里执行第三方脚本。
export function sanitizeEditableSvg(svg: string) {
    const document = parseSvg(svg);
    document.querySelectorAll("script,foreignObject,iframe,object,embed,link,meta,style").forEach((element) => element.remove());
    document.querySelectorAll("*").forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
            const value = attribute.value.trim().toLowerCase();
            if (attribute.name.toLowerCase().startsWith("on") || value.startsWith("javascript:") || value.includes("url(javascript:")) element.removeAttribute(attribute.name);
        }
    });
    document.documentElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(document.documentElement);
}
