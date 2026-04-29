import { useRef } from "react";
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
  const text = await file.text();
  return { id, kind: "text", name: file.name, text };
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
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              const next = [...attachments];
              for (const f of files.slice(0, 6 - next.length)) {
                try {
                  next.push(await readAttachment(f));
                } catch {
                  // ignore bad file
                }
              }
              setAttachments(next);
              e.currentTarget.value = "";
            }}
          />

          <div className="input-row-primary">
            <button className="btn-attach" onClick={() => fileRef.current?.click()} title="Attach">
              📎
            </button>
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
      </div>
    </div>
  );
}
