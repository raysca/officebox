import type { ChatChannel } from "./chat-channel";
import type { DocRoom } from "./doc-room";
import type { UserHub } from "./user-hub";
import type { WorkspacePresence } from "./presence";
import type { HuddleRoom } from "./huddle-room";
import type { FakeSfu } from "./fake-sfu";

/** Full current state of one message, sent from a ChatChannel DO to the D1 copy (TDD §3.3). */
export interface ProjectionMessage {
  channelId: string;
  seq: number;
  id: string;
  senderId: string;
  parentId: string | null;
  body: string | null;
  mentions: string[];
  reactions: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  lastEventSeq: number;
}

/** Hub events delivered by the fan-out (TDD §3.5). */
export interface HubActivity {
  channels: Array<{ channelId: string; latestSeq: number; changedSeq: number }>;
  inbox: InboxItem[];
}

export interface InboxItem {
  id: string;
  eventType: "mention" | "dm";
  channelId: string;
  seq: number;
  messageId: string;
  actorId: string;
  createdAt: number;
}

export interface Env {
  DB: D1Database;
  CHAT: DurableObjectNamespace<ChatChannel>;
  DOCS: DurableObjectNamespace<DocRoom>;
  USER_HUB: DurableObjectNamespace<UserHub>;
  PRESENCE: DurableObjectNamespace<WorkspacePresence>;
  HUDDLES: DurableObjectNamespace<HuddleRoom>;
  FAKE_SFU: DurableObjectNamespace<FakeSfu>;
  SFU_MODE?: "fake" | "real";
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  PROJECTION_QUEUE: Queue<ProjectionMessage>;
  SESSION_SECRET: string;
  DEV_LOGIN?: string;
  APP_ORIGIN?: string;
}
