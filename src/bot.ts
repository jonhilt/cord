/**
 * Discord Bot - Catches @mentions, creates threads, forwards to queue
 *
 * This is the entry point for the Discord → Claude bridge.
 * When someone @mentions the bot, it:
 * 1. Creates a thread for the conversation
 * 2. Queues the message for Claude processing
 * 3. Posts responses back to the thread
 */

import {
    Client,
    GatewayIntentBits,
    Events,
    Message,
    TextChannel,
    ThreadAutoArchiveDuration,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    WebhookClient,
    type Interaction,
    type Webhook,
} from 'discord.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { claudeQueue, type Attachment } from './queue.js';
import { db, getChannelConfigCached, setChannelConfig, clearThreadInit, loadButtonHandler, deleteButtonHandlers } from './db.js';
import { startApiServer, buttonHandlers, activeActionMessages } from './api.js';

// Allowed working directories (configurable via env, comma-separated)
// If not set, any existing directory is allowed (backward compatible)
const ALLOWED_DIRS = process.env.CORD_ALLOWED_DIRS
    ? process.env.CORD_ALLOWED_DIRS.split(',').map(d => resolve(d.trim()))
    : null;

/**
 * Validate that a path is within the allowed directories.
 * Returns null if valid, or an error message if invalid.
 */
function validateWorkingDir(dir: string): string | null {
    // Resolve to absolute path
    const resolved = resolve(dir);

    // If no allowlist configured, just check existence
    if (!ALLOWED_DIRS) {
        if (!existsSync(resolved)) {
            return `Directory not found: \`${dir}\``;
        }
        return null;
    }

    // Check against allowlist
    const isAllowed = ALLOWED_DIRS.some(allowed =>
        resolved === allowed || resolved.startsWith(allowed + '/')
    );

    if (!isAllowed) {
        return `Directory not in allowed list. Allowed: ${ALLOWED_DIRS.join(', ')}`;
    }

    if (!existsSync(resolved)) {
        return `Directory not found: \`${dir}\``;
    }

    return null;
}

// Board meeting API base URL
const BOARD_API_URL = process.env.BOARD_API_URL || 'http://localhost:2644';

// Force unbuffered logging
const log = (msg: string) => process.stdout.write(`[bot] ${msg}\n`);

// Cache webhooks per channel so we don't create duplicates
const webhookCache = new Map<string, Webhook>();

/**
 * Get or create a webhook for a channel, used to post messages
 * that appear to come from a specific user (with their name + avatar).
 */
async function getOrCreateWebhook(channel: TextChannel): Promise<Webhook> {
    const cached = webhookCache.get(channel.id);
    if (cached) return cached;

    // Check for existing cord webhook
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(w => w.name === 'Cord');

    if (!webhook) {
        webhook = await channel.createWebhook({ name: 'Cord' });
        log(`Created webhook for channel ${channel.id}`);
    }

    webhookCache.set(channel.id, webhook);
    return webhook;
}

/**
 * Post a message in a thread that appears to come from a specific user.
 * Uses a channel webhook with the user's display name and avatar.
 */
async function sendAsUser(
    threadId: string,
    text: string,
    user: { displayName: string; avatarURL: string | null },
): Promise<void> {
    const thread = await client.channels.fetch(threadId);
    if (!thread?.isThread()) return;

    const parentChannel = await client.channels.fetch(thread.parentId!) as TextChannel;
    const webhook = await getOrCreateWebhook(parentChannel);

    await webhook.send({
        content: text,
        username: user.displayName,
        avatarURL: user.avatarURL || undefined,
        threadId,
    });
}

// Helper function to resolve working directory from message or channel config
function resolveWorkingDir(message: string, channelId: string): { workingDir: string; cleanedMessage: string; error?: string } {
    // Check for [/path] prefix override
    const pathMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (pathMatch && pathMatch[1]) {
        let dir = pathMatch[1];
        // Expand ~ to home directory
        if (dir.startsWith('~')) {
            dir = dir.replace('~', homedir());
        }
        const validationError = validateWorkingDir(dir);
        if (validationError) {
            return {
                workingDir: '',
                cleanedMessage: message.slice(pathMatch[0].length),
                error: validationError
            };
        }
        return {
            workingDir: resolve(dir),
            cleanedMessage: message.slice(pathMatch[0].length)
        };
    }

    // Check channel config (cached)
    const channelConfig = getChannelConfigCached(channelId);
    if (channelConfig?.working_dir) {
        return { workingDir: channelConfig.working_dir, cleanedMessage: message };
    }

    // Fall back to env or cwd
    return {
        workingDir: process.env.CLAUDE_WORKING_DIR || process.cwd(),
        cleanedMessage: message
    };
}

/** Extract image/file attachments from a Discord message */
function extractAttachments(message: Message): Attachment[] {
    return Array.from(message.attachments.values()).map(att => ({
        url: att.url,
        name: att.name,
        contentType: att.contentType,
    }));
}

/**
 * Disable all buttons on a message (greyed out but still visible)
 */
async function disableActionButtons(threadId: string): Promise<void> {
    const messageId = activeActionMessages.get(threadId);
    if (!messageId) return;

    try {
        const channel = await client.channels.fetch(threadId);
        if (!channel?.isTextBased()) return;

        const msg = await (channel as TextChannel).messages.fetch(messageId);
        const disabledRows = msg.components.map(row =>
            ActionRowBuilder.from(row).setComponents(
                row.components.map(c => ButtonBuilder.from(c as any).setDisabled(true))
            )
        ) as ActionRowBuilder<ButtonBuilder>[];

        await msg.edit({ components: disabledRows });

        // Clean up handlers for these buttons (memory + DB)
        const customIds: string[] = [];
        for (const row of msg.components) {
            for (const component of row.components) {
                if (component.customId) {
                    buttonHandlers.delete(component.customId);
                    customIds.push(component.customId);
                }
            }
        }
        deleteButtonHandlers(customIds);

        activeActionMessages.delete(threadId);
        log(`Disabled action buttons in thread ${threadId}`);
    } catch (error) {
        log(`Failed to disable buttons: ${error}`);
        activeActionMessages.delete(threadId);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

client.once(Events.ClientReady, async (c) => {
    log(`Logged in as ${c.user.tag}`);

    // Register slash commands as guild-specific (instant propagation)
    const guild = c.guilds.cache.first();
    if (!guild) {
        log('WARNING: Bot is not in any guild, cannot register slash commands');
    } else {
        log(`Registering guild commands for: ${guild.name} (${guild.id})`);

        const existingCommands = await guild.commands.fetch();
        const cordCommand = existingCommands?.find(cmd => cmd.name === 'cord');

        if (!cordCommand) {
            const command = new SlashCommandBuilder()
                .setName('cord')
                .setDescription('Configure Cord bot')
                .addSubcommand(sub =>
                    sub.setName('config')
                       .setDescription('Configure channel settings')
                       .addStringOption(opt =>
                           opt.setName('dir')
                              .setDescription('Working directory for Claude in this channel')
                              .setRequired(true)
                       )
                );

            await guild.commands.create(command);
            log('/cord guild command registered');
        } else {
            log('/cord guild command already registered');
        }

        // Register /board and /board-close commands
        const boardCommand = existingCommands?.find(cmd => cmd.name === 'board');
        if (!boardCommand) {
            const board = new SlashCommandBuilder()
                .setName('board')
                .setDescription('Start a board meeting on a topic')
                .addStringOption(opt =>
                    opt.setName('topic')
                       .setDescription('The topic for the board meeting')
                       .setRequired(true)
                );
            await guild.commands.create(board);
            log('/board guild command registered');
        }

        const boardCloseCommand = existingCommands?.find(cmd => cmd.name === 'board-close');
        if (!boardCloseCommand) {
            const boardClose = new SlashCommandBuilder()
                .setName('board-close')
                .setDescription('Close the current board meeting');
            await guild.commands.create(boardClose);
            log('/board-close guild command registered');
        }

        // Clean up stale global commands (from previous registration)
        try {
            const globalCommands = await c.application?.commands.fetch();
            if (globalCommands && globalCommands.size > 0) {
                for (const [, cmd] of globalCommands) {
                    await c.application?.commands.delete(cmd.id);
                    log(`Deleted stale global command: /${cmd.name}`);
                }
            }
        } catch (err) {
            log(`Failed to clean up global commands: ${err}`);
        }
    }

    // Start HTTP API server
    const apiPort = parseInt(process.env.API_PORT || '2643');
    startApiServer(client, apiPort);
});

// Handle slash command and button interactions
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Handle /cord slash command
    if (interaction.isChatInputCommand() && interaction.commandName === 'cord') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'config') {
            let dir = interaction.options.getString('dir', true);

            // Expand ~ to home directory
            if (dir.startsWith('~')) {
                dir = dir.replace('~', homedir());
            }

            // Validate path against allowlist and check existence
            const validationError = validateWorkingDir(dir);
            if (validationError) {
                await interaction.reply({
                    content: validationError,
                    ephemeral: true
                });
                return;
            }

            // Resolve to absolute path before storing
            dir = resolve(dir);

            setChannelConfig(interaction.channelId, dir);
            await interaction.reply({
                content: `Working directory set to \`${dir}\` for this channel.`,
                ephemeral: true
            });
            log(`Channel ${interaction.channelId} configured with working dir: ${dir}`);
        }
        return;
    }

    // Handle /board slash command
    if (interaction.isChatInputCommand() && interaction.commandName === 'board') {
        const topic = interaction.options.getString('topic', true);
        await interaction.deferReply();
        try {
            const response = await fetch(`${BOARD_API_URL}/board/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic }),
            });
            const result = await response.json() as { message?: string; error?: string };
            if (response.ok) {
                await interaction.editReply(result.message || `Board meeting started on: ${topic}`);
            } else {
                await interaction.editReply(`Failed to start board meeting: ${result.error || response.statusText}`);
            }
        } catch (error) {
            log(`/board error: ${error}`);
            await interaction.editReply(`Failed to start board meeting: ${error}`);
        }
        return;
    }

    // Handle /board-close slash command
    if (interaction.isChatInputCommand() && interaction.commandName === 'board-close') {
        await interaction.deferReply();
        try {
            const response = await fetch(`${BOARD_API_URL}/board/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const result = await response.json() as { message?: string; error?: string };
            if (response.ok) {
                await interaction.editReply(result.message || 'Board meeting closed.');
            } else {
                await interaction.editReply(`Failed to close board meeting: ${result.error || response.statusText}`);
            }
        } catch (error) {
            log(`/board-close error: ${error}`);
            await interaction.editReply(`Failed to close board meeting: ${error}`);
        }
        return;
    }

    if (!interaction.isButton()) return;

    log(`Looking up handler for: ${interaction.customId}`);
    // Check in-memory first, fall back to DB (survives restarts)
    let handler = buttonHandlers.get(interaction.customId);
    if (!handler) {
        const persisted = loadButtonHandler(interaction.customId);
        if (persisted) {
            handler = persisted as typeof handler;
            buttonHandlers.set(interaction.customId, handler);
            log(`Loaded handler from DB: ${interaction.customId}`);
        }
    }
    if (!handler) {
        log(`No handler found for: ${interaction.customId}`);
        await interaction.reply({ content: 'This button has expired.', ephemeral: true });
        return;
    }

    try {
        if (handler.type === 'inline') {
            await interaction.reply({
                content: handler.content,
                ephemeral: handler.ephemeral ?? false,
            });
        } else if (handler.type === 'webhook') {
            await interaction.deferReply({ ephemeral: true });
            const response = await fetch(handler.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customId: interaction.customId,
                    userId: interaction.user.id,
                    channelId: interaction.channelId,
                    data: handler.data,
                }),
            });
            const result = await response.json() as { content?: string };
            await interaction.editReply({ content: result.content || 'Done.' });
        } else if (handler.type === 'thread-reply') {
            // Acknowledge the click silently
            await interaction.deferUpdate();

            const threadId = interaction.channelId!;
            const text = handler.text;

            // Disable buttons on this message
            await disableActionButtons(threadId);

            // Post the button text as if the user typed it
            await sendAsUser(threadId, text, {
                displayName: interaction.user.displayName,
                avatarURL: interaction.user.displayAvatarURL(),
            }).catch(e => log(`Failed to send as user: ${e}`));

            // Look up session for this thread and queue a Claude job
            const channel = await client.channels.fetch(threadId);
            const mapping = db.query('SELECT session_id, working_dir FROM threads WHERE thread_id = ?')
                .get(threadId) as { session_id: string; working_dir: string | null } | null;

            if (mapping) {
                const workingDir = mapping.working_dir ||
                    getChannelConfigCached((channel as any)?.parentId || '')?.working_dir ||
                    process.env.CLAUDE_WORKING_DIR ||
                    process.cwd();

                // Show typing indicator
                if (channel?.isTextBased()) {
                    await (channel as TextChannel).sendTyping();
                }

                await claudeQueue.add('process', {
                    prompt: text,
                    threadId,
                    sessionId: mapping.session_id,
                    resume: true,
                    userId: interaction.user.id,
                    username: interaction.user.tag,
                    workingDir,
                });

                log(`Thread-reply button: queued "${text}" for thread ${threadId}`);
            } else {
                log(`Thread-reply button: no session found for thread ${threadId}`);
            }
        }
    } catch (error) {
        log(`Button handler error: ${error}`);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An error occurred.', ephemeral: true });
        }
    }
});

client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots
    if (message.author.bot) return;

    const isMentioned = client.user && message.mentions.has(client.user);
    const isInThread = message.channel.isThread();

    // =========================================================================
    // THREAD MESSAGES: Continue existing conversations
    // =========================================================================
    if (isInThread) {
        const thread = message.channel;

        // Look up session ID and working dir for this thread
        const mapping = db.query('SELECT session_id, working_dir, context, needs_init, webhook_url FROM threads WHERE thread_id = ?')
            .get(thread.id) as { session_id: string; working_dir: string | null; context: string | null; needs_init: number; webhook_url: string | null } | null;

        if (!mapping) {
            // Not a thread we created, ignore
            return;
        }

        log(`Thread message from ${message.author.tag}`);

        // Disable any active action buttons (user typed instead of clicking)
        disableActionButtons(thread.id).catch(e => log(`Disable buttons error: ${e}`));

        // Webhook threads: forward to webhook URL instead of Claude
        if (mapping.webhook_url) {
            log(`Webhook thread message from ${message.author.tag} → ${mapping.webhook_url}`);
            await thread.sendTyping();
            const content = message.content.replace(/<@!?\d+>/g, '').trim();
            try {
                await fetch(mapping.webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: content }),
                });
            } catch (error) {
                log(`Webhook error: ${error}`);
            }
            return;
        }

        // Show typing indicator
        await thread.sendTyping();

        // Extract message content (strip @mentions)
        const content = message.content.replace(/<@!?\d+>/g, '').trim();

        // Use stored working dir or fall back to channel config / env / cwd
        const workingDir = mapping.working_dir ||
            getChannelConfigCached(thread.parentId || '')?.working_dir ||
            process.env.CLAUDE_WORKING_DIR ||
            process.cwd();

        // Pre-registered threads (notifications) need initialization on first reply
        const isInit = mapping.needs_init === 1;
        const prompt = isInit && mapping.context
            ? `[You sent this notification to Jon]\n---\n${mapping.context}\n---\n\nJon's reply: ${content}`
            : content;

        if (isInit) {
            clearThreadInit(thread.id);
        }

        // Queue for Claude processing
        const attachments = extractAttachments(message);
        await claudeQueue.add('process', {
            prompt,
            threadId: thread.id,
            sessionId: mapping.session_id,
            resume: !isInit,
            userId: message.author.id,
            username: message.author.tag,
            workingDir,
            ...(attachments.length > 0 && { attachments }),
        });

        return;
    }

    // =========================================================================
    // NEW MENTIONS: Start new conversations
    // =========================================================================
    if (!isMentioned) return;

    log(`New mention from ${message.author.tag}`);

    // Extract message content and resolve working directory
    const rawText = message.content.replace(/<@!?\d+>/g, '').trim();
    const { workingDir, cleanedMessage, error: workingDirError } = resolveWorkingDir(rawText, message.channelId);

    // If path override validation failed, reply with error
    if (workingDirError) {
        await message.reply(workingDirError);
        return;
    }

    log(`Working directory: ${workingDir}`);

    // Create thread directly from the user's message —
    // their @mention becomes the thread starter, no "Processing..." needed
    let thread;
    try {
        const threadName = cleanedMessage.length > 50
            ? cleanedMessage.slice(0, 47) + '...'
            : cleanedMessage || 'New conversation';

        thread = await message.startThread({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
    } catch (error) {
        log(`Failed to create thread: ${error}`);
        await message.reply('Failed to start thread. Try again?');
        return;
    }

    // Generate a new session ID for this conversation
    const sessionId = crypto.randomUUID();

    // Store the thread → session mapping with working directory
    // Note: thread.id === statusMessage.id because thread was created from that message
    db.run(
        'INSERT INTO threads (thread_id, session_id, working_dir) VALUES (?, ?, ?)',
        [thread.id, sessionId, workingDir]
    );

    log(`Created thread ${thread.id} with session ${sessionId}`);

    // Show typing indicator
    await thread.sendTyping();

    // Queue for Claude processing
    const attachments = extractAttachments(message);
    await claudeQueue.add('process', {
        prompt: cleanedMessage,
        threadId: thread.id,
        sessionId,
        resume: false,
        userId: message.author.id,
        username: message.author.tag,
        workingDir,
        ...(attachments.length > 0 && { attachments }),
    });
});

// =========================================================================
// REACTION HANDLER: ✅ on last message marks thread as done
// =========================================================================
client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // Ignore bot reactions
    if (user.bot) return;

    // Only handle ✅ reactions
    if (reaction.emoji.name !== '✅') return;

    // Only handle reactions in threads
    const channel = reaction.message.channel;
    if (!channel.isThread()) return;

    try {
        const thread = channel;
        const parentChannelId = thread.parentId;
        if (!parentChannelId) return;

        // Check if this is the last message in the thread
        const messages = await thread.messages.fetch({ limit: 1 });
        const lastMessage = messages.first();

        if (!lastMessage || lastMessage.id !== reaction.message.id) {
            // Reaction is not on the last message, ignore
            return;
        }

        log(`✅ reaction on last message in thread ${thread.id}`);

        // Update thread starter message to "Done"
        // The thread ID equals the starter message ID (thread was created from that message)
        const parentChannel = await client.channels.fetch(parentChannelId);
        if (parentChannel?.isTextBased()) {
            const starterMessage = await (parentChannel as TextChannel).messages.fetch(thread.id);
            await starterMessage.edit('✅ Done');
            log(`Thread ${thread.id} marked as Done`);
        }
    } catch (error) {
        log(`Failed to mark thread done: ${error}`);
    }
});

// Start the bot
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error('DISCORD_BOT_TOKEN required');
    process.exit(1);
}

client.login(token);

// Export for external use
export { client };
