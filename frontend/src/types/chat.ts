export type Role = "user" | "assistant" | "error";

export interface ModelOption {
  id: string;
  label: string;
}

export interface Attachment {
  id: string;
  kind: "image" | "pdf" | "text";
  name: string;
  mime?: string;
  data?: string;
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
}
