"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Typography } from "antd";
import { Code2, Eye, MousePointer2, Save, Trash2, Type, Move } from "lucide-react";

import { dataUrlToSvgText, sanitizeEditableSvg, svgToDataUrl } from "../utils/canvas-svg-vector";

type EditableElementInfo = {
    id: string;
    tagName: string;
    label: string;
    fill: string;
    stroke: string;
    opacity: string;
    text: string;
};

type VisualSvgState = {
    markup: string;
    elements: EditableElementInfo[];
    error: string;
};

type DragState = {
    selectedId: string;
    startClientX: number;
    startClientY: number;
    startSvg: string;
    viewBoxWidth: number;
    viewBoxHeight: number;
    renderedWidth: number;
    renderedHeight: number;
};

const editableSelector = "path,rect,circle,ellipse,line,polyline,polygon,text,g";

export function CanvasNodeSvgEditDialog({ source, initialSvg, open, onClose, onConfirm }: { source: string; initialSvg?: string; open: boolean; onClose: () => void; onConfirm: (svg: string) => void }) {
    const { message } = App.useApp();
    const [svg, setSvg] = useState(initialSvg || "");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const dragRef = useRef<DragState | null>(null);

    useEffect(() => {
        if (!open) return;
        setError("");
        setSelectedId(null);
        setSvg(initialSvg || "");
        if (initialSvg) return;
        setLoading(true);
        void readSvgSource(source)
            .then((text) => setSvg(text))
            .catch((readError) => setError(readError instanceof Error ? readError.message : "SVG 读取失败"))
            .finally(() => setLoading(false));
    }, [initialSvg, open, source]);

    const visualSvg = useMemo(() => buildVisualSvgState(svg, selectedId), [selectedId, svg]);
    const selectedElement = visualSvg.elements.find((item) => item.id === selectedId) || null;
    const previewUrl = useMemo(() => {
        if (!svg.trim()) return "";
        try {
            return svgToDataUrl(sanitizeEditableSvg(svg));
        } catch {
            return "";
        }
    }, [svg]);

    const save = () => {
        try {
            const clean = sanitizeEditableSvg(svg);
            onConfirm(clean);
        } catch (saveError) {
            const text = saveError instanceof Error ? saveError.message : "SVG 格式不正确";
            setError(text);
            message.error(text);
        }
    };

    const updateSelected = (update: (element: Element) => void, fallback = "SVG 更新失败") => {
        if (selectedId === null) return;
        try {
            setSvg(updateSvgElement(svg, selectedId, update));
            setError("");
        } catch (updateError) {
            const text = updateError instanceof Error ? updateError.message : fallback;
            setError(text);
            message.error(text);
        }
    };

    const updateSelectedAttribute = (name: string, value: string) => {
        updateSelected((element) => {
            if (value.trim()) element.setAttribute(name, value.trim());
            else element.removeAttribute(name);
        });
    };

    const updateSelectedText = (value: string) => {
        updateSelected((element) => {
            element.textContent = value;
        }, "文字更新失败");
    };

    const deleteSelectedElement = () => {
        updateSelected((element) => element.remove(), "元素删除失败");
        setSelectedId(null);
    };

    const handleVisualPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const editable = target.closest("[data-edit-id]");
        const id = editable?.getAttribute("data-edit-id");
        if (!editable || !id) {
            setSelectedId(null);
            return;
        }
        const svgElement = editable.closest("svg") as SVGSVGElement | null;
        const rect = svgElement?.getBoundingClientRect();
        if (!svgElement || !rect?.width || !rect.height) {
            setSelectedId(id);
            return;
        }
        const viewBox = svgElement.viewBox.baseVal;
        const viewBoxWidth = viewBox?.width || Number(svgElement.getAttribute("width")) || rect.width;
        const viewBoxHeight = viewBox?.height || Number(svgElement.getAttribute("height")) || rect.height;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelectedId(id);
        dragRef.current = {
            selectedId: id,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startSvg: svg,
            viewBoxWidth,
            viewBoxHeight,
            renderedWidth: rect.width,
            renderedHeight: rect.height,
        };
    };

    const handleVisualPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        event.preventDefault();
        const dx = ((event.clientX - drag.startClientX) * drag.viewBoxWidth) / drag.renderedWidth;
        const dy = ((event.clientY - drag.startClientY) * drag.viewBoxHeight) / drag.renderedHeight;
        try {
            setSvg(updateSvgElement(drag.startSvg, drag.selectedId, (element) => {
                element.setAttribute("transform", translatedTransform(element.getAttribute("transform") || "", dx, dy));
            }));
        } catch (dragError) {
            dragRef.current = null;
            setError(dragError instanceof Error ? dragError.message : "拖动失败");
        }
    };

    const handleVisualPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        event.preventDefault();
        dragRef.current = null;
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // Pointer capture may already be released by the browser.
        }
    };

    return (
        <Modal title={null} open={open} onCancel={onClose} footer={null} width={1280} centered destroyOnHidden>
            <div className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">可视化对象编辑</h2>
                    <Typography.Paragraph type="secondary" className="!mb-0">
                        直接点击图形或文字选中，拖动即可移动；右侧修改文字、填充、描边和透明度。源码编辑仅作为高级选项。
                    </Typography.Paragraph>
                    {error || visualSvg.error ? <div className="mt-2 text-xs font-medium text-[#ef4444]">{error || visualSvg.error}</div> : null}
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(620px,1fr)_340px]">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 text-sm font-medium opacity-75">
                                <Eye className="size-4" />
                                对象画布
                            </div>
                            <span className="text-xs opacity-55">{visualSvg.elements.length ? `${visualSvg.elements.length} 个可点选对象` : loading ? "读取中..." : "等待有效 SVG"}</span>
                        </div>
                        <div
                            className="grid h-[640px] touch-none place-items-center overflow-hidden rounded-xl border bg-[linear-gradient(45deg,rgba(0,0,0,.04)_25%,transparent_25%),linear-gradient(-45deg,rgba(0,0,0,.04)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,rgba(0,0,0,.04)_75%),linear-gradient(-45deg,transparent_75%,rgba(0,0,0,.04)_75%)] bg-[length:18px_18px] bg-[position:0_0,0_9px,9px_-9px,-9px_0] p-5 dark:bg-[linear-gradient(45deg,rgba(255,255,255,.06)_25%,transparent_25%),linear-gradient(-45deg,rgba(255,255,255,.06)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,rgba(255,255,255,.06)_75%),linear-gradient(-45deg,transparent_75%,rgba(255,255,255,.06)_75%)]"
                            onPointerDown={handleVisualPointerDown}
                            onPointerMove={handleVisualPointerMove}
                            onPointerUp={handleVisualPointerUp}
                            onPointerCancel={handleVisualPointerUp}
                        >
                            {visualSvg.markup ? (
                                <div className="flex max-h-full max-w-full items-center justify-center [&_svg]:max-h-[600px] [&_svg]:max-w-full [&_svg]:select-none" dangerouslySetInnerHTML={{ __html: visualSvg.markup }} />
                            ) : previewUrl ? (
                                <img src={previewUrl} alt="SVG 预览" className="max-h-full max-w-full object-contain" />
                            ) : (
                                <span className="text-sm opacity-45">等待有效 SVG</span>
                            )}
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div className="rounded-xl border p-3">
                            <div className="mb-3 flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                    <MousePointer2 className="size-4" />
                                    <span className="truncate">{selectedElement ? `已选中：${selectedElement.label}` : "点击左侧对象开始编辑"}</span>
                                </div>
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedElement} onClick={deleteSelectedElement}>
                                    删除
                                </Button>
                            </div>
                            <div className="mb-3 flex items-center gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-xs opacity-70 dark:bg-white/[0.06]">
                                <Move className="size-3.5" />
                                选中对象后直接在左侧拖动位置
                            </div>
                            <div className="grid gap-3 text-sm">
                                {selectedElement?.tagName === "text" ? <AttributeEditor icon={<Type className="size-3.5" />} label="文字内容" value={selectedElement.text} disabled={!selectedElement} onChange={updateSelectedText} /> : null}
                                <AttributeEditor label="填充" value={selectedElement?.fill || ""} disabled={!selectedElement} onChange={(value) => updateSelectedAttribute("fill", value)} />
                                <AttributeEditor label="描边" value={selectedElement?.stroke || ""} disabled={!selectedElement} onChange={(value) => updateSelectedAttribute("stroke", value)} />
                                <AttributeEditor label="透明度" value={selectedElement?.opacity || ""} disabled={!selectedElement} placeholder="0-1，留空使用默认" onChange={(value) => updateSelectedAttribute("opacity", value)} />
                            </div>
                        </div>

                        <details className="rounded-xl border p-3">
                            <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium opacity-75">
                                <Code2 className="size-4" />
                                高级：SVG 源码
                            </summary>
                            <Input.TextArea
                                value={svg}
                                onChange={(event) => {
                                    setSvg(event.target.value);
                                    setError("");
                                    setSelectedId(null);
                                }}
                                spellCheck={false}
                                autoSize={false}
                                className="!mt-3 !h-[260px] !font-mono !text-xs"
                                placeholder={loading ? "读取 SVG 中..." : "在这里粘贴或编辑 <svg>...</svg>"}
                            />
                        </details>
                    </div>
                </div>

                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" icon={<Save className="size-4" />} disabled={!svg.trim()} onClick={save}>
                        保存到画布
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function AttributeEditor({ icon, label, value, disabled, placeholder, onChange }: { icon?: React.ReactNode; label: string; value: string; disabled: boolean; placeholder?: string; onChange: (value: string) => void }) {
    const colorValue = toColorInputValue(value);
    return (
        <label className="grid gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium opacity-60">
                {icon}
                {label}
            </span>
            <span className="flex gap-2">
                <Input value={value} disabled={disabled} placeholder={placeholder || "例如 #2f80ff / none"} onChange={(event) => onChange(event.target.value)} />
                {colorValue ? <input type="color" value={colorValue} disabled={disabled} className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent p-0 disabled:cursor-not-allowed" onChange={(event) => onChange(event.target.value)} /> : null}
            </span>
        </label>
    );
}

async function readSvgSource(source: string) {
    const inline = dataUrlToSvgText(source);
    if (inline) return inline;
    const response = await fetch(source);
    if (!response.ok) throw new Error("SVG 读取失败");
    const text = await response.text();
    if (!text.trim().startsWith("<svg") && !text.includes("<svg")) throw new Error("当前节点不是可编辑 SVG，请先使用“转可编辑”");
    return text;
}

function buildVisualSvgState(svg: string, selectedId: string | null): VisualSvgState {
    if (!svg.trim()) return { markup: "", elements: [], error: "" };
    try {
        const clean = sanitizeEditableSvg(svg);
        const document = new DOMParser().parseFromString(clean, "image/svg+xml");
        const elements = editableElements(document);
        const infos = elements.map((element, index) => {
            const id = String(index);
            const tagName = element.tagName.toLowerCase();
            const text = tagName === "text" ? element.textContent || "" : "";
            const info = {
                id,
                tagName,
                label: text ? `${tagName}：${text.slice(0, 18)}` : `${tagName} #${index + 1}`,
                fill: element.getAttribute("fill") || "",
                stroke: element.getAttribute("stroke") || "",
                opacity: element.getAttribute("opacity") || "",
                text,
            };
            element.setAttribute("data-edit-id", id);
            element.setAttribute("style", `${element.getAttribute("style") || ""};cursor:move;pointer-events:all`);
            if (id === selectedId) {
                element.setAttribute("stroke", "#2f80ff");
                element.setAttribute("stroke-width", element.getAttribute("stroke-width") || "2");
                element.setAttribute("vector-effect", "non-scaling-stroke");
                element.setAttribute("filter", "drop-shadow(0 0 3px rgba(47,128,255,.55))");
            }
            return info;
        });
        return { markup: new XMLSerializer().serializeToString(document.documentElement), elements: infos, error: "" };
    } catch (buildError) {
        return { markup: "", elements: [], error: buildError instanceof Error ? buildError.message : "SVG 解析失败" };
    }
}

function updateSvgElement(svg: string, selectedId: string, update: (element: Element) => void) {
    const clean = sanitizeEditableSvg(svg);
    const document = new DOMParser().parseFromString(clean, "image/svg+xml");
    const element = editableElements(document)[Number(selectedId)];
    if (!element) throw new Error("选中的 SVG 元素不存在");
    update(element);
    return new XMLSerializer().serializeToString(document.documentElement);
}

function editableElements(document: Document) {
    return Array.from(document.querySelectorAll(editableSelector)).filter((element) => element !== document.documentElement);
}

function translatedTransform(transform: string, dx: number, dy: number) {
    const move = `translate(${roundSvgNumber(dx)} ${roundSvgNumber(dy)})`;
    return transform.trim() ? `${transform.trim()} ${move}` : move;
}

function roundSvgNumber(value: number) {
    return Number(value.toFixed(2));
}

function toColorInputValue(value: string) {
    const normalized = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized;
    if (/^#[0-9a-f]{3}$/i.test(normalized)) return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`;
    if (!normalized || normalized === "none") return "#000000";
    return "";
}
