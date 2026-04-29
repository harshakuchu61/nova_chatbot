import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Attachment, ModelOption } from "../types/chat";

type Props = {
  input: string;
  setInput: (value: string) => void;
  attachments: Attachment[];
  setAttachments: (atts: Attachment[]) => void;
  models: ModelOption[];
  selectedModel: string;
  setSelectedModel: (id: string) => void;
  onSend: () => void;
  onVoiceStart: () => void;
  onVoiceStop: () => void;
  isListening: boolean;
  sendOnEnter: boolean;
};

async function readAttachment(file: File): Promise<Attachment> {
  const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  if (file.type.startsWith("image/") || file.type === "application/pdf") {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const [, mime = file.type, b64 = ""] = dataUrl.match(/^data:([^;]+);base64,(.+)$/) || [];
    return {
      id,
      kind: file.type === "application/pdf" ? "pdf" : "image",
      name: file.name,
      mime,
      data: b64
    };
  }
  const isTextLike = file.type.startsWith("text/") || /\.(txt|md|json|csv|log|xml|yaml|yml)$/i.test(file.name);
  if (isTextLike && file.size <= MAX_TEXT_FILE_SIZE) {
    const text = await file.text();
    return { id, kind: "text", name: file.name, text };
  }
  return {
    id,
    kind: "text",
    name: file.name,
    text: [
      "[Attached binary file]",
      `Filename: ${file.name}`,
      `Type: ${file.type || "unknown"}`,
      `Size: ${Math.round(file.size / 1024)} KB`,
      "Raw binary preview is not included."
    ].join("\n")
  };
}

const MAX_ATTACHMENTS = 6;
const MAX_RECENT_ATTACHMENTS = 5;
const RECENT_ATTACHMENTS_KEY = "nova_recent_attachments";
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

type Rect = { x: number; y: number; width: number; height: number };

function cloneAttachment(attachment: Attachment): Attachment {
  return {
    ...attachment,
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  };
}

function mergeRecentAttachments(existing: Attachment[], additions: Attachment[]): Attachment[] {
  const next = [...existing];
  for (const attachment of additions) {
    const dedupeKey = `${attachment.kind}:${attachment.name}:${attachment.mime || ""}:${attachment.data || attachment.text || ""}`;
    const filtered = next.filter((item) => {
      const itemKey = `${item.kind}:${item.name}:${item.mime || ""}:${item.data || item.text || ""}`;
      return itemKey !== dedupeKey;
    });
    next.splice(0, next.length, attachment, ...filtered);
  }
  return next.slice(0, MAX_RECENT_ATTACHMENTS);
}

export function Composer(props: Props) {
  const {
    input,
    setInput,
    attachments,
    setAttachments,
    models,
    selectedModel,
    setSelectedModel,
    onSend,
    onVoiceStart,
    onVoiceStop,
    isListening,
    sendOnEnter
  } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showRecentFiles, setShowRecentFiles] = useState(false);
  const [recentAttachments, setRecentAttachments] = useState<Attachment[]>([]);
  const [attachStatus, setAttachStatus] = useState("");
  const [screenshotFrame, setScreenshotFrame] = useState<string | null>(null);
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const screenshotImageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_ATTACHMENTS_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        setRecentAttachments(parsed.filter(Boolean).slice(0, MAX_RECENT_ATTACHMENTS));
      }
    } catch {
      // ignore bad local storage data
    }
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setShowRecentFiles(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setShowRecentFiles(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      setShowRecentFiles(false);
    }
  }, [menuOpen]);

  const addRecentAttachments = (items: Attachment[]) => {
    if (!items.length) return;
    setRecentAttachments((prev) => {
      const next = mergeRecentAttachments(prev, items);
      try {
        localStorage.setItem(RECENT_ATTACHMENTS_KEY, JSON.stringify(next));
      } catch {
        // ignore quota errors to avoid UI crashes
      }
      return next;
    });
  };

  const removeRecentAttachment = (attachment: Attachment) => {
    setRecentAttachments((prev) => {
      const next = prev.filter((item) => item.id !== attachment.id);
      try {
        localStorage.setItem(RECENT_ATTACHMENTS_KEY, JSON.stringify(next));
      } catch {
        // ignore localStorage write errors
      }
      return next;
    });
  };

  const appendAttachments = (items: Attachment[]) => {
    if (!items.length) return;
    const next = [...attachments];
    const added: Attachment[] = [];
    for (const item of items) {
      if (next.length >= MAX_ATTACHMENTS) break;
      next.push(item);
      added.push(item);
    }
    setAttachments(next);
    addRecentAttachments(added);
  };

  const addRecentAttachmentToComposer = (attachment: Attachment) => {
    appendAttachments([cloneAttachment(attachment)]);
    setMenuOpen(false);
  };

  const handleFilePick = async (files: File[]) => {
    const items: Attachment[] = [];
    let skipped = 0;
    for (const file of files.slice(0, MAX_ATTACHMENTS - attachments.length)) {
      try {
        if (file.size > MAX_FILE_SIZE) {
          skipped += 1;
          continue;
        }
        items.push(await readAttachment(file));
      } catch {
        skipped += 1;
      }
    }
    appendAttachments(items);
    setAttachStatus(skipped ? `${skipped} file(s) were skipped (too large or unreadable).` : "");
  };

  const handleScreenshot = async () => {
    setMenuOpen(false);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      stream.getTracks().forEach((track) => track.stop());
      setScreenshotFrame(canvas.toDataURL("image/png"));
      setSelectionRect(null);
      setDragStart(null);
    } catch {
      // ignore cancellation or unsupported browsers
    }
  };

  const onScreenshotMouseDown = (event: ReactMouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    setDragStart({ x, y });
    setSelectionRect({ x, y, width: 0, height: 0 });
  };

  const onScreenshotMouseMove = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!dragStart) return;
    const box = event.currentTarget.getBoundingClientRect();
    const currentX = event.clientX - box.left;
    const currentY = event.clientY - box.top;
    const x = Math.min(dragStart.x, currentX);
    const y = Math.min(dragStart.y, currentY);
    const width = Math.abs(currentX - dragStart.x);
    const height = Math.abs(currentY - dragStart.y);
    setSelectionRect({ x, y, width, height });
  };

  const finalizeScreenshotSelection = () => {
    setDragStart(null);
  };

  const attachSelectedScreenshot = async () => {
    if (!screenshotFrame || !selectionRect || !screenshotImageRef.current) return;
    const img = screenshotImageRef.current;
    const renderedW = img.clientWidth || 1;
    const renderedH = img.clientHeight || 1;
    const naturalW = img.naturalWidth || renderedW;
    const naturalH = img.naturalHeight || renderedH;

    const cropW = Math.max(1, selectionRect.width);
    const cropH = Math.max(1, selectionRect.height);
    const scaleX = naturalW / renderedW;
    const scaleY = naturalH / renderedH;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cropW * scaleX));
    canvas.height = Math.max(1, Math.round(cropH * scaleY));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(
      img,
      Math.round(selectionRect.x * scaleX),
      Math.round(selectionRect.y * scaleY),
      Math.round(cropW * scaleX),
      Math.round(cropH * scaleY),
      0,
      0,
      canvas.width,
      canvas.height
    );

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    const file = new File([blob], `snip-${Date.now()}.png`, { type: "image/png" });
    const attachment = await readAttachment(file);
    appendAttachments([attachment]);
    setScreenshotFrame(null);
    setSelectionRect(null);
    setDragStart(null);
  };

  return (
    <div className="chat-input-area">
      <div className="input-container">
        <div className="input-wrapper">
          <div id="attachment-strip" className="attachment-strip" hidden={!attachments.length}>
            {attachments.map((a) => (
              <span key={a.id} className="attach-chip">
                <span className="attach-chip-name">
                  {a.kind === "image" ? "🖼 " : a.kind === "pdf" ? "📕 " : "📄 "}
                  {a.name}
                </span>
                <button
                  className="attach-chip-remove"
                  onClick={() => setAttachments(attachments.filter((x) => x.id !== a.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx,.xls,.xlsx"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              await handleFilePick(files);
              e.currentTarget.value = "";
            }}
          />
          <input
            ref={cameraRef}
            type="file"
            hidden
            accept="image/*"
            capture="environment"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              if (!files.length || attachments.length >= MAX_ATTACHMENTS) {
                e.currentTarget.value = "";
                return;
              }
              await handleFilePick([files[0]]);
              e.currentTarget.value = "";
            }}
          />

          <div className="input-row-primary">
            <div className="attach-menu-wrap" ref={menuRef}>
              <button
                className={`btn-attach ${menuOpen ? "is-open" : ""}`}
                onClick={() => setMenuOpen((prev) => !prev)}
                title="Add attachment"
                aria-label="Add attachment"
                aria-expanded={menuOpen}
                type="button"
              >
                +
              </button>
              {menuOpen ? (
                <div className="attach-menu" role="menu">
                  <button
                    className="attach-menu-item"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      fileRef.current?.click();
                    }}
                  >
                    <span className="attach-menu-icon" aria-hidden="true">🖼</span>
                    <span>Photos & files</span>
                  </button>
                  <button className="attach-menu-item" type="button" onClick={() => void handleScreenshot()}>
                    <span className="attach-menu-icon" aria-hidden="true">▣</span>
                    <span>Take screenshot</span>
                  </button>
                  <button
                    className="attach-menu-item"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      cameraRef.current?.click();
                    }}
                  >
                    <span className="attach-menu-icon" aria-hidden="true">📷</span>
                    <span>Take photo</span>
                  </button>
                  <button
                    className={`attach-menu-item ${showRecentFiles ? "active" : ""}`}
                    type="button"
                    onClick={() => setShowRecentFiles((prev) => !prev)}
                  >
                    <span className="attach-menu-icon" aria-hidden="true">🕘</span>
                    <span>Recent files</span>
                  </button>
                  {showRecentFiles ? (
                    <>
                      <div className="attach-menu-section-label">Recent files</div>
                      {recentAttachments.length ? (
                        recentAttachments.map((attachment) => (
                          <div
                            key={attachment.id}
                            className="attach-menu-item recent-file-item"
                          >
                            <button
                              className="recent-file-open"
                              type="button"
                              onClick={() => addRecentAttachmentToComposer(attachment)}
                            >
                              <span className="attach-menu-icon" aria-hidden="true">
                                {attachment.kind === "image" ? "🖼" : attachment.kind === "pdf" ? "📕" : "📄"}
                              </span>
                              <span className="recent-file-name">{attachment.name}</span>
                            </button>
                            <button
                              type="button"
                              className="recent-file-remove"
                              aria-label={`Remove ${attachment.name} from recent files`}
                              title="Remove from recent files"
                              onClick={() => removeRecentAttachment(attachment)}
                            >
                              ×
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="attach-menu-empty">No recent attachments yet</div>
                      )}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            <textarea
              id="message-input"
              placeholder="Message Nova…"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (sendOnEnter && e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim() || attachments.length) onSend();
                }
              }}
            />
            <button
              id="mic-btn"
              className={`btn-mic ${isListening ? "is-listening" : ""}`}
              onClick={() => (isListening ? onVoiceStop() : onVoiceStart())}
            >
              🎤
            </button>
            <button id="send-btn" className="btn-send" disabled={!input.trim() && !attachments.length} onClick={onSend}>
              ➤
            </button>
          </div>

          <div className="input-row-secondary">
            <span className="model-select-label">Model</span>
            <div className="model-select-wrap">
              <select
                className="model-select-trigger"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <p className="input-hint">Mic: click to start/stop · Enter to send · Shift+Enter new line</p>
        {attachStatus ? <p className="input-hint attach-status">{attachStatus}</p> : null}
      </div>
      {screenshotFrame ? (
        <div className="snip-overlay" role="dialog" aria-label="Screenshot snip">
          <div className="snip-card">
            <div className="snip-header">
              <strong>Take screenshot</strong>
              <span>Drag to select an area, then attach.</span>
            </div>
            <div className="snip-canvas-wrap">
              <img
                ref={screenshotImageRef}
                src={screenshotFrame}
                alt="Screenshot preview"
                className="snip-image"
                onMouseDown={onScreenshotMouseDown}
                onMouseMove={onScreenshotMouseMove}
                onMouseUp={finalizeScreenshotSelection}
                draggable={false}
              />
              {selectionRect ? (
                <div
                  className="snip-selection"
                  style={{
                    left: selectionRect.x,
                    top: selectionRect.y,
                    width: selectionRect.width,
                    height: selectionRect.height
                  }}
                />
              ) : null}
            </div>
            <div className="snip-actions">
              <button className="btn-secondary btn-sm" type="button" onClick={() => setScreenshotFrame(null)}>
                Cancel
              </button>
              <button
                className="btn-primary btn-sm"
                type="button"
                disabled={!selectionRect || selectionRect.width < 4 || selectionRect.height < 4}
                onClick={() => void attachSelectedScreenshot()}
              >
                Attach snip
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
