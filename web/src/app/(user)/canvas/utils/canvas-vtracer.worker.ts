import { ColorMode, Hierarchical, PathSimplifyMode, TracerConfig, convertImageToSvg, init, isReady } from "wasm_vtracer";

type TraceProfile = "detailed" | "safe";

type TraceRequest = {
    id: number;
    type: "trace";
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
    profile?: TraceProfile;
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
        applyTraceProfile(config, request.profile || "detailed");

        const rgba = new Uint8Array(request.rgba.buffer, request.rgba.byteOffset, request.rgba.byteLength);
        const svg = convertImageToSvg(rgba, request.width, request.height, config);
        postMessage({ id: request.id, type: "done", svg } satisfies TraceResponse);
    } catch (error) {
        postMessage({ id: request.id, type: "error", error: error instanceof Error ? error.message : "VTracer 转换失败" } satisfies TraceResponse);
    } finally {
        config?.free();
    }
};

function applyTraceProfile(config: TracerConfig, profile: TraceProfile) {
    config.presetPhoto();
    config.setColorMode(ColorMode.Color);
    config.setHierarchical(Hierarchical.Stacked);
    config.setPathSimplifyMode(PathSimplifyMode.Spline);

    if (profile === "safe") {
        config.setFilterSpeckle(4);
        config.setColorPrecision(6);
        config.setLayerDifference(16);
        config.setCornerThreshold(60);
        config.setLengthThreshold(5);
        config.setMaxIterations(8);
        config.setSpliceThreshold(45);
        config.setPathPrecision(2);
        return;
    }

    config.setFilterSpeckle(1);
    config.setColorPrecision(7);
    config.setLayerDifference(8);
    config.setCornerThreshold(60);
    config.setLengthThreshold(4);
    config.setMaxIterations(12);
    config.setSpliceThreshold(35);
    config.setPathPrecision(3);
}
