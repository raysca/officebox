import type { ChatChannel } from "./chat-channel";
import type { DocRoom } from "./doc-room";

/** Full current state of one message, sent from a ChatChannel DO to the D1 copy (TDD §3.3). */
export interface ProjectionMessage {
  channelId: string;
  seq: number;
  id: string;
  senderId: string;
  parentId: string | null;
  body: string | null;
  reactions: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  lastEventSeq: number;
}

export interface Env {
  DB: D1Database;
  CHAT: DurableObjectNamespace<ChatChannel>;
  DOCS: DurableObjectNamespace<DocRoom>;
  PROJECTION_QUEUE: Queue<ProjectionMessage>;
  SESSION_SECRET: string;
  DEV_LOGIN?: string;
  APP_ORIGIN?: string;
}
