/**
 * Worker - Processes Claude jobs from the queue
 *
 * This is where the magic happens:
 * 1. Pulls jobs from the queue
 * 2. Spawns Claude CLI with the right flags
 * 3. Posts the response back to Discord
 */

import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { spawnClaude, type SpawnResult } from './spawner.js';
import { sendToThread, sendTyping } from './discord.js';
import type { ClaudeJob } from './queue.js';

const log = (msg: string) => process.stdout.write(`[worker] ${msg}\n`);

const API_PORT = parseInt(process.env.API_PORT || '2643');

/**
 * Parse [BUTTONS: label1 | label2 | label3] from Claude's response.
 * Returns the cleaned text and any button labels found.
 */
function parseActionButtons(response: string): { text: string; buttons: string[] } {
    const buttonPattern = /\[BUTTONS:\s*(.+?)\]\s*$/m;
    const match = response.match(buttonPattern);

    if (!match) {
        return { text: response, buttons: [] };
    }

    const buttons = match[1].split('|').map(b => b.trim()).filter(Boolean);
    const text = response.replace(buttonPattern, '').trimEnd();

    return { text, buttons };
}

/**
 * Send action buttons to a thread via the HTTP API
 */
async function sendActionButtons(threadId: string, labels: string[]): Promise<void> {
    const timestamp = Date.now();
    const buttons = labels.map((label, i) => ({
        label,
        customId: `action-${threadId}-${timestamp}-${i}`,
        style: 'secondary' as const,
        handler: {
            type: 'thread-reply' as const,
            text: label,
        },
    }));

    try {
        const response = await fetch(`http://localhost:${API_PORT}/send-with-buttons`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channelId: threadId,
                buttons,
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            log(`Failed to send action buttons: ${response.status} ${error}`);
        } else {
            log(`Sent ${labels.length} action buttons to thread ${threadId}`);
        }
    } catch (error) {
        log(`Error sending action buttons: ${error}`);
    }
}

const connection = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: null,
});

const worker = new Worker<ClaudeJob>(
    'claude',
    async (job: Job<ClaudeJob>) => {
        const { prompt, threadId, sessionId, resume, username, workingDir, attachments } = job.data;

        log(`Processing job ${job.id} for ${username}`);
        log(`Session: ${sessionId}, Resume: ${resume}`);
        if (attachments?.length) log(`Attachments: ${attachments.map(a => a.name).join(', ')}`);

        // Keep typing indicator alive while Claude is processing
        // Discord's typing indicator expires after 10 seconds
        const typingInterval = setInterval(() => {
            log(`Typing ping → ${threadId}`);
            sendTyping(threadId).catch((e) => log(`Typing failed: ${e}`));
        }, 8000);
        log(`Initial typing → ${threadId}`);
        sendTyping(threadId).catch((e) => log(`Initial typing failed: ${e}`));

        try {
            // Spawn Claude and get response (includes any suggest_options tool calls)
            const spawnResult = await spawnClaude({
                prompt,
                sessionId,
                resume,
                workingDir,
                attachments,
            });

            clearInterval(typingInterval);

            // Use buttons from MCP tool call if available, fall back to text parsing
            let text = spawnResult.text;
            let buttons = spawnResult.buttons;

            if (buttons.length === 0) {
                // Fallback: parse [BUTTONS: ...] from response text
                const parsed = parseActionButtons(text);
                text = parsed.text;
                buttons = parsed.buttons;
            }

            // Guard: if Claude returned nothing, don't send a blank message
            if (!text.trim() && buttons.length === 0) {
                log(`Empty response from Claude (no text, no buttons) — skipping send`);
                return { success: true, responseLength: 0, buttons: 0 };
            }

            // Send response to Discord thread (skip if text is empty but buttons exist)
            if (text.trim()) {
                await sendToThread(threadId, text);
            }

            // Send action buttons if Claude suggested any
            if (buttons.length > 0) {
                await sendActionButtons(threadId, buttons);
            }

            log(`Job ${job.id} completed`);
            return { success: true, responseLength: text.length, buttons: buttons.length };

        } catch (error) {
            clearInterval(typingInterval);
            log(`Job ${job.id} failed: ${error}`);

            // Send error message to thread
            await sendToThread(
                threadId,
                `Something went wrong. Try again?\n\`\`\`${error}\`\`\``
            );

            throw error; // Re-throw for BullMQ retry logic
        }
    },
    {
        connection,
        concurrency: 2, // Process up to 2 jobs at once
    }
);

worker.on('completed', (job) => {
    log(`Job ${job?.id} completed`);
});

worker.on('failed', (job, err) => {
    log(`Job ${job?.id} failed: ${err.message}`);
});

log('Worker started, waiting for jobs...');

export { worker, parseActionButtons, sendActionButtons };
