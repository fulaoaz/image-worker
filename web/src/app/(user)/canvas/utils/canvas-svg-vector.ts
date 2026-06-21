"use client";

type AzureOcrLine = {
    text: string;
    confidence: number;
    polygon: Array<{ x: number; y: number }>;
};

type AzureOcrResponse = {
    width: number;
    height: number;
    angle: number;
    lines: AzureOcrLine[];
};

export function svgToDataUrl(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function svgToBlob(svg: string) {
    return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

export function dataUrlToSvgText(dataUrl: string) {
    const match = dataUrl.match(/^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
    if (!match) return "";
    if (match[1]) {
        const binary = atob(match[2] || "");
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(match[2] || "");
}

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

const DEFAULT_TRACE_MAX_LONG_EDGE = 1800;
let vtracerRequestId = 0;

export async function rasterImageToEditableSvg(source: string, options: EditableSvgTraceOptions = {}): Promise<EditableSvgTraceResult> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const image = await loadImage(source);
    const width = Math.max(1, image.naturalWidth || image.width || 1);
    const height = Math.max(1, image.naturalHeight || image.height || 1);
    const maxLongEdge = Math.max(512, Math.min(4096, Math.round(options.maxLongEdge || DEFAULT_TRACE_MAX_LONG_EDGE)));
    const scale = Math.min(1, maxLongEdge / Math.max(width, height));
    const sampledWidth = Math.max(1, Math.round(width * scale));
    const sampledHeight = Math.max(1, Math.round(height * scale));
    const imageData = imageToImageData(image, sampledWidth, sampledHeight);
    const [tracedSvg, textLayer] = await Promise.all([
        traceImageDataWithWorker(imageData, sampledWidth, sampledHeight, options.signal),
        options.ocr === false ? Promise.resolve("") : recognizeTextLayer(source, { width, height, sampledWidth, sampledHeight, signal: options.signal }),
    ]);
    const svg = textLayer ? appendSvgTextLayer(tracedSvg, textLayer) : tracedSvg;
    return { svg: annotateTracedSvg(svg, { width, height, viewBoxWidth: sampledWidth, viewBoxHeight: sampledHeight, title: options.title || "Editable image" }), width, height, sampledWidth, sampledHeight };
}

function traceImageDataWithWorker(imageData: ImageData, width: number, height: number, signal?: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const id = ++vtracerRequestId;
        const worker = new Worker(new URL("./canvas-vtracer.worker.ts", import.meta.url), { type: "module" });
        const cleanup = () => {
            signal?.removeEventListener("abort", abort);
            worker.terminate();
        };
        const abort = () => {
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
        };
        worker.onmessage = (event: MessageEvent<{ id: number; type: "done"; svg: string } | { id: number; type: "error"; error: string }>) => {
            if (event.data.id !== id) return;
            cleanup();
            if (event.data.type === "done") resolve(event.data.svg);
            else reject(new Error(event.data.error || "VTracer 转换失败"));
        };
        worker.onerror = (event) => {
            cleanup();
            reject(new Error(event.message || "VTracer Worker 运行失败"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        worker.postMessage({ id, type: "trace", width, height, rgba: imageData.data }, [imageData.data.buffer]);
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
    const clean = sanitizeEditableSvg(svg);
    const document = new DOMParser().parseFromString(clean, "image/svg+xml");
    const root = document.documentElement;
    root.setAttribute("width", String(meta.width));
    root.setAttribute("height", String(meta.height));
    root.setAttribute("viewBox", `0 0 ${meta.viewBoxWidth} ${meta.viewBoxHeight}`);
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", meta.title);
    document.querySelector("title")?.remove();
    document.querySelector("desc")?.remove();
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = meta.title;
    const desc = document.createElementNS("http://www.w3.org/2000/svg", "desc");
    desc.textContent = "Generated locally by VTracer WASM high fidelity conversion.";
    root.prepend(desc);
    root.prepend(title);
    return sanitizeEditableSvg(new XMLSerializer().serializeToString(root));
}

function appendSvgTextLayer(svg: string, textLayer: string) {
    if (!textLayer) return svg;
    const document = new DOMParser().parseFromString(sanitizeEditableSvg(svg), "image/svg+xml");
    const root = document.documentElement;
    const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
    wrapper.setAttribute("id", "editable-ocr-text");
    wrapper.setAttribute("data-editable-layer", "ocr-text");
    wrapper.innerHTML = textLayer;
    root.appendChild(wrapper);
    return new XMLSerializer().serializeToString(root);
}

async function recognizeTextLayer(source: string, meta: { width: number; height: number; sampledWidth: number; sampledHeight: number; signal?: AbortSignal }) {
    if (meta.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
        const blob = await dataUrlToBlob(source);
        const response = await fetch("/api/ocr/azure", {
            method: "POST",
            headers: { "Content-Type": blob.type || "application/octet-stream" },
            body: blob,
            signal: meta.signal,
        });
        const payload = (await response.json().catch(() => null)) as (AzureOcrResponse & { error?: string }) | null;
        if (!response.ok || !payload) throw new Error(payload?.error || `Azure OCR 失败（${response.status}）`);
        return ocrResultToSvgText(payload, meta);
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        console.warn("Azure OCR text layer failed", error);
        return "";
    }
}

async function dataUrlToBlob(dataUrl: string) {
    return await (await fetch(dataUrl)).blob();
}

function ocrResultToSvgText(page: AzureOcrResponse, meta: { width: number; height: number; sampledWidth: number; sampledHeight: number }) {
    const sourceWidth = page.width || meta.width;
    const sourceHeight = page.height || meta.height;
    const scaleX = meta.sampledWidth / sourceWidth;
    const scaleY = meta.sampledHeight / sourceHeight;
    return (page.lines || [])
        .map((line, index) => ocrLineToSvgText(line, index, scaleX, scaleY))
        .filter(Boolean)
        .join("\n");
}

function ocrLineToSvgText(line: AzureOcrLine, index: number, scaleX: number, scaleY: number) {
    const text = (line.text || "").replace(/\s+/g, " ").trim();
    const polygon = line.polygon || [];
    if (!text || polygon.length < 4 || line.confidence < 0.35) return "";
    const points = polygon.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
    const topLeft = points[0];
    const topRight = points[1] || points[0];
    const bottomRight = points[2] || points[0];
    const bottomLeft = points[3] || points[0];
    const width = distance(topLeft, topRight);
    const height = Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight));
    if (width < 4 || height < 4) return "";
    const angle = (Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x) * 180) / Math.PI;
    const transform = Math.abs(angle) > 0.5 ? ` transform="rotate(${round(angle)} ${round(topLeft.x)} ${round(bottomLeft.y)})"` : "";
    return `<text id="ocr-text-${index + 1}" x="${round(topLeft.x)}" y="${round(bottomLeft.y)}" font-size="${round(height * 0.86)}" font-family="Arial, 'Noto Sans SC', sans-serif" fill="#111111" opacity="0.92" data-ocr-confidence="${round(line.confidence)}"${transform}>${escapeXml(text)}</text>`;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(value: number) {
    return Math.round(value * 100) / 100;
}

function escapeXml(value: string) {
    return value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char] || char);
}

function loadImage(source: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片读取失败，无法转成可编辑 SVG"));
        image.src = source;
    });
}

export function sanitizeEditableSvg(svg: string) {
    const parser = new DOMParser();
    const document = parser.parseFromString(svg, "image/svg+xml");
    if (document.querySelector("parsererror")) throw new Error("SVG 格式不正确，请检查标签是否闭合");
    const root = document.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") throw new Error("请输入完整的 <svg> 内容");

    document.querySelectorAll("script,foreignObject,iframe,object,embed,link,meta").forEach((element) => element.remove());
    document.querySelectorAll("*").forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim().toLowerCase();
            if (name.startsWith("on") || value.startsWith("javascript:") || value.includes("url(javascript:")) element.removeAttribute(attribute.name);
        }
    });
    root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(root);
}
