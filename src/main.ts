import VT100, { DEFAULT_TERMINAL_SETTINGS } from './vt100.js';
import type { TerminalSettings } from './vt100.js';
import VT100Keyboard from './vt100Keyboard.js';
import SerialConnection, { DEFAULT_SERIAL_SETTINGS, serialSupportError, validateSerialSettings } from './serial.js';
import type { ConnectionState, FlowState, SerialSettings } from './serial.js';
import TerminalView from './terminalView.js';
import type { CursorAppearance } from './terminalView.js';
import { asciiEscapePrint } from './asciiEscapeCode.js';

interface Preferences {
  terminal: TerminalSettings;
  serial: SerialSettings;
  cursor: CursorAppearance;
  audibleBell: boolean;
  keyClick: boolean;
  marginBell: boolean;
}

function element<T extends Element>(selector: string, constructor: { new(): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof constructor)) throw new Error(`Missing application element: ${selector}`);
  return value;
}

const button = (id: string) => element(`#${id}`, HTMLButtonElement);
const input = (id: string) => element(`#${id}`, HTMLInputElement);
const select = (id: string) => element(`#${id}`, HTMLSelectElement);
const label = (id: string) => element(`#${id}`, HTMLElement);
const terminalElement = label('terminal');
const terminalInput = element('#terminal-input', HTMLTextAreaElement);
const connectionDialog = element('#connection-dialog', HTMLDialogElement);
const setupDialog = element('#setup-dialog', HTMLDialogElement);
const notice = label('notice');
const noticeText = label('notice-text');
const logPanel = element('#log-panel', HTMLDetailsElement);
const logElement = label('log');
const listeners = new AbortController();
const eventOptions = { signal: listeners.signal };
const storageKey = 'vt100-web.settings.v1';
const maximumLogLength = 1024 * 1024;
const supportError = serialSupportError();
let loadWarning = '';
let savedPreferences = loadPreferences();
let lastSerialSettings = { ...savedPreferences.serial };
let cursorAppearance = { ...savedPreferences.cursor };
let audibleBell = savedPreferences.audibleBell;
let keyClick = savedPreferences.keyClick;
let marginBell = savedPreferences.marginBell;
let localMode = false;
let connection: SerialConnection | undefined;
let connectionState: ConnectionState = 'disconnected';
let flow: FlowState = { transmitPaused: false, receivePaused: false };
let frame = 0;
let disposed = false;
let renderingFailed = false;
let receivedBytes = 0;
let transmittedBytes = 0;
let logging = false;
let logParts: string[] = [];
let logLength = 0;
let logTruncated = false;
let logDirty = false;
let draftTabs: number[] = [];
let setupPause: Promise<boolean> | null = null;
let connectionFormGeneration = 0;
let audio: AudioContext | null = null;
let audioFailed = false;
let lastBell = -Infinity;
let pendingBell = false;

const view = new TerminalView(label('screen'), terminalElement);
const terminal = new VT100({
  send: sendReply,
  bell: ringBell,
  warning: showWarning,
}, savedPreferences.terminal);
terminal.setMarginBell(marginBell);

connection = new SerialConnection({
  onData(bytes) {
    terminal.write(bytes);
    requestRender();
  },
  onState(state) {
    connectionState = state;
    if (state === 'disconnected') {
      terminal.setTransportParameters({ ...lastSerialSettings, softwareFlowControl: false });
    }
    updateConnectionUI();
  },
  onError: showError,
  onFlow(state) {
    flow = state;
    updateConnectionUI();
  },
  onTraffic(direction, bytes) {
    if (direction === 'rx') receivedBytes += bytes.length;
    else transmittedBytes += bytes.length;
    if (logging) appendLog(direction, bytes);
    requestRender();
  },
});
const serial = connection;
const keyboard = new VT100Keyboard(sendKeyboard, () => terminal.getModes(), {
  warning: showWarning,
  break: (long) => runAsync(sendBreak(long)),
  noScroll: toggleNoScroll,
  setup: openSetup,
  answerback: () => {
    const message = terminal.getSettings().answerback;
    if (message) sendKeyboard(new TextEncoder().encode(message));
  },
  keyClick: () => {
    if (keyClick) playTone(1800, 0.006, 0.015);
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showError(error: unknown): void {
  console.error(error);
  notice.hidden = false;
  notice.classList.add('error');
  noticeText.textContent = errorMessage(error);
}

function showWarning(message: string): void {
  console.warn(message);
  notice.hidden = false;
  notice.classList.remove('error');
  noticeText.textContent = message;
}

function runAsync(operation: Promise<unknown>): void {
  void operation.catch(showError);
}

function defaultPreferences(): Preferences {
  return {
    terminal: { ...DEFAULT_TERMINAL_SETTINGS, tabs: [...DEFAULT_TERMINAL_SETTINGS.tabs] },
    serial: { ...DEFAULT_SERIAL_SETTINGS },
    cursor: { style: 'block', blink: true },
    audibleBell: true,
    keyClick: false,
    marginBell: false,
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${name} settings.`);
  }
  return value as Record<string, unknown>;
}

function booleanValue(values: Record<string, unknown>, name: string): boolean {
  const value = values[name];
  if (typeof value !== 'boolean') throw new Error(`Invalid ${name} setting.`);
  return value;
}

function parseTerminalSettings(value: unknown): TerminalSettings {
  const values = record(value, 'terminal');
  if (values.columns !== 80 && values.columns !== 132) throw new Error('Columns must be 80 or 132.');
  if (typeof values.answerback !== 'string' || !/^[\x00-\x7f]{0,20}$/.test(values.answerback)) {
    throw new Error('Answerback must contain at most 20 ASCII characters.');
  }
  const tabs: unknown = values.tabs;
  if (
    !Array.isArray(tabs) || tabs.length > 132 ||
    !tabs.every((tab: unknown) => typeof tab === 'number' && Number.isInteger(tab) && tab >= 0 && tab < 132)
  ) throw new Error('Invalid tab stops.');
  return {
    columns: values.columns,
    ansi: booleanValue(values, 'ansi'),
    autoWrap: booleanValue(values, 'autoWrap'),
    autoRepeat: booleanValue(values, 'autoRepeat'),
    newLine: booleanValue(values, 'newLine'),
    smoothScroll: booleanValue(values, 'smoothScroll'),
    reverseVideo: booleanValue(values, 'reverseVideo'),
    answerback: values.answerback,
    tabs: tabs.map((tab: number) => tab),
  };
}

function parseSerialSettings(value: unknown): SerialSettings {
  const values = record(value, 'serial');
  if (
    typeof values.baudRate !== 'number' ||
    (values.dataBits !== 7 && values.dataBits !== 8) ||
    (values.stopBits !== 1 && values.stopBits !== 2) ||
    (values.parity !== 'none' && values.parity !== 'even' && values.parity !== 'odd') ||
    (values.flowControl !== 'none' && values.flowControl !== 'hardware')
  ) throw new Error('Invalid serial connection settings.');
  const settings: SerialSettings = {
    baudRate: values.baudRate,
    dataBits: values.dataBits,
    stopBits: values.stopBits,
    parity: values.parity,
    flowControl: values.flowControl,
    softwareFlowControl: booleanValue(values, 'softwareFlowControl'),
  };
  validateSerialSettings(settings);
  return settings;
}

function loadPreferences(): Preferences {
  try {
    const text = localStorage.getItem(storageKey);
    if (text === null) return defaultPreferences();
    const values = record(JSON.parse(text), 'saved');
    if (values.version !== 1) throw new Error('Unsupported saved-settings version.');
    const cursor = record(values.cursor, 'cursor');
    if (cursor.style !== 'block' && cursor.style !== 'underline') {
      throw new Error('Invalid cursor style.');
    }
    return {
      terminal: parseTerminalSettings(values.terminal),
      serial: parseSerialSettings(values.serial),
      cursor: { style: cursor.style, blink: booleanValue(cursor, 'blink') },
      audibleBell: booleanValue(values, 'audibleBell'),
      keyClick: booleanValue(values, 'keyClick'),
      marginBell: booleanValue(values, 'marginBell'),
    };
  } catch (error) {
    loadWarning = `Could not load saved settings: ${errorMessage(error)} Using factory settings for this page.`;
    return defaultPreferences();
  }
}

function savePreferences(preferences: Preferences): void {
  localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...preferences }));
  savedPreferences = structuredClone(preferences);
}

function requestRender(): void {
  if (frame || disposed || renderingFailed) return;
  frame = requestAnimationFrame(() => {
    try {
      render();
    } catch (error) {
      renderingFailed = true;
      showError(`Terminal rendering stopped: ${errorMessage(error)} Disconnecting the device; reload after correcting the error.`);
      runAsync(serial.disconnect());
    }
  });
}

function render(): void {
  frame = 0;
  const snapshot = terminal.getSnapshot();
  view.render(snapshot, cursorAppearance);
  if (pendingBell) {
    pendingBell = false;
    view.bell();
  }
  label('mode-status').textContent = `${snapshot.modes.ansi ? 'VT100' : 'VT52'} / ${snapshot.columns} x 24 / ${snapshot.modes.applicationKeypad ? 'APPLICATION' : 'NUMERIC'} KEYPAD`;
  label('host-settings').textContent = `export TERM=${snapshot.modes.ansi ? 'vt100' : 'vt52'} LC_ALL=C; stty rows 24 cols ${snapshot.columns}`;
  snapshot.leds.forEach((on, index) => {
    const led = label(`led-${index + 1}`);
    led.classList.toggle('on', on);
    led.setAttribute('aria-label', `LED ${index + 1} ${on ? 'on' : 'off'}`);
  });
  label('traffic-status').textContent = `RX ${receivedBytes.toLocaleString()} B / TX ${transmittedBytes.toLocaleString()} B`;
  if (logDirty && logPanel.open) {
    const atEnd = logElement.scrollHeight - logElement.scrollTop - logElement.clientHeight < 30;
    logElement.textContent = (logTruncated ? '[Earlier log text truncated at the 1 MiB limit]\n' : '') + logParts.join('');
    if (atEnd) logElement.scrollTop = logElement.scrollHeight;
    logDirty = false;
  }
}

function updateConnectionUI(): void {
  const connected = connectionState === 'connected';
  const idle = connectionState === 'disconnected';
  const settings = connection?.settings ?? lastSerialSettings;
  const names: Record<ConnectionState, string> = {
    disconnected: localMode ? 'LOCAL - serial closed' : 'Disconnected',
    selecting: 'Select a device in the browser chooser',
    connecting: 'Opening serial port...',
    connected: `${settings.baudRate} baud / ${settings.dataBits}${settings.parity === 'none' ? 'N' : settings.parity === 'even' ? 'E' : 'O'}${settings.stopBits}`,
    disconnecting: 'Closing serial port...',
  };
  label('connection-status').textContent = names[connectionState];
  label('connection-light').classList.toggle('connected', connected);
  label('connection-light').classList.toggle('pending', !idle && !connected);
  button('connect').disabled = !idle || supportError !== null || localMode || renderingFailed;
  button('disconnect').disabled = !connected && connectionState !== 'connecting';
  button('setup').disabled = !idle && !connected;
  button('break').disabled = !connected;
  button('line-feed').disabled = !connected && !localMode;
  button('no-scroll').disabled = !connected || !settings.softwareFlowControl;
  button('no-scroll').setAttribute('aria-pressed', String(flow.receivePaused));
  label('keyboard-lock').classList.toggle('locked', flow.transmitPaused);
  label('keyboard-lock').textContent = flow.transmitPaused ? 'KBD LOCKED' : 'KBD';
  label('online-indicator').textContent = localMode ? 'LOCAL' : 'ON LINE';
  label('online-indicator').classList.toggle('on', connected || localMode);
  terminalInput.disabled = !connected && !localMode;
  requestRender();
}

function sendReply(bytes: Uint8Array): void {
  if (localMode) return;
  const active = connection;
  if (!active || active.state !== 'connected') {
    showWarning('A terminal response could not be sent because the serial port is closed.');
    return;
  }
  if (bytes.length === 1 && bytes[0] === 0x11 && active.settings?.softwareFlowControl) {
    // Finish the core reset before resuming and parsing buffered serial input.
    runAsync(Promise.resolve().then(() => active.setReceivePaused(false)));
  } else if (bytes.length === 1 && (bytes[0] === 0x11 || bytes[0] === 0x13)) {
    runAsync(active.sendControl(bytes[0]));
  } else {
    runAsync(active.send(bytes));
  }
}

function sendKeyboard(bytes: Uint8Array): void {
  if (localMode) {
    terminal.write(bytes);
    requestRender();
    return;
  }
  if (serial.state !== 'connected') {
    showWarning('Connect a serial device before typing, or explicitly select LOCAL in SET-UP.');
    return;
  }
  if (
    serial.settings?.softwareFlowControl && bytes.length === 1 &&
    (bytes[0] === 0x11 || bytes[0] === 0x13)
  ) {
    runAsync(serial.setReceivePaused(bytes[0] === 0x13));
  } else {
    runAsync(serial.send(bytes));
  }
}

function appendLog(direction: 'rx' | 'tx', bytes: Uint8Array): void {
  let text = `${direction.toUpperCase()} `;
  for (const byte of bytes) text += asciiEscapePrint(byte);
  text += '\n';
  if (text.length > maximumLogLength) {
    text = text.slice(-maximumLogLength);
    logTruncated = true;
  }
  logParts.push(text);
  logLength += text.length;
  while (logLength > maximumLogLength) {
    const removed = logParts.shift();
    if (removed === undefined) throw new Error('Raw log length accounting failed.');
    logLength -= removed.length;
    logTruncated = true;
  }
  logDirty = true;
}

function audioError(error: unknown): void {
  audioFailed = true;
  showWarning(`Sound is unavailable: ${errorMessage(error)} The visual bell is still active.`);
}

function prepareSound(): void {
  if ((!audibleBell && !keyClick) || audioFailed) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume().catch(audioError);
  } catch (error) {
    audioError(error);
  }
}

function playTone(frequency: number, duration: number, volume: number): void {
  if (!audio || audio.state !== 'running') return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + duration);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}

function ringBell(): void {
  const now = performance.now();
  if (now - lastBell < 80) return;
  lastBell = now;
  pendingBell = true;
  if (audibleBell) playTone(800, 0.1, 0.04);
  requestRender();
}

function focusTerminal(): void {
  if (!terminalInput.disabled) terminalInput.focus({ preventScroll: true });
}

function selectionInTerminal(): boolean {
  const selection = window.getSelection();
  return Boolean(
    selection && !selection.isCollapsed && selection.toString() &&
    selection.anchorNode && terminalElement.contains(selection.anchorNode),
  );
}

function paste(text: string): void {
  try {
    keyboard.paste(text);
  } catch (error) {
    showError(error);
  }
}

function openConnection(): void {
  if (supportError) {
    showError(supportError);
    return;
  }
  const generation = ++connectionFormGeneration;
  input('baud-rate').value = String(lastSerialSettings.baudRate);
  select('data-bits').value = String(lastSerialSettings.dataBits);
  select('stop-bits').value = String(lastSerialSettings.stopBits);
  select('parity').value = lastSerialSettings.parity;
  select('flow-control').value = lastSerialSettings.softwareFlowControl ? 'software' : lastSerialSettings.flowControl;
  select('serial-device').replaceChildren(new Option('Choose a device in the browser...', ''));
  label('connection-form-error').textContent = '';
  connectionDialog.showModal();
  void serial.getAuthorizedPorts().then(
    (ports) => {
      if (!connectionDialog.open || generation !== connectionFormGeneration) return;
      for (const port of ports) select('serial-device').add(new Option(port.label, port.id));
      if (ports.length === 1) select('serial-device').value = ports[0].id;
    },
    (error: unknown) => {
      console.error(error);
      if (connectionDialog.open && generation === connectionFormGeneration) {
        label('connection-form-error').textContent = `Could not list authorized devices: ${errorMessage(error)} You can still use the browser chooser.`;
      }
    },
  );
}

async function connectFromForm(): Promise<void> {
  let settings: SerialSettings;
  try {
    const flowControl = select('flow-control').value;
    settings = parseSerialSettings({
      baudRate: input('baud-rate').valueAsNumber,
      dataBits: Number(select('data-bits').value),
      stopBits: Number(select('stop-bits').value),
      parity: select('parity').value,
      flowControl: flowControl === 'hardware' ? 'hardware' : 'none',
      softwareFlowControl: flowControl === 'software',
    });
    prepareSound();
    terminal.setTransportParameters(settings);
    connectionDialog.close();
    notice.hidden = true;
    receivedBytes = 0;
    transmittedBytes = 0;
    const connected = await serial.connect(settings, select('serial-device').value || undefined);
    if (!connected) {
      showWarning('Device selection cancelled. No serial port was opened.');
      return;
    }
  } catch (error) {
    showError(error);
    label('connection-form-error').textContent = errorMessage(error);
    if (!connectionDialog.open && serial.state === 'disconnected') connectionDialog.showModal();
    return;
  }
  lastSerialSettings = { ...settings };
  try {
    savePreferences({ ...savedPreferences, serial: settings });
  } catch (error) {
    showWarning(`Connected, but the connection settings could not be saved: ${errorMessage(error)}`);
  }
  updateConnectionUI();
  focusTerminal();
}

function fillSetup(preferences: Preferences, settings: TerminalSettings, local: boolean): void {
  select('setup-columns').value = String(settings.columns);
  select('setup-protocol').value = settings.ansi ? 'ansi' : 'vt52';
  select('setup-cursor').value = preferences.cursor.style;
  input('setup-answerback').value = settings.answerback;
  input('setup-wrap').checked = settings.autoWrap;
  input('setup-repeat').checked = settings.autoRepeat;
  input('setup-newline').checked = settings.newLine;
  input('setup-reverse').checked = settings.reverseVideo;
  input('setup-smooth').checked = settings.smoothScroll;
  input('setup-cursor-blink').checked = preferences.cursor.blink;
  input('setup-bell').checked = preferences.audibleBell;
  input('setup-keyclick').checked = preferences.keyClick;
  input('setup-margin-bell').checked = preferences.marginBell;
  input('setup-local').checked = local;
  draftTabs = [...settings.tabs];
  updateTabStatus();
}

function updateTabStatus(): void {
  const columns = Number(select('setup-columns').value);
  label('tab-status').textContent = `Columns: ${draftTabs.filter((tab) => tab < columns).map((tab) => tab + 1).join(', ') || 'none'}. Tab changes take effect with Apply or Save.`;
}

function openSetup(): void {
  if (setupDialog.open) return;
  fillSetup({
    ...savedPreferences,
    cursor: cursorAppearance,
    audibleBell,
    keyClick,
    marginBell,
  }, terminal.getSettings(), localMode);
  label('setup-form-error').textContent = '';
  setupDialog.showModal();
  if (serial.state === 'connected' && serial.settings?.softwareFlowControl && !serial.flow.receivePaused) {
    setupPause = serial.setReceivePaused(true).then(
      () => true,
      (error: unknown) => {
        showError(error);
        label('setup-form-error').textContent = `Could not pause the host: ${errorMessage(error)}`;
        return false;
      },
    );
  }
}

async function applySetup(save: boolean): Promise<void> {
  const settings = parseTerminalSettings({
    columns: Number(select('setup-columns').value),
    ansi: select('setup-protocol').value === 'ansi',
    autoWrap: input('setup-wrap').checked,
    autoRepeat: input('setup-repeat').checked,
    newLine: input('setup-newline').checked,
    smoothScroll: input('setup-smooth').checked,
    reverseVideo: input('setup-reverse').checked,
    answerback: input('setup-answerback').value,
    tabs: draftTabs,
  });
  const style = select('setup-cursor').value;
  if (style !== 'block' && style !== 'underline') throw new Error('Invalid cursor style.');
  const nextLocal = input('setup-local').checked;
  if (nextLocal && serial.state !== 'disconnected') await serial.disconnect();
  localMode = nextLocal;
  cursorAppearance = { style, blink: input('setup-cursor-blink').checked };
  audibleBell = input('setup-bell').checked;
  keyClick = input('setup-keyclick').checked;
  marginBell = input('setup-margin-bell').checked;
  audioFailed = false;
  prepareSound();
  terminal.configure(settings);
  terminal.setMarginBell(marginBell);
  if (save) {
    try {
      savePreferences({
        terminal: settings,
        serial: lastSerialSettings,
        cursor: cursorAppearance,
        audibleBell,
        keyClick,
        marginBell,
      });
      terminal.configure(settings, true);
    } catch (error) {
      updateConnectionUI();
      throw new Error(`Settings were applied to this page but could not be saved: ${errorMessage(error)}`);
    }
  }
  setupDialog.close();
  updateConnectionUI();
  focusTerminal();
}

function toggleNoScroll(): void {
  if (serial.state !== 'connected' || !serial.settings?.softwareFlowControl) {
    showWarning('NO SCROLL requires a connection with XON/XOFF software flow control enabled.');
    return;
  }
  runAsync(serial.setReceivePaused(!serial.flow.receivePaused));
}

async function sendBreak(long: boolean): Promise<void> {
  if (long && !window.confirm('Send a long BREAK? This deasserts then asserts DTR and may disconnect or reset attached equipment.')) return;
  await serial.sendBreak(long);
}

function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  if (serial.state === 'connected' || serial.state === 'connecting') {
    event.preventDefault();
    event.returnValue = '';
  }
}

button('connect').addEventListener('click', openConnection, eventOptions);
button('cancel-connect').addEventListener('click', () => connectionDialog.close(), eventOptions);
element('#connection-form', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  runAsync(connectFromForm());
}, eventOptions);
button('disconnect').addEventListener('click', () => runAsync(serial.disconnect()), eventOptions);
button('dismiss-notice').addEventListener('click', () => { notice.hidden = true; }, eventOptions);
button('setup').addEventListener('click', openSetup, eventOptions);
button('close-setup').addEventListener('click', () => setupDialog.close(), eventOptions);
element('#setup-form', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  void applySetup(event.submitter === button('save-setup')).catch((error: unknown) => {
    label('setup-form-error').textContent = errorMessage(error);
    showError(error);
  });
}, eventOptions);
setupDialog.addEventListener('close', () => {
  const paused = setupPause;
  setupPause = null;
  if (paused) {
    runAsync(paused.then(async (didPause) => {
      if (didPause && serial.state === 'connected') await serial.setReceivePaused(false);
    }));
  }
}, eventOptions);
button('factory-settings').addEventListener('click', () => {
  const defaults = defaultPreferences();
  fillSetup(defaults, defaults.terminal, false);
}, eventOptions);
select('setup-columns').addEventListener('change', updateTabStatus, eventOptions);
button('set-tab').addEventListener('click', () => {
  draftTabs = [...new Set([...draftTabs, terminal.getSnapshot().cursor.col])].sort((a, b) => a - b);
  updateTabStatus();
}, eventOptions);
button('clear-tab').addEventListener('click', () => {
  draftTabs = draftTabs.filter((tab) => tab !== terminal.getSnapshot().cursor.col);
  updateTabStatus();
}, eventOptions);
button('clear-tabs').addEventListener('click', () => { draftTabs = []; updateTabStatus(); }, eventOptions);
button('default-tabs').addEventListener('click', () => {
  draftTabs = [...DEFAULT_TERMINAL_SETTINGS.tabs];
  updateTabStatus();
}, eventOptions);
button('reset').addEventListener('click', () => {
  terminal.reset();
  cursorAppearance = { ...savedPreferences.cursor };
  audibleBell = savedPreferences.audibleBell;
  keyClick = savedPreferences.keyClick;
  marginBell = savedPreferences.marginBell;
  terminal.setMarginBell(marginBell);
  requestRender();
  focusTerminal();
}, eventOptions);
button('line-feed').addEventListener('click', () => { keyboard.sendLineFeed(); focusTerminal(); }, eventOptions);
button('no-scroll').addEventListener('click', toggleNoScroll, eventOptions);
button('break').addEventListener('click', (event) => runAsync(sendBreak(event.shiftKey)), eventOptions);
button('toggle-log').addEventListener('click', () => {
  logging = !logging;
  button('toggle-log').textContent = logging ? 'Stop log' : 'Start log';
  label('log-status').textContent = logging ? 'recording RX/TX' : 'off';
}, eventOptions);
button('clear-log').addEventListener('click', () => {
  logParts = [];
  logLength = 0;
  logTruncated = false;
  logDirty = true;
  requestRender();
}, eventOptions);
logPanel.addEventListener('toggle', requestRender, eventOptions);
terminalElement.addEventListener('pointerup', () => {
  prepareSound();
  if (!selectionInTerminal()) focusTerminal();
}, eventOptions);
terminalElement.addEventListener('focus', focusTerminal, eventOptions);
terminalElement.addEventListener('focusin', () => {
  label('focus-status').textContent = localMode ? 'LOCAL keyboard active' : 'Keyboard active';
}, eventOptions);
terminalElement.addEventListener('focusout', () => {
  label('focus-status').textContent = 'Click the terminal to type';
}, eventOptions);
terminalElement.addEventListener('keydown', (event) => {
  if (terminalInput.disabled || event.isComposing) return;
  if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey) return;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') return;
  if (event.ctrlKey && !event.shiftKey && event.code === 'KeyC' && selectionInTerminal()) return;
  prepareSound();
  if (keyboard.keyDown(event)) event.preventDefault();
}, eventOptions);
terminalInput.addEventListener('paste', (event) => {
  event.preventDefault();
  if (!event.clipboardData) {
    showError('The browser did not provide clipboard text.');
    return;
  }
  paste(event.clipboardData.getData('text/plain'));
}, eventOptions);
terminalInput.addEventListener('input', (event) => {
  if (event instanceof InputEvent && event.isComposing) return;
  const text = terminalInput.value;
  terminalInput.value = '';
  if (text) paste(text);
}, eventOptions);
window.addEventListener('beforeunload', warnBeforeLeaving, eventOptions);
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  disposed = true;
  listeners.abort();
  cancelAnimationFrame(frame);
  view.dispose();
  runAsync(serial.dispose());
  if (audio) runAsync(audio.close());
}, eventOptions);

updateConnectionUI();
if (loadWarning) showWarning(loadWarning);
if (supportError) showError(supportError);
