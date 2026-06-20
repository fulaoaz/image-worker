"use client";

import { App, Button, Form, Input, Select } from "antd";
import { CircleAlert, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { createModelChannel, defaultBaseUrlForApiFormat, type ApiCallFormat, type ModelChannel } from "@/stores/use-config-store";

type ModelChannelSettingsProps = {
    channels: ModelChannel[];
    onChannelsChange: (channels: ModelChannel[]) => void;
    fetchModels: (channel: ModelChannel) => Promise<string[]>;
    onOpenModels?: () => void;
    disableServerManaged?: boolean;
    scopeLabel?: (channel: ModelChannel) => string;
    hint?: string;
    modelsPlaceholder?: (channel: ModelChannel) => string;
    apiKeyPlaceholder?: (channel: ModelChannel) => string;
};

const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "Gemini", value: "gemini" },
];

export function ModelChannelSettings({
    channels,
    onChannelsChange,
    fetchModels,
    onOpenModels,
    disableServerManaged = true,
    scopeLabel = (channel) => (channel.serverManaged ? "服务器配置" : "浏览器本地"),
    hint = "新增或拉取模型后，需要到“模型”Tab 选择可选项才会显示。",
    modelsPlaceholder = (channel) => (channel.serverManaged ? "由服务器环境变量或管理员面板提供" : "输入模型名，或点击拉取模型"),
    apiKeyPlaceholder = (channel) => (channel.serverManaged ? "由服务器保存，不下发到浏览器" : "请输入 API Key"),
}: ModelChannelSettingsProps) {
    const { message } = App.useApp();
    const [loadingChannelId, setLoadingChannelId] = useState("");
    const safeChannels = channels.length ? channels : [createModelChannel({ name: "渠道 1" })];
    const editableChannels = safeChannels.filter(isEditableChannel);

    function isEditableChannel(channel: ModelChannel) {
        return !(disableServerManaged && channel.serverManaged);
    }

    const updateChannels = (nextChannels: ModelChannel[]) => {
        onChannelsChange(nextChannels.map((channel) => createModelChannel(channel)));
    };

    const updateChannel = (id: string, patch: Partial<ModelChannel>) => {
        updateChannels(safeChannels.map((channel) => (channel.id === id ? { ...channel, ...patch, models: patch.models ? uniqueModels(patch.models) : channel.models } : channel)));
    };

    const updateChannelApiFormat = (channel: ModelChannel, apiFormat: ApiCallFormat) => {
        const baseUrl = !channel.baseUrl.trim() || channel.baseUrl.trim() === defaultBaseUrlForApiFormat(channel.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : channel.baseUrl;
        updateChannel(channel.id, { apiFormat, baseUrl });
    };

    const addChannel = () => {
        updateChannels([...safeChannels, createModelChannel({ name: `渠道 ${safeChannels.length + 1}` })]);
    };

    const deleteChannel = (id: string) => {
        if (safeChannels.length <= 1) {
            message.warning("至少保留一个渠道");
            return;
        }
        updateChannels(safeChannels.filter((channel) => channel.id !== id));
    };

    const refreshChannelModels = async (channel: ModelChannel) => {
        if (!channel.baseUrl.trim() || (!channel.apiKey.trim() && !channel.serverManaged)) {
            message.error("请先填写该渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingChannelId(channel.id);
        try {
            const models = await fetchModels(channel);
            updateChannels(safeChannels.map((item) => (item.id === channel.id ? { ...item, models } : item)));
            message.success(`${channel.name} 模型列表已更新`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    const refreshAllModels = async () => {
        const runnable = editableChannels.filter((channel) => channel.baseUrl.trim() && (channel.apiKey.trim() || channel.serverManaged));
        if (!runnable.length) {
            message.error("请先填写至少一个渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingChannelId("all");
        try {
            const entries = await Promise.all(runnable.map(async (channel) => [channel.id, await fetchModels(channel)] as const));
            const modelMap = new Map(entries);
            updateChannels(safeChannels.map((channel) => (modelMap.has(channel.id) ? { ...channel, models: modelMap.get(channel.id) || [] } : channel)));
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="min-w-0 flex-1">
                    <div className="flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
                        <CircleAlert className="size-3.5 shrink-0" />
                        <span className="font-semibold">重要：</span>
                        <span>{hint}</span>
                        {onOpenModels ? (
                            <Button type="link" size="small" className="h-auto p-0 text-xs font-semibold text-amber-900 dark:text-amber-100" onClick={onOpenModels}>
                                去模型设置
                            </Button>
                        ) : null}
                    </div>
                </div>
                <div className="flex shrink-0 gap-2">
                    <Button icon={<RefreshCw className="size-4" />} loading={Boolean(loadingChannelId)} disabled={!editableChannels.length} onClick={() => void refreshAllModels()}>
                        拉取全部
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                        新增渠道
                    </Button>
                </div>
            </div>
            <div className="space-y-3">
                {safeChannels.map((channel) => {
                    const editable = isEditableChannel(channel);
                    return (
                        <section key={channel.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</div>
                                    <div className="mt-1 text-xs text-stone-500">
                                        {apiFormatLabel(channel.apiFormat)} · {scopeLabel(channel)} · 已保存 {channel.models.length} 个模型
                                    </div>
                                </div>
                                <div className="flex shrink-0 gap-2">
                                    <Button size="small" loading={loadingChannelId === channel.id} disabled={!editable} onClick={() => void refreshChannelModels(channel)}>
                                        拉取模型
                                    </Button>
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!editable} onClick={() => deleteChannel(channel.id)} />
                                </div>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <Form.Item label="渠道名称" className="mb-0">
                                    <Input value={channel.name} disabled={!editable} onChange={(event) => updateChannel(channel.id, { name: event.target.value })} />
                                </Form.Item>
                                <Form.Item label="调用格式" className="mb-0">
                                    <Select value={channel.apiFormat} options={apiFormatOptions} disabled={!editable} onChange={(value: ApiCallFormat) => updateChannelApiFormat(channel, value)} />
                                </Form.Item>
                                <Form.Item label="Base URL" className="mb-0">
                                    <Input value={channel.baseUrl} disabled={!editable} onChange={(event) => updateChannel(channel.id, { baseUrl: event.target.value })} />
                                </Form.Item>
                                <Form.Item label="API Key" className="mb-0">
                                    <Input.Password value={editable ? channel.apiKey : apiKeyPlaceholder(channel)} disabled={!editable} placeholder={apiKeyPlaceholder(channel)} onChange={(event) => updateChannel(channel.id, { apiKey: event.target.value })} />
                                </Form.Item>
                                <Form.Item label="模型列表" className="mb-0 md:col-span-2">
                                    <Select mode="tags" showSearch allowClear maxTagCount="responsive" placeholder={modelsPlaceholder(channel)} value={channel.models} disabled={!editable} onChange={(models) => updateChannel(channel.id, { models })} />
                                </Form.Item>
                            </div>
                        </section>
                    );
                })}
            </div>
        </Form>
    );
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function apiFormatLabel(apiFormat: ApiCallFormat) {
    return apiFormat === "gemini" ? "Gemini" : "OpenAI";
}
