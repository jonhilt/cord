/**
 * Spawner - The Claude CLI integration
 *
 * THIS IS THE CORE OF THE SYSTEM.
 *
 * Uses `--output-format stream-json` instead of `--print` so we can detect
 * the result event and return immediately — even if background tasks
 * (preview servers, long-running tools) keep the process alive.
 *
 * Key flags:
 * - `--output-format stream-json`: Structured JSON event stream
 * - `--session-id UUID`: Set session ID for new sessions
 * - `--resume UUID`: Resume an existing session (for follow-ups)
 * - `--append-system-prompt`: Inject context that survives compaction
 * - `-p "prompt"`: The actual prompt to send
 */

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Subprocess } from 'bun';
import type { Attachment } from './queue.js';

const log = (msg: string) => process.stdout.write(`[spawner] ${msg}\n`);

// Timezone for datetime injection (set via TZ env var)
const TIMEZONE = process.env.TZ || 'UTC';

// Attachments go under the working dir so the sandbox can access them
const ATTACHMENT_DIR = join(process.env.CLAUDE_WORKING_DIR || '/root/PAI', '.cord-attachments');

interface SpawnOptions {
    prompt: string;
    sessionId: string;
    resume: boolean;
    systemPrompt?: string;
    workingDir?: string;
    attachments?: Attachment[];
}

/**
 * Download Discord attachments to temp directory.
 * Returns array of local file paths.
 */
async function downloadAttachments(attachments: Attachment[], jobId: string): Promise<string[]> {
    const dir = join(ATTACHMENT_DIR, jobId);
    mkdirSync(dir, { recursive: true });

    const paths: string[] = [];
    for (const att of attachments) {
        try {
            const res = await fetch(att.url);
            if (!res.ok) {
                log(`Failed to download ${att.name}: ${res.status}`);
                continue;
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            const filePath = join(dir, att.name);
            await Bun.write(filePath, buffer);
            paths.push(filePath);
            log(`Downloaded attachment: ${att.name} (${buffer.length} bytes)`);
        } catch (e) {
            log(`Error downloading ${att.name}: ${e}`);
        }
    }
    return paths;
}

/** Clean up downloaded attachments for a job */
function cleanupAttachments(jobId: string): void {
    const dir = join(ATTACHMENT_DIR, jobId);
    if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Get current datetime in user's timezone
 * Claude Code doesn't know the time - we inject it
 */
function getDatetimeContext(): string {
    const now = new Date();
    return now.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: TIMEZONE,
    });
}

/**
 * Parse the stream-json output from Claude CLI.
 *
 * Reads newline-delimited JSON events and resolves as soon as the `result`
 * event arrives — without waiting for the process to exit. This prevents
 * background tasks (preview servers, long-running tools) from blocking
 * message delivery to Discord.
 */
export interface SpawnResult {
    text: string;
    buttons: string[];
    error?: string;
}

async function readStreamResult(proc: Subprocess): Promise<SpawnResult> {
    const reader = (proc.stdout as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = '';
    let accumulatedText = ''; // Collect text from assistant events as fallback
    const suggestedOptions: string[] = [];

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete lines (stream-json is newline-delimited JSON)
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete last line in buffer

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);

                    // Log all event types for debugging MCP tool capture
                    if (event.type !== 'assistant' && event.type !== 'result') {
                        log(`Stream event: type=${event.type} subtype=${event.subtype || ''} name=${event.name || event.tool || ''}`);
                    }

                    // Accumulate text from assistant messages as fallback
                    // The result event can be empty when Claude calls tools after producing text
                    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                        for (const block of event.message.content) {
                            if (block.type === 'text' && block.text) {
                                accumulatedText += block.text;
                            }
                            // Capture suggest_options tool calls from content blocks
                            if (block.type === 'tool_use' && block.name?.endsWith('suggest_options')) {
                                const opts = block.input?.options || [];
                                suggestedOptions.push(...opts);
                                log(`Captured suggest_options from content block: ${opts.join(', ')}`);
                            }
                        }
                    }

                    // Capture suggest_options tool calls from MCP (alternative event shape)
                    if (event.type === 'tool_use' && event.name?.endsWith('suggest_options')) {
                        const opts = event.input?.options || [];
                        suggestedOptions.push(...opts);
                        log(`Captured suggest_options tool call: ${opts.join(', ')}`);
                    }

                    if (event.type === 'result') {
                        // Use result text if available, otherwise fall back to accumulated text
                        result = event.result || accumulatedText || '';
                        log(`Got result event (${result.length} chars, ${suggestedOptions.length} buttons)`);

                        // Give Claude CLI time to flush the session to disk
                        // before killing the process. Without this, --resume
                        // won't see previous turns (the session file is incomplete).
                        try { reader.cancel(); } catch {}

                        // Wait up to 5s for natural exit, then force kill
                        // (background tasks like preview servers may keep it alive)
                        const exitTimeout = setTimeout(() => {
                            log('Process still alive after 5s, force killing');
                            proc.kill();
                        }, 5000);

                        await proc.exited;
                        clearTimeout(exitTimeout);
                        log('Process exited cleanly, session saved');

                        return { text: result, buttons: suggestedOptions };
                    }
                } catch {
                    // Not valid JSON — skip (e.g. partial line, stderr leak)
                }
            }
        }
    } catch {
        // Reader cancelled or stream closed — that's fine
    }

    // stdout closed without a result event — process probably errored
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr as ReadableStream).text();
        return { text: '', buttons: [], error: stderr || `Exit code ${exitCode}` };
    }

    return { text: result || 'No response generated.', buttons: suggestedOptions };
}

/**
 * Spawn Claude CLI and return the response
 */
export async function spawnClaude(options: SpawnOptions): Promise<SpawnResult> {
    const { prompt, sessionId, resume, systemPrompt, workingDir, attachments } = options;

    const cwd = workingDir || process.env.CLAUDE_WORKING_DIR || process.cwd();
    log(`Spawning Claude - Session: ${sessionId}, Resume: ${resume}`);
    log(`Working directory: ${cwd}`);

    // Download any attachments
    const jobId = `${sessionId}-${Date.now()}`;
    let attachmentPaths: string[] = [];
    if (attachments && attachments.length > 0) {
        log(`Downloading ${attachments.length} attachment(s)...`);
        attachmentPaths = await downloadAttachments(attachments, jobId);
    }

    // Build CLI arguments
    const args = ['claude'];

    // Stream-json output so we can resolve on the result event
    // without waiting for the process to exit
    args.push('--output-format', 'stream-json');
    args.push('--verbose');

    // Load suggest-options MCP server for action buttons
    args.push('--mcp-config', '/root/PAI/mcp/suggest-options.json');

    // Session handling
    if (resume) {
        // Resume existing session for follow-up messages
        args.push('--resume', sessionId);
    } else {
        // New session - set the ID upfront
        args.push('--session-id', sessionId);
    }

    // Inject datetime context and Discord-specific instructions (survives session compaction)
    const datetimeContext = `Current date/time: ${getDatetimeContext()}`;
    const discordBehavior = `\n\nDISCORD BEHAVIOR: This is a Discord thread. Be concise — short messages, no walls of text. CRITICAL: Do not repeat points you already made earlier in the conversation. If you covered something, move forward. Users can scroll up. Restating the same idea in different words is the worst habit here — say it once, say it well, then advance the discussion. Ask ONE question at a time — never multiple questions in a single message. This is essential because action buttons map to your question, and multiple questions make buttons nonsensical.`;
    const actionButtonInstruction = `\n\nACTION BUTTONS: You have a suggest_options tool. Call it at the END of your response when there are clear next actions (yes/no, multiple choice, proceed/cancel). The options become clickable buttons in Discord. Keep labels short (1-4 words). Max 5 options. Don't use for open-ended questions. IMPORTANT: You MUST still write a text response — the tool only adds buttons below your message, it does not replace your response. Don't list the options as text since the buttons handle that.`;
    const fullSystemPrompt = systemPrompt
        ? `${datetimeContext}${discordBehavior}${actionButtonInstruction}\n\n${systemPrompt}`
        : `${datetimeContext}${discordBehavior}${actionButtonInstruction}`;

    args.push('--append-system-prompt', fullSystemPrompt);

    // Build prompt with attachment references
    let fullPrompt = prompt;
    if (attachmentPaths.length > 0) {
        const fileList = attachmentPaths.map(p => `- ${p}`).join('\n');
        const attachmentNote = attachmentPaths.length === 1
            ? `\n\n[The user attached a file. Read it with the Read tool: ${attachmentPaths[0]}]`
            : `\n\n[The user attached ${attachmentPaths.length} files. Read them with the Read tool:\n${fileList}]`;
        fullPrompt = prompt + attachmentNote;
    }

    // The actual prompt
    args.push('-p', fullPrompt);

    log(`Command: ${args.join(' ').slice(0, 100)}...`);

    // Spawn the process
    const proc = Bun.spawn(args, {
        cwd,
        env: {
            ...process.env,
            TZ: TIMEZONE,
        },
        stdout: 'pipe',
        stderr: 'pipe',
    });

    // Parse stream-json, resolve on result event
    const spawnResult = await readStreamResult(proc);

    // Clean up downloaded attachments
    if (attachmentPaths.length > 0) {
        cleanupAttachments(jobId);
        log(`Cleaned up ${attachmentPaths.length} attachment(s)`);
    }

    if (spawnResult.error) {
        log(`Claude error: ${spawnResult.error}`);
        throw new Error(`Claude failed: ${spawnResult.error}`);
    }

    log(`Claude responded (${spawnResult.text.length} chars, ${spawnResult.buttons.length} buttons)`);

    return spawnResult;
}
