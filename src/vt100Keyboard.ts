const KEYBOARD_MAP:{[key:string]:string} = {
    'Escape': '\x1b',
    'F1': '\x1bOP',
    'F2': '\x1bOQ',
    'F3': '\x1bOR',
    'F4': '\x1bOS',
    'F5': '\x1bOt',
    'F6': '\x1bOu',
    'F7': '\x1bOv',
    'F8': '\x1bOl',
    'F9': '\x1bOw',
    'F10':'\x1bOx',
    /** No F11 - F12 keys for vt100? */
    'Backquote': '`',
    'Digit1': '1',
    'Digit2': '2',
    'Digit3': '3',
    'Digit4': '4',
    'Digit5': '5',
    'Digit6': '6',
    'Digit7': '7',
    'Digit8': '8',
    'Digit9': '9',
    'Digit0': '0',
    'Minus': '-',
    'Equal': '=',
    'Backspace': '\x08',
    'Tab': '\x09',
    'KeyQ': 'q',
    'KeyW': 'w',
    'KeyE': 'e',
    'KeyR': 'r',
    'KeyT': 't',
    'KeyY': 'y',
    'KeyU': 'u',
    'KeyI': 'i',
    'KeyO': 'o',
    'KeyP': 'p',
    'BracketLeft': '[',
    'BracketRight': ']',
    'Backslash': '\\',
    'KeyA': 'a',
    'KeyS': 's',
    'KeyD': 'd',
    'KeyF': 'f',
    'KeyG': 'g',
    'KeyH': 'h',
    'KeyJ': 'j',
    'KeyK': 'k',
    'KeyL': 'l',
    'Semicolon': ';',
    'Quote': '\'',
    'Enter': '\n',
    'KeyZ': 'z',
    'KeyX': 'x',
    'KeyC': 'c',
    'KeyV': 'v',
    'KeyB': 'b',
    'KeyN': 'n',
    'KeyM': 'm',
    'Comma': ',',
    'Period': '.',
    'Slash': '/',
    'Space': ' ',
    'ArrowUp': '\x1bOA',
    'ArrowDown': '\x1bOB',
    'ArrowLeft': '\x1bOD',
    'ArrowRight': '\x1bOC'
    /** numpad is not implemented yet. */
};

const KEYBOARD_MAP_SHIFT:{[key:string]:string} = {
    'Backquote': '~',
    'Digit1': '!',
    'Digit2': '@',
    'Digit3': '#',
    'Digit4': '$',
    'Digit5': '%',
    'Digit6': '^',
    'Digit7': '&',
    'Digit8': '*',
    'Digit9': '(',
    'Digit0': ')',
    'Minus': '_',
    'Equal': '+',
    'KeyQ': 'Q',
    'KeyW': 'W',
    'KeyE': 'E',
    'KeyR': 'R',
    'KeyT': 'T',
    'KeyY': 'Y',
    'KeyU': 'U',
    'KeyI': 'I',
    'KeyO': 'O',
    'KeyP': 'P',
    'BracketLeft': '{',
    'BracketRight': '}',
    'Backslash': '|',
    'KeyA': 'A',
    'KeyS': 'S',
    'KeyD': 'D',
    'KeyF': 'F',
    'KeyG': 'G',
    'KeyH': 'H',
    'KeyJ': 'J',
    'KeyK': 'K',
    'KeyL': 'L',
    'Semicolon': ':',
    'Quote': '"',
    'KeyZ': 'Z',
    'KeyX': 'X',
    'KeyC': 'C',
    'KeyV': 'V',
    'KeyB': 'B',
    'KeyN': 'N',
    'KeyM': 'M',
    'Comma': '<',
    'Period': '>',
    'Slash': '?'
};

const KEYBOARD_MAP_CTRL:{[key:string]:string} = {
    'Digit2': '\x00',
    'KeyA': '\x01',
    'KeyB': '\x02',
    'KeyC': '\x03',
    'keyD': '\x04',
    'KeyE': '\x05',
    'KeyF': '\x06',
    'KeyG': '\x07',
    'KeyH': '\x08',
    'KeyI': '\x09',
    'KeyJ': '\x0a',
    'KeyK': '\x0b',
    'KeyL': '\x0c',
    'KeyM': '\x0d',
    'KeyN': '\x0e',
    'KeyO': '\x0f',
    'KeyP': '\x10',
    'KeyQ': '\x11',
    'KeyR': '\x12',
    'KeyS': '\x13',
    'KeyT': '\x14',
    'KeyU': '\x15',
    'KeyV': '\x16',
    'KeyW': '\x17',
    'KeyX': '\x18',
    'KeyY': '\x19',
    'KeyZ': '\x1a',
    'Digit3': '\x1b',
    'Digit4': '\x1c',
    'Digit5': '\x1d',
    'Digit6': '\x1e',
    'Digit7': '\x1f',
    'Digit8': '\x7f'
};

class VT100Keyboard {
    private capsLock:boolean = false;
    private shift:boolean = false;
    private ctrl:boolean = false;
    private putc:(char:number)=>void;
    constructor(putc:(char:number)=>void){
        this.putc = putc;
    }
    keyDown(key:string) {
        switch(key){
            case 'CapsLock':
                this.capsLock = !this.capsLock;
                break;
            case 'ShiftLeft':
            case 'ShiftRight':
                this.shift = true;
                break;
            case 'ControlLeft':
            case 'ControlRight':
                this.ctrl = true;
                break;
            /** keys ignored */
            case 'AltLeft':
            case 'AltRight':
            case 'MetaLeft':
                break;
            default:
                let codes:string;
                if(this.ctrl){
                    codes = KEYBOARD_MAP_CTRL[key] ?? KEYBOARD_MAP[key];
                }else if(this.shift !== this.capsLock){
                    codes = KEYBOARD_MAP_SHIFT[key] ?? KEYBOARD_MAP[key];
                }else{
                    codes = KEYBOARD_MAP[key];
                }
                if(codes === undefined){
                    break;
                }
                for(const code of codes){
                    this.putc(code.charCodeAt(0));
                }
                break;
        }
    }
    keyUp(key:string){
        switch(key){
            case 'ShiftLeft':
            case 'ShiftRight':
                this.shift = false;
                break;
            case 'ControlLeft':
            case 'ControlRight':
                this.ctrl = false;
                break;
            case 'AltLeft':
            case 'AltRight':
            case 'MetaLeft':
                break;
            default:
                break;
        }
    }
}

export default VT100Keyboard;
