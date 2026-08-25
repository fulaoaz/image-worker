#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# unset providers remain disabled, load no scripts, and send no external requests. Multiple providers may be enabled together.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")

# AI_CHANNELS 是部署者预置的渠道 JSON 数组，用单引号包裹写入，并转义单引号和反斜杠，
# 避免值里的引号截断 config.js。注意：该值会下发到浏览器，密钥对使用者可见，
# 仅适合个人或可信环境预置，不等同于服务端保管密钥。
escape_js_single_quoted() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g" -e 's/$/\\n/' | tr -d '\n'
}

AI_CHANNELS_JSON=$(escape_js_single_quoted "${AI_CHANNELS:-}")

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}",
  AI_CHANNELS: '${AI_CHANNELS_JSON}'
};
EOF
