// 位图文字识别：在浏览器本地跑 tesseract.js，识别结果转成可编辑的 SVG <text> 图层。
// 旧实现走服务端 Azure OCR 路由，上游是纯静态部署没有服务端运行时，这里改为本地识别，不需要密钥也不外发图片。
import { createWorker, type Worker } from "tesseract.js";

export type OcrTextLine = {
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
};

export type OcrOptions = {
    signal?: AbortSignal;
    languages?: string;
};

// 置信度低于此值的行不写入图层，避免把噪点当成文字。
const MIN_CONFIDENCE = 60;
const MIN_LINE_SIZE = 4;
const OCR_TIMEOUT_MS = 60000;

let workerPromise: Promise<Worker> | null = null;

// worker 启动要下载语言包，开销较大，进程内复用同一个实例。
function getWorker(languages: string) {
    workerPromise ||= createWorker(languages);
    return workerPromise;
}

export async function recognizeImageLines(source: string, options: OcrOptions = {}): Promise<OcrTextLine[]> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const worker = await getWorker(options.languages || "chi_sim+eng");
    const result = await withTimeout(worker.recognize(source), OCR_TIMEOUT_MS, options.signal);
    const lines = (result.data as { lines?: OcrTextLine[] }).lines || [];
    return lines.filter((line) => line.text.trim() && line.confidence >= MIN_CONFIDENCE);
}

// 识别坐标基于原图，描摹 SVG 的 viewBox 用的是采样尺寸，这里按比例换算。
export function ocrLinesToSvgText(lines: OcrTextLine[], meta: { width: number; height: number; viewBoxWidth: number; viewBoxHeight: number }) {
    const scaleX = meta.viewBoxWidth / Math.max(1, meta.width);
    const scaleY = meta.viewBoxHeight / Math.max(1, meta.height);
    return lines
        .map((line, index) => ocrLineToSvgText(line, index, scaleX, scaleY))
        .filter(Boolean)
        .join("\n");
}

function ocrLineToSvgText(line: OcrTextLine, index: number, scaleX: number, scaleY: number) {
    const text = line.text.replace(/\s+/g, " ").trim();
    const x = line.bbox.x0 * scaleX;
    const top = line.bbox.y0 * scaleY;
    const bottom = line.bbox.y1 * scaleY;
    const width = (line.bbox.x1 - line.bbox.x0) * scaleX;
    const height = bottom - top;
    if (!text || width < MIN_LINE_SIZE || height < MIN_LINE_SIZE) return "";
    // baseline 取 bbox 底边略上收，font-size 用行高，贴近原图排版。
    return `<text id="ocr-text-${index + 1}" x="${round(x)}" y="${round(bottom - height * 0.12)}" font-size="${round(height * 0.86)}" font-family="Arial, 'Noto Sans SC', sans-serif" fill="#111111" data-ocr-confidence="${round(line.confidence)}">${escapeXml(text)}</text>`;
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal?: AbortSignal) {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("文字识别耗时过长，已跳过文字图层")), timeoutMs);
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        task.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        });
    });
}

function round(value: number) {
    return Math.round(value * 100) / 100;
}

function escapeXml(value: string) {
    return value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char] || char);
}
