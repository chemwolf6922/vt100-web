import { isAsciiEscapeCode } from "./asciiEscapeCode";

const charSets:{[charSet:string]:{[char:string]:string}} = {
    '(A':{
        '#':'£'
    },
    ')A':{
        '#':'£'
    },
    '(B':{},
    ')B':{},
    '(0':{
        '`':'◆',
        'a':'▒',
        'b':'␉',
        'c':'␌',
        'd':'␍',
        'e':'␊',
        'f':'°',
        'g':'±',
        'h':'␤',
        'i':'␋',
        'j':'┘',
        'k':'┐',
        'l':'┌',
        'm':'└',
        'n':'┼',
        'o':'⎺',
        'p':'⎻',
        'q':'─',
        'r':'⎼',
        's':'⎽',
        't':'├',
        'u':'┤',
        'v':'┴',
        'w':'┬',
        'x':'│',
        'y':'≤',
        'z':'≥',
        '{':'π',
        '|':'≠',
        '}':'£',
        '~':'·'
    },
    ')0':{
        '`':'◆',
        'a':'▒',
        'b':'␉',
        'c':'␌',
        'd':'␍',
        'e':'␊',
        'f':'°',
        'g':'±',
        'h':'␤',
        'i':'␋',
        'j':'┘',
        'k':'┐',
        'l':'┌',
        'm':'└',
        'n':'┼',
        'o':'⎺',
        'p':'⎻',
        'q':'─',
        'r':'⎼',
        's':'⎽',
        't':'├',
        'u':'┤',
        'v':'┴',
        'w':'┬',
        'x':'│',
        'y':'≤',
        'z':'≥',
        '{':'π',
        '|':'≠',
        '}':'£',
        '~':'·'
    },
    '(1':{},
    ')1':{},
    '(2':{},
    ')2':{},
}

class VT100 {
    private putc: (char:number) => void;
    private lines:number;
    private columns:number;
    private buffer:Array<Array<string>>;
    private cursor:{x:number, y:number} = {x:0, y:0};
    private savedCursor:{x:number, y:number} = {x:0, y:0};
    private escapeSequence:Array<number> = [];
    private charSet:string = '(B';
    private scrollRegion:{top:number, bottom:number} = {top:0, bottom:0};
    constructor(putc:(char:number) => void, size?:{lines:number, columns:number}) {
        this.putc = putc;
        this.lines = size?.lines ?? 24;
        this.columns = size?.columns ?? 80;
        this.scrollRegion.top = 0;
        this.scrollRegion.bottom = this.lines - 1;
        this.buffer = new Array<Array<string>>(this.lines);
        for (let i = 0; i < this.lines; i++) {
            this.buffer[i] = new Array<string>(this.columns);
            this.buffer[i].fill('&nbsp;');
        }
    }
    getc(char:number):void {
        if(!this.handleEscapeCode(char)){
            this.drawChar(char);
        }
    }
    private handleScreenScroll():void{
        if(this.cursor.y > this.scrollRegion.bottom){
            this.buffer.splice(this.scrollRegion.top, 1);
            this.buffer.splice(this.scrollRegion.bottom, 0, new Array<string>(this.columns).fill('&nbsp;'));
            this.cursor.y--;
        }
        /** No extra memory on top, thus no scroll up */
    }
    private handleEscapeCode(char:number):boolean{
        if(isAsciiEscapeCode(char) || char >= 0x80){
            this.escapeSequence = [];
            switch (char) {
                /** C0 control codes */
                case '\b'.charCodeAt(0):
                    /**
                     * Move cursor to the left.
                     * This will not move the cursor to the previous line 
                     * if the cursor is already at the leftmost column.
                     */
                    this.cursor.x--;
                    if(this.cursor.x < 0){
                        this.cursor.x = 0;
                    }
                    break;
                case '\t'.charCodeAt(0):
                    /**
                     * Move cursor to the next tab stop.
                     * If the next tab stop is beyond the rightmost column,
                     * move the cursor to the rightmost column.
                     */
                    this.cursor.x = this.cursor.x + 8 - this.cursor.x % 8;
                    if(this.cursor.x >= this.columns){
                        this.cursor.x = this.columns - 1;
                    }
                    break;
                /** Seems the same to \n to me. */
                case '\v'.charCodeAt(0):
                case '\f'.charCodeAt(0):
                case '\n'.charCodeAt(0):
                    /**
                     * Move cursor to the next line.
                     * If the cursor is already at the bottommost line,
                     * scroll the screen up by one line.
                     */
                    this.cursor.y++;
                    this.handleScreenScroll();
                    break;
                case '\r'.charCodeAt(0):
                    /**
                     * Move cursor to the leftmost column.
                     */
                    this.cursor.x = 0;
                    break;
                case 0x0E:
                    /** Switch to an alternative char set */
                    this.charSet = '(0';
                    break;
                case 0x0F:
                    /** Return to regular char set */
                    this.charSet = '(B';
                    break;
                case 0x1b:
                    /** ESC, start of escape codes */
                    this.escapeSequence.push(char);
                    break;
                /** C1 control codes */
                default:
                    break;
            }
            return true;
        }
        if(this.escapeSequence.length === 0){
            return false;
        }
        /** @todo */
        if(this.escapeSequence.length === 1){
            switch(char){
                case '('.charCodeAt(0):
                case ')'.charCodeAt(0):
                case '#'.charCodeAt(0):
                case '5'.charCodeAt(0):
                case '6'.charCodeAt(0):
                case '['.charCodeAt(0):
                    this.escapeSequence.push(char);
                    break;
                case 'D'.charCodeAt(0):
                    /**
                     * Move the text down/ window up one line.
                     */
                    this.buffer.shift();
                    this.buffer.push(new Array<string>(this.columns));
                    this.buffer[this.lines-1].fill('&nbsp;');
                    this.escapeSequence = [];
                    break;
                case 'E'.charCodeAt(0):
                    /**
                     * Move to the next line.
                     */
                    this.cursor.x = 0;
                    this.cursor.y++;
                    this.handleScreenScroll();
                    this.escapeSequence = [];
                    break;
                case '7'.charCodeAt(0):
                    /**
                     * Save the cursor position.
                     */
                    this.savedCursor.x = this.cursor.x;
                    this.savedCursor.y = this.cursor.y;
                    this.escapeSequence = [];
                    break;
                case '8'.charCodeAt(0):
                    /**
                     * Restore the cursor position.
                     */
                    this.cursor.x = this.savedCursor.x;
                    this.cursor.y = this.savedCursor.y;
                    this.escapeSequence = [];
                    break;
                case 'c'.charCodeAt(0):
                    /**
                     * Set the terminal to the initial state.
                     */
                    for(const line of this.buffer){
                        line.fill('&nbsp;');
                    }
                    this.cursor.x = 0;
                    this.cursor.y = 0;
                    this.charSet = '(B';
                    this.scrollRegion.top = 0;
                    this.scrollRegion.bottom = this.lines - 1;
                    this.escapeSequence = [];
                    break;
                default:
                    /** ignored single byte escape codes */
                    this.escapeSequence = [];
                    break;
            }
            return true;
        }
        switch(this.escapeSequence[1]){
            case '('.charCodeAt(0):
            case ')'.charCodeAt(0):
                const charSetIndex = String.fromCharCode(this.escapeSequence[1], char);
                if(charSetIndex in charSets){
                    this.charSet = charSetIndex;
                }
                this.escapeSequence = [];
                return true;
            case '#'.charCodeAt(0):
                /** ignored */
                this.escapeSequence = [];
                return true;
            case '5'.charCodeAt(0):
                /** Device status report */
                if(char === 'n'.charCodeAt(0)){
                    /** terminal is OK */
                    this.puts('\x1b[0n');
                }
                this.escapeSequence = [];
                return true;
            case '6'.charCodeAt(0):
                /** Get cursor position */
                if(char === 'n'.charCodeAt(0)){
                    this.puts(`\x1b${this.cursor.y+1};${this.cursor.x+1}R`);
                }
                this.escapeSequence = [];
                return true;
            default:
                /** @todo there might be more that need to be ignored */
                break;
        }
        if(char < 0x40){
            /** add to the CSI escape sequence */
            this.escapeSequence.push(char);
            return true;
        }
        /** final bytes */
        switch (char){
            case '@'.charCodeAt(0):{
                /** Insert characters */
                const n = this.getCSIParams()[0] ?? 1;
                for(let i = this.columns - 1; i >= this.cursor.x; i--){
                    if(i-n >= this.cursor.x){
                        this.buffer[this.cursor.y][i] = this.buffer[this.cursor.y][i-n];
                    }else{
                        this.buffer[this.cursor.y][i] = '&nbsp;';
                    }
                }
            } break;
            case 'A'.charCodeAt(0):{
                /** Move cursor up. */
                const params = this.getCSIParams();
                const n = params[0] ?? 1;
                this.cursor.y -= n;
                if(this.cursor.y < 0){
                    this.cursor.y = 0;
                }
            } break;
            case 'B'.charCodeAt(0):{
                /** Move cursor down. */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.y += n;
                while(this.cursor.y > this.scrollRegion.bottom){
                    this.handleScreenScroll();
                }
            } break;
            case 'C'.charCodeAt(0):
            case 'a'.charCodeAt(0):{
                /** Move cursor right. */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.x += n;
                if(this.cursor.x >= this.columns){
                    this.cursor.x = this.columns - 1;
                }
            } break;
            case 'D'.charCodeAt(0):{
                /** Move cursor left. */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.x -= n;
                if(this.cursor.x < 0){
                    this.cursor.x = 0;
                }
            } break;
            case 'E'.charCodeAt(0):{
                /** Move cursor down to begining of the line */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.y += n;
                this.cursor.x = 0;
                while(this.cursor.y > this.scrollRegion.bottom){
                    this.handleScreenScroll();
                }
            } break;
            case 'F'.charCodeAt(0):{
                /** Move cursor up to begining of the line */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.y -= n;
                this.cursor.x = 0;
                if(this.cursor.y < 0){
                    this.cursor.y = 0;
                }
            } break;
            case 'G'.charCodeAt(0):
            case '`'.charCodeAt(0):{
                /** Move cursor to the column */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.x = n - 1;
                if(this.cursor.x < 0){
                    this.cursor.x = 0;
                }
                if(this.cursor.x >= this.columns){
                    this.cursor.x = this.columns - 1;
                }
            } break;
            case 'H'.charCodeAt(0):
            case 'f'.charCodeAt(0):{
                /** Set the cursor position */
                const params = this.getCSIParams();
                const y = params[0] ?? 1;
                const x = params[1] ?? 1;
                this.cursor.x = x - 1;
                if(this.cursor.x < 0){
                    this.cursor.x = 0;
                }
                if(this.cursor.x >= this.columns){
                    this.cursor.x = this.columns - 1;
                }
                this.cursor.y = y - 1;
                if(this.cursor.y < 0){
                    this.cursor.y = 0;
                }
                if(this.cursor.y >= this.lines){
                    this.cursor.y = this.lines - 1;
                }
            } break;
            case 'I'.charCodeAt(0):{
                /** Move the cursor n tabs ahead */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.x = this.cursor.x + 8 * n - this.cursor.x % 8;
                if(this.cursor.x >= this.columns){
                    this.cursor.x = this.columns - 1;
                }
            } break;
            case 'J'.charCodeAt(0):{
                /** Erase in display */
                const mode = this.getCSIParams()[0] ?? 0;
                switch (mode) {
                    case 0:
                        /** Erase from the cursor to the end of the page */
                        for(let i = this.cursor.x; i < this.columns; i++){
                            this.buffer[this.cursor.y][i] = '&nbsp;';
                        }
                        for(let i = this.cursor.y + 1; i < this.lines; i++){
                            this.buffer[i].fill('&nbsp;');
                        }
                        break;
                    case 1:
                        /** Erase from the cursor to the begining of the page */
                        for(let i = this.cursor.x - 1; i >= 0; i--){
                            this.buffer[this.cursor.y][i] = '&nbsp;';
                        }
                        for(let i = this.cursor.y - 1; i >= 0; i--){
                            this.buffer[i].fill('&nbsp;');
                        }
                        break;
                    case 2:
                        /** Erase the entire display */
                        for(const line of this.buffer){
                            line.fill('&nbsp;');
                        }
                        break;
                    default:
                        break;
                }
            } break;
            case 'K'.charCodeAt(0):{
                /** Erase in line */
                const mode = this.getCSIParams()[0] ?? 0;
                switch (mode) {
                    case 0:
                        /** Erase from the cursor to the end of the line */
                        for(let i = this.cursor.x; i < this.columns; i++){
                            this.buffer[this.cursor.y][i] = '&nbsp;';
                        }
                        break;
                    case 1:
                        /** Erase from the cursor to the begining of the line */
                        for(let i = this.cursor.x - 1; i >= 0; i--){
                            this.buffer[this.cursor.y][i] = '&nbsp;';
                        }
                        break;
                    case 2:
                        /** Erase the entire line */
                        this.buffer[this.cursor.y].fill('&nbsp;');
                        break;
                    default:
                        break;
                }
            } break;
            case 'L'.charCodeAt(0):{
                /** Insert lines */
                let n = this.getCSIParams()[0] ?? 1;
                n = Math.min(n, this.lines - this.cursor.y);
                for(let i = 0; i < n; i++){
                    this.buffer.splice(this.cursor.y, 0, new Array<string>(this.columns));
                    this.buffer[this.cursor.y].fill('&nbsp;');
                }
                this.buffer.splice(this.lines, n);
            } break;
            case 'M'.charCodeAt(0):{
                /** Delete lines */
                let n = this.getCSIParams()[0] ?? 1;
                n = Math.min(n, this.lines - this.cursor.y);
                this.buffer.splice(this.cursor.y, n);
                for(let i = 0; i < n; i++){
                    this.buffer.push(new Array<string>(this.columns).fill('&nbsp;'));
                }
            } break;
            case 'N'.charCodeAt(0):{
                /** Erase in filed */
            } break;
            case 'O'.charCodeAt(0):{
                /** Erase in aera */
            } break;
            case 'P'.charCodeAt(0):{
                /** Delete characters */
                const n = this.getCSIParams()[0] ?? 1;
                for(let i = this.cursor.x; i < this.columns; i++){
                    if(i+n < this.columns){
                        this.buffer[this.cursor.y][i] = this.buffer[this.cursor.y][i+n];
                    }else{
                        this.buffer[this.cursor.y][i] = '&nbsp;';
                    }
                }
            } break;
            case 'S'.charCodeAt(0):{
                /** Move the displayed text up/ windows down */
                const n = this.getCSIParams()[0] ?? 1;
                for(let i = 0; i < n; i++){
                    this.buffer.shift();
                    this.buffer.push(new Array<string>(this.columns));
                    this.buffer[this.lines-1].fill('&nbsp;');
                }
            } break;
            case 'T'.charCodeAt(0):{
                /** Move the displayed text down/ windows up */
                /** ignored since we do not have extra memory (nothing on top) now. */
                // const n = this.getCSIParams()[0] ?? 1;
                // for(let i = 0; i < n; i++){
                //     this.buffer.unshift(new Array<string>(this.columns));
                //     this.buffer.pop();
                //     this.buffer[0].fill('&nbsp;');
                // }
            } break;
            case 'X'.charCodeAt(0):{
                /** Erase characters */
                const n = this.getCSIParams()[0] ?? 1;
                for(let i = this.cursor.x; i < this.cursor.x + n && i < this.columns; i++){
                    this.buffer[this.cursor.y][i] = '&nbsp;';
                }
            } break;
            case 'Z'.charCodeAt(0):{
                /** Move the cursor n tabs backward */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.x = this.cursor.x - 8 * n + (8 - this.cursor.x % 8) % 8;
                if(this.cursor.x < 0){
                    this.cursor.x = 0;
                }
            } break;
            case 'd'.charCodeAt(0):{
                /** Move cursor to the line */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.y = n - 1;
                if(this.cursor.y < 0){
                    this.cursor.y = 0;
                }
                if(this.cursor.y >= this.lines){
                    this.cursor.y = this.lines - 1;
                }
            } break;
            case 'e'.charCodeAt(0):{
                /** Move cursor n lines down */
                const n = this.getCSIParams()[0] ?? 1;
                this.cursor.y += n;
                if(this.cursor.y >= this.lines){
                    this.cursor.y = this.lines - 1;
                }
            } break;
            case 'm'.charCodeAt(0):
                /** @todo */
                break;
            case 'r'.charCodeAt(0):{
                /** Set scroll region */
                const params = this.getCSIParams();
                const top = params[0] ?? 1;
                const bottom = params[1] ?? this.lines;
                if(top > bottom){
                    break;
                }
                this.scrollRegion.top = top - 1;
                this.scrollRegion.bottom = bottom - 1;
            } break;
            case 's'.charCodeAt(0):{
                /** Push line. Move n lines from this line to the bottom. Pushing the original bottom lines up. */
                let n = this.getCSIParams()[0] ?? 1;
                n = Math.min(n, this.lines - this.cursor.y);
                for(let i = 0; i < n; i++){
                    this.buffer.push(...this.buffer.splice(this.cursor.y, 1));
                }
            } break;
            case 't'.charCodeAt(0):{
                /** Pop line. Move n lines from the bottom the this line. Pushing the original lines down */
                let n = this.getCSIParams()[0] ?? 1;
                n = Math.min(n, this.lines - this.cursor.y);
                for(let i = 0; i < n; i++){
                    const line = this.buffer.pop() ?? new Array<string>(this.columns).fill('&nbsp;');
                    this.buffer.splice(this.cursor.y, 0, line);
                }
            } break;
            default:
                /** ignored */
                break;
        }
        this.escapeSequence = [];
        return true;
    }
    private drawChar(char:number):void{
        let charStr = String.fromCharCode(char);
        charStr = charSets[this.charSet]?.[charStr] ?? charStr;
        /** escape for html */
        charStr = {
            ' ': '&nbsp;',
            '<': '&lt;',
            '>': '&gt;',
            '&': '&amp;',
        }[charStr] ?? charStr;
        this.buffer[this.cursor.y][this.cursor.x] = charStr;
        this.cursor.x++;
        if (this.cursor.x >= this.columns) {
            this.cursor.x = 0;
            this.cursor.y++;
        }
        this.handleScreenScroll();
    }
    private puts(str:string):void{
        for(const char of str){
            this.putc(char.charCodeAt(0));
        }
    }
    private getCSIParams():Array<number>{
        const escapeStr = String.fromCharCode(...this.escapeSequence);
        return escapeStr.slice(2).split(';').filter(s=>s!=='').map(s=>parseInt(s));
    }
    getBuffer():string {
        let buffer = '';
        for(let i = 0; i < this.buffer.length; i++){
            for(let j = 0; j < this.buffer[i].length; j++){
                if(i === this.cursor.y && j === this.cursor.x){
                    buffer += '<span class="cursor">|</span>';
                }
                buffer += this.buffer[i][j];
            }
            if(i !== this.buffer.length - 1){
                buffer += '<br>';
            }
        }
        return buffer;
    }
}

export default VT100;