import { getDb } from './connection.js';

/**
 * Record that a given outbound message was delivered with the platform-assigned
 * id. Called from delivery.ts immediately after a successful `adapter.deliver`.
 *
 * Keyed on (channel_type, platform_id, platform_message_id) — these together
 * uniquely identify a message in the destination platform. The (agent_group_id,
 * session_id) fields are the lookup target: when the same message later comes
 * back as the target of a reply or reaction, the router uses this index to
 * route the inbound event directly to its owning agent.
 *
 * INSERT OR REPLACE — re-delivering the same message_out_id (e.g. after a
 * retry that the adapter idempotently dedupes) overwrites the prior row with
 * the latest delivery timestamp. The PK collision is unlikely in practice
 * (platform message ids are platform-unique).
 */
export function recordOutboundMessage(
  channelType: string,
  platformId: string,
  platformMessageId: string,
  agentGroupId: string,
  sessionId: string,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO outbound_message_index
       (channel_type, platform_id, platform_message_id, agent_group_id, session_id, delivered_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(channelType, platformId, platformMessageId, agentGroupId, sessionId);
}

/**
 * Look up the agent that originally sent a given platform message. Used by
 * the router to redirect reactions and replies past the engage_pattern check.
 * Returns null if the message wasn't sent by any tracked agent (older
 * outbound from before the index existed, or a non-agent message).
 */
export function findOwningAgent(
  channelType: string,
  platformId: string,
  platformMessageId: string,
): { agentGroupId: string; sessionId: string } | null {
  const row = getDb()
    .prepare(
      `SELECT agent_group_id, session_id FROM outbound_message_index
       WHERE channel_type=? AND platform_id=? AND platform_message_id=?`,
    )
    .get(channelType, platformId, platformMessageId) as { agent_group_id: string; session_id: string } | undefined;
  return row ? { agentGroupId: row.agent_group_id, sessionId: row.session_id } : null;
}
