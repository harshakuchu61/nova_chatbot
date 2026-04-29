import type { Attachment, ModelOption } from "../types/chat";

export async function fetchConfig() {
  const r = await fetch("/api/config");
  if (!r.ok) throw new Error("Failed to load API config.");
  return r.json();
}

export async function fetchModels(): Promise<{ models: ModelOption[]; default_model: string }> {
  const r = await fetch("/api/models");
  if (!r.ok) throw new Error("Failed to load model list.");
  return r.json();
}

export async function fetchSettings() {
  const r = await fetch("/api/settings");
  if (!r.ok) throw new Error("Failed to load settings.");
  return r.json();
}

export async function patchSettings(payload: Record<string, unknown>) {
  const r = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error("Failed to save settings.");
  return r.json();
}

export async function listConversations() {
  const r = await fetch("/api/conversations");
  if (!r.ok) throw new Error("Failed to load conversations.");
  return r.json();
}

export async function getConversation(id: string) {
  const r = await fetch(`/api/conversations/${id}`);
  if (!r.ok) throw new Error("Conversation not found.");
  return r.json();
}

export async function renameConversation(id: string, title: string) {
  const r = await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title })
  });
  if (!r.ok) throw new Error("Failed to rename conversation.");
  return r.json();
}

export async function deleteConversation(id: string) {
  await fetch(`/api/conversations/${id}`, { method: "DELETE" });
}

export async function deleteAllConversations() {
  await fetch("/api/conversations", { method: "DELETE" });
}

export async function fetchSecurityEvents() {
  const r = await fetch("/api/security/events");
  if (!r.ok) throw new Error("Failed to load security events.");
  return r.json();
}

export async function exportUserData() {
  const r = await fetch("/api/data/export");
  if (!r.ok) throw new Error("Failed to export data.");
  return r.json();
}

export async function deleteAccount() {
  const r = await fetch("/api/account", { method: "DELETE" });
  if (!r.ok) throw new Error("Failed to delete account.");
  return r.json();
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const r = await fetch("/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.detail || "Failed to change password.");
  return body;
}

export async function streamChat(params: {
  message: string;
  model: string;
  attachments: Attachment[];
  conversationId?: string | null;
  temporary?: boolean;
  onChunk: (chunk: string) => void;
  onDone: (data?: { conversation_id?: string; title?: string }) => void;
  onError: (err: string) => void;
}) {
  const { message, model, attachments, conversationId, temporary, onChunk, onDone, onError } = params;
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, model, attachments, conversation_id: conversationId, temporary: !!temporary })
  });
  if (!r.ok || !r.body) throw new Error(`Chat failed (${r.status})`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.error) onError(String(payload.error));
        else if (payload.chunk) onChunk(String(payload.chunk));
        else if (payload.done) onDone(payload);
      } catch {
        // ignore malformed partial chunks
      }
    }
  }
}
