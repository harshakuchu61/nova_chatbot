import type { ChatMessage } from "../types/chat";
import { Fragment, useEffect, useRef } from "react";

type Props = {
  messages: ChatMessage[];
  onSpeak: (text: string) => void;
  activeConversationId?: string | null;
};

type BulletNode = {
  text: string;
  children: BulletNode[];
};

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function isSectionHeading(line: string) {
  const trimmed = line.trim();
  const numberedMatch = trimmed.match(/^(?:[IVXLC]+\.|\d+\.)\s+(.+)$/);
  if (numberedMatch) {
    const remainder = numberedMatch[1].trim();
    // Numbered lines that contain ":" are usually sub-points, not main headings.
    if (remainder.includes(":")) return false;
    return true;
  }
  if (!trimmed.endsWith(":")) return false;
  if (trimmed.length > 80) return false;
  if (/^\d+\./.test(trimmed)) return false;
  return true;
}

function renderKeyValueLine(line: string, key: string) {
  const value = line.slice(key.length + 1).trim();
  return (
    <p>
      <strong>{key}:</strong> {renderInline(value)}
    </p>
  );
}

function isOrderedItem(line: string) {
  return /^\s*\d+\.\s+/.test(line);
}

function isBulletItem(line: string) {
  return /^\s*[-*]\s+/.test(line);
}

function isKeyValueLine(line: string) {
  return /^([^:]{2,50}):\s+(.+)$/.test(line.trim());
}

function normalizeLine(line: string) {
  const leading = line.match(/^\s*/)?.[0] || "";
  const content = line.trimStart().replace(/^#{1,6}\s+/, "");
  return `${leading}${content}`.trimEnd();
}

function stripHeadingPrefix(line: string) {
  const trimmed = line.trim();
  const withoutPrefix = trimmed.replace(/^(?:[IVXLC]+\.|\d+\.)\s+/, "");
  return withoutPrefix.endsWith(":") ? withoutPrefix.slice(0, -1) : withoutPrefix;
}

function isHorizontalRule(line: string) {
  return /^-{3,}$/.test(line.trim());
}

function getBulletMarker(line: string) {
  const match = line.match(/^(\s*)(?:[-*]|\d+\.)\s+(.+)$/);
  if (!match) return null;
  const indent = match[1].replace(/\t/g, "  ").length;
  const depth = Math.floor(indent / 2);
  return { depth, text: match[2].trim() };
}

function renderBulletNodes(nodes: BulletNode[], keyPrefix: string): JSX.Element {
  return (
    <ul key={`${keyPrefix}-ul`}>
      {nodes.map((node, idx) => (
        <li key={`${keyPrefix}-${idx}`}>
          {renderInline(node.text)}
          {node.children.length ? renderBulletNodes(node.children, `${keyPrefix}-${idx}`) : null}
        </li>
      ))}
    </ul>
  );
}

function renderMessageBody(content: string) {
  const lines = content.split(/\r?\n/).map((l) => normalizeLine(l.trimEnd()));
  const blocks: JSX.Element[] = [];
  let i = 0;
  let headingIndex = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (isSectionHeading(line)) {
      headingIndex += 1;
      blocks.push(<h3 key={`h3-${i}`}>{`${headingIndex}. ${stripHeadingPrefix(line)}`}</h3>);
      i += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push(<hr key={`hr-${i}`} />);
      i += 1;
      continue;
    }

    if (isKeyValueLine(line) && !/^https?:\/\//i.test(line)) {
      const items: JSX.Element[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!current || !isKeyValueLine(current) || /^https?:\/\//i.test(current)) break;
        const keyValueMatch = current.match(/^([^:]{2,50}):\s+(.+)$/);
        if (!keyValueMatch) break;
        items.push(<li key={`${i}-${keyValueMatch[1]}`}>{renderKeyValueLine(current, keyValueMatch[1].trim())}</li>);
        i += 1;
      }
      blocks.push(<ul key={`kv-ul-${i}`}>{items}</ul>);
      continue;
    }

    if (isOrderedItem(line) || isBulletItem(line)) {
      const root: BulletNode[] = [];
      const stack: Array<{ depth: number; children: BulletNode[] }> = [{ depth: -1, children: root }];

      while (i < lines.length) {
        const marker = getBulletMarker(lines[i]);
        if (!marker) break;
        const node: BulletNode = { text: marker.text, children: [] };

        while (stack.length > 1 && marker.depth <= stack[stack.length - 1].depth) {
          stack.pop();
        }
        stack[stack.length - 1].children.push(node);
        stack.push({ depth: marker.depth, children: node.children });
        i += 1;

        while (
          i < lines.length &&
          lines[i].trim() &&
          !getBulletMarker(lines[i]) &&
          !isSectionHeading(lines[i].trim()) &&
          !isKeyValueLine(lines[i].trim())
        ) {
          node.text += ` ${lines[i].trim()}`;
          i += 1;
        }
      }

      blocks.push(renderBulletNodes(root, `ul-${i}`));
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isOrderedItem(lines[i]) &&
      !isBulletItem(lines[i]) &&
      !isSectionHeading(lines[i].trim()) &&
      !isKeyValueLine(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push(<p key={`p-${i}`}>{renderInline(para.join(" "))}</p>);
  }

  return blocks.length ? blocks : <p>{content}</p>;
}

export function MessageList({ messages, onSpeak, activeConversationId }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeConversationId]);

  return (
    <div id="chat-messages" className="chat-messages" ref={scrollRef}>
      {!messages.length ? (
        <div id="welcome-screen" className="welcome-screen">
          <div className="welcome-icon">✦</div>
          <h2>Hello! I'm Nova</h2>
          <p>Your personal AI assistant powered by Vertex AI.</p>
        </div>
      ) : null}

      {messages.map((m) => (
        <div
          key={m.id}
          className={`message ${m.role === "error" ? "message-assistant message-error" : `message-${m.role}`}`}
        >
          <div className="message-avatar">{m.role === "user" ? "" : "✦"}</div>
          <div className="message-content">
            {m.role === "user" ? null : (
              <div className="message-role">{m.role === "error" ? "Error" : "Nova"}</div>
            )}
            <div className="message-body">
              {m.role === "assistant" ? (
                m.content.trim() ? (
                  renderMessageBody(m.content)
                ) : (
                  <div className="thinking-row" aria-live="polite">
                    <span>Thinking</span>
                    <span className="thinking-dots">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                  </div>
                )
              ) : (
                m.content
              )}
            </div>
            {m.role === "assistant" && m.content.trim() ? (
              <div className="message-actions">
                <button
                  className="msg-action-btn icon-only"
                  title="Copy"
                  aria-label="Copy response"
                  onClick={() => navigator.clipboard.writeText(m.content).catch(() => undefined)}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16h-9V7h9v14Z"
                    />
                  </svg>
                </button>
                <button
                  className="msg-action-btn icon-only"
                  title="Read aloud"
                  aria-label="Read response aloud"
                  onClick={() => onSpeak(m.content)}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M3 10v4h4l5 5V5L7 10H3Zm13.5 2c0-1.77-1-3.29-2.5-4.03v8.05A4.49 4.49 0 0 0 16.5 12Zm0-9.5v2.06c2.89.86 5 3.54 5 6.44s-2.11 5.58-5 6.44v2.06c4.01-.91 7-4.49 7-8.5s-2.99-7.59-7-8.5Z"
                    />
                  </svg>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
