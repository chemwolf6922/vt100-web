const asciiEscapeCodes:{[key:number]:string} = {
    0x00:'\\0',
    0x01:'\\x01',
    0x02:'\\x02',
    0x03:'\\x03',
    0x04:'\\x04',
    0x05:'\\x05',
    0x06:'\\x06',
    0x07:'\\x07',
    0x08:'\\b',
    0x09:'\\t',
    0x0a:'\\n',
    0x0b:'\\v',
    0x0c:'\\f',
    0x0d:'\\r',
    0x0e:'\\x0e',
    0x0f:'\\x0f',
    0x10:'\\x10',
    0x11:'\\x11',
    0x12:'\\x12',
    0x13:'\\x13',
    0x14:'\\x14',
    0x15:'\\x15',
    0x16:'\\x16',
    0x17:'\\x17',
    0x18:'\\x18',
    0x19:'\\x19',
    0x1a:'\\x1a',
    0x1b:'^[',
    0x1c:'\\x1c',
    0x1d:'\\x1d',
    0x1e:'\\x1e',
    0x1f:'\\x1f',
    0x7f:'\\x7f'
};

function asciiEscapePrint(char:number):string{
    return asciiEscapeCodes[char] ?? String.fromCharCode(char);
}

function isAsciiEscapeCode(char:number):boolean{
    return asciiEscapeCodes[char] !== undefined;
}

export {
    asciiEscapePrint,
    isAsciiEscapeCode
};
