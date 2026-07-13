import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Central index mapping (channel, platform_id, platform_message_id) → owning
 * agent_group + session. Populated by delivery.ts after a successful
 * adapter.deliver call. Read by the router to route reactions and replies
 * directly to the agent that sent the original message, bypassing the
 * pattern-based engage logic. This is what lets a Telegram reply to a
 * krasivo draft land at krasivo even though the wiring pattern says
 * otherwise.
 *
 * Kept out of the numbered upstream sequence (module- prefix, like the other
 * local/skill migrations) so it never collides with a future upstream NNN-*.
 * Idempotency is keyed on `name`, not the number, so `version` is arbitrary.
 */
export const moduleOutboundMessageIndex: Migration = {
  version: 16,
  name: 'outbound-message-index',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_message_index (
        channel_type        TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id          TEXT NOT NULL,
        delivered_at        TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id, platform_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_message_index_agent
        ON outbound_message_index(agent_group_id);
    `);
  },
};
