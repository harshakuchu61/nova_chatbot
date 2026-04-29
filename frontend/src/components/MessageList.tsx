import type { ChatMessage } from "../types/chat";

type Props = {
  messages: ChatMessage[];
  onSpeak: (text: string) => void;
};

export function MessageList({ messages, onSpeak }: Props) {
  return (
    <div id="chat-messages" className="chat-messages">
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
          <div className="message-avatar">{m.role === "user" ? "You" : "✦"}</div>
          <div className="message-content">
            <div className="message-role">{m.role === "user" ? "You" : m.role === "error" ? "Error" : "Nova"}</div>
            <div className="message-body">{m.content}</div>
            {m.role === "assistant" ? (
              <div className="message-actions">
                <button
                  className="msg-action-btn"
                  onClick={() => navigator.clipboard.writeText(m.content).catch(() => undefined)}
                >
                  Copy
                </button>
                <button className="msg-action-btn" onClick={() => onSpeak(m.content)}>
                  Read aloud
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
