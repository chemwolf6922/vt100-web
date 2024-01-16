import React from 'react';
import './App.css';
import VT100 from './vt100';
import VT100Keyboard from './vt100Keyboard';
import {asciiEscapePrint} from './asciiEscapeCode';

class App extends React.Component {
  writer:WritableStreamDefaultWriter|undefined;
  vt100 = new VT100((c:number)=>{
    if(this.writer){
      this.writer.write(new Uint8Array([c]));
    }
    // console.log(asciiEscapePrint(c));
  },{
    lines:37,
    columns:128
  });
  vt100Keyboard = new VT100Keyboard((c:number)=>{
    // console.log(asciiEscapePrint(c));
    // this.vt100.getc(c);
    if(this.writer){
      this.writer.write(new Uint8Array([c]));
    }
  });
  state = {
    content:this.vt100.getBuffer(),
    withLog:false,
    log:''
  };
  listenerRegistered = false;
  componentDidMount(): void {
    if(this.listenerRegistered){
      return;
    }
    this.listenerRegistered = true;
    document.addEventListener('keydown',(e)=>{
      e.preventDefault();
      this.vt100Keyboard.keyDown(e.code);
    });
    document.addEventListener('keyup',(e)=>{
      e.preventDefault();
      this.vt100Keyboard.keyUp(e.code);
    });
  }

  async onConnectSerialButtonClick():Promise<void>{
    const port = await (navigator as any).serial.requestPort();
    await port.open({ baudRate: 115200 });
    const reader:ReadableStreamDefaultReader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    while(true){
      const { value,done } = await reader.read();
      if(done){
        break;
      }
      let logPiece = '';
      for(let i = 0;i < value.length; i++){
        this.vt100.getc(value[i]);
        // console.log(value[i].toString(16), asciiEscapePrint(value[i]));
        logPiece += asciiEscapePrint(value[i]);
      }
      if(this.state.withLog){
        const log = this.state.log+logPiece;
        await new Promise<void>(res=>{
          this.setState({content:this.vt100.getBuffer(),log:log},()=>{res();});
        });
      }else{
        await new Promise<void>(res=>{
          this.setState({content:this.vt100.getBuffer()},()=>{res();});
        });
      }
    }
    reader.releaseLock();
  }

  onToggleLogButtonClick():void{
    this.setState({withLog:!this.state.withLog});
  }

  onClearLogButtonClick():void{
    this.setState({log:''});
  }

  render() {
    return (
      <div className="App">
        {/* @todo change this, this is shit code. */}
        <div className='console' dangerouslySetInnerHTML={{ __html: this.state.content }}></div>
        <button onClick={this.onConnectSerialButtonClick.bind(this)}>Connect serial</button>
        <button onClick={this.onToggleLogButtonClick.bind(this)}>{this.state.withLog?'Stop log':'Start log'}</button>
        <button onClick={this.onClearLogButtonClick.bind(this)}>Clear log</button><br/>
        <div className='log'>{this.state.log}</div>
      </div>
    );
  }
}

export default App;
