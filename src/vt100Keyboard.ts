import type { TerminalModes } from './vt100.js';

interface KeyboardHooks {
    warning?: (message: string) => void;
    break?: (long: boolean) => void;
    answerback?: () => void;
    noScroll?: () => void;
    setup?: () => void;
    keyClick?: () => void;
}

const MAX_PASTE_BYTES = 65_536;
const ARROWS: Readonly<Record<string, string>> = Object.freeze({
    ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D',
});
// PC NumLock/Clear, / and * stand in for PF1–PF3; F1–F4 also provide all four PF keys.
const PF_KEYS: Readonly<Record<string, string>> = Object.freeze({
    F1: 'P', F2: 'Q', F3: 'R', F4: 'S',
    NumLock: 'P', NumpadClear: 'P', NumpadDivide: 'Q', NumpadMultiply: 'R',
});
// PC keypad + substitutes the VT100 comma key; keypad - retains the VT100 minus meaning.
const KEYPAD: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
    Numpad0: ['0', 'p'], Numpad1: ['1', 'q'], Numpad2: ['2', 'r'], Numpad3: ['3', 's'],
    Numpad4: ['4', 't'], Numpad5: ['5', 'u'], Numpad6: ['6', 'v'], Numpad7: ['7', 'w'],
    Numpad8: ['8', 'x'], Numpad9: ['9', 'y'], NumpadSubtract: ['-', 'm'],
    NumpadComma: [',', 'l'], NumpadAdd: [',', 'l'], NumpadDecimal: ['.', 'n'],
    NumpadEnter: ['\r', 'M'],
} as const);
// The ncurses vt100 description assigns F5-F10 to these application-keypad keys.
const VT100_FUNCTION_KEYPAD: Readonly<Record<string, string>> = Object.freeze({
    F5: 'Numpad4', F6: 'Numpad5', F7: 'Numpad6',
    F8: 'NumpadComma', F9: 'Numpad7', F10: 'Numpad8',
});
const CONTROL_DIGITS: Readonly<Record<string, number>> = Object.freeze({
    Digit2: 0x00, Digit3: 0x1b, Digit4: 0x1c, Digit5: 0x1d,
    Digit6: 0x1e, Digit7: 0x1f, Digit8: 0x7f,
});

export default class VT100Keyboard {
    private readonly send: (data: Uint8Array) => void;
    private readonly getModes: () => Readonly<TerminalModes>;
    private readonly hooks: KeyboardHooks;
    private readonly warnings = new Set<'character' | 'break' | 'no-scroll'>();

    constructor(
        send: (data: Uint8Array) => void,
        getModes: () => Readonly<TerminalModes>,
        hooks: KeyboardHooks = {},
    ) {
        this.send = send;
        this.getModes = getModes;
        this.hooks = hooks;
    }

    keyDown(event: KeyboardEvent): boolean {
        if (event.defaultPrevented || event.metaKey || event.altKey || event.getModifierState('AltGraph')) {
            return false;
        }
        if (event.isComposing || event.key === 'Dead' || event.key === 'Process') {
            this.warn('character', 'VT100 keyboard input supports seven-bit ASCII only; composed input is not supported.');
            return false;
        }
        const modes = this.getModes();
        const code = event.code || this.fallbackCode(event);
        const key = event.key;

        if (code === 'Pause' || code === 'Break' || key === 'Pause' || key === 'Break'
            || (event.ctrlKey && key === 'Cancel')) {
            if (event.ctrlKey) {
                if (!this.hooks.answerback) return false;
                if (!event.repeat) this.hooks.answerback();
            } else if (!event.repeat) {
                if (this.hooks.break) this.hooks.break(event.shiftKey);
                else this.warn('break', 'BREAK is unavailable because no serial BREAK handler is connected.');
            }
            return true;
        }
        if (!event.ctrlKey && (code === 'ScrollLock' || key === 'ScrollLock')) {
            if (event.repeat) return true;
            if (this.hooks.noScroll) this.hooks.noScroll();
            else this.warn('no-scroll', 'NO SCROLL is unavailable because no flow-control handler is connected.');
            return true;
        }
        // F12 is the browser-accessible SET-UP key.
        if (!event.ctrlKey && (code === 'F12' || key === 'F12') && this.hooks.setup) {
            if (!event.repeat) this.hooks.setup();
            return true;
        }

        let sequence: string | undefined;
        let repeatable = !event.ctrlKey;
        const pf = PF_KEYS[code] ?? PF_KEYS[key];
        const functionKeypad = modes.ansi
            ? VT100_FUNCTION_KEYPAD[code] ?? VT100_FUNCTION_KEYPAD[key] : undefined;
        const keypad = KEYPAD[functionKeypad ?? code];
        if (pf !== undefined) {
            sequence = `${modes.ansi ? '\x1bO' : '\x1b'}${pf}`;
        } else if (keypad !== undefined) {
            sequence = modes.applicationKeypad || functionKeypad !== undefined
                ? `${modes.ansi ? '\x1bO' : '\x1b?'}${keypad[1]}`
                : keypad[0] === '\r' ? this.returnSequence(modes) : keypad[0];
        } else if (code === 'NumpadEqual') {
            // This modern extra key has no VT100 application code; retain its literal ASCII value.
            if (event.ctrlKey) return false;
            sequence = '=';
        } else if (event.ctrlKey) {
            const control = this.controlCode(event);
            if (control === undefined) return false;
            sequence = String.fromCharCode(control);
        } else {
            const arrow = ARROWS[key] ?? ARROWS[code];
            if (arrow !== undefined) {
                // The original VT100 gates DECCKM on DECKPAM, unlike many later terminals.
                const prefix = !modes.ansi ? '\x1b'
                    : modes.applicationKeypad && modes.applicationCursor ? '\x1bO' : '\x1b[';
                sequence = prefix + arrow;
            } else {
                switch (key) {
                    case 'Escape':
                        sequence = '\x1b';
                        repeatable = false;
                        break;
                    case 'Backspace': sequence = '\x08'; break;
                    case 'Delete': sequence = '\x7f'; break;
                    case 'Tab':
                        sequence = '\t';
                        repeatable = false;
                        break;
                    case 'Enter':
                        sequence = this.returnSequence(modes);
                        repeatable = false;
                        break;
                    default:
                        if (key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) <= 0x7e) {
                            sequence = /^[A-Za-z]$/u.test(key)
                                && (event.shiftKey || event.getModifierState('CapsLock')) ? key.toUpperCase() : key;
                        } else if ([...key].length === 1 && (key.codePointAt(0) ?? 0) > 0x7f) {
                            this.warn('character', 'VT100 keyboard input supports seven-bit ASCII only; the non-ASCII character was not sent.');
                            return true;
                        }
                        break;
                }
            }
        }
        if (sequence === undefined) return false;
        if (event.repeat && (!modes.autoRepeat || !repeatable)) return true;
        this.emit(sequence);
        return true;
    }

    paste(text: string): void {
        // CRLF can shrink to one Return, so bound source length without rejecting that case.
        if (text.length > MAX_PASTE_BYTES * 2) {
            throw new RangeError(`Paste exceeds the ${MAX_PASTE_BYTES}-byte VT100 input limit.`);
        }
        for (let index = 0; index < text.length; index++) {
            if (text.charCodeAt(index) > 0x7f) {
                const point = text.codePointAt(index)!.toString(16).toUpperCase().padStart(4, '0');
                throw new RangeError(`VT100 paste requires seven-bit ASCII: unsupported U+${point} at character ${index + 1}. Nothing was sent.`);
            }
        }
        const modes = this.getModes();
        let length = 0;
        for (let index = 0; index < text.length; index++) {
            const byte = text.charCodeAt(index);
            if (byte === 0x0d || byte === 0x0a) {
                length += modes.newLine ? 2 : 1;
                if (byte === 0x0d && text.charCodeAt(index + 1) === 0x0a) index++;
            } else {
                length++;
            }
        }
        if (length > MAX_PASTE_BYTES) {
            throw new RangeError(`Paste exceeds the ${MAX_PASTE_BYTES}-byte VT100 input limit after newline normalization. Nothing was sent.`);
        }
        if (length === 0) return;
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (let index = 0; index < text.length; index++) {
            const byte = text.charCodeAt(index);
            if (byte === 0x0d || byte === 0x0a) {
                bytes[offset++] = 0x0d;
                if (modes.newLine) bytes[offset++] = 0x0a;
                if (byte === 0x0d && text.charCodeAt(index + 1) === 0x0a) index++;
            } else {
                bytes[offset++] = byte;
            }
        }
        this.send(bytes);
    }

    sendLineFeed(): void {
        this.emit('\n');
    }

    private returnSequence(modes: Readonly<TerminalModes>): string {
        return modes.newLine ? '\r\n' : '\r';
    }

    private controlCode(event: KeyboardEvent): number | undefined {
        const key = event.key;
        if (/^[A-Za-z]$/u.test(key)) return key.toUpperCase().charCodeAt(0) - 0x40;
        if (key === ' ' || key === '@' || event.code === 'Space') return 0;
        if (key === '[' || key === '\\' || key === ']' || key === '^' || key === '_') {
            return key.charCodeAt(0) & 0x1f;
        }
        // On the VT100, the ~/` and ?// keys with CTRL generate RS and US, not DEL.
        if (key === '~' || key === '`') return 0x1e;
        if (key === '?' || key === '/') return 0x1f;
        if (/^Key[A-Z]$/u.test(event.code) && key.length !== 1) {
            return event.code.charCodeAt(3) - 0x40;
        }
        return CONTROL_DIGITS[event.code];
    }

    private fallbackCode(event: KeyboardEvent): string {
        if (event.location !== 3) return event.key;
        if (/^[0-9]$/u.test(event.key)) return `Numpad${event.key}`;
        switch (event.key) {
            case 'Enter': return 'NumpadEnter';
            case '.': return 'NumpadDecimal';
            case ',': return 'NumpadComma';
            case '-': return 'NumpadSubtract';
            case '+': return 'NumpadAdd';
            case '/': return 'NumpadDivide';
            case '*': return 'NumpadMultiply';
            case '=': return 'NumpadEqual';
            case 'Clear': return 'NumpadClear';
            default: return event.key;
        }
    }

    private emit(text: string): void {
        this.send(Uint8Array.from(text, character => character.charCodeAt(0)));
        this.hooks.keyClick?.();
    }

    private warn(kind: 'character' | 'break' | 'no-scroll', message: string): void {
        if (this.warnings.has(kind)) return;
        this.warnings.add(kind);
        this.hooks.warning?.(message);
    }
}
