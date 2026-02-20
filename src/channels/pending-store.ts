import {
    deleteChannelPendingMessage,
    getChannelPendingMessage,
    incrementMetric,
    purgeExpiredChannelPendingMessages,
    upsertChannelPendingMessage,
} from '../harness/repository';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface DurablePendingMessage {
    channel: string;
    sender: string;
    senderId: string;
    chatRef: string;
    replyRef: string;
}

export function rememberPendingMessage(input: {
    messageId: string;
    channel: string;
    sender: string;
    senderId: string;
    chatRef?: string;
    replyRef?: string;
    ttlMs?: number;
}): void {
    const ttlMs = Math.max(1, input.ttlMs || DEFAULT_TTL_MS);
    const expiresAt = Date.now() + ttlMs;
    upsertChannelPendingMessage({
        messageId: input.messageId,
        channel: input.channel,
        sender: input.sender,
        senderId: input.senderId,
        chatRef: input.chatRef || input.senderId,
        replyRef: input.replyRef || '',
        expiresAt,
    });
}

export function readPendingMessage(channel: string, messageId: string): DurablePendingMessage | null {
    const row = getChannelPendingMessage(messageId);
    if (!row || row.channel !== channel) return null;
    if (row.expires_at <= Date.now()) {
        deleteChannelPendingMessage(messageId);
        return null;
    }

    return {
        channel: row.channel,
        sender: row.sender,
        senderId: row.sender_id,
        chatRef: row.chat_ref || row.sender_id,
        replyRef: row.reply_ref || '',
    };
}

export function clearPendingMessage(messageId: string): void {
    deleteChannelPendingMessage(messageId);
}

export function cleanupExpiredPendingMessages(channel: string): number {
    const removed = purgeExpiredChannelPendingMessages(channel, 0);
    if (removed > 0) {
        incrementMetric('channel_pending_expired_count', removed, { channel });
    }
    return removed;
}
