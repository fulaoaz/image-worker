import React, { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Typography } from "antd";
import { Code2, Eye, MousePointer2, Move, Save, Trash2, Type } from "lucide-react";
import { useTranslation } from "react-i18next";

import { dataUrlToSvgText, sanitizeEditableSvg, svgToDataUrl } from "@/lib/canvas/canvas-svg-vector";

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
    const { t } = useTranslation();
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
        void readSvgSource(source, t("canvas.svgEditor.notEditable"))
            .then((text) => setSvg(text))
            .catch((readError) => setError(readError instanceof Error ? readError.message : t("canvas.svgEditor.readFailed")))
            .finally(() => setLoading(false));
    }, [initialSvg, open, source, t]);

    const visualSvg = useMemo(() => buildVisualSvgState(svg, selectedId, t("canvas.svgEditor.parseFailed")), [selectedId, svg, t]);
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
            onConfirm(sanitizeEditableSvg(svg));
        } catch (saveError) {
            const text = saveError instanceof Error ? saveError.message : t("canvas.svgEditor.invalidSvg");
            setError(text);
            message.error(text);
        }
    };

    const updateSelected = (update: (element: Element) => void) => {
        if (selectedId === null) return;
        try {
            setSvg(updateSvgElement(svg, selectedId, update, t("canvas.svgEditor.missingElement")));
            setError("");
        } catch (updateError) {
            const text = updateError instanceof Error ? updateError.message : t("canvas.svgEditor.updateFailed");
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

    const deleteSelectedElement = () => {
        updateSelected((element) => element.remove());
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
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelectedId(id);
        dragRef.current = {
            selectedId: id,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startSvg: svg,
            viewBoxWidth: viewBox?.width || Number(svgElement.getAttribute("width")) || rect.width,
            viewBoxHeight: viewBox?.height || Number(svgElement.getAttribute("height")) || rect.height,
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
            setSvg(
                updateSvgElement(
                    drag.startSvg,
                    drag.selectedId,
                    (element) => element.setAttribute("transform", translatedTransform(element.getAttribute("transform") || "", dx, dy)),
                    t("canvas.svgEditor.missingElement"),
                ),
            );
        } catch (dragError) {
            dragRef.current = null;
            setError(dragError instanceof Error ? dragError.message : t("canvas.svgEditor.dragFailed"));
        }
    };

    const handleVisualPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        event.preventDefault();
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    return (
        <Modal title={null} open={open} onCancel={onClose} footer={null} width={1280} centered destroyOnHidden>
            <div className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.svgEditor.title")}</h2>
                    <Typography.Paragraph type="secondary" className="!mb-0">
                        {t("canvas.svgEditor.description")}
                    </Typography.Paragraph>
                    {error || visualSvg.error ? <div className="mt-2 text-xs font-medium text-[#ef4444]">{error || visualSvg.error}</div> : null}
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(620px,1fr)_340px]">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 text-sm font-medium opacity-75">
                                <Eye className="size-4" />
                                {t("canvas.svgEditor.canvas")}
                            </div>
                            <span className="text-xs opacity-55">
                                {visualSvg.elements.length ? t("canvas.svgEditor.objectCount", { count: visualSvg.elements.length }) : loading ? t("canvas.editors.loading") : t("canvas.svgEditor.waiting")}
                            </span>
                        </div>
                        <div
                            className="grid h-[640px] touch-none place-items-center overflow-hidden rounded-xl border bg-black/[0.03] p-5 dark:bg-white/[0.04]"
                            onPointerDown={handleVisualPointerDown}
                            onPointerMove={handleVisualPointerMove}
                            onPointerUp={handleVisualPointerUp}
                            onPointerCancel={handleVisualPointerUp}
                        >
                            {visualSvg.markup ? (
                                <div className="flex max-h-full max-w-full items-center justify-center [&_svg]:max-h-[600px] [&_svg]:max-w-full [&_svg]:select-none" dangerouslySetInnerHTML={{ __html: visualSvg.markup }} />
                            ) : previewUrl ? (
                                <img src={previewUrl} alt="" className="max-h-full max-w-full object-contain" />
                            ) : (
                                <span className="text-sm opacity-45">{t("canvas.svgEditor.waiting")}</span>
                            )}
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div className="rounded-xl border p-3">
                            <div className="mb-3 flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                    <MousePointer2 className="size-4" />
                                    <span className="truncate">{selectedElement ? t("canvas.svgEditor.selected", { name: selectedElement.label }) : t("canvas.svgEditor.selectHint")}</span>
                                </div>
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedElement} onClick={deleteSelectedElement}>
                                    {t("common.delete")}
                                </Button>
                            </div>
                            <div className="mb-3 flex items-center gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-xs opacity-70 dark:bg-white/[0.06]">
                                <Move className="size-3.5" />
                                {t("canvas.svgEditor.dragHint")}
                            </div>
                            <div className="grid gap-3 text-sm">
                                {selectedElement?.tagName === "text" ? (
                                    <AttributeEditor
                                        icon={<Type className="size-3.5" />}
                                        label={t("canvas.svgEditor.textContent")}
                                        value={selectedElement.text}
                                        disabled={false}
                                        onChange={(value) => updateSelected((element) => (element.textContent = value))}
                                    />
                                ) : null}
                                <AttributeEditor label={t("canvas.svgEditor.fill")} value={selectedElement?.fill || ""} disabled={!selectedElement} onChange={(value) => updateSelectedAttribute("fill", value)} />
                                <AttributeEditor label={t("canvas.svgEditor.stroke")} value={selectedElement?.stroke || ""} disabled={!selectedElement} onChange={(value) => updateSelectedAttribute("stroke", value)} />
                                <AttributeEditor
                                    label={t("canvas.svgEditor.opacity")}
                                    value={selectedElement?.opacity || ""}
                                    disabled={!selectedElement}
                                    placeholder={t("canvas.svgEditor.opacityPlaceholder")}
                                    onChange={(value) => updateSelectedAttribute("opacity", value)}
                                />
                            </div>
                        </div>

                        <details className="rounded-xl border p-3">
                            <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium opacity-75">
                                <Code2 className="size-4" />
                                {t("canvas.svgEditor.sourceCode")}
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
                                placeholder={loading ? t("canvas.editors.loading") : t("canvas.svgEditor.sourcePlaceholder")}
                            />
                        </details>
                    </div>
                </div>

                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" icon={<Save className="size-4" />} disabled={!svg.trim()} onClick={save}>
                        {t("canvas.svgEditor.save")}
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
                <Input value={value} disabled={disabled} placeholder={placeholder || "#2f80ff / none"} onChange={(event) => onChange(event.target.value)} />
                {colorValue ? (
                    <input type="color" value={colorValue} disabled={disabled} className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent p-0 disabled:cursor-not-allowed" onChange={(event) => onChange(event.target.value)} />
                ) : null}
            </span>
        </label>
    );
}

async function readSvgSource(source: string, notEditableMessage: string) {
    const inline = dataUrlToSvgText(source);
    if (inline) return inline;
    const response = await fetch(source);
    const text = await response.text();
    if (!text.includes("<svg")) throw new Error(notEditableMessage);
    return text;
}

function buildVisualSvgState(svg: string, selectedId: string | null, parseFailedMessage: string): VisualSvgState {
    if (!svg.trim()) return { markup: "", elements: [], error: "" };
    try {
        const document = new DOMParser().parseFromString(sanitizeEditableSvg(svg), "image/svg+xml");
        const infos = editableElements(document).map((element, index) => {
            const id = String(index);
            const tagName = element.tagName.toLowerCase();
            const text = tagName === "text" ? element.textContent || "" : "";
            const info = {
                id,
                tagName,
                label: text ? `${tagName}: ${text.slice(0, 18)}` : `${tagName} #${index + 1}`,
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
        return { markup: "", elements: [], error: buildError instanceof Error ? buildError.message : parseFailedMessage };
    }
}

function updateSvgElement(svg: string, selectedId: string, update: (element: Element) => void, missingMessage: string) {
    const document = new DOMParser().parseFromString(sanitizeEditableSvg(svg), "image/svg+xml");
    const element = editableElements(document)[Number(selectedId)];
    if (!element) throw new Error(missingMessage);
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
