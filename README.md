# VT100 Web Serial Console

A TypeScript VT100 terminal that talks directly to a serial device through the
browser's Web Serial API. No React, runtime npm dependencies, CDN resources, or
server-side serial proxy. The device remains attached to the computer running the
browser, not necessarily the computer serving this project.

**Hosted console:** <https://chemwolf6922.github.io/vt100-web/>

## Run

Keep your existing Node installation. This project was developed using Node
22.14.0 and npm 10.9.2; installation does not update either.

```sh
npm run check:dependencies
npm ci
npm audit signatures
npm start
```

Open <http://localhost:3000> in a Web Serial-capable desktop browser. With remote
VS Code, forward port 3000 and open the forwarded localhost URL in the browser
on the computer attached to your device. An arbitrary HTTP LAN address is not a
secure context and will not expose Web Serial; use localhost or HTTPS.

`npm start` builds once and serves only the generated `build/` directory,
bound to `127.0.0.1`. Run `npm run build` after changing source, then reload the
browser. Set `PORT` to use a different port. There is no hot reloading: disconnect
the device before reloading an active session.

```sh
npm run typecheck
npm run build
```

The build emits native ES modules and copies the static assets. Deploy the
contents of `build/` together to an HTTPS static server. Source maps are included.
No service worker caches an obsolete version of the application.

## GitHub Pages deployment

[Build and deploy Pages](.github/workflows/pages.yml) builds pull requests to
`main` and deploys successful pushes to `main`. It can also be started manually
from the repository's **Actions** tab; only runs on `main` can publish.

The pipeline uses Node **22.14.0**, enforces the dependency age/download/integrity
policy before installation, runs `npm ci` with lifecycle scripts disabled,
verifies registry signatures, checks published advisories, and runs the strict
TypeScript build. It does not install or run unit-test frameworks.

Only `build/` is uploaded. Deployment uses GitHub's built-in Pages/OIDC
permissions in a separate `github-pages` environment; no personal access token,
deploy key, or `gh-pages` branch is required. Pull requests cannot publish.
Official GitHub Actions are pinned to full commit hashes, including the
artifact-upload action referenced by the Pages uploader.

For a new repository or fork, set **Settings > Pages > Build and deployment >
Source** to **GitHub Actions** once, then run the workflow on `main`. The site is
published at `https://<owner>.github.io/<repository>/`. Relative asset and module
URLs support that project subpath without a separate production build.

The hosted site uses HTTPS, so Web Serial can access devices attached to your
browser's computer. Serial permissions and saved settings are origin-specific:
you must authorize the device again on the hosted site even if it was already
authorized at localhost. The pipeline never connects to hardware or replaces the
real-Pi validation documented below.

## Connect

1. Select **Connect serial**.
2. Choose a baud rate. Common rates are suggested; a positive integer custom rate
   is allowed if supported by the browser, driver, and device.
3. Set data bits, parity, stop bits, and flow control to match the device.
   Defaults are **115200 baud, 8-N-1, no flow control**.
4. Confirm, then select the device in the browser's native chooser. For the
   Raspberry Pi used during development, this is **COM7 on the Windows machine**.
5. Click the terminal to type. At a Linux shell prompt, apply the host settings
   below before starting full-screen applications such as `htop`.
6. Use **Disconnect** before opening the device in a different program.

Previously authorized devices appear in the connection form for deliberate
reconnection without another native chooser. Browser APIs expose USB vendor and
product IDs, not Windows COM names; select the correct device in the native
chooser when unsure.

The app never automatically sends a login, shell command, reset, or BREAK to the
host. Terminal **Reset** resets the emulated display and modes; it does not reboot
the connected computer. Serial output is always rendered as literal text, not
HTML.

### Host configuration

Raw serial links do not negotiate the host's terminal type, window size, or text
encoding. All three must match the emulator. At a Linux shell prompt, run:

```sh
export TERM=vt100 LC_ALL=C
stty rows 24 cols 80
```

If the host switches to 132-column operation, its applications must also use the
matching tty size. Use `stty cols 132` when appropriate. The browser viewport does
not change the terminal's logical dimensions. The display frame fits the actual
cell grid with an 8px inset on all sides; narrower windows scroll horizontally
without stretching the terminal. When deliberately using VT52 mode,
use `TERM=vt52` instead; the on-screen host-setup hint follows the active mode.

The terminal is a **7-bit VT100, not a UTF-8/xterm terminal**. `TERM=vt100` alone
does not disable UTF-8 output; `LC_ALL=C` selects an ASCII locale for applications
such as `htop`. These settings affect the current login, not the system locale or
startup files. Reapply them after a new login or another terminal changes the tty.
Unsupported non-ASCII keyboard/paste input is rejected rather than encoded into
corrupted VT100 bytes. No local echo is added while connected: the host controls
echo.

If a full-screen application's rows overlap, its footer disappears, or output
wraps in the wrong places, exit it and check `stty size`, `TERM`, and `LC_ALL`.
For the default console they should be `24 80`, `vt100`, and `C`, respectively.
Apply the command above and restart the application. An old tty size such as
`30 202`, a VT220 terminal type, or a UTF-8 locale is not a compatible setup.

## Keyboard and SET-UP

- Return sends CR, or CR+LF when newline mode is enabled.
- Backspace sends BS; Delete sends DEL; **Line Feed** sends LF independently.
- F1-F4 are PF1-PF4. Arrow and numeric-keypad sequences follow terminal modes.
- In ANSI/VT100 mode, PC F5-F10 provide the application-keypad aliases declared
  by the ncurses `vt100` terminal description: keypad 4, 5, 6, comma, 7, and 8.
  This restores controls such as `htop`'s F10 Quit without inventing additional
  VT100 escape sequences. These aliases do not change native VT52 key mappings.
- On a PC keypad, NumLock, `/`, and `*` also provide PF1-PF3; `+` is the VT100
  keypad comma. F12 opens **SET-UP**.
- Ctrl combinations include Ctrl-C, Ctrl-D, Ctrl-[, and ordinary Ctrl-V (SYN).
  **Ctrl+Shift+V** pastes. A paste must be ASCII and at most 64 KiB after newline
  normalization; the entire packet is validated before sending.
- Selecting text and pressing Ctrl+C copies it; with no selection, Ctrl+C goes
  to the host. **Shift+Tab** leaves terminal focus so the toolbar remains
  keyboard-accessible.
- **NO SCROLL** / Scroll Lock and Ctrl-S/Ctrl-Q coordinate receive pause/resume
  when XON/XOFF is enabled. Reset clears a receive pause before buffered input is
  processed again. These controls do not silently enable flow control.
- **BREAK** / Pause requests a short serial break. Shift requests a long break
  with a confirmation because it changes DTR and can disconnect or reset
  hardware. Ctrl+Pause sends the configured answerback.

**SET-UP** controls columns, ANSI/VT52, wrapping, autorepeat, newline, reverse
screen, smooth scrolling, tabs, answerback, cursor, bells, keyclick, and LOCAL.
**Apply** affects the current terminal; **Save** also stores power-on defaults in
this browser. Reset recalls saved terminal defaults. Host escape sequences do
not overwrite saved preferences.

Selecting **LOCAL** explicitly disconnects serial I/O and connects the keyboard
to the emulated display. LOCAL is a VT100 operating mode, not a substitute for
testing a real device, and is never used as a connection-error fallback.

Settings are stored in local storage. Raw data is not persisted. The optional
RX/TX log is kept only in memory, capped at 1 MiB of escaped text, and indicates
truncation. **Logs can include passwords**; leave logging off while entering
credentials and clear it when finished.

## Compatibility

The behavioral reference is the
[DEC VT100 User Guide](https://vt100.net/docs/vt100-ug/contents.html), especially
[programmer information](https://vt100.net/docs/vt100-ug/chapter3.html).

Implemented software behaviors include:

- 24 lines, 80/132 columns; streaming ANSI/VT52 parsing across arbitrary serial
  chunks, embedded controls, cancellation, and bounded malformed sequences.
- Cursor addressing and reports, deferred autowrap, inclusive erasure,
  index/reverse-index, scrolling margins, origin mode, save/restore, and reset.
- Configurable tab stops, G0/G1 designation and SI/SO invocation, US/UK and DEC
  special-graphics character sets.
- Advanced Video Option text attributes: bold, underline, blink, and inverse;
  reverse screen; single/double-width and double-height lines; alignment display.
- Normal/application cursor keys and keypad, ANSI/VT52 mode, autorepeat, newline,
  answerback, keyboard indicators, and host-controlled LEDs.
- Device attributes identify VT100 with AVO, not a newer terminal. Status/cursor
  replies, terminal-parameter reports, and applicable reset/test commands are
  supported.

### Physical and browser limits

- The original VT100 baud-report table ends at 19200. At 115200 or another
  unencodable transport rate, terminal-parameter queries report a documented
  **virtual 19200-baud VT100** and show a warning; the real serial connection
  stays at its configured rate.
- Physical ROM/RAM tests, alternate character ROMs, loopback plugs, modem
  diagnostics, CRT scan/interlace timing, and optional STP/graphics processors
  are not browser hardware.
  Unsupported hardware diagnostics are not reported as successful tests.
- Smooth scrolling is a browser presentation animation at nominal VT100 speed.
  Rendering is frame-coalesced and does not delay the serial parser to emulate
  the original CPU. Reduced-motion preferences disable presentation animation.
- Web Serial has one transmit/receive baud setting and only the parity/signal
  options exposed by the browser and driver. It cannot reproduce all electrical
  configurations of the original RS-232 hardware.
- This is not an xterm/VT220 implementation: no color palette, alternate-screen
  protocol, mouse reporting, UTF-8, OSC clipboard operations, or terminal-driven
  browser navigation is advertised.

## Dependency policy

Only `typescript@6.0.3` is installed, as a development dependency. It has no
runtime or optional dependencies. The application itself needs no npm package at
runtime. The prior React/CRA dependency tree and its mirror-resolved lockfile have
been removed.

Every proposed package, including transitives, must have **at least 100,000
weekly downloads**, and every selected version must be **at least 14 days old**.
The compiler is exactly pinned rather than following `latest`.

`npm run check:dependencies` uses Node built-ins and official registry metadata
to check every lockfile entry's source, version age, popularity, integrity hash,
signature presence, deprecation state, and install hooks. It fails closed if
registry evidence cannot be retrieved. Run it before `npm ci` and after any
manifest/lockfile change. `.npmrc` fixes the official registry, exact saves, and
disabled lifecycle scripts. `npm audit signatures` performs signature
verification after installation; `npm audit` checks published advisories.

At implementation time, the compiler release date was 2026-04-16, weekly
downloads were 270,587,987 (2026-09-18 through 2026-09-24), its registry signature
verified, and npm reported no known advisories. These checks reduce risk; age,
popularity, and an advisory scan do not guarantee a package is safe.

## Validation

There is deliberately no unit-test framework, mock serial device, or npm browser
test package. Verification uses the TypeScript build plus the actual
Playwright-controlled Windows browser, **COM7**, and the attached Raspberry Pi.

Use the VT100-specific portions of an available
[`vttest`](https://invisible-island.net/vttest/) on the Pi, or Pi-side
shell/Python-standard-library diagnostics. Control sequences must come from the
real tty and terminal replies/keyboard bytes must be captured there. Later
VT220/xterm tests are not evidence that the original VT100 feature set is missing.

The live acceptance checklist covers connection parameters and cancellation,
reconnect and device removal, keyboard byte sequences, cursor/erase/wrap/margins,
character sets and line presentation, reports, ANSI/VT52, sustained/split output,
flow control, and a real full-screen host application. Restore tty settings after
raw-mode diagnostics. Ask the operator before installing software, changing system
configuration, rebooting, or exercising disruptive modem signals.

### Observed real-device results

On 2026-09-26, the Windows browser connected through the user-authorized COM7
adapter at 115200/8-N-1 to the Pi's `/dev/ttyAMA3`. Python standard-library
diagnostics ran on that actual tty; no software was installed on the Pi.

| Check | Observed result |
| --- | --- |
| Protocol reports and cursor/mode behavior | 40/40 Pi-side byte-reply checks passed |
| Keyboard/keypad modes | 17/17 Pi-side raw-byte captures passed |
| Screen, erasure, regions, recovery | 17/17 Pi-driven screen fixtures passed |
| Display | 24 rows, 80/132 columns, graphics, UK characters, attributes, double-sized lines, LEDs, and literal markup verified in DOM and screenshots |
| Reconnect | Three repeated close/open cycles each received a distinct acknowledgement from the Pi |
| Physical USB removal | Unplugging the adapter produced an explicit device-loss error and a clean disconnected state; reconnecting the reinserted adapter received a fresh Pi acknowledgement |
| Connection form | Invalid baud rejected; Cancel left the port closed; authorized-device reconnect worked without reopening the native chooser |
| Software flow control | Host XOFF held keyboard data until host XON; priority Ctrl-Q passed; NO SCROLL buffered actual received bytes until resume |
| Reset while paused | Reset cleared NO SCROLL, sent XON, and correctly answered a status query buffered during the pause |
| Full-screen application | Live `top` ran with `TERM=vt100`; quitting restored the original tty attributes and size |
| Normal `htop` launch | Correctly aligned after setting the actual login to `TERM=vt100`, `LC_ALL=C`, and `24 80`; all 24 rows were 80 columns and the footer was visible |
| ncurses function keys | 16/16 additional real-Pi checks matched its terminfo capabilities and preserved native keypad/VT52 behavior; F10 quit the actual `htop` application |
| Paste boundary | 65,537 bytes rejected with zero bytes received by the Pi; a 65,536-byte paste arrived intact |
| Sustained receive/logging | All 327,712 bytes received exactly (payload plus end marker), UI remained responsive, log truncation was visible and bounded |

Logging was stopped and cleared after validation, and connection parameters were
returned to 115200/8-N-1/no flow control. Physical BREAK/modem-signal tests and
hardware loopback diagnostics were not exercised. These are observed checks, not
a claim of exhaustive conformance certification.

The `htop` follow-up caught a normal-session mismatch that the earlier temporary
`top` configuration had hidden: the Pi still had `TERM=vt220`, a UTF-8 locale,
and a `30 202` tty size. With operator approval, this login was left configured
for VT100/ASCII/24-by-80 instead of restoring the incompatible settings. No
system or shell-startup files were changed.
