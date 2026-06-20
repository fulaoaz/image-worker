import { NextRequest } from "next/server";

import { getAdminServerModelChannels, saveAdminServerModelChannels } from "@/lib/server-ai-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    if (!isAuthorized(request)) return unauthorized();
    return Response.json({ channels: getAdminServerModelChannels() });
}

export async function POST(request: NextRequest) {
    if (!isAuthorized(request)) return unauthorized();
    try {
        const payload = (await request.json()) as { channels?: unknown };
        const saved = await saveAdminServerModelChannels(payload.channels || []);
        return Response.json({ channels: saved, ok: true });
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "保存服务器配置失败" }, { status: 400 });
    }
}

function isAuthorized(request: NextRequest) {
    const configuredToken = process.env.ADMIN_TOKEN || "";
    if (!configuredToken) return false;
    const token = request.headers.get("x-admin-token") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    return token === configuredToken;
}

function unauthorized() {
    return Response.json({ error: "管理员 Token 不正确，或服务器未配置 ADMIN_TOKEN" }, { status: 401 });
}
