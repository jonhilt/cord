/**
 * Tests for action buttons feature:
 * - Parsing [BUTTONS: ...] from Claude responses
 * - Sending buttons via HTTP API
 * - Button handler registry and dispatch
 * - Active action message tracking
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { parseActionButtons } from './worker.js';
import { buttonHandlers, activeActionMessages } from './api.js';

// =========================================================================
// parseActionButtons - Pure function tests
// =========================================================================
describe('parseActionButtons', () => {
    it('returns original text when no buttons present', () => {
        const input = 'Just a normal response with no buttons.';
        const result = parseActionButtons(input);

        expect(result.text).toBe(input);
        expect(result.buttons).toEqual([]);
    });

    it('extracts single button', () => {
        const input = 'Do you want to proceed?\n[BUTTONS: Yes]';
        const result = parseActionButtons(input);

        expect(result.text).toBe('Do you want to proceed?');
        expect(result.buttons).toEqual(['Yes']);
    });

    it('extracts multiple pipe-separated buttons', () => {
        const input = 'Choose an option:\n[BUTTONS: Option A | Option B | Option C]';
        const result = parseActionButtons(input);

        expect(result.text).toBe('Choose an option:');
        expect(result.buttons).toEqual(['Option A', 'Option B', 'Option C']);
    });

    it('trims whitespace from button labels', () => {
        const input = 'Pick one\n[BUTTONS:  Yes |  No  | Maybe ]';
        const result = parseActionButtons(input);

        expect(result.buttons).toEqual(['Yes', 'No', 'Maybe']);
    });

    it('filters out empty labels from double pipes', () => {
        const input = 'Pick\n[BUTTONS: Yes || No]';
        const result = parseActionButtons(input);

        expect(result.buttons).toEqual(['Yes', 'No']);
    });

    it('handles buttons at end of multiline response', () => {
        const input = `Here's a long explanation.

It has multiple paragraphs.

What would you like to do next?
[BUTTONS: Continue | Go back | Cancel]`;
        const result = parseActionButtons(input);

        expect(result.text).toBe(`Here's a long explanation.

It has multiple paragraphs.

What would you like to do next?`);
        expect(result.buttons).toEqual(['Continue', 'Go back', 'Cancel']);
    });

    it('handles trailing whitespace after button tag', () => {
        const input = 'Choose:\n[BUTTONS: A | B]   ';
        const result = parseActionButtons(input);

        expect(result.buttons).toEqual(['A', 'B']);
    });

    it('does not match BUTTONS in middle of text', () => {
        const input = 'See [BUTTONS: A | B] for options.\nMore text here.';
        const result = parseActionButtons(input);

        // Pattern requires ] to be at end of line — "for options." after ] prevents match
        expect(result.buttons).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('handles max 5 buttons (Discord limit)', () => {
        const input = 'Pick:\n[BUTTONS: A | B | C | D | E]';
        const result = parseActionButtons(input);

        expect(result.buttons).toHaveLength(5);
        expect(result.buttons).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    it('preserves markdown formatting in response text', () => {
        const input = '**Bold** and `code` response\n[BUTTONS: OK]';
        const result = parseActionButtons(input);

        expect(result.text).toBe('**Bold** and `code` response');
        expect(result.buttons).toEqual(['OK']);
    });

    it('handles response that is ONLY a button tag', () => {
        const input = '[BUTTONS: Yes | No]';
        const result = parseActionButtons(input);

        expect(result.text).toBe('');
        expect(result.buttons).toEqual(['Yes', 'No']);
    });
});

// =========================================================================
// Button handler registry
// =========================================================================
describe('buttonHandlers registry', () => {
    beforeEach(() => {
        buttonHandlers.clear();
    });

    it('stores and retrieves inline handlers', () => {
        buttonHandlers.set('btn-1', {
            type: 'inline',
            content: 'You clicked it!',
            ephemeral: true,
        });

        const handler = buttonHandlers.get('btn-1');
        expect(handler).toBeDefined();
        expect(handler!.type).toBe('inline');
        if (handler!.type === 'inline') {
            expect(handler.content).toBe('You clicked it!');
            expect(handler.ephemeral).toBe(true);
        }
    });

    it('stores and retrieves webhook handlers', () => {
        buttonHandlers.set('btn-2', {
            type: 'webhook',
            url: 'http://localhost:3000/callback',
            data: { meetingId: '123' },
        });

        const handler = buttonHandlers.get('btn-2');
        expect(handler).toBeDefined();
        expect(handler!.type).toBe('webhook');
        if (handler!.type === 'webhook') {
            expect(handler.url).toBe('http://localhost:3000/callback');
            expect(handler.data).toEqual({ meetingId: '123' });
        }
    });

    it('stores and retrieves thread-reply handlers', () => {
        buttonHandlers.set('btn-3', {
            type: 'thread-reply',
            text: 'Yes, proceed',
        });

        const handler = buttonHandlers.get('btn-3');
        expect(handler).toBeDefined();
        expect(handler!.type).toBe('thread-reply');
        if (handler!.type === 'thread-reply') {
            expect(handler.text).toBe('Yes, proceed');
        }
    });

    it('returns undefined for expired/unknown button', () => {
        expect(buttonHandlers.get('nonexistent')).toBeUndefined();
    });

    it('removes handler on delete', () => {
        buttonHandlers.set('btn-4', { type: 'inline', content: 'test' });
        expect(buttonHandlers.has('btn-4')).toBe(true);

        buttonHandlers.delete('btn-4');
        expect(buttonHandlers.has('btn-4')).toBe(false);
    });
});

// =========================================================================
// activeActionMessages tracking
// =========================================================================
describe('activeActionMessages tracking', () => {
    beforeEach(() => {
        activeActionMessages.clear();
    });

    it('tracks message ID per thread', () => {
        activeActionMessages.set('thread-1', 'msg-100');
        activeActionMessages.set('thread-2', 'msg-200');

        expect(activeActionMessages.get('thread-1')).toBe('msg-100');
        expect(activeActionMessages.get('thread-2')).toBe('msg-200');
    });

    it('overwrites previous message for same thread', () => {
        activeActionMessages.set('thread-1', 'msg-100');
        activeActionMessages.set('thread-1', 'msg-101');

        expect(activeActionMessages.get('thread-1')).toBe('msg-101');
    });

    it('removes tracking on delete', () => {
        activeActionMessages.set('thread-1', 'msg-100');
        activeActionMessages.delete('thread-1');

        expect(activeActionMessages.has('thread-1')).toBe(false);
    });

    it('returns undefined for untracked thread', () => {
        expect(activeActionMessages.get('unknown-thread')).toBeUndefined();
    });
});

// =========================================================================
// sendActionButtons - HTTP integration
// =========================================================================
describe('sendActionButtons', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('builds correct button payload with thread-reply handlers', async () => {
        let capturedBody: any;
        globalThis.fetch = (async (url: string, init: any) => {
            capturedBody = JSON.parse(init.body);
            return new Response(JSON.stringify({ success: true, messageId: 'msg-1' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as any;

        // Import fresh to get the function with mocked fetch
        const { sendActionButtons } = await import('./worker.js');
        await sendActionButtons('thread-123', ['Yes', 'No', 'Maybe']);

        expect(capturedBody.channelId).toBe('thread-123');
        expect(capturedBody.buttons).toHaveLength(3);

        // Check button structure
        for (const btn of capturedBody.buttons) {
            expect(btn.style).toBe('secondary');
            expect(btn.handler.type).toBe('thread-reply');
            expect(btn.customId).toMatch(/^action-thread-123-\d+-\d+$/);
        }

        expect(capturedBody.buttons[0].label).toBe('Yes');
        expect(capturedBody.buttons[0].handler.text).toBe('Yes');
        expect(capturedBody.buttons[1].label).toBe('No');
        expect(capturedBody.buttons[2].label).toBe('Maybe');
    });

    it('generates unique custom IDs per button', async () => {
        let capturedBody: any;
        globalThis.fetch = (async (_url: string, init: any) => {
            capturedBody = JSON.parse(init.body);
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as any;

        const { sendActionButtons } = await import('./worker.js');
        await sendActionButtons('thread-1', ['A', 'B', 'C']);

        const ids = capturedBody.buttons.map((b: any) => b.customId);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(3);
    });

    it('handles API error gracefully (does not throw)', async () => {
        globalThis.fetch = (async () => {
            return new Response('Internal Server Error', { status: 500 });
        }) as any;

        const { sendActionButtons } = await import('./worker.js');
        // Should not throw
        await sendActionButtons('thread-1', ['A']);
    });

    it('handles network error gracefully (does not throw)', async () => {
        globalThis.fetch = (async () => {
            throw new Error('Connection refused');
        }) as any;

        const { sendActionButtons } = await import('./worker.js');
        // Should not throw
        await sendActionButtons('thread-1', ['A']);
    });
});
