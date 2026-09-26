export interface TerminalCell {
    text: string;
    bold: boolean;
    underline: boolean;
    blink: boolean;
    inverse: boolean;
}

export type LineSize = 'normal' | 'double-width' | 'double-top' | 'double-bottom';

export interface TerminalLine {
    cells: readonly TerminalCell[];
    size: LineSize;
    revision: number;
}

export interface TerminalModes {
    ansi: boolean;
    applicationCursor: boolean;
    applicationKeypad: boolean;
    origin: boolean;
    autoWrap: boolean;
    autoRepeat: boolean;
    newLine: boolean;
    smoothScroll: boolean;
    reverseVideo: boolean;
    interlace: boolean;
}

export interface TerminalSettings {
    columns: 80 | 132;
    ansi: boolean;
    autoWrap: boolean;
    autoRepeat: boolean;
    newLine: boolean;
    smoothScroll: boolean;
    reverseVideo: boolean;
    answerback: string;
    tabs: readonly number[];
}

export interface TerminalSnapshot {
    lines: readonly TerminalLine[];
    columns: 80 | 132;
    cursor: { row: number; col: number };
    modes: Readonly<TerminalModes>;
    leds: readonly boolean[];
}

const ROWS = 24;
const MAX_COLUMNS = 132;
const MAX_PARAMETERS = 32;
const MAX_PARAMETER_VALUE = 65_535;
const MAX_SEQUENCE_BYTES = 256;
const STRING_WARNING_BYTES = 4_096;
const DEFAULT_TABS = Object.freeze(Array.from({ length: 16 }, (_, index) => (index + 1) * 8));

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = Object.freeze({
    columns: 80,
    ansi: true,
    autoWrap: true,
    autoRepeat: true,
    newLine: false,
    smoothScroll: false,
    reverseVideo: false,
    answerback: '',
    tabs: DEFAULT_TABS,
});

type Attributes = Omit<TerminalCell, 'text'>;
type CharacterSet = 'us' | 'uk' | 'graphics';
type ParserState = 'ground' | 'escape' | 'csi' | 'csi-ignore'
    | 'string' | 'string-escape' | 'vt52-row' | 'vt52-column';
type WarningKind = 'long-sequence' | 'long-string' | 'eight-bit' | 'alternate-rom'
    | 'baud-report' | 'hardware-test' | 'repeated-test' | 'interlace' | 'reply-loop';

interface MutableLine {
    cells: TerminalCell[];
    size: LineSize;
    revision: number;
}

interface SavedCursor {
    row: number;
    col: number;
    attributes: Attributes;
    g0: CharacterSet;
    g1: CharacterSet;
    activeSet: 0 | 1;
    vt52Graphics: boolean;
    origin: boolean;
    autoWrap: boolean;
    wrapPending: boolean;
}

interface TransportParameters {
    baudRate: number;
    dataBits: 7 | 8;
    parity: 'none' | 'even' | 'odd';
    softwareFlowControl: boolean;
}

interface TerminalOptions {
    send: (data: Uint8Array) => void;
    bell?: () => void;
    warning?: (message: string) => void;
}

const NORMAL_ATTRIBUTES: Readonly<Attributes> = Object.freeze({
    bold: false, underline: false, blink: false, inverse: false,
});
const BLANK: TerminalCell = Object.freeze({ text: ' ', ...NORMAL_ATTRIBUTES });
const GRAPHICS: Readonly<Record<string, string>> = Object.freeze({
    '_': ' ', '`': '◆', a: '▒', b: '␉', c: '␌', d: '␍', e: '␊', f: '°', g: '±',
    h: '␤', i: '␋', j: '┘', k: '┐', l: '┌', m: '└', n: '┼', o: '⎺', p: '⎻',
    q: '─', r: '⎼', s: '⎽', t: '├', u: '┤', v: '┴', w: '┬', x: '│', y: '≤',
    z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
});
const BAUD_CODES = new Map<number, number>([
    [50, 0], [75, 8], [110, 16], [134.5, 24], [150, 32], [200, 40], [300, 48],
    [600, 56], [1200, 64], [1800, 72], [2000, 80], [2400, 88], [3600, 96],
    [4800, 104], [9600, 112], [19200, 120],
]);

function checkedSettings(settings: TerminalSettings): TerminalSettings {
    if (settings.columns !== 80 && settings.columns !== 132) {
        throw new RangeError('VT100 columns must be 80 or 132.');
    }
    const booleanKeys = [
        'ansi', 'autoWrap', 'autoRepeat', 'newLine', 'smoothScroll', 'reverseVideo',
    ] as const;
    for (const key of booleanKeys) {
        if (typeof settings[key] !== 'boolean') {
            throw new TypeError(`VT100 setting ${key} must be a boolean.`);
        }
    }
    if (typeof settings.answerback !== 'string'
        || settings.answerback.length > 20 || /[^\x00-\x7f]/u.test(settings.answerback)) {
        throw new RangeError('The VT100 answerback must contain at most 20 seven-bit ASCII characters.');
    }
    if (!Array.isArray(settings.tabs) || settings.tabs.length > MAX_COLUMNS
        || settings.tabs.some(tab => !Number.isInteger(tab) || tab < 0 || tab >= MAX_COLUMNS)) {
        throw new RangeError('VT100 tab stops must be zero-based integers from 0 through 131.');
    }
    return Object.freeze({
        columns: settings.columns,
        ansi: settings.ansi,
        autoWrap: settings.autoWrap,
        autoRepeat: settings.autoRepeat,
        newLine: settings.newLine,
        smoothScroll: settings.smoothScroll,
        reverseVideo: settings.reverseVideo,
        answerback: settings.answerback,
        tabs: Object.freeze([...new Set(settings.tabs)].sort((a, b) => a - b)),
    });
}

function initialModes(settings: TerminalSettings): TerminalModes {
    return {
        ansi: settings.ansi,
        applicationCursor: false,
        applicationKeypad: false,
        origin: false,
        autoWrap: settings.autoWrap,
        autoRepeat: settings.autoRepeat,
        newLine: settings.newLine,
        smoothScroll: settings.smoothScroll,
        reverseVideo: settings.reverseVideo,
        interlace: false,
    };
}

export default class VT100 {
    private readonly options: TerminalOptions;
    private powerOnSettings: TerminalSettings;
    private columns: 80 | 132 = 80;
    private lines: MutableLine[] = [];
    private readonly lineViews = new WeakMap<MutableLine, TerminalLine>();
    private revision = 0;
    private row = 0;
    private col = 0;
    private marginTop = 0;
    private marginBottom = ROWS - 1;
    private wrapPending = false;
    private attributes: Attributes = { ...NORMAL_ATTRIBUTES };
    private g0: CharacterSet = 'us';
    private g1: CharacterSet = 'us';
    private activeSet: 0 | 1 = 0;
    private vt52Graphics = false;
    private savedCursor: SavedCursor | undefined;
    private modes = initialModes(DEFAULT_TERMINAL_SETTINGS);
    private tabs = new Set<number>(DEFAULT_TABS);
    private leds = [false, false, false, false];
    private answerback = '';
    private marginBellEnabled = false;
    private unsolicitedReports = false;
    private transport: TransportParameters = {
        baudRate: 19200, dataBits: 8, parity: 'none', softwareFlowControl: false,
    };
    private readonly warnings = new Set<WarningKind>();
    private sendingReply = false;

    private state: ParserState = 'ground';
    private sequenceLength = 0;
    private escapeIntermediates = '';
    private escapeInvalid = false;
    private csiParameters: (number | null)[] = [null];
    private csiPrefix = '';
    private csiIntermediates = '';
    private csiHasParameters = false;
    private csiEnabled = true;
    private stringKind: 'osc' | 'other' = 'other';
    private stringLength = 0;
    private vt52Row = 0;

    constructor(options: TerminalOptions, settings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS) {
        this.options = options;
        this.powerOnSettings = checkedSettings(settings);
        this.reset();
    }

    write(data: Uint8Array): void {
        for (const byte of data) {
            this.accept(byte);
        }
    }

    getSnapshot(): TerminalSnapshot {
        return Object.freeze({
            lines: Object.freeze(this.lines.map(line => this.lineView(line))),
            columns: this.columns,
            cursor: Object.freeze({ row: this.row, col: this.col }),
            modes: this.getModes(),
            leds: Object.freeze(this.leds.slice()),
        });
    }

    getModes(): Readonly<TerminalModes> {
        return Object.freeze({ ...this.modes });
    }

    getSettings(): TerminalSettings {
        return Object.freeze({
            columns: this.columns,
            ansi: this.modes.ansi,
            autoWrap: this.modes.autoWrap,
            autoRepeat: this.modes.autoRepeat,
            newLine: this.modes.newLine,
            smoothScroll: this.modes.smoothScroll,
            reverseVideo: this.modes.reverseVideo,
            answerback: this.answerback,
            tabs: Object.freeze([...this.tabs].sort((a, b) => a - b)),
        });
    }

    configure(settings: TerminalSettings, saveForReset = false): void {
        const next = checkedSettings(settings);
        if (this.columns !== next.columns) {
            this.changeColumns(next.columns);
        }
        if (this.modes.ansi !== next.ansi) {
            this.resetParser();
            this.wrapPending = false;
        }
        if (this.modes.reverseVideo !== next.reverseVideo) {
            this.touchAllLines();
        }
        this.modes.ansi = next.ansi;
        this.modes.autoWrap = next.autoWrap;
        this.modes.autoRepeat = next.autoRepeat;
        this.modes.newLine = next.newLine;
        this.modes.smoothScroll = next.smoothScroll;
        this.modes.reverseVideo = next.reverseVideo;
        this.answerback = next.answerback;
        this.tabs = new Set(next.tabs);
        if (!next.autoWrap) {
            this.wrapPending = false;
        }
        this.clampCursor();
        if (saveForReset) {
            this.powerOnSettings = next;
        }
        // Committing SET-UP is the VT100's occasion for an enabled unsolicited report.
        if (this.unsolicitedReports) {
            this.reportParameters();
        }
    }

    reset(): void {
        const settings = this.powerOnSettings;
        this.columns = settings.columns;
        this.modes = initialModes(settings);
        this.row = 0;
        this.col = 0;
        this.marginTop = 0;
        this.marginBottom = ROWS - 1;
        this.wrapPending = false;
        this.attributes = { ...NORMAL_ATTRIBUTES };
        this.g0 = 'us';
        this.g1 = 'us';
        this.activeSet = 0;
        this.vt52Graphics = false;
        this.tabs = new Set(settings.tabs);
        this.answerback = settings.answerback;
        this.leds = [false, false, false, false];
        this.unsolicitedReports = false;
        this.resetParser();
        this.lines = Array.from({ length: ROWS }, () => this.blankLine());
        this.saveCursor();
        if (this.transport.softwareFlowControl) {
            this.reply('\x11');
        }
    }

    setTab(): void {
        this.tabs.add(this.col);
    }

    clearTab(): void {
        this.tabs.delete(this.col);
    }

    clearAllTabs(): void {
        this.tabs.clear();
    }

    resetTabs(): void {
        this.tabs = new Set(DEFAULT_TABS);
    }

    setMarginBell(enabled: boolean): void {
        this.marginBellEnabled = enabled;
    }

    setTransportParameters(settings: TransportParameters): void {
        if (!Number.isFinite(settings.baudRate) || settings.baudRate <= 0
            || settings.baudRate > Number.MAX_SAFE_INTEGER) {
            throw new RangeError('The transport baud rate must be a positive, finite number.');
        }
        if ((settings.dataBits !== 7 && settings.dataBits !== 8)
            || !['none', 'even', 'odd'].includes(settings.parity)
            || typeof settings.softwareFlowControl !== 'boolean') {
            throw new RangeError('Invalid VT100 transport data bits, parity, or software flow control.');
        }
        this.transport = {
            baudRate: settings.baudRate,
            dataBits: settings.dataBits,
            parity: settings.parity,
            softwareFlowControl: settings.softwareFlowControl,
        };
    }

    private accept(byte: number): void {
        if (byte === 0x18 || byte === 0x1a) {
            if (this.state !== 'ground') {
                this.resetParser();
                this.putCharacter('▒');
            }
            return;
        }
        if (this.state === 'string' || this.state === 'string-escape') {
            this.acceptString(byte);
            return;
        }
        if (byte === 0x1b) {
            this.resetParser();
            this.state = 'escape';
            return;
        }
        if (byte < 0x20) {
            this.control(byte);
            return;
        }
        if (byte === 0x7f) {
            return;
        }
        if (byte >= 0x80) {
            this.warn('eight-bit', 'VT100 expects seven-bit ASCII, but the host sent eight-bit data (often UTF-8). Use an ASCII locale on the host, e.g. export LC_ALL=C at a Linux shell prompt. Unsupported eight-bit input is ignored.');
            if (byte === 0x9b) {
                this.beginCSI(false);
            } else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(byte)) {
                this.beginString(byte === 0x9d ? 'osc' : 'other');
            } else if (this.state === 'csi') {
                this.state = 'csi-ignore';
            } else if (this.state === 'escape') {
                this.escapeInvalid = true;
            }
            return;
        }
        switch (this.state) {
            case 'ground':
                this.putByte(byte);
                break;
            case 'escape':
                this.acceptEscape(byte);
                break;
            case 'csi':
            case 'csi-ignore':
                this.acceptCSI(byte);
                break;
            case 'vt52-row':
                this.vt52Row = Math.min(ROWS - 1, byte - 0x20);
                this.state = 'vt52-column';
                break;
            case 'vt52-column':
                this.state = 'ground';
                this.row = this.vt52Row;
                this.col = Math.min(this.lineWidth(this.row) - 1, byte - 0x20);
                this.wrapPending = false;
                break;
        }
    }

    private control(byte: number): void {
        switch (byte) {
            case 0x05:
                this.reply(this.answerback);
                break;
            case 0x07:
                this.options.bell?.();
                break;
            case 0x08:
                this.col = Math.max(0, this.col - 1);
                this.wrapPending = false;
                break;
            case 0x09:
                this.moveTabs(1, 1);
                break;
            case 0x0a:
            case 0x0b:
            case 0x0c:
                if (this.modes.newLine) {
                    this.col = 0;
                }
                this.index(1);
                break;
            case 0x0d:
                this.col = 0;
                this.wrapPending = false;
                break;
            case 0x0e:
                this.activeSet = 1;
                break;
            case 0x0f:
                this.activeSet = 0;
                break;
            // XON/XOFF belong to the transport. Other undefined C0 controls are ignored.
        }
    }

    private acceptEscape(byte: number): void {
        if (++this.sequenceLength > MAX_SEQUENCE_BYTES) {
            this.escapeInvalid = true;
            this.warn('long-sequence', 'An overlong VT100 control sequence was discarded.');
            this.sequenceLength = MAX_SEQUENCE_BYTES + 1;
        }
        if (byte >= 0x20 && byte <= 0x2f) {
            if (this.escapeIntermediates.length < 2) {
                this.escapeIntermediates += String.fromCharCode(byte);
            } else {
                this.escapeInvalid = true;
            }
            return;
        }
        this.state = 'ground';
        if (this.escapeInvalid) {
            return;
        }
        const final = String.fromCharCode(byte);
        const intermediate = this.escapeIntermediates;
        if (intermediate === '') {
            if (final === '[') {
                this.beginCSI(this.modes.ansi);
            } else if (final === ']') {
                this.beginString('osc');
            } else if (this.modes.ansi && ['P', 'X', '^', '_'].includes(final)) {
                this.beginString('other');
            } else if (this.modes.ansi) {
                this.ansiEscape(final);
            } else {
                this.vt52Escape(final);
            }
        } else if (this.modes.ansi && (intermediate === '(' || intermediate === ')')) {
            this.designate(intermediate === '(' ? 0 : 1, final);
        } else if (this.modes.ansi && intermediate === '#') {
            switch (final) {
                case '3': this.changeLineSize('double-top'); break;
                case '4': this.changeLineSize('double-bottom'); break;
                case '5': this.changeLineSize('normal'); break;
                case '6': this.changeLineSize('double-width'); break;
                case '8': this.alignmentDisplay(); break;
            }
        }
    }

    private ansiEscape(final: string): void {
        switch (final) {
            case 'D': this.index(1); break;
            case 'E': this.col = 0; this.index(1); break;
            case 'M': this.index(-1); break;
            case 'H': this.setTab(); break;
            case '7': this.saveCursor(); break;
            case '8': this.restoreCursor(); break;
            case 'Z': this.reply('\x1b[?1;2c'); break;
            case 'c': this.reset(); break;
            case '=': this.modes.applicationKeypad = true; break;
            case '>': this.modes.applicationKeypad = false; break;
        }
    }

    private vt52Escape(final: string): void {
        switch (final) {
            case 'A': this.moveVertical(-1); break;
            case 'B': this.moveVertical(1); break;
            case 'C': this.moveHorizontal(1); break;
            case 'D': this.moveHorizontal(-1); break;
            case 'F': this.vt52Graphics = true; break;
            case 'G': this.vt52Graphics = false; break;
            case 'H': this.position(1, 1); break;
            case 'I': this.index(-1); break;
            case 'J': this.eraseDisplay(0); break;
            case 'K': this.eraseLine(0); break;
            case 'Y': this.state = 'vt52-row'; break;
            case 'Z': this.reply('\x1b/Z'); break;
            case '=': this.modes.applicationKeypad = true; break;
            case '>': this.modes.applicationKeypad = false; break;
            case '<':
                this.modes.ansi = true;
                this.wrapPending = false;
                this.clampCursor();
                break;
        }
    }

    private beginCSI(enabled: boolean): void {
        this.state = 'csi';
        this.sequenceLength = 0;
        this.csiParameters = [null];
        this.csiPrefix = '';
        this.csiIntermediates = '';
        this.csiHasParameters = false;
        this.csiEnabled = enabled;
    }

    private acceptCSI(byte: number): void {
        if (++this.sequenceLength > MAX_SEQUENCE_BYTES) {
            this.state = 'csi-ignore';
            this.sequenceLength = MAX_SEQUENCE_BYTES + 1;
            this.warn('long-sequence', 'An overlong VT100 control sequence was discarded.');
        }
        if (byte >= 0x40 && byte <= 0x7e) {
            const execute = this.state === 'csi' && this.csiEnabled && this.csiIntermediates === '';
            this.state = 'ground';
            if (execute) {
                this.executeCSI(String.fromCharCode(byte));
            }
            return;
        }
        if (this.state === 'csi-ignore') {
            return;
        }
        if (byte >= 0x20 && byte <= 0x2f) {
            if (this.csiIntermediates.length < 2) {
                this.csiIntermediates += String.fromCharCode(byte);
            } else {
                this.state = 'csi-ignore';
            }
            return;
        }
        if (this.csiIntermediates !== '') {
            this.state = 'csi-ignore';
        } else if (byte >= 0x30 && byte <= 0x39) {
            this.csiHasParameters = true;
            const index = this.csiParameters.length - 1;
            this.csiParameters[index] = Math.min(
                MAX_PARAMETER_VALUE, (this.csiParameters[index] ?? 0) * 10 + byte - 0x30,
            );
        } else if (byte === 0x3b) {
            this.csiHasParameters = true;
            if (this.csiParameters.length < MAX_PARAMETERS) {
                this.csiParameters.push(null);
            } else {
                this.state = 'csi-ignore';
                this.warn('long-sequence', 'A VT100 control sequence with too many parameters was discarded.');
            }
        } else if (byte >= 0x3c && byte <= 0x3f && !this.csiHasParameters && this.csiPrefix === '') {
            this.csiPrefix = String.fromCharCode(byte);
        } else {
            this.state = 'csi-ignore';
        }
    }

    private executeCSI(final: string): void {
        const params = this.csiParameters;
        const value = (index: number, fallback: number): number => params[index] || fallback;
        if (final === 'h' || final === 'l') {
            if (this.csiPrefix === '' || this.csiPrefix === '?') {
                this.setModes(params, this.csiPrefix === '?', final === 'h');
            }
            return;
        }
        if (this.csiPrefix !== '') {
            return;
        }
        switch (final) {
            case 'A': this.moveVertical(-value(0, 1)); break;
            case 'B':
            case 'e': this.moveVertical(value(0, 1)); break;
            case 'C':
            case 'a': this.moveHorizontal(value(0, 1)); break;
            case 'D': this.moveHorizontal(-value(0, 1)); break;
            case 'E': this.moveVertical(value(0, 1)); this.col = 0; break;
            case 'F': this.moveVertical(-value(0, 1)); this.col = 0; break;
            case 'G':
            case '`':
                this.col = Math.min(this.lineWidth(this.row) - 1, value(0, 1) - 1);
                this.wrapPending = false;
                break;
            case 'H':
            case 'f': this.position(value(0, 1), value(1, 1)); break;
            case 'd': this.position(value(0, 1), this.col + 1); break;
            case 'I': this.moveTabs(value(0, 1), 1); break;
            case 'Z': this.moveTabs(value(0, 1), -1); break;
            case 'J': for (const param of params) this.eraseDisplay(param ?? 0); break;
            case 'K': for (const param of params) this.eraseLine(param ?? 0); break;
            case '@': this.editCharacters(value(0, 1), 'insert'); break;
            case 'P': this.editCharacters(value(0, 1), 'delete'); break;
            case 'X': this.editCharacters(value(0, 1), 'erase'); break;
            case 'L':
            case 'M':
                if (this.row >= this.marginTop && this.row <= this.marginBottom) {
                    this.scroll(this.row, this.marginBottom, value(0, 1), final === 'M' ? 1 : -1);
                    this.wrapPending = false;
                    this.clampCursor();
                }
                break;
            case 'S':
            case 'T':
                this.scroll(this.marginTop, this.marginBottom, value(0, 1), final === 'S' ? 1 : -1);
                this.wrapPending = false;
                this.clampCursor();
                break;
            case 'c':
                if (params.length === 1 && (params[0] ?? 0) === 0) {
                    this.reply('\x1b[?1;2c');
                }
                break;
            case 'g':
                for (const param of params) {
                    if ((param ?? 0) === 0) this.clearTab();
                    else if (param === 3) this.clearAllTabs();
                }
                break;
            case 'm': this.rendition(params); break;
            case 'n':
                for (const param of params) {
                    if (param === 5) this.reply('\x1b[0n');
                    else if (param === 6) {
                        const row = this.row - (this.modes.origin ? this.marginTop : 0) + 1;
                        this.reply(`\x1b[${row};${this.col + 1}R`);
                    }
                }
                break;
            case 'q':
                for (const param of params) {
                    if ((param ?? 0) === 0) this.leds.fill(false);
                    else if (param !== null && param >= 1 && param <= 4) this.leds[param - 1] = true;
                }
                break;
            case 'r':
                if (params.length <= 2) this.setMargins(value(0, 1), value(1, ROWS));
                break;
            case 'x':
                if (params.length === 1 && ((params[0] ?? 0) === 0 || params[0] === 1)) {
                    this.unsolicitedReports = (params[0] ?? 0) === 0;
                    this.reportParameters();
                }
                break;
            case 'y':
                if (params.length <= 2 && params[0] === 2) {
                    this.confidenceTest(params[1] ?? 0);
                }
                break;
            // CSI s/t are not VT100 line-rotation commands; unsupported finals do nothing.
        }
    }

    private beginString(kind: 'osc' | 'other'): void {
        this.state = 'string';
        this.stringKind = kind;
        this.stringLength = 0;
    }

    private acceptString(byte: number): void {
        if (byte === 0x9c || (this.state === 'string-escape' && byte === 0x5c)
            || (this.stringKind === 'osc' && byte === 0x07)) {
            this.resetParser();
            return;
        }
        // Unsupported strings are never stored or executed, even when they contain ESC.
        this.stringLength = Math.min(STRING_WARNING_BYTES + 1, this.stringLength + 1);
        if (this.stringLength > STRING_WARNING_BYTES) {
            this.warn('long-string', 'An overlong unsupported terminal string is being discarded until its terminator.');
        }
        this.state = byte === 0x1b ? 'string-escape' : 'string';
    }

    private resetParser(): void {
        this.state = 'ground';
        this.sequenceLength = 0;
        this.escapeIntermediates = '';
        this.escapeInvalid = false;
        this.csiParameters = [null];
        this.csiPrefix = '';
        this.csiIntermediates = '';
        this.csiHasParameters = false;
        this.stringLength = 0;
    }

    private putByte(byte: number): void {
        let text = String.fromCharCode(byte);
        const set = this.modes.ansi ? (this.activeSet === 0 ? this.g0 : this.g1)
            : (this.vt52Graphics ? 'graphics' : 'us');
        if (set === 'graphics') text = GRAPHICS[text] ?? text;
        else if (set === 'uk' && text === '#') text = '£';
        this.putCharacter(text);
    }

    private putCharacter(text: string): void {
        if (this.wrapPending && this.modes.autoWrap) {
            this.col = 0;
            this.index(1);
        }
        this.wrapPending = false;
        const line = this.lineAt(this.row);
        line.cells[this.col] = Object.freeze({ text, ...this.attributes });
        this.touch(line);
        const previousColumn = this.col;
        const warningColumn = this.lineWidth(this.row) - 8;
        if (this.col < this.lineWidth(this.row) - 1) {
            this.col++;
        } else {
            this.wrapPending = this.modes.autoWrap;
        }
        if (this.marginBellEnabled && previousColumn < warningColumn && this.col >= warningColumn) {
            this.options.bell?.();
        }
    }

    private lineAt(row: number): MutableLine {
        return this.lines[row]!;
    }

    private lineView(line: MutableLine): TerminalLine {
        const existing = this.lineViews.get(line);
        if (existing) return existing;
        let cellRevision = -1;
        let cells: readonly TerminalCell[] = [];
        // A live row keeps its identity through edits and scrolling; consumers cache revision numbers.
        const view: TerminalLine = Object.freeze({
            get cells(): readonly TerminalCell[] {
                if (cellRevision !== line.revision) {
                    cells = Object.freeze(line.cells.slice());
                    cellRevision = line.revision;
                }
                return cells;
            },
            get size(): LineSize {
                return line.size;
            },
            get revision(): number {
                return line.revision;
            },
        });
        this.lineViews.set(line, view);
        return view;
    }

    private lineWidth(row: number): number {
        return this.lineAt(row).size === 'normal' ? this.columns : this.columns / 2;
    }

    private blankLine(): MutableLine {
        return { cells: Array<TerminalCell>(this.columns).fill(BLANK), size: 'normal', revision: ++this.revision };
    }

    private touch(line: MutableLine): void {
        line.revision = ++this.revision;
    }

    private touchAllLines(): void {
        for (const line of this.lines) this.touch(line);
    }

    private clampCursor(): void {
        const origin = this.modes.ansi && this.modes.origin;
        this.row = Math.max(origin ? this.marginTop : 0, Math.min(origin ? this.marginBottom : ROWS - 1, this.row));
        this.col = Math.max(0, Math.min(this.lineWidth(this.row) - 1, this.col));
    }

    private position(row: number, col: number): void {
        const origin = this.modes.ansi && this.modes.origin;
        this.row = Math.min(origin ? this.marginBottom : ROWS - 1, (origin ? this.marginTop : 0) + row - 1);
        this.col = col - 1;
        this.clampCursor();
        this.wrapPending = false;
    }

    private moveHorizontal(distance: number): void {
        this.col = Math.max(0, Math.min(this.lineWidth(this.row) - 1, this.col + distance));
        this.wrapPending = false;
    }

    private moveVertical(distance: number): void {
        const top = this.modes.ansi && this.row >= this.marginTop ? this.marginTop : 0;
        const bottom = this.modes.ansi && this.row <= this.marginBottom ? this.marginBottom : ROWS - 1;
        this.row = distance < 0 ? Math.max(top, this.row + distance) : Math.min(bottom, this.row + distance);
        this.col = Math.min(this.col, this.lineWidth(this.row) - 1);
        this.wrapPending = false;
    }

    private index(direction: 1 | -1): void {
        const top = this.modes.ansi ? this.marginTop : 0;
        const bottom = this.modes.ansi ? this.marginBottom : ROWS - 1;
        if ((direction === 1 && this.row === bottom) || (direction === -1 && this.row === top)) {
            this.scroll(top, bottom, 1, direction);
        } else {
            this.row = Math.max(0, Math.min(ROWS - 1, this.row + direction));
        }
        this.col = Math.min(this.col, this.lineWidth(this.row) - 1);
        this.wrapPending = false;
    }

    private scroll(top: number, bottom: number, count: number, direction: 1 | -1): void {
        const amount = Math.min(count, bottom - top + 1);
        const blanks = Array.from({ length: amount }, () => this.blankLine());
        if (direction === 1) {
            this.lines.splice(top, amount);
            this.lines.splice(bottom - amount + 1, 0, ...blanks);
        } else {
            this.lines.splice(bottom - amount + 1, amount);
            this.lines.splice(top, 0, ...blanks);
        }
        for (let row = top; row <= bottom; row++) this.touch(this.lineAt(row));
    }

    private moveTabs(count: number, direction: 1 | -1): void {
        const edge = direction === 1 ? this.lineWidth(this.row) - 1 : 0;
        for (let index = 0; index < Math.min(count, MAX_COLUMNS) && this.col !== edge; index++) {
            do {
                this.col += direction;
            } while (this.col !== edge && !this.tabs.has(this.col));
        }
        this.wrapPending = false;
    }

    private erasePart(row: number, first: number, last: number, normalize: boolean): void {
        const line = this.lineAt(row);
        if (normalize) {
            line.cells.fill(BLANK);
            line.size = 'normal';
        } else {
            line.cells.fill(BLANK, first, last + 1);
        }
        this.touch(line);
    }

    private eraseDisplay(mode: number): void {
        if (mode < 0 || mode > 2) return;
        this.wrapPending = false;
        if (mode === 2) {
            for (let row = 0; row < ROWS; row++) this.erasePart(row, 0, this.columns - 1, true);
        } else if (mode === 0) {
            this.erasePart(this.row, this.col, this.lineWidth(this.row) - 1, this.col === 0);
            for (let row = this.row + 1; row < ROWS; row++) this.erasePart(row, 0, this.columns - 1, true);
        } else {
            for (let row = 0; row < this.row; row++) this.erasePart(row, 0, this.columns - 1, true);
            this.erasePart(this.row, 0, this.col, this.col === this.lineWidth(this.row) - 1);
        }
    }

    private eraseLine(mode: number): void {
        if (mode < 0 || mode > 2) return;
        this.wrapPending = false;
        this.erasePart(this.row, mode === 0 ? this.col : 0, mode === 1 ? this.col : this.columns - 1, false);
    }

    private editCharacters(count: number, operation: 'insert' | 'delete' | 'erase'): void {
        const line = this.lineAt(this.row);
        const width = this.lineWidth(this.row);
        const amount = Math.min(count, width - this.col);
        if (operation === 'insert') {
            line.cells.copyWithin(this.col + amount, this.col, width - amount);
            line.cells.fill(BLANK, this.col, this.col + amount);
        } else if (operation === 'delete') {
            line.cells.copyWithin(this.col, this.col + amount, width);
            line.cells.fill(BLANK, width - amount, width);
        } else {
            line.cells.fill(BLANK, this.col, this.col + amount);
        }
        this.wrapPending = false;
        this.touch(line);
    }

    private setMargins(top: number, bottom: number): void {
        if (top < 1 || bottom > ROWS || top >= bottom) return;
        this.marginTop = top - 1;
        this.marginBottom = bottom - 1;
        this.position(1, 1);
    }

    private changeColumns(columns: 80 | 132): void {
        this.columns = columns;
        this.marginTop = 0;
        this.marginBottom = ROWS - 1;
        this.lines = Array.from({ length: ROWS }, () => this.blankLine());
        this.position(1, 1);
    }

    private changeLineSize(size: LineSize): void {
        const line = this.lineAt(this.row);
        if (size !== 'normal') line.cells.fill(BLANK, this.columns / 2);
        line.size = size;
        this.touch(line);
        this.col = Math.min(this.col, this.lineWidth(this.row) - 1);
        this.wrapPending = false;
    }

    private alignmentDisplay(): void {
        const cell: TerminalCell = Object.freeze({ text: 'E', ...NORMAL_ATTRIBUTES });
        for (const line of this.lines) {
            line.cells.fill(cell);
            line.size = 'normal';
            this.touch(line);
        }
        this.marginTop = 0;
        this.marginBottom = ROWS - 1;
        this.position(1, 1);
    }

    private designate(bank: 0 | 1, final: string): void {
        let set: CharacterSet;
        switch (final) {
            case 'A': set = 'uk'; break;
            case 'B': set = 'us'; break;
            case '0': set = 'graphics'; break;
            case '1':
            case '2':
                this.warn('alternate-rom', 'The optional VT100 alternate character ROM is not installed; its character-set designation is ignored.');
                return;
            default: return;
        }
        if (bank === 0) this.g0 = set;
        else this.g1 = set;
    }

    private saveCursor(): void {
        this.savedCursor = {
            row: this.row, col: this.col, attributes: { ...this.attributes },
            g0: this.g0, g1: this.g1, activeSet: this.activeSet, vt52Graphics: this.vt52Graphics,
            origin: this.modes.origin, autoWrap: this.modes.autoWrap, wrapPending: this.wrapPending,
        };
    }

    private restoreCursor(): void {
        const saved = this.savedCursor;
        if (!saved) return;
        this.row = saved.row;
        this.col = saved.col;
        this.attributes = { ...saved.attributes };
        this.g0 = saved.g0;
        this.g1 = saved.g1;
        this.activeSet = saved.activeSet;
        this.vt52Graphics = saved.vt52Graphics;
        this.modes.origin = saved.origin;
        this.modes.autoWrap = saved.autoWrap;
        this.clampCursor();
        this.wrapPending = saved.wrapPending && this.modes.autoWrap && this.col === this.lineWidth(this.row) - 1;
    }

    private rendition(params: readonly (number | null)[]): void {
        for (const param of params) {
            switch (param ?? 0) {
                case 0: this.attributes = { ...NORMAL_ATTRIBUTES }; break;
                case 1: this.attributes.bold = true; break;
                case 4: this.attributes.underline = true; break;
                case 5: this.attributes.blink = true; break;
                case 7: this.attributes.inverse = true; break;
                case 22: this.attributes.bold = false; break;
                case 24: this.attributes.underline = false; break;
                case 25: this.attributes.blink = false; break;
                case 27: this.attributes.inverse = false; break;
            }
        }
    }

    private setModes(params: readonly (number | null)[], privateModes: boolean, enabled: boolean): void {
        for (const param of params) {
            if (!privateModes) {
                if (param === 20) this.modes.newLine = enabled;
                continue;
            }
            switch (param) {
                case 1: this.modes.applicationCursor = enabled; break;
                case 2:
                    this.modes.ansi = enabled;
                    this.wrapPending = false;
                    this.clampCursor();
                    break;
                case 3: this.changeColumns(enabled ? 132 : 80); break;
                case 4: this.modes.smoothScroll = enabled; break;
                case 5:
                    if (this.modes.reverseVideo !== enabled) this.touchAllLines();
                    this.modes.reverseVideo = enabled;
                    break;
                case 6:
                    this.modes.origin = enabled;
                    this.position(1, 1);
                    break;
                case 7:
                    this.modes.autoWrap = enabled;
                    if (!enabled) this.wrapPending = false;
                    break;
                case 8: this.modes.autoRepeat = enabled; break;
                case 9:
                    this.modes.interlace = enabled;
                    if (enabled) this.warn('interlace', 'Interlace mode is retained as terminal state; a browser cannot switch physical CRT scanning.');
                    break;
            }
        }
    }

    private reportParameters(): void {
        let speed = BAUD_CODES.get(this.transport.baudRate);
        if (speed === undefined) {
            speed = 120;
            this.warn('baud-report', `VT100 has no parameter-report encoding for ${this.transport.baudRate} baud. DECREPTPARM reports virtual 19200 baud (120); the actual serial rate is unchanged.`);
        }
        const parity = this.transport.parity === 'none' ? 1 : this.transport.parity === 'odd' ? 4 : 5;
        const bits = this.transport.dataBits === 8 ? 1 : 2;
        this.reply(`\x1b[${this.unsolicitedReports ? 2 : 3};${parity};${bits};${speed};${speed};1;0x`);
    }

    private confidenceTest(tests: number): void {
        if (tests < 0 || tests > 15) return;
        this.reset();
        if ((tests & 7) !== 0) {
            this.warn('hardware-test', 'DECTST reset the emulated terminal. Physical ROM/RAM/NVR, keyboard/AVO, data-loopback and modem tests cannot be performed in a browser; no hardware test pass is reported.');
        }
        if ((tests & 8) !== 0) {
            this.warn('repeated-test', 'DECTST indefinite repetition is not performed; the emulated terminal was reset once.');
        }
    }

    private reply(text: string): void {
        if (text.length === 0) return;
        if (this.sendingReply) {
            this.warn('reply-loop', 'A synchronous terminal-response loop was suppressed. Route device replies to the transport, not back into terminal input.');
            return;
        }
        const bytes = Uint8Array.from(text, character => character.charCodeAt(0));
        this.sendingReply = true;
        try {
            this.options.send(bytes);
        } finally {
            this.sendingReply = false;
        }
    }

    private warn(kind: WarningKind, message: string): void {
        if (this.warnings.has(kind)) return;
        this.warnings.add(kind);
        this.options.warning?.(message);
    }
}
