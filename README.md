# BlueSky Browser

A privacy-focused desktop browser with separate **containers** (isolated sessions), built on Electron/Chromium, TypeScript. Made for people who manage several client accounts and want their logins and cookies kept apart. Everything stays on your computer: no account, no cloud, no telemetry.

> **Status: early MVP (work in progress).** Not ready for daily use and no installers yet. See "What works" and "Not built yet" below.

## What works

- **Containers**: create, edit, rename, duplicate (settings only), pin, search, sort, delete. Each container has its own persistent Electron session partition, so cookies, localStorage, IndexedDB, cache and service workers are separate.
- **Per-container proxy** (HTTP / HTTPS / SOCKS5): saved per container. No direct fallback in the proxy rules, so an unreachable proxy makes pages fail instead of connecting directly. The proxy host is validated so extra rules cannot be smuggled in.
- **Password vault**: AES-256-GCM encrypted file, key protected by the OS (Windows DPAPI / macOS Keychain via Electron `safeStorage`) or by a master password (scrypt). Auto-lock, exact-origin matching, cross-container use off by default, encrypted backup and restore.
- **Browser shell**: tabs, address bar, back/forward/reload, container picker, Containers and Passwords panels. Only `http(s)` pages can be opened in a tab. Web pages get no Node access (sandbox on, context isolation on) and all site permissions are denied by default.

## Not built yet

- Autofill and "save password?" prompts in web pages (the vault itself is ready)
- Tracker blocking, cookie controls, permission prompts, HTTPS-first, download warnings, privacy dashboard
- Bookmarks, history, downloads, session restore
- Proxy username/password login and live connection status (it only shows "configured")
- React UI (the shell is plain JS for now)
- SQLite storage (containers are stored in a JSON file for now)
- Windows `.exe` and macOS `.dmg` installers, code signing, auto-update

## Honest limits

Containers separate browser storage. They do **not** hide your device fingerprint, and they do not change your IP address by themselves (that needs a separate proxy per container). A proxy does not make you anonymous or stop websites from linking sessions. This project does not try to evade any platform's rules or security checks; follow each platform's terms.

## Run it

Requires Node.js 22+.

```bash
npm install
npm run build
npm start          # opens the browser
npm test           # unit tests (25)
npm run test:ui    # UI smoke test (jsdom, stubbed backend)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
