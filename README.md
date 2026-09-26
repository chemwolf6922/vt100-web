# VT100 Web Serial Console

A VT100 serial terminal for your web browser.

**[Open the console](https://chemwolf6922.github.io/vt100-web/)**

Use desktop Chrome or Edge on the computer connected to your serial device.

## Build and run

Use Node.js 22.14.0 and npm.

```sh
git clone https://github.com/chemwolf6922/vt100-web.git
cd vt100-web
npm run check:dependencies
npm ci
npm audit signatures
npm start
```

Open <http://localhost:3000>. With remote VS Code, forward port 3000 and open
the forwarded address in the browser on your device-connected computer.

To build the static site:

```sh
npm run build
```

The output is in `build/`, ready to serve over HTTPS. After editing source,
rebuild, disconnect any active serial session, and reload the page.
Use `npm run typecheck` to check TypeScript.

## Connect a device

1. Click **Connect serial**.
2. Set the baud rate and serial options to match your device. Defaults are
   **115200 baud, 8 data bits, no parity, 1 stop bit, no flow control**.
3. Click **Select device and connect**, then choose the port in the browser
   prompt. Previously authorized devices also appear in the connection form.
4. Click the terminal to type.
5. Click **Disconnect** when finished or before using another serial program.

Open the app through HTTPS or localhost to enable browser serial access.
Authorize the device separately for each site address you use.

### Linux host setup

After logging in, run this before starting full-screen applications such as
`htop`:

```sh
export TERM=vt100 LC_ALL=C
stty rows 24 cols 80
```

This sets the current shell to VT100, ASCII text, and an 80-by-24 display.
For 132-column mode, select 132 columns in **SET-UP** and run `stty cols 132`.
If an application's display becomes misaligned, check these settings and
restart the application.

## Controls

| Control | Use |
| --- | --- |
| **SET-UP** / F12 | Adjust display, keyboard, tab, and bell settings. **Apply** changes this session; **Save** remembers defaults in this browser. |
| **Reset terminal** | Clear the display and restore saved terminal defaults. |
| Ctrl+Shift+V | Paste ASCII text. |
| Ctrl+C | Copy selected text, or send Ctrl+C to the device when nothing is selected. |
| Shift+Tab | Move keyboard focus out of the terminal. |
| F1-F4 | Send the VT100 PF keys. F5-F10 provide ncurses function-key shortcuts. |
| **Line Feed** | Send a line-feed character. |
| **NO SCROLL** | Pause or resume incoming output with XON/XOFF flow control enabled. |
| **BREAK** | Send a serial break. Shift sends a long break, which may disconnect or reset attached equipment. |

Expand **Raw serial log** to start, stop, or clear logging. Logs are held in
memory and may contain passwords; keep logging off while entering credentials.

## Publish with GitHub Pages

Push to `main` to build and publish automatically. You can also run
**Build and deploy Pages** from the repository's **Actions** tab.

For a fork, first set **Settings > Pages > Build and deployment > Source** to
**GitHub Actions**.
