import { useEffect, useMemo, useState } from "react";
import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
import {
  changePassword,
  deleteAccount,
  deleteAllConversations,
  deleteConversation,
  exportUserData,
  fetchConfig,
  fetchModels,
  fetchSecurityEvents,
  fetchSettings,
  getConversation,
  listConversations,
  patchSettings,
  renameConversation,
  streamChat
} from "./lib/api";
import { useVoiceInput } from "./hooks/useVoiceInput";
import type { Attachment, ChatMessage, ModelOption } from "./types/chat";

type ConversationSummary = {
  id: string;
  title: string;
  updated_at: string;
};

type AuthUser = {
  id: string;
  email: string;
  display_name: string;
  provider?: string;
};

type SecurityEvent = {
  id: number;
  ip?: string | null;
  user_agent?: string | null;
  timestamp: string;
  success: boolean;
};

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("gemini-2.0-flash");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState("light");
  const [fontSize, setFontSize] = useState("medium");
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authError, setAuthError] = useState("");
  const [settingsTab, setSettingsTab] = useState<"general" | "security" | "data" | "account">("general");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([]);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const refreshConversations = () =>
    listConversations()
      .then((rows) => setConversations(rows || []))
      .catch(() => undefined);

  useEffect(() => {
    fetch("/auth/me")
      .then(async (r) => {
        if (!r.ok) throw new Error("unauthorized");
        const me = await r.json();
        setAuthUser({ id: me.id, email: me.email, display_name: me.display_name, provider: me.provider });
        setTheme(me.settings?.theme || "light");
        setFontSize(me.settings?.font_size || "medium");
        setSendOnEnter(me.settings?.send_on_enter !== false);
        return true;
      })
      .then(async () => {
        await fetchConfig().catch(() => undefined);
        await fetchModels()
          .then((m) => {
            setModels(m.models || []);
            setSelectedModel(m.default_model || "gemini-2.0-flash");
          })
          .catch(() => {
            setModels([
              { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash — fast, economical" },
              { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — most capable" }
            ]);
          });
        await refreshConversations();
      })
      .catch(() => setAuthUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    const map: Record<string, string> = { small: "87.5%", medium: "100%", large: "112.5%" };
    document.documentElement.style.fontSize = map[fontSize] || "100%";
  }, [fontSize]);

  const speaking = useMemo(() => window.speechSynthesis, []);
  const speak = (text: string) => {
    if (!speaking) return;
    speaking.cancel();
    const u = new SpeechSynthesisUtterance(text);
    speaking.speak(u);
  };

  const voice = useVoiceInput((text) => {
    setInput((prev) => (prev ? `${prev} ${text}` : text));
  });

  const submitAuth = async () => {
    setAuthError("");
    const endpoint = authMode === "login" ? "/auth/login" : "/auth/register";
    const payload: Record<string, string> = { email: authEmail, password: authPassword };
    if (authMode === "register") payload.display_name = authDisplayName;
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail || "Authentication failed.");
      setAuthUser({ id: j.user.id, email: j.user.email, display_name: j.user.display_name, provider: j.user.provider });
      setAuthPassword("");
      await fetchSettings()
        .then((s) => {
          setTheme(s.theme || "light");
          setFontSize(s.font_size || "medium");
          setSendOnEnter(s.send_on_enter !== false);
        })
        .catch(() => undefined);
      await fetchModels().then((m) => {
        setModels(m.models || []);
        setSelectedModel(m.default_model || "gemini-2.0-flash");
      });
      await refreshConversations();
    } catch (e: any) {
      setAuthError(e?.message || "Authentication failed.");
    }
  };

  const onSend = async () => {
    if (!authUser) return;
    const text = input.trim();
    if (!text && !attachments.length) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text || "(Attachments)"
    };
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, userMessage, { id: assistantId, role: "assistant", content: "" }]);
    setInput("");
    const payloadAttachments = attachments;
    setAttachments([]);

    await streamChat({
      message: text,
      model: selectedModel,
      attachments: payloadAttachments,
      conversationId: activeConversationId,
      onChunk: (chunk) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m))
        );
      },
      onDone: (data) => {
        if (data?.conversation_id) setActiveConversationId(data.conversation_id);
        void refreshConversations();
      },
      onError: (err) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, role: "error", content: err } : m))
        );
      }
    }).catch((e: Error) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, role: "error", content: e.message } : m))
      );
    });
  };

  const loadConversation = async (id: string) => {
    try {
      const conv = await getConversation(id);
      const next: ChatMessage[] = (conv.messages || []).map((m: any) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content
      }));
      setMessages(next);
      setActiveConversationId(id);
    } catch {
      // ignore
    }
  };

  const loadSecurityEvents = async () => {
    if (!authUser) return;
    setSecurityLoading(true);
    try {
      const events = await fetchSecurityEvents();
      setSecurityEvents(events || []);
    } catch {
      setSecurityEvents([]);
      setSettingsStatus("Could not load security activity.");
    } finally {
      setSecurityLoading(false);
    }
  };

  if (authLoading) {
    return <div style={{ padding: 24, fontFamily: "Inter, sans-serif" }}>Loading Nova…</div>;
  }

  if (!authUser) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <div className="login-logo-icon">✦</div>
            <div className="login-logo-text">Nova</div>
          </div>
          <h2 className="login-title">{authMode === "login" ? "Sign in to Nova" : "Create Nova account"}</h2>
          <p className="login-subtitle">
            {authMode === "login" ? "Use your account to continue securely." : "Create your workspace and get started."}
          </p>

          {authError ? <div className="error-banner">{authError}</div> : null}

          <div className="oauth-section">
            <button className="oauth-btn oauth-google" onClick={() => (window.location.href = "/auth/google/login")}>
              <span className="oauth-icon oauth-icon-google" aria-hidden="true">G</span>
              Continue with Google
            </button>
            <button className="oauth-btn oauth-github" onClick={() => (window.location.href = "/auth/github/login")}>
              <span className="oauth-icon oauth-icon-github" aria-hidden="true">GH</span>
              Continue with GitHub
            </button>
          </div>

          <div className="login-divider">or use email</div>

          <div className="auth-form">
            {authMode === "register" ? (
              <div className="form-field">
                <label>Display name</label>
                <input
                  placeholder="Display name"
                  value={authDisplayName}
                  onChange={(e) => setAuthDisplayName(e.target.value)}
                />
              </div>
            ) : null}
            <div className="form-field">
              <label>Email</label>
              <input
                placeholder="you@company.com"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label>Password</label>
              <input
                type="password"
                placeholder="Enter password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
            </div>
            <button className="btn-submit" onClick={() => void submitAuth()}>
              {authMode === "login" ? "Sign in" : "Create account"}
            </button>
          </div>

          <div className="login-toggle">
            {authMode === "login" ? "Need an account?" : "Already have an account?"}
            <button className="btn-link" onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>
              {authMode === "login" ? "Register" : "Sign in"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <aside id="sidebar" className="sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <span className="logo-icon">✦</span>
            <span className="logo-text">Nova</span>
          </div>
          <div className="sidebar-user-meta">
            <span className="sidebar-user-dot">{(authUser.display_name || authUser.email || "N").charAt(0).toUpperCase()}</span>
            <span className="sidebar-user-line">{authUser.display_name} · {authUser.email}</span>
          </div>
        </div>
        <button id="new-chat-btn" className="btn-new-chat" onClick={() => setMessages([])}>
          New Chat
        </button>
        <div className="conversation-list">
          {!conversations.length ? (
            <div className="conv-list-empty">No conversations yet</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`conv-item ${activeConversationId === c.id ? "active" : ""}`}
                onClick={() => void loadConversation(c.id)}
              >
                <div className="conv-item-title">{c.title}</div>
                <div className="conv-item-actions">
                  <button
                    className="conv-item-btn conv-item-rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = window.prompt("Rename conversation", c.title);
                      if (next && next.trim()) {
                        void renameConversation(c.id, next.trim()).then(refreshConversations);
                      }
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="conv-item-btn conv-item-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteConversation(c.id).then(() => {
                        if (activeConversationId === c.id) {
                          setActiveConversationId(null);
                          setMessages([]);
                        }
                        void refreshConversations();
                      });
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="sidebar-footer">
          <button className="btn-subtle" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <div className="header-title">
            <span className="header-icon">✦</span>
            <h1>Nova</h1>
            <span className="header-badge">Vertex AI</span>
          </div>
          <div className="header-spacer" />
          <button className="btn-subtle" onClick={() => setSettingsOpen(true)}>Settings</button>
        </header>

        <MessageList messages={messages} onSpeak={speak} />
        <Composer
          input={input}
          setInput={setInput}
          attachments={attachments}
          setAttachments={setAttachments}
          models={models}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          onSend={onSend}
          onVoiceStart={voice.start}
          onVoiceStop={voice.stop}
          isListening={voice.isListening}
          sendOnEnter={sendOnEnter}
        />
      </main>

      {!settingsOpen ? null : (
        <>
          <div className="settings-overlay" onClick={() => setSettingsOpen(false)} />
          <aside className="settings-drawer">
            <div className="settings-header">
              <h2 className="settings-title">Settings</h2>
              <button className="btn-icon settings-close-btn" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </div>
            <div className="settings-content">
              <nav className="settings-nav">
                <button className={`settings-tab ${settingsTab === "general" ? "active" : ""}`} onClick={() => setSettingsTab("general")}>
                  <span>General</span>
                </button>
                <button
                  className={`settings-tab ${settingsTab === "security" ? "active" : ""}`}
                  onClick={() => {
                    setSettingsTab("security");
                    void loadSecurityEvents();
                  }}
                >
                  <span>Security</span>
                </button>
                <button className={`settings-tab ${settingsTab === "data" ? "active" : ""}`} onClick={() => setSettingsTab("data")}>
                  <span>Data</span>
                </button>
                <button className={`settings-tab ${settingsTab === "account" ? "active" : ""}`} onClick={() => setSettingsTab("account")}>
                  <span>Account</span>
                </button>
              </nav>
              <div className={`settings-panel ${settingsTab === "general" ? "active" : ""}`}>
                <h3 className="panel-heading">General</h3>
                <div className="settings-field">
                  <label className="field-label">Theme</label>
                  <select className="field-select" value={theme} onChange={(e) => setTheme(e.target.value)}>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="field-label">Font size</label>
                  <select className="field-select" value={fontSize} onChange={(e) => setFontSize(e.target.value)}>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </div>
                <div className="settings-field settings-field-row">
                  <div>
                    <div className="field-label">Send on Enter</div>
                    <div className="field-hint">Shift+Enter for new line</div>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={sendOnEnter} onChange={(e) => setSendOnEnter(e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="settings-field">
                  <button
                    className="btn-primary"
                    onClick={async () => {
                      setSettingsStatus("");
                      await patchSettings({
                        theme,
                        font_size: fontSize,
                        send_on_enter: sendOnEnter,
                        default_model: selectedModel
                      });
                      setSettingsStatus("Settings saved.");
                    }}
                  >
                    Save Settings
                  </button>
                </div>
                <div className="settings-field">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      void fetch("/auth/logout", { method: "POST" }).finally(() => {
                        setAuthUser(null);
                        setMessages([]);
                        setConversations([]);
                        setActiveConversationId(null);
                      });
                    }}
                  >
                    Sign out
                  </button>
                </div>
                {settingsStatus ? <div className={`field-hint ${settingsStatus.includes("saved") ? "success" : "error"}`}>{settingsStatus}</div> : null}
              </div>

              <div className={`settings-panel ${settingsTab === "security" ? "active" : ""}`}>
                <h3 className="panel-heading">Security</h3>
                <div className="settings-field">
                  <label className="field-label">Authentication provider</label>
                  <div className="field-hint">{authUser.provider || "email"}</div>
                </div>
                {authUser.provider === "email" ? (
                  <>
                    <div className="settings-field">
                      <label className="field-label">Current password</label>
                      <input className="field-input" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                    </div>
                    <div className="settings-field">
                      <label className="field-label">New password</label>
                      <input className="field-input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                    </div>
                    <div className="settings-field">
                      <button
                        className="btn-primary"
                        onClick={() =>
                          void changePassword(currentPassword, newPassword)
                            .then(() => {
                              setCurrentPassword("");
                              setNewPassword("");
                              setSettingsStatus("Password updated.");
                            })
                            .catch((e: Error) => setSettingsStatus(e.message))
                        }
                      >
                        Change Password
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="field-hint">Password changes are managed by your OAuth provider.</div>
                )}
                <div className="settings-field">
                  <label className="field-label">Recent login activity</label>
                  {securityLoading ? (
                    <div className="field-hint">Loading…</div>
                  ) : !securityEvents.length ? (
                    <div className="field-hint">No recent events.</div>
                  ) : (
                    <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border-subtle)", borderRadius: 8, padding: 8 }}>
                      {securityEvents.slice(0, 10).map((e) => (
                        <div key={e.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: "0.85rem" }}>
                          {new Date(e.timestamp).toLocaleString()} · {e.success ? "Success" : "Failed"} · {e.ip || "unknown IP"}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className={`settings-panel ${settingsTab === "data" ? "active" : ""}`}>
                <h3 className="panel-heading">Data Controls</h3>
                <div className="settings-field">
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      void exportUserData().then((data) => {
                        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "nova-export.json";
                        a.click();
                        URL.revokeObjectURL(url);
                        setSettingsStatus("Data export downloaded.");
                      })
                    }
                  >
                    Export My Data
                  </button>
                </div>
                <div className="settings-field">
                  <button
                    className="btn-danger"
                    onClick={() =>
                      void deleteAllConversations().then(() => {
                        setMessages([]);
                        setActiveConversationId(null);
                        void refreshConversations();
                        setSettingsStatus("All conversations deleted.");
                      })
                    }
                  >
                    Delete All Conversations
                  </button>
                </div>
              </div>

              <div className={`settings-panel ${settingsTab === "account" ? "active" : ""}`}>
                <h3 className="panel-heading">Account</h3>
                <div className="settings-field">
                  <label className="field-label">Email</label>
                  <div className="field-hint">{authUser.email}</div>
                </div>
                <div className="settings-field">
                  <label className="field-label">Display name</label>
                  <div className="field-hint">{authUser.display_name}</div>
                </div>
                <div className="settings-field">
                  <button
                    className="btn-danger"
                    onClick={() => {
                      if (!window.confirm("Delete account and all data permanently?")) return;
                      void deleteAccount().then(() => {
                        setAuthUser(null);
                        setMessages([]);
                        setConversations([]);
                        setActiveConversationId(null);
                      });
                    }}
                  >
                    Delete Account
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
