export type ConnectionState =
  | 'disconnected'
  | 'selecting'
  | 'connecting'
  | 'connected'
  | 'disconnecting';

export interface SerialSettings {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'hardware';
  softwareFlowControl: boolean;
}

export const DEFAULT_SERIAL_SETTINGS: SerialSettings = Object.freeze({
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  softwareFlowControl: false,
});

export interface FlowState {
  transmitPaused: boolean;
  receivePaused: boolean;
}

interface SerialCallbacks {
  onData: (bytes: Uint8Array) => void;
  onState: (state: ConnectionState) => void;
  onError: (error: Error) => void;
  onFlow?: (state: FlowState) => void;
  onTraffic?: (direction: 'rx' | 'tx', byteCount: number) => void;
}

// Web Serial is not included in all versions of lib.dom.d.ts.
interface BrowserSerial {
  requestPort(): Promise<BrowserSerialPort>;
  getPorts(): Promise<BrowserSerialPort[]>;
}

interface BrowserSerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: {
    baudRate: number;
    dataBits: 7 | 8;
    stopBits: 1 | 2;
    parity: 'none' | 'even' | 'odd';
    flowControl: 'none' | 'hardware';
    bufferSize: number;
  }): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  setSignals(signals: {
    break?: boolean;
    dataTerminalReady?: boolean;
  }): Promise<void>;
}

interface AuthorizedPortChoice {
  id: string;
  label: string;
}

interface PortIdentity {
  readonly id: string;
  readonly ordinal: number;
}

const MAX_TX_BYTES = 1024 * 1024;
const MAX_TX_PACKETS = 4096;
const MAX_PAUSED_RX_BYTES = 1024 * 1024;
const MAX_PAUSED_RX_CHUNKS = 4096;
const DISCONNECT_TIMEOUT_MS = 5000;
const CANCELLATION_TIMEOUT_MS = 1000;
const SIGNAL_TIMEOUT_MS = 2000;
const NORMAL_BREAK_MS = 233;
const LONG_BREAK_MS = 3500;

class ConnectionCancelledError extends Error {
  constructor(
    message = 'The serial operation was cancelled by disconnect. An in-flight write may already have sent some bytes.',
  ) {
    super(message);
    this.name = 'AbortError';
  }
}

interface Completion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

type TransmitItem = Completion &
  (
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    | { readonly kind: 'break'; readonly long: boolean }
  );

interface Session {
  readonly settings: SerialSettings;
  readonly abort: AbortController;
  readonly cancellation: ConnectionCancelledError;
  stopReason: Error;
  stopping: boolean;
  port: BrowserSerialPort | null;
  onDisconnect: (() => void) | null;
  opening: Promise<void> | null;
  opened: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  cancelledReader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  writerReleased: boolean;
  readTask: Promise<void> | null;
  pumpTask: Promise<void> | null;
  breakTask: Promise<void> | null;
  cleanupTask: Promise<void> | null;
  cleanupWait: Promise<void> | null;
  ioCleanupStarted: boolean;
  readonly cancellationTasks: Promise<void>[];
  readonly cleanupErrors: Error[];
  readonly normal: TransmitItem[];
  readonly priority: TransmitItem[];
  readonly outstanding: Set<TransmitItem>;
  activeItem: TransmitItem | null;
  queuedBytes: number;
  transmitPaused: boolean;
  receivePaused: boolean;
  readonly received: Uint8Array[];
  receivedBytes: number;
  draining: boolean;
  dtr: boolean | undefined;
}

function browserSerial(): BrowserSerial | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const browserNavigator: Navigator & { readonly serial?: BrowserSerial } = navigator;
  return browserNavigator.serial;
}

export function serialSupportError(): string | null {
  if (!globalThis.isSecureContext) {
    return 'Web Serial requires a secure context. Open this console using HTTPS or localhost in Chrome or Edge.';
  }
  const serial = browserSerial();
  if (!serial || typeof serial.requestPort !== 'function') {
    return 'Web Serial is unavailable in this browser. Use desktop Chrome or Edge with serial-device access enabled.';
  }
  return null;
}

export function validateSerialSettings(settings: SerialSettings): void {
  if (!settings || typeof settings !== 'object') {
    throw new Error('Provide serial connection settings.');
  }
  if (
    !Number.isFinite(settings.baudRate) ||
    !Number.isInteger(settings.baudRate) ||
    settings.baudRate <= 0 ||
    settings.baudRate > 0xffffffff
  ) {
    throw new Error('Baud rate must be a whole number from 1 to 4294967295.');
  }
  if (settings.dataBits !== 7 && settings.dataBits !== 8) {
    throw new Error('Data bits must be 7 or 8.');
  }
  if (settings.stopBits !== 1 && settings.stopBits !== 2) {
    throw new Error('Stop bits must be 1 or 2.');
  }
  if (
    settings.parity !== 'none' &&
    settings.parity !== 'even' &&
    settings.parity !== 'odd'
  ) {
    throw new Error('Parity must be none, even, or odd.');
  }
  if (settings.flowControl !== 'none' && settings.flowControl !== 'hardware') {
    throw new Error('Hardware flow control must be none or hardware.');
  }
  if (typeof settings.softwareFlowControl !== 'boolean') {
    throw new Error('Software flow control must be enabled or disabled.');
  }
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error(typeof cause === 'string' ? cause : 'Unknown serial error.', { cause });
}

function explain(message: string, cause: unknown): Error {
  if (cause instanceof ConnectionCancelledError) return cause;
  const error = errorFrom(cause);
  return new Error(`${message} ${error.message}`, { cause });
}

function combinedErrors(errors: Error[], message: string): Error {
  return errors.length === 1
    ? errors[0] ?? new Error(message)
    : new AggregateError(errors, `${message} ${errors.map((error) => error.message).join(' ')}`);
}

function completion(): Completion {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject, settled: false };
}

function deadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), milliseconds);
    operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        globalThis.clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function untilStopped<T>(operation: Promise<T>, session: Session): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(session.stopReason);
    operation.then(
      (value) => {
        session.abort.signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (cause: unknown) => {
        session.abort.signal.removeEventListener('abort', stop);
        reject(cause);
      },
    );
    if (session.stopping) stop();
    else session.abort.signal.addEventListener('abort', stop, { once: true });
  });
}

function pause(milliseconds: number, session: Session): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      globalThis.clearTimeout(timer);
      reject(session.stopReason);
    };
    const timer = globalThis.setTimeout(() => {
      session.abort.signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    if (session.stopping) stop();
    else session.abort.signal.addEventListener('abort', stop, { once: true });
  });
}

function newSession(settings: SerialSettings): Session {
  const cancellation = new ConnectionCancelledError();
  return {
    settings: { ...settings },
    abort: new AbortController(),
    cancellation,
    stopReason: cancellation,
    stopping: false,
    port: null,
    onDisconnect: null,
    opening: null,
    opened: false,
    reader: null,
    cancelledReader: null,
    writer: null,
    writerReleased: false,
    readTask: null,
    pumpTask: null,
    breakTask: null,
    cleanupTask: null,
    cleanupWait: null,
    ioCleanupStarted: false,
    cancellationTasks: [],
    cleanupErrors: [],
    normal: [],
    priority: [],
    outstanding: new Set(),
    activeItem: null,
    queuedBytes: 0,
    transmitPaused: false,
    receivePaused: false,
    received: [],
    receivedBytes: 0,
    draining: false,
    dtr: undefined,
  };
}

/**
 * Public rejections are also observed by onError (except deliberate cancellation).
 * A timed-out close retains ownership until the browser actually releases the port.
 */
export default class SerialConnection {
  private connectionState: ConnectionState = 'disconnected';
  private session: Session | null = null;
  private chooser: Promise<BrowserSerialPort> | null = null;
  private authorizedRequest: Promise<readonly AuthorizedPortChoice[]> | null = null;
  private readonly authorizedPorts = new Map<string, BrowserSerialPort>();
  private readonly portIdentities = new WeakMap<BrowserSerialPort, PortIdentity>();
  private nextPortOrdinal = 1;
  private lastSuccessfulPortId: string | null = null;
  private disposed = false;
  private readonly reported = new WeakSet<Error>();

  constructor(private readonly callbacks: SerialCallbacks) {}

  get state(): ConnectionState {
    return this.connectionState;
  }

  get settings(): SerialSettings | null {
    return this.session ? { ...this.session.settings } : null;
  }

  get flow(): FlowState {
    return {
      transmitPaused: this.session?.transmitPaused ?? false,
      receivePaused: this.session?.receivePaused ?? false,
    };
  }

  getAuthorizedPorts(): Promise<readonly { id: string; label: string }[]> {
    const owner = this.session;
    try {
      if (this.disposed) throw new Error('This serial connection has been disposed.');
      if (this.authorizedRequest) return this.authorizedRequest;
      const supportError = serialSupportError();
      if (supportError) throw new Error(supportError);
      const serial = browserSerial();
      if (!serial || typeof serial.getPorts !== 'function') {
        throw new Error('This browser cannot list authorized serial ports. Use desktop Chrome or Edge.');
      }
      const request = serial.getPorts().then((ports) => {
        if (this.disposed) {
          throw new ConnectionCancelledError('Serial port discovery was cancelled because the connection was disposed.');
        }
        const authorized = new Map<string, BrowserSerialPort>();
        const choices: AuthorizedPortChoice[] = [];
        for (const port of ports) {
          const info = port.getInfo();
          const identity = this.identifyPort(port);
          const details: string[] = [];
          if (info.usbVendorId !== undefined) {
            details.push(`VID 0x${info.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}`);
          }
          if (info.usbProductId !== undefined) {
            details.push(`PID 0x${info.usbProductId.toString(16).padStart(4, '0').toUpperCase()}`);
          }
          const usb = details.length ? ` - USB ${details.join(', ')}` : '';
          const last = identity.id === this.lastSuccessfulPortId ? ' - last connected' : '';
          choices.push({
            id: identity.id,
            label: `Serial device ${identity.ordinal}${usb}${last}`,
          });
          authorized.set(identity.id, port);
        }
        this.authorizedPorts.clear();
        for (const [id, port] of authorized) this.authorizedPorts.set(id, port);
        return choices;
      }).catch((cause: unknown) => {
        throw explain(
          "Could not list authorized serial ports. Check this site's serial permissions and the device connection.",
          cause,
        );
      });
      // Coalesce overlapping refreshes so an older enumeration cannot replace a newer map.
      this.authorizedRequest = request;
      const settled = () => {
        if (this.authorizedRequest === request) this.authorizedRequest = null;
      };
      void request.then(settled, settled);
      return this.observe(request, owner);
    } catch (cause) {
      return this.observe(Promise.reject(errorFrom(cause)), owner);
    }
  }

  connect(settings: SerialSettings, authorizedPortId?: string): Promise<boolean> {
    const previous = this.session;
    try {
      if (this.disposed) throw new Error('This serial connection has been disposed.');
      if (previous) {
        throw new Error('Disconnect and wait for the previous serial port to close before connecting.');
      }
      if (this.chooser) {
        throw new Error('Dismiss the previous native port chooser before connecting again.');
      }
      validateSerialSettings(settings);
      const supportError = serialSupportError();
      if (supportError) throw new Error(supportError);
      const serial = browserSerial();
      if (!serial) throw new Error('Web Serial is unavailable.');
      let authorizedPort: BrowserSerialPort | undefined;
      if (authorizedPortId !== undefined) {
        authorizedPort = this.authorizedPorts.get(authorizedPortId);
        if (!authorizedPort) {
          throw new Error('The selected authorized serial port is not in the current list. Refresh the list and explicitly select a port, or choose the native port chooser.');
        }
      }

      const session = newSession(settings);
      this.session = session;
      const nativeChooser = authorizedPort === undefined;
      const initialState = nativeChooser ? 'selecting' : 'connecting';
      this.connectionState = initialState;
      let request: Promise<BrowserSerialPort>;
      if (authorizedPort) {
        request = Promise.resolve(authorizedPort);
      } else {
        // Invoke the native chooser before any await or caller-supplied callback.
        try {
          request = serial.requestPort();
        } catch (cause) {
          request = Promise.reject(cause);
        }
        this.chooser = request;
        void request.then(
          () => {
            if (this.chooser === request) this.chooser = null;
          },
          (cause: unknown) => {
            if (this.chooser === request) this.chooser = null;
            if (session.stopping && errorFrom(cause).name !== 'NotFoundError') {
              this.report(explain('The native serial port chooser failed.', cause), session);
            }
          },
        );
      }
      const operation = this.observe(this.openSelected(session, request, nativeChooser), session);
      try {
        this.callback(session, 'onState', () => this.callbacks.onState(initialState));
      } catch (cause) {
        this.fail(session, errorFrom(cause));
      }
      return operation;
    } catch (cause) {
      return this.observe(Promise.reject(errorFrom(cause)), previous);
    }
  }

  private identifyPort(port: BrowserSerialPort): PortIdentity {
    const known = this.portIdentities.get(port);
    if (known) return known;
    const ordinal = this.nextPortOrdinal++;
    const identity = { id: `authorized-port-${ordinal}`, ordinal };
    this.portIdentities.set(port, identity);
    return identity;
  }

  disconnect(): Promise<void> {
    const session = this.session;
    return session
      ? this.stop(session, session.cancellation)
      : Promise.resolve();
  }

  send(bytes: Uint8Array): Promise<void> {
    const session = this.session;
    try {
      this.requireConnected(session);
      if (bytes.byteLength === 0) return Promise.resolve();
      this.checkCapacity(session, bytes.byteLength);
      return this.enqueue(session, { ...completion(), kind: 'bytes', bytes: bytes.slice() }, false);
    } catch (cause) {
      return this.observe(Promise.reject(errorFrom(cause)), session);
    }
  }

  sendControl(byte: 0x11 | 0x13): Promise<void> {
    const session = this.session;
    try {
      this.requireConnected(session);
      if (byte !== 0x11 && byte !== 0x13) {
        throw new Error('A flow-control byte must be XON (0x11) or XOFF (0x13).');
      }
      return this.queueControl(session, byte);
    } catch (cause) {
      return this.observe(Promise.reject(errorFrom(cause)), session);
    }
  }

  setReceivePaused(paused: boolean): Promise<void> {
    const session = this.session;
    let changing = false;
    try {
      this.requireConnected(session);
      if (typeof paused !== 'boolean') throw new Error('Receive pause must be true or false.');
      if (!session.settings.softwareFlowControl) {
        throw new Error('NO SCROLL requires software XON/XOFF flow control. Enable it when connecting.');
      }
      const operation = this.queueControl(session, paused ? 0x13 : 0x11);
      changing = true;
      const changed = session.receivePaused !== paused;
      session.receivePaused = paused;
      if (changed) this.notifyFlow(session);
      if (!paused) this.drainReceived(session);
      return operation;
    } catch (cause) {
      const error = errorFrom(cause);
      if (changing && session && this.live(session)) {
        this.fail(session, error);
      }
      return this.observe(Promise.reject(error), session);
    }
  }

  /**
   * Long BREAK alone cycles DTR. Web Serial cannot read output signals, so an
   * unknown original DTR is restored to asserted, not claimed to be preserved.
   */
  sendBreak(long = false): Promise<void> {
    const session = this.session;
    try {
      this.requireConnected(session);
      if (typeof long !== 'boolean') throw new Error('The long BREAK option must be true or false.');
      this.checkCapacity(session, 0);
      return this.enqueue(session, { ...completion(), kind: 'break', long }, true);
    } catch (cause) {
      return this.observe(Promise.reject(errorFrom(cause)), session);
    }
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.authorizedPorts.clear();
    return this.disconnect();
  }

  private live(session: Session): boolean {
    return this.session === session && !session.stopping && !this.disposed;
  }

  private requireLive(session: Session): void {
    if (!this.live(session)) throw session.stopReason;
  }

  private requireConnected(session: Session | null): asserts session is Session {
    if (!session || !this.live(session) || this.connectionState !== 'connected') {
      throw new Error('The serial port is not connected.');
    }
  }

  private observe<T>(operation: Promise<T>, owner: Session | null): Promise<T> {
    // Observe the original promise without converting a public rejection to success.
    void operation.catch((cause: unknown) => this.report(errorFrom(cause), owner));
    return operation;
  }

  private report(error: Error, owner: Session | null): void {
    if (error instanceof ConnectionCancelledError || this.reported.has(error)) return;
    this.reported.add(error);
    if (this.session !== owner || (this.disposed && owner === null)) {
      console.error(error);
      return;
    }
    try {
      const result: unknown = this.callbacks.onError(error);
      if (result !== undefined) {
        void Promise.resolve(result).catch((cause: unknown) => {
          this.errorCallbackFailed(error, cause, owner);
        });
      }
    } catch (cause) {
      this.errorCallbackFailed(error, cause, owner);
    }
  }

  private errorCallbackFailed(original: Error, cause: unknown, owner: Session | null): void {
    const error = explain('The serial onError callback failed.', cause);
    console.error(original, error);
    if (owner && this.session === owner) {
      owner.cleanupErrors.push(error);
      if (!owner.stopping) this.stop(owner, error);
    }
  }

  private callback(owner: Session | null, name: string, action: () => unknown): void {
    if (this.session !== owner) return;
    try {
      const result = action();
      if (result !== undefined) {
        void Promise.resolve(result).catch((cause: unknown) => {
          const error = explain(`The serial ${name} callback failed.`, cause);
          if (owner) this.fail(owner, error);
          else this.report(error, owner);
        });
      }
    } catch (cause) {
      throw explain(`The serial ${name} callback failed.`, cause);
    }
  }

  private stateChanged(session: Session, state: ConnectionState): void {
    if (this.session !== session) return;
    this.connectionState = state;
    this.callback(session, 'onState', () => this.callbacks.onState(state));
  }

  private notifyFlow(session: Session): void {
    this.callback(session, 'onFlow', () => this.callbacks.onFlow?.({
      transmitPaused: session.transmitPaused,
      receivePaused: session.receivePaused,
    }));
  }

  private async openSelected(
    session: Session,
    request: Promise<BrowserSerialPort>,
    nativeChooser: boolean,
  ): Promise<boolean> {
    try {
      let port: BrowserSerialPort;
      try {
        port = await untilStopped(request, session);
      } catch (cause) {
        if (nativeChooser && !session.stopping && errorFrom(cause).name === 'NotFoundError') {
          await this.stop(session, session.cancellation);
          return false;
        }
        if (session.stopping && cause === session.stopReason) throw cause;
        throw explain(
          'Could not select a serial port. Allow serial access and use the Connect button in a secure, top-level browser page.',
          cause,
        );
      }
      this.requireLive(session);
      session.port = port;
      session.onDisconnect = () => {
        this.fail(session, new Error('The serial device was removed. Reconnect its cable and select the port again.'));
      };
      port.addEventListener('disconnect', session.onDisconnect);
      if (this.connectionState !== 'connecting') this.stateChanged(session, 'connecting');
      this.requireLive(session);
      const settings = session.settings;
      session.opening = port.open({
        baudRate: settings.baudRate,
        dataBits: settings.dataBits,
        stopBits: settings.stopBits,
        parity: settings.parity,
        flowControl: settings.flowControl,
        bufferSize: 64 * 1024,
      }).then(
        () => { session.opened = true; },
        (cause: unknown) => {
          const error = explain(
            'Could not open the serial port. Close other applications using it, check the cable and permissions, and verify that the device supports these serial settings.',
            cause,
          );
          if (session.stopping) this.cleanupError(session, error);
          throw error;
        },
      );
      await untilStopped(session.opening, session);
      this.requireLive(session);
      const writable = port.writable;
      if (!port.readable || !writable) {
        throw new Error('The opened serial port has no readable or writable stream. Check the device connection.');
      }
      const writer = writable.getWriter();
      session.writer = writer;
      void writer.closed.then(
        () => {
          if (this.live(session)) this.fail(session, new Error('The serial output stream closed unexpectedly.'));
        },
        (cause: unknown) => {
          if (
            cause === session.stopReason ||
            (session.stopping && session.writerReleased && cause instanceof TypeError)
          ) return;
          const error = explain('The serial output stream failed.', cause);
          if (session.stopping) this.cleanupError(session, error);
          else this.fail(session, error);
        },
      );
      this.stateChanged(session, 'connected');
      this.requireLive(session);
      this.notifyFlow(session);
      this.requireLive(session);
      session.readTask = this.read(session);
      void session.readTask.catch((cause: unknown) => this.fail(session, errorFrom(cause)));
      this.lastSuccessfulPortId = this.identifyPort(port).id;
      return true;
    } catch (cause) {
      const error = errorFrom(cause);
      if (!session.stopping) this.fail(session, error);
      throw error;
    }
  }

  private async read(session: Session): Promise<void> {
    let consecutiveErrors = 0;
    while (this.live(session)) {
      const stream = session.port?.readable;
      if (!stream) throw new Error('The serial input stream is unavailable. The device may have been unplugged.');
      const reader = stream.getReader();
      session.reader = reader;
      let failure: Error | null = null;
      let ended = false;
      try {
        while (this.live(session)) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (cause) {
            if (
              cause !== session.stopReason &&
              !(session.stopping && session.cancelledReader === reader && cause instanceof TypeError)
            ) failure = errorFrom(cause);
            break;
          }
          const raw = result.done ? undefined : result.value;
          if (raw && raw.byteLength > 0 && this.session === session) {
            this.callback(session, 'onTraffic', () => this.callbacks.onTraffic?.('rx', raw.byteLength));
          }
          if (!this.live(session)) break;
          if (result.done) {
            ended = true;
            break;
          }
          if (result.value.byteLength > 0) {
            consecutiveErrors = 0;
            this.receive(session, result.value);
          }
        }
      } finally {
        if (session.reader === reader) {
          reader.releaseLock();
          session.reader = null;
        }
      }
      if (session.stopping) {
        if (failure) this.cleanupError(session, explain('Serial input failed while disconnecting.', failure));
        return;
      }
      this.requireLive(session);
      const replacement = session.port?.readable;
      if (ended || !replacement || replacement === stream || !failure) {
        throw explain(
          'The serial input stream ended unexpectedly. Check the cable and reconnect.',
          failure ?? new Error('No replacement input stream is available.'),
        );
      }
      consecutiveErrors += 1;
      if (consecutiveErrors > 8) {
        throw explain('Serial input repeatedly failed. Check baud rate, framing, flow control, and wiring.', failure);
      }
      this.report(
        explain('A recoverable serial receive error occurred; some incoming bytes may have been lost. Reading will resume.', failure),
        session,
      );
      await pause(Math.min(25 * consecutiveErrors, 200), session);
    }
  }

  private receive(session: Session, bytes: Uint8Array): void {
    this.requireLive(session);
    let data = bytes;
    if (session.settings.softwareFlowControl) {
      const filtered = new Uint8Array(bytes.byteLength);
      let length = 0;
      for (const byte of bytes) {
        if (byte === 0x11 || byte === 0x13) {
          const paused = byte === 0x13;
          if (session.transmitPaused !== paused) {
            session.transmitPaused = paused;
            this.notifyFlow(session);
            this.requireLive(session);
            if (!paused) this.startPump(session);
          }
        } else {
          filtered[length++] = byte;
        }
      }
      data = filtered.subarray(0, length);
    }
    if (data.byteLength === 0) return;
    if (session.receivePaused || session.draining) {
      if (
        session.receivedBytes + data.byteLength > MAX_PAUSED_RX_BYTES ||
        session.received.length >= MAX_PAUSED_RX_CHUNKS
      ) {
        throw new Error('The paused receive buffer exceeded 1 MiB or 4096 chunks. The peer may be ignoring XOFF; disconnecting instead of silently dropping data.');
      }
      session.received.push(data.slice());
      session.receivedBytes += data.byteLength;
    } else {
      this.callback(session, 'onData', () => this.callbacks.onData(data));
    }
  }

  private drainReceived(session: Session): void {
    if (session.draining) return;
    session.draining = true;
    try {
      while (this.live(session) && !session.receivePaused) {
        const bytes = session.received.shift();
        if (!bytes) break;
        session.receivedBytes -= bytes.byteLength;
        this.callback(session, 'onData', () => this.callbacks.onData(bytes));
      }
    } finally {
      session.draining = false;
    }
  }

  private checkCapacity(session: Session, bytes: number): void {
    if (
      session.queuedBytes + bytes > MAX_TX_BYTES ||
      session.outstanding.size >= MAX_TX_PACKETS
    ) {
      const error = new Error('The transmit queue exceeded 1 MiB or 4096 packets. Wait for the peer to resume or send less data; disconnecting instead of silently dropping bytes.');
      this.fail(session, error);
      throw error;
    }
  }

  private queueControl(session: Session, byte: 0x11 | 0x13): Promise<void> {
    this.checkCapacity(session, 1);
    return this.enqueue(
      session,
      { ...completion(), kind: 'bytes', bytes: new Uint8Array([byte]) },
      true,
    );
  }

  private enqueue(session: Session, item: TransmitItem, priority: boolean): Promise<void> {
    session.outstanding.add(item);
    session.queuedBytes += item.kind === 'bytes' ? item.bytes.byteLength : 0;
    (priority ? session.priority : session.normal).push(item);
    this.startPump(session);
    return this.observe(item.promise, session);
  }

  private settle(session: Session, item: TransmitItem, error?: Error): void {
    if (item.settled) return;
    item.settled = true;
    session.outstanding.delete(item);
    session.queuedBytes -= item.kind === 'bytes' ? item.bytes.byteLength : 0;
    if (error) item.reject(error);
    else item.resolve();
  }

  private startPump(session: Session): void {
    if (!this.live(session) || session.pumpTask) return;
    // Scheduling also lets a synchronous resume drain its older RX data before XON is written.
    const task = Promise.resolve().then(() => this.pump(session));
    session.pumpTask = task;
    void task.then(
      () => {
        session.pumpTask = null;
        if (session.priority.length || (!session.transmitPaused && session.normal.length)) {
          this.startPump(session);
        }
      },
      (cause: unknown) => {
        session.pumpTask = null;
        this.fail(session, errorFrom(cause));
      },
    );
  }

  private async pump(session: Session): Promise<void> {
    while (this.live(session)) {
      const item = session.priority.shift() ??
        (session.transmitPaused ? undefined : session.normal.shift());
      if (!item) return;
      session.activeItem = item;
      try {
        if (item.kind === 'bytes') {
          const writer = session.writer;
          if (!writer) throw new Error('The serial writer is unavailable.');
          const writing = writer.write(item.bytes).then(
            () => {
              if (this.session === session) {
                this.callback(session, 'onTraffic', () => this.callbacks.onTraffic?.('tx', item.bytes.byteLength));
              }
            },
            (cause: unknown) => {
              if (cause === session.stopReason) throw cause;
              throw explain('Writing to the serial device failed. Check the cable and reconnect.', cause);
            },
          );
          void writing.catch((cause: unknown) => {
            if (session.stopping && cause !== session.stopReason) {
              this.cleanupError(session, errorFrom(cause));
            }
          });
          await untilStopped(writing, session);
        } else {
          const breaking = this.performBreak(session, item.long);
          session.breakTask = breaking;
          void breaking.then(
            () => { if (session.breakTask === breaking) session.breakTask = null; },
            (cause: unknown) => {
              if (session.breakTask === breaking) session.breakTask = null;
              if (session.stopping && cause !== session.stopReason) {
                this.cleanupError(session, errorFrom(cause));
              }
            },
          );
          await untilStopped(
            deadline(
              breaking,
              (item.long ? LONG_BREAK_MS : NORMAL_BREAK_MS) +
                (item.long ? 3 : 2) * SIGNAL_TIMEOUT_MS,
              'The browser did not finish the BREAK signal operation. Disconnecting; do not reopen until the old port has closed.',
            ),
            session,
          );
        }
        this.requireLive(session);
        this.settle(session, item);
      } catch (cause) {
        const error = errorFrom(cause);
        this.settle(session, item, error);
        throw error;
      } finally {
        if (session.activeItem === item) session.activeItem = null;
      }
    }
  }

  private async performBreak(session: Session, long: boolean): Promise<void> {
    const port = session.port;
    if (!port) throw new Error('The serial port is unavailable for BREAK.');
    this.requireLive(session);
    const restoreDtr = session.dtr ?? true;
    const errors: Error[] = [];
    try {
      await port.setSignals(long ? { break: true, dataTerminalReady: false } : { break: true });
      if (long) session.dtr = false;
      await pause(long ? LONG_BREAK_MS : NORMAL_BREAK_MS, session);
    } catch (cause) {
      errors.push(
        session.stopping && cause === session.stopReason
          ? session.stopReason
          : explain('Could not complete BREAK.', cause),
      );
    } finally {
      // Never race restoration against an unfinished assertion or a subsequent port open.
      try {
        await port.setSignals({ break: false });
      } catch (cause) {
        errors.push(explain('Could not release BREAK. Check the physical device before reconnecting.', cause));
      }
      if (long) {
        // setSignals applies DTR before BREAK: restore separately, after releasing BREAK.
        try {
          await port.setSignals({ dataTerminalReady: restoreDtr });
          session.dtr = restoreDtr;
        } catch (cause) {
          errors.push(explain('Could not restore DTR. Check the physical device before reconnecting.', cause));
        }
      }
    }
    if (errors.length) throw combinedErrors(errors, 'BREAK failed, including signal restoration.');
  }

  private fail(session: Session, error: Error): void {
    if (error instanceof ConnectionCancelledError) return;
    if (this.session !== session) {
      this.report(error, session);
      return;
    }
    if (session.stopping) {
      if (error !== session.stopReason) this.cleanupError(session, error);
      return;
    }
    this.stop(session, error);
    this.report(error, session);
  }

  private cleanupError(session: Session, error: Error): void {
    if (error instanceof ConnectionCancelledError || error === session.stopReason) return;
    if (!session.cleanupErrors.includes(error)) session.cleanupErrors.push(error);
    this.report(error, session);
  }

  private stop(session: Session, reason: Error): Promise<void> {
    if (this.session !== session) return session.cleanupWait ?? Promise.resolve();
    if (!session.stopping) {
      session.stopping = true;
      session.stopReason = reason;
      session.abort.abort();
      for (const item of session.outstanding) this.settle(session, item, reason);
      session.normal.length = 0;
      session.priority.length = 0;
      if (session.port && session.onDisconnect) {
        session.port.removeEventListener('disconnect', session.onDisconnect);
        session.onDisconnect = null;
      }
    }
    if (!session.cleanupTask) {
      const task = Promise.resolve().then(() => this.cleanup(session));
      session.cleanupTask = task;
      const wait = deadline(
        task,
        DISCONNECT_TIMEOUT_MS,
        'Serial disconnect did not finish within 5 seconds. The old port is still owned and reconnect is blocked. Check the cable or close this browser tab if the device driver remains stuck.',
      );
      session.cleanupWait = this.observe(wait, session);
      void task.then(
        () => {
          session.cleanupTask = null;
          session.cleanupWait = null;
        },
        (cause: unknown) => {
          session.cleanupTask = null;
          session.cleanupWait = null;
          this.report(errorFrom(cause), this.session === null ? null : session);
        },
      );
    }
    if (this.connectionState !== 'disconnecting') {
      try {
        this.stateChanged(session, 'disconnecting');
      } catch (cause) {
        this.cleanupError(session, errorFrom(cause));
      }
    }
    return session.cleanupWait ?? Promise.reject(new Error('Serial cleanup was not started.'));
  }

  private cancelIO(session: Session): void {
    const firstAttempt = !session.ioCleanupStarted;
    session.ioCleanupStarted = true;
    const reader = session.reader;
    if (reader) {
      session.cancelledReader = reader;
      try {
        if (firstAttempt) {
          this.trackCancellation(session, reader.cancel(session.stopReason), 'Cancelling serial input failed.');
        }
      } catch (cause) {
        this.cleanupError(session, explain('Cancelling serial input failed.', cause));
      } finally {
        try {
          reader.releaseLock();
          session.reader = null;
        } catch (cause) {
          this.cleanupError(session, explain('Releasing the serial reader lock failed.', cause));
        }
      }
    }
    const writer = session.writer;
    if (writer) {
      try {
        // close() would wait for queued writes, including hardware/XOFF stalls.
        if (firstAttempt) {
          this.trackCancellation(session, writer.abort(session.stopReason), 'Aborting serial output failed.');
        }
      } catch (cause) {
        this.cleanupError(session, explain('Aborting serial output failed.', cause));
      } finally {
        try {
          writer.releaseLock();
          session.writerReleased = true;
          session.writer = null;
        } catch (cause) {
          this.cleanupError(session, explain('Releasing the serial writer lock failed.', cause));
        }
      }
    }
  }

  private trackCancellation(session: Session, task: Promise<void>, message: string): void {
    session.cancellationTasks.push(task.catch((cause: unknown) => {
      if (cause !== session.stopReason) this.cleanupError(session, explain(message, cause));
    }));
  }

  private async cleanup(session: Session): Promise<void> {
    if (session.opening) {
      // open() has no abort API. Retain ownership and close a late successful open.
      try {
        await session.opening;
      } catch {
        // The opening operation already reports and propagates its own failure.
      }
    }
    this.cancelIO(session);
    if (session.breakTask) {
      try {
        await session.breakTask;
      } catch (cause) {
        this.cleanupError(session, errorFrom(cause));
      }
    }
    if (session.opened && session.port) {
      try {
        // Locks are released before this call, even when aborting a write is still pending.
        await session.port.close();
        session.opened = false;
      } catch (cause) {
        this.cleanupError(session, explain('Closing the serial port failed. Retry Disconnect before reconnecting.', cause));
        throw combinedErrors(session.cleanupErrors.splice(0), 'Serial port cleanup failed.');
      }
    }
    try {
      await deadline(
        Promise.all(session.cancellationTasks),
        CANCELLATION_TIMEOUT_MS,
        'The serial port closed, but the browser did not finish cancelling its streams.',
      );
    } catch (cause) {
      this.cleanupError(session, errorFrom(cause));
    }
    session.received.length = 0;
    session.receivedBytes = 0;
    if (this.session === session) {
      session.transmitPaused = false;
      session.receivePaused = false;
      try {
        this.notifyFlow(session);
      } catch (cause) {
        this.cleanupError(session, errorFrom(cause));
      }
      this.session = null;
      this.connectionState = 'disconnected';
      try {
        this.callback(null, 'onState', () => this.callbacks.onState('disconnected'));
      } catch (cause) {
        const error = errorFrom(cause);
        session.cleanupErrors.push(error);
        this.report(error, null);
      }
    }
    if (session.cleanupErrors.length) {
      throw combinedErrors(session.cleanupErrors.splice(0), 'Serial stream cleanup failed.');
    }
  }
}
