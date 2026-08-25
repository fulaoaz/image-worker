export const APP_VERSION = __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://github.com/fulaoaz/image-worker/tree/main/docs";

// 官方插件注册表：CI 构建后发布到 plugins-dist 分支，经 jsDelivr 分发；可用环境变量覆盖成自建来源。
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/fulaoaz/image-worker@plugins-dist/official-plugins.json";
