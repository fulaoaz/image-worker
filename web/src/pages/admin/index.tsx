import { App, Button, Card, Form, Input, Tag, Typography } from "antd";
import { ArrowLeft, Pencil, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { fetchAdminServerModelChannels, saveAdminServerModelChannels } from "@/services/api/server-ai-config";
import { createModelChannel, type ModelChannel } from "@/stores/use-config-store";

export default function AdminPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [token, setToken] = useState("");
    const [channels, setChannels] = useState<ModelChannel[]>(() => [createModelChannel({ id: "server", name: t("admin.defaultChannel") })]);
    const [editingChannelId, setEditingChannelId] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const canManage = Boolean(token.trim());
    const editingChannel = channels.find((channel) => channel.id === editingChannelId) || null;
    const configuredChannels = useMemo(() => channels.filter((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length), [channels]);

    const loadConfig = async () => {
        if (!canManage) {
            message.error(t("admin.tokenRequired"));
            return;
        }
        setLoading(true);
        try {
            const savedChannels = await fetchAdminServerModelChannels(token);
            setChannels((savedChannels.length ? savedChannels : [createModelChannel({ id: "server", name: t("admin.defaultChannel") })]).map((channel) => createModelChannel({ ...channel, serverManaged: false })));
            setLoaded(true);
            message.success(t("admin.loaded"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.loadFailed"));
        } finally {
            setLoading(false);
        }
    };

    const saveConfig = async () => {
        if (!canManage) {
            message.error(t("admin.tokenRequired"));
            return;
        }
        setSaving(true);
        try {
            const savedChannels = await saveAdminServerModelChannels(token, channels.map(({ serverManaged: _serverManaged, ...channel }) => channel));
            setChannels(savedChannels.map((channel) => createModelChannel({ ...channel, serverManaged: false })));
            setLoaded(true);
            message.success(t("admin.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const addChannel = () => {
        const channel = createModelChannel({ name: t("admin.channelNumber", { count: channels.length + 1 }) });
        setChannels((current) => [...current, channel]);
        setEditingChannelId(channel.id);
    };

    const saveChannel = (channel: ModelChannel) => setChannels((current) => current.map((item) => (item.id === channel.id ? { ...channel, serverManaged: false } : item)));
    const deleteChannel = (id: string) => setChannels((current) => current.filter((channel) => channel.id !== id));

    return (
        <main className="h-dvh overflow-y-auto overscroll-contain bg-background px-4 py-6 text-foreground md:px-8 md:py-10">
            <div className="mx-auto max-w-5xl pb-12">
                <header className="mb-8 flex flex-wrap items-start justify-between gap-5 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div className="max-w-3xl">
                        <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">
                            <ShieldCheck className="size-4" />
                            {t("admin.eyebrow")}
                        </div>
                        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{t("admin.title")}</h1>
                        <Typography.Paragraph type="secondary" className="!mt-3 !mb-0 max-w-2xl text-sm leading-6">
                            {t("admin.description")}
                        </Typography.Paragraph>
                    </div>
                    <Link to="/">
                        <Button icon={<ArrowLeft className="size-4" />}>{t("admin.back")}</Button>
                    </Link>
                </header>

                <Card className="!mb-5" styles={{ body: { padding: 20 } }}>
                    <Form layout="vertical" requiredMark={false}>
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
                            <Form.Item label={t("admin.token")} extra={t("admin.tokenDescription")} className="mb-0">
                                <Input.Password value={token} placeholder={t("admin.tokenPlaceholder")} autoComplete="current-password" onChange={(event) => setToken(event.target.value)} onPressEnter={() => void loadConfig()} />
                            </Form.Item>
                            <Button loading={loading} disabled={!canManage || saving} onClick={() => void loadConfig()}>
                                {loaded ? t("admin.reload") : t("admin.load")}
                            </Button>
                            <Button type="primary" icon={<Save className="size-4" />} loading={saving} disabled={!canManage || loading} onClick={() => void saveConfig()}>
                                {t("admin.save")}
                            </Button>
                        </div>
                    </Form>
                </Card>

                <section className="rounded-xl border border-stone-200 bg-white/60 dark:border-stone-800 dark:bg-stone-950/20">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-5 py-4 dark:border-stone-800">
                        <div>
                            <h2 className="text-base font-semibold">{t("admin.providers")}</h2>
                            <p className="mt-1 text-xs text-stone-500">{t("admin.providerDescription", { configured: configuredChannels.length, total: channels.length })}</p>
                        </div>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                            {t("admin.add")}
                        </Button>
                    </div>

                    {channels.length ? (
                        <div className="divide-y divide-stone-200 dark:divide-stone-800">
                            {channels.map((channel) => (
                                <div key={channel.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="truncate text-sm font-semibold">{channel.name || t("config.channels.unnamed")}</span>
                                            <Tag color={channel.apiFormat === "gemini" ? "blue" : "green"}>{channel.apiFormat === "gemini" ? "Gemini" : "OpenAI"}</Tag>
                                            {channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length ? <Tag color="success">{t("admin.ready")}</Tag> : <Tag>{t("admin.draft")}</Tag>}
                                        </div>
                                        <div className="mt-1 max-w-2xl truncate text-xs text-stone-500">{channel.baseUrl || t("config.channels.missingUrl")} · {t("config.channels.modelCount", { count: channel.models.length })}</div>
                                    </div>
                                    <div className="flex shrink-0 gap-1">
                                        <Button type="text" icon={<Pencil className="size-4" />} onClick={() => setEditingChannelId(channel.id)}>
                                            {t("common.edit")}
                                        </Button>
                                        <Button type="text" danger icon={<Trash2 className="size-4" />} onClick={() => deleteChannel(channel.id)} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="px-5 py-12 text-center text-sm text-stone-500">{t("admin.empty")}</div>
                    )}
                </section>
            </div>

            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} enableScripts={false} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
        </main>
    );
}
