import { useEffect, useMemo, useRef, useState } from "react";
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

const ACTIVE_CONVERSATION_KEY = "nova_active_conversation_id";
const THEME_KEY = "nova_theme";

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("gemini-2.5-flash");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) || "light";
    } catch {
      return "light";
    }
  });
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
  const [conversationSearch, setConversationSearch] = useState("");
  const [temporaryChat, setTemporaryChat] = useState(false);
  const loadedThemeFromServer = useRef(false);
  const hasInitializedConversationPersistence = useRef(false);
  const autoSendTimerRef = useRef<number | null>(null);
  const inputRef = useRef(input);
  const onSendRef = useRef<(() => Promise<void>) | null>(null);

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
        setTheme(localStorage.getItem(THEME_KEY) || me.settings?.theme || "light");
        setFontSize(me.settings?.font_size || "medium");
        setSendOnEnter(me.settings?.send_on_enter !== false);
        return true;
      })
      .then(async () => {
        await fetchConfig().catch(() => undefined);
        await fetchModels()
          .then((m) => {
            setModels(m.models || []);
            setSelectedModel(m.default_model || "gemini-2.5-flash");
          })
          .catch(() => {
            setModels([
              { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — fast, economical" },
              { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — most capable" }
            ]);
          });
        await refreshConversations();
        const savedConversationId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
        if (savedConversationId) {
          await loadConversation(savedConversationId);
        }
        loadedThemeFromServer.current = true;
      })
      .catch(() => setAuthUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", theme === "dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!authUser || !loadedThemeFromServer.current) return;
    void patchSettings({ theme }).catch(() => undefined);
  }, [theme, authUser]);

  useEffect(() => {
    const map: Record<string, string> = { small: "87.5%", medium: "100%", large: "112.5%" };
    document.documentElement.style.fontSize = map[fontSize] || "100%";
  }, [fontSize]);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!hasInitializedConversationPersistence.current) {
      hasInitializedConversationPersistence.current = true;
      return;
    }
    if (activeConversationId) {
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeConversationId);
    } else {
      localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    }
  }, [activeConversationId]);

  const speaking = useMemo(() => window.speechSynthesis, []);
  const speak = (text: string) => {
    if (!speaking) return;
    speaking.cancel();
    const u = new SpeechSynthesisUtterance(text);
    speaking.speak(u);
  };

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
        setSelectedModel(m.default_model || "gemini-2.5-flash");
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
      conversationId: temporaryChat ? null : activeConversationId,
      temporary: temporaryChat,
      onChunk: (chunk) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m))
        );
      },
      onDone: (data) => {
        if (!temporaryChat) {
          if (data?.conversation_id) setActiveConversationId(data.conversation_id);
          void refreshConversations();
        }
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

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  useEffect(() => {
    return () => {
      if (autoSendTimerRef.current !== null) {
        window.clearTimeout(autoSendTimerRef.current);
      }
    };
  }, []);

  const voice = useVoiceInput({
    onFinalText: (text) => {
      setInput((prev) => (prev ? `${prev} ${text}` : text));
    },
    onSilence: () => {
      if (autoSendTimerRef.current !== null) {
        window.clearTimeout(autoSendTimerRef.current);
      }
      autoSendTimerRef.current = window.setTimeout(() => {
        if (!inputRef.current.trim()) return;
        void onSendRef.current?.();
      }, 3500);
    },
    silenceMs: 2000,
  });

  const loadConversation = async (id: string) => {
    setActiveConversationId(id);
    setTemporaryChat(false);
    try {
      const conv = await getConversation(id);
      const next: ChatMessage[] = (conv.messages || []).map((m: any) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content
      }));
      setMessages(
        next.length
          ? next
          : [
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content:
                  "This chat has no saved messages yet. Previous requests may have failed before the conversation was stored."
              }
            ]
      );
      setConversationSearch("");
    } catch {
      setActiveConversationId(null);
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

  const goHome = () => {
    setSettingsOpen(false);
    setTemporaryChat(false);
    setConversationSearch("");
    setActiveConversationId(null);
    setMessages([]);
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
              <span className="oauth-icon oauth-icon-google" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path fill="#EA4335" d="M12 5c1.62 0 3.08.56 4.24 1.66l3.18-3.18C17.51 1.7 14.97.5 12 .5 7.31.5 3.27 3.2 1.24 7.14l3.7 2.87C5.87 7.13 8.7 5 12 5z"/>
                  <path fill="#4285F4" d="M23.5 12.27c0-.8-.07-1.57-.2-2.31H12v4.37h6.47c-.28 1.5-1.12 2.78-2.38 3.64l3.67 2.85c2.15-1.98 3.74-4.9 3.74-8.55z"/>
                  <path fill="#FBBC05" d="M4.94 14.01A7.06 7.06 0 0 1 4.55 12c0-.69.14-1.36.39-2L1.24 7.14A11.44 11.44 0 0 0 .5 12c0 1.85.44 3.61 1.22 5.14l3.72-3.13z"/>
                  <path fill="#34A853" d="M12 23.5c3.09 0 5.68-1.02 7.58-2.77l-3.67-2.85c-1.02.68-2.33 1.1-3.91 1.1-3.29 0-6.12-2.13-7.06-5.01l-3.72 3.13C3.25 20.76 7.3 23.5 12 23.5z"/>
                </svg>
              </span>
              Continue with Google
            </button>
            <button className="oauth-btn oauth-github" onClick={() => (window.location.href = "/auth/github/login")}>
              <span className="oauth-icon oauth-icon-github" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path
                    fill="currentColor"
                    d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.02c-3.2.7-3.88-1.54-3.88-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.72.08-.71.08-.71 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.52-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.01 0 0 .96-.31 3.14 1.17a10.9 10.9 0 0 1 5.72 0c2.17-1.48 3.13-1.17 3.13-1.17.62 1.56.23 2.72.11 3.01.74.8 1.18 1.82 1.18 3.07 0 4.41-2.68 5.39-5.24 5.67.41.35.77 1.05.77 2.12v3.15c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
                  />
                </svg>
              </span>
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

  const sidebarShortName =
    (authUser.display_name || authUser.email || "User").trim().split(/\s+/)[0] || "User";
  const filteredConversations = conversations.filter((c) =>
    c.title.toLowerCase().includes(conversationSearch.trim().toLowerCase())
  );

  return (
    <div className="app-container">
      <aside id="sidebar" className="sidebar">
        <div className="sidebar-header">
          <button className="logo logo-button" onClick={goHome} type="button" title="Go to home">
            <span className="logo-icon">✦</span>
            <span className="logo-text">Nova</span>
          </button>
        </div>
        <div className="sidebar-quick-controls">
          <input
            className="sidebar-search"
            placeholder="Search chats"
            value={conversationSearch}
            onChange={(e) => setConversationSearch(e.target.value)}
          />
        </div>
        <div className="sidebar-modes">
          <button
            className="sidebar-mode-btn"
            onClick={() => {
              setTemporaryChat(false);
              setMessages([]);
              setActiveConversationId(null);
            }}
          >
            <span className="mode-icon" aria-hidden="true">✎</span>
            New chat
          </button>
          <button
            className={`sidebar-mode-btn ${temporaryChat ? "active" : ""}`}
            onClick={() => {
              setTemporaryChat(true);
              setMessages([]);
              setActiveConversationId(null);
            }}
          >
            <span className="mode-icon" aria-hidden="true">◔</span>
            Temporary chat
          </button>
        </div>
        <div className="conversation-list">
          {!filteredConversations.length ? (
            <div className="conv-list-empty">No conversations yet</div>
          ) : (
            filteredConversations.map((c) => (
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
          <div className="sidebar-profile" title={authUser.display_name || authUser.email}>
            <span className="sidebar-profile-avatar">{sidebarShortName.charAt(0).toUpperCase()}</span>
            <span className="sidebar-profile-name">{sidebarShortName}</span>
          </div>
          <button className="btn-subtle sidebar-settings-link" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.3 7.3 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.85a.5.5 0 0 0 .12.63l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.63l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
              />
            </svg>
          </button>
        </div>
      </aside>

      <main className="chat-main">
        <MessageList messages={messages} onSpeak={speak} activeConversationId={activeConversationId} />
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
