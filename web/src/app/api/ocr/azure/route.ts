import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AZURE_OCR_TIMEOUT_MS = 60000;
const AZURE_OCR_MAX_BYTES = 8 * 1024 * 1024;

type AzureReadResponse = {
    metadata?: { width?: number; height?: number };
    readResult?: {
        pages?: AzureReadPage[];
        blocks?: AzureReadBlock[];
    };
    error?: { message?: string };
};

type AzureReadPage = {
    width?: number;
    height?: number;
    angle?: number;
    words?: AzureReadWord[];
    lines?: AzureReadLine[];
};

type AzureReadBlock = {
    lines?: AzureReadLine[];
};

type AzureReadLine = {
    content?: string;
    text?: string;
    boundingBox?: number[];
    boundingPolygon?: AzurePoint[];
    words?: AzureReadWord[];
};

type AzureReadWord = {
    content?: string;
    text?: string;
    confidence?: number;
    boundingBox?: number[];
    boundingPolygon?: AzurePoint[];
};

type AzurePoint = { x?: number; y?: number };

type OcrLine = {
    text: string;
    confidence: number;
    polygon: Array<{ x: number; y: number }>;
};

type OcrResponse = {
    width: number;
    height: number;
    angle: number;
    lines: OcrLine[];
};

export async function POST(request: NextRequest) {
    const endpoint = normalizeEndpoint(process.env.AZURE_VISION_ENDPOINT || "");
    const apiKey = process.env.AZURE_VISION_KEY || "";
    const apiVersion = process.env.AZURE_VISION_API_VERSION || "2024-02-01";
    if (!endpoint || !apiKey) return Response.json({ error: "Azure OCR 未配置，请在服务器环境变量中设置 AZURE_VISION_ENDPOINT 和 AZURE_VISION_KEY" }, { status: 500 });

    const contentType = request.headers.get("content-type") || "application/octet-stream";
    const imageBytes = await request.arrayBuffer();
    if (!imageBytes.byteLength) return Response.json({ error: "缺少图片内容" }, { status: 400 });
    if (imageBytes.byteLength > AZURE_OCR_MAX_BYTES) return Response.json({ error: "图片超过 Azure OCR 8MB 限制，请先压缩或缩小图片" }, { status: 413 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AZURE_OCR_TIMEOUT_MS);
    try {
        const url = `${endpoint}/computervision/imageanalysis:analyze?api-version=${encodeURIComponent(apiVersion)}&features=read`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": contentType,
                "Ocp-Apim-Subscription-Key": apiKey,
            },
            body: imageBytes,
            signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as AzureReadResponse | null;
        if (!response.ok || !payload) {
            return Response.json({ error: payload?.error?.message || `Azure OCR 调用失败（${response.status}）` }, { status: response.status || 502 });
        }
        return Response.json(normalizeAzureReadResult(payload));
    } catch (error) {
        const message = error instanceof Error && error.name === "AbortError" ? "Azure OCR 超时" : error instanceof Error ? error.message : "Azure OCR 调用失败";
        return Response.json({ error: message }, { status: 502 });
    } finally {
        clearTimeout(timer);
    }
}

function normalizeEndpoint(endpoint: string) {
    return endpoint.trim().replace(/\/+$/, "");
}

function normalizeAzureReadResult(payload: AzureReadResponse): OcrResponse {
    const page = payload.readResult?.pages?.[0];
    const pageLines = page?.lines || payload.readResult?.blocks?.flatMap((block) => block.lines || []) || [];
    const pageWords = page?.words || [];
    const lines = pageLines.map((line) => normalizeLine(line, pageWords)).filter((line): line is OcrLine => Boolean(line && line.text && line.polygon.length >= 4));
    return {
        width: Number(page?.width || payload.metadata?.width || 0),
        height: Number(page?.height || payload.metadata?.height || 0),
        angle: Number(page?.angle || 0),
        lines,
    };
}

function normalizeLine(line: AzureReadLine, pageWords: AzureReadWord[]): OcrLine | null {
    const text = (line.content || line.text || "").replace(/\s+/g, " ").trim();
    const polygon = polygonFromLine(line);
    if (!text || !polygon.length) return null;
    const lineWords = line.words?.length ? line.words : pageWords.filter((word) => wordText(word) && isInside(polygonCenter(polygonFromWord(word)), polygon));
    const confidences = lineWords.map((word) => Number(word.confidence)).filter((value) => Number.isFinite(value));
    const confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 1;
    return { text, confidence, polygon };
}

function polygonFromLine(line: AzureReadLine) {
    return line.boundingPolygon?.length ? polygonFromPoints(line.boundingPolygon) : polygonFromBox(line.boundingBox || []);
}

function polygonFromWord(word: AzureReadWord) {
    return word.boundingPolygon?.length ? polygonFromPoints(word.boundingPolygon) : polygonFromBox(word.boundingBox || []);
}

function wordText(word: AzureReadWord) {
    return word.content || word.text || "";
}

function polygonFromPoints(points: AzurePoint[]) {
    return points.map((point) => ({ x: Number(point.x || 0), y: Number(point.y || 0) }));
}

function polygonFromBox(box: number[]) {
    const points: Array<{ x: number; y: number }> = [];
    for (let index = 0; index + 1 < box.length; index += 2) points.push({ x: Number(box[index] || 0), y: Number(box[index + 1] || 0) });
    return points;
}

function polygonCenter(points: Array<{ x: number; y: number }>) {
    if (!points.length) return { x: 0, y: 0 };
    return {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
}

function isInside(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>) {
    if (polygon.length < 3) return false;
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
        const currentPoint = polygon[current];
        const previousPoint = polygon[previous];
        const intersects = currentPoint.y > point.y !== previousPoint.y > point.y && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y || 1) + currentPoint.x;
        if (intersects) inside = !inside;
    }
    return inside;
}
