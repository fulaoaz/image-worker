import { getPublicServerModelChannels } from "@/lib/server-ai-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    return Response.json({ channels: getPublicServerModelChannels() });
}
