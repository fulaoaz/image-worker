"use client";

import { App, Button, Card, Form, Input, Typography } from "antd";
import { Save, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { ModelChannelSettings } from "@/components/model-channel-settings";
import { fetchChannelModels } from "@/services/api/image";
import { createModelChannel, type ModelChannel } from "@/stores/use-config-store";

export default function AdminPage() {
    const { message } = App.useApp();
    const [token, setToken] = useState("");
    const [channels, setChannels] = useState<ModelChannel[]>([createModelChannel({ id: "server", name: "服务器渠道" })]);
    const [loaded, setLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const canManage = token.trim().length > 0;
    const normalizedChannels = useMemo(() => channels.map((channel) => ({ ...channel, serverManaged: false })), [channels]);

    const loadConfig = async () => {
        if (!canManage) {
            message.error("请先填写管理员 Token");
            return;
        }
        setLoading(true);
        try {
            const response = await fetch("/api/admin/ai-config", { headers: adminHeaders(token), cache: "no-store" });
            const payload = (await response.json()) as { channels?: ModelChannel[]; error?: string };
            if (!response.ok) throw new Error(payload.error || "读取服务器配置失败");
            setChannels((payload.channels?.length ? payload.channels : [createModelChannel({ id: "server", name: "服务器渠道" })]).map((channel) => createModelChannel({ ...channel, serverManaged: false })));
            setLoaded(true);
            message.success("已读取服务器配置");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取服务器配置失败");
        } finally {
            setLoading(false);
        }
    };

    const saveConfig = async () => {
        if (!canManage) {
            message.error("请先填写管理员 Token");
            return;
        }
        setSaving(true);
        try {
            const response = await fetch("/api/admin/ai-config", {
                method: "POST",
                headers: { ...adminHeaders(token), "Content-Type": "application/json" },
                body: JSON.stringify({ channels: normalizedChannels }),
            });
            const payload = (await response.json()) as { channels?: ModelChannel[]; error?: string };
            if (!response.ok) throw new Error(payload.error || "保存服务器配置失败");
            setChannels((payload.channels || normalizedChannels).map((channel) => createModelChannel({ ...channel, serverManaged: false })));
            setLoaded(true);
            message.success("服务器配置已保存，普通用户刷新后即可使用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存服务器配置失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <main className="h-dvh overflow-y-auto overscroll-contain bg-background px-6 py-8 text-foreground thin-scrollbar">
            <div className="mx-auto max-w-6xl space-y-5 pb-10">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-stone-500">
                            <ShieldCheck className="size-4" />
                            Image Worker 管理员
                        </div>
                        <h1 className="text-2xl font-semibold tracking-tight">模型提供商服务端配置</h1>
                        <Typography.Paragraph type="secondary" className="!mt-2 !mb-0 max-w-3xl">
                            这里的配置会保存到服务器数据目录，普通用户会在配置面板自动看到这些服务器渠道并直接使用；API Key 只保存在服务器，不会下发到浏览器。普通用户仍然可以在自己的配置面板里添加本地私有渠道。
                        </Typography.Paragraph>
                    </div>
                    <Link href="/">
                        <Button>返回用户端</Button>
                    </Link>
                </div>

                <Card>
                    <Form layout="vertical" requiredMark={false}>
                        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
                            <Form.Item label="管理员 Token" className="mb-0">
                                <Input.Password value={token} placeholder="服务器环境变量 ADMIN_TOKEN" autoComplete="current-password" onChange={(event) => setToken(event.target.value)} onPressEnter={() => void loadConfig()} />
                            </Form.Item>
                            <Button loading={loading} disabled={!canManage} onClick={() => void loadConfig()}>
                                {loaded ? "重新读取" : "读取配置"}
                            </Button>
                            <Button type="primary" icon={<Save className="size-4" />} loading={saving} disabled={!canManage} onClick={() => void saveConfig()}>
                                保存到服务器
                            </Button>
                        </div>
                    </Form>
                </Card>

                <Card>
                    <ModelChannelSettings
                        channels={normalizedChannels}
                        onChannelsChange={setChannels}
                        fetchModels={fetchChannelModels}
                        disableServerManaged={false}
                        scopeLabel={() => "保存到服务器"}
                        hint="管理员保存后，所有普通用户刷新页面即可看到这些服务器渠道；普通用户看不到 API Key。"
                        apiKeyPlaceholder={() => "保存到服务器，不下发给普通用户"}
                        modelsPlaceholder={() => "输入模型名，或点击拉取模型"}
                    />
                </Card>
            </div>
        </main>
    );
}

function adminHeaders(token: string) {
    return { "x-admin-token": token.trim() };
}
