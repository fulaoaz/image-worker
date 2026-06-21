import { ColorMode, Hierarchical, PathSimplifyMode, TracerConfig, convertImageToSvg, init, isReady } from "wasm_vtracer";

type TraceRequest = {
    id: number;
    type: "trace";
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
};

type TraceResponse = { id: number; type: "done"; svg: string } | { id: number; type: "error"; error: string };

let initialized = false;

self.onmessage = (event: MessageEvent<TraceRequest>) => {
    const request = event.data;
    if (request.type !== "trace") return;

    let config: TracerConfig | null = null;
    try {
        if (!initialized || !isReady()) {
            init();
            initialized = true;
        }

        config = new TracerConfig();
        config.presetPhoto();
        config.setColorMode(ColorMode.Color);
        config.setHierarchical(Hierarchical.Stacked);
        config.setPathSimplifyMode(PathSimplifyMode.Spline);
        config.setFilterSpeckle(0);
        config.setColorPrecision(8);
        config.setLayerDifference(4);
        config.setCornerThreshold(60);
        config.setLengthThreshold(3.5);
        config.setMaxIterations(20);
        config.setSpliceThreshold(30);
        config.setPathPrecision(4);

        const rgba = new Uint8Array(request.rgba.buffer, request.rgba.byteOffset, request.rgba.byteLength);
        const svg = convertImageToSvg(rgba, request.width, request.height, config);
        postMessage({ id: request.id, type: "done", svg } satisfies TraceResponse);
    } catch (error) {
        postMessage({ id: request.id, type: "error", error: error instanceof Error ? error.message : "VTracer 转换失败" } satisfies TraceResponse);
    } finally {
        config?.free();
    }
};
