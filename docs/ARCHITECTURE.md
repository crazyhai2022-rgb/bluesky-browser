# BlueSky Browser: Phase 1 Architecture

Status legend used across the project: **[WORKING]** implemented and tested, **[PARTIAL]** implemented with known gaps, **[PLANNED]** not started, **[PLACEHOLDER]** stub only.

## 1. Proposed Architecture

**Engine decision: Electron (Chromium) with `WebContentsView` per tab. No Chromium fork.**

| Layer | Choice | Why |
|---|---|---|
| Engine | Electron (latest stable) | Real Chromium, real navigation, supported partitions, per-session proxy, permission handlers |
| Language | TypeScript (strict) | Maintainability |
| UI shell | React + Vite | Browser chrome (tab strip, toolbar, container manager) |
| Local data | SQLite via `better-sqlite3` | Containers, bookmarks, history, settings metadata |
| Secrets | Electron `safeStorage` (Windows DPAPI / macOS Keychain) + optional master password (Argon2id/scrypt, AES-256-GCM) | OS-protected keys, no plaintext |
| Packaging | Electron Builder (NSIS `.exe`, `.dmg`) | Mature signing/notarization support |

### Process model
- **Main process**: owns containers, sessions, proxy config, vault, DB, permissions, downloads. The only process with Node access.
- **Shell renderer** (React UI): sandboxed, `contextIsolation: true`, `nodeIntegration: false`, talks to main only through a minimal typed `contextBridge` API.
- **Tab views** (`WebContentsView`): one per tab, each created with `session.fromPartition('persist:container-<uuid>')`. Sandboxed, no preload exposing OS APIs. Only a tiny, origin-checked autofill preload is attached.

### Container = Session partition
Creating a container generates a UUID and a dedicated persistent partition `persist:container-<uuid>`. Cookies, localStorage, IndexedDB, Cache Storage, HTTP cache, service workers, and permissions are stored in separate on-disk directories per partition. Deleting a container calls `session.clearStorageData()` + `clearCache()` + `clearAuthCache()` and removes the partition directory on next start.

## 2. Is Electron sufficient for the required isolation?

**Yes for storage and per-container proxy. No for hardware/network-stack identity.** Documented honestly:

### Isolated per container
- Cookies, localStorage, sessionStorage, IndexedDB, Cache Storage, service workers, HTTP cache, auth cache
- Site permissions (camera, mic, location, notifications) decisions
- Proxy route (`session.setProxy` is per session)
- Downloads attribution (tracked per container in main)

### NOT isolated (will be stated in the in-app Privacy Limitations page)
- Hardware and software fingerprint: GPU, fonts, screen, CPU cores, canvas/WebGL output, user agent family. All containers share one Chromium build and one machine.
- Shared OS-level resources: OS DNS cache (when not using a proxy), system clock, installed fonts
- IP address, unless the user configures a different proxy per container. Containers do not get different IPs automatically.
- Behavioral correlation by websites (timing, usage patterns, same payment method, same device cookies set outside the browser)
- A single browser process family: a Chromium zero-day affects all containers

**Conclusion:** Electron is sufficient for the stated goals (session isolation, per-container proxy, privacy controls). A Chromium fork would only add fingerprint-level control, which the brief does not require and which is not worth the maintenance cost. Trade-off recorded: we inherit Electron's release cadence and must ship security updates promptly.

## 3. Realistic MVP Scope

| Feature | MVP | Notes |
|---|---|---|
| Tabs, back/forward/reload, address bar, search engine setting | Yes | Core shell |
| Containers CRUD, color, emoji, description, pin, search, sort, duplicate config | Yes | JSON then SQLite |
| Persistent isolated sessions per container | Yes | Core feature |
| Per-container proxy (HTTP/SOCKS5, auth), status indicator, strict mode (fail closed) | Yes | Tested |
| Pop-up blocking, permission prompts, HTTPS-first, third-party tracker blocking (list based) | Yes | Basic |
| Clear data per container / all | Yes | |
| Password manager: save, autofill (origin-bound), vault lock, auto-lock, master password | Yes (core) | Backup/restore in Phase 4 |
| Bookmarks, history, downloads with warnings, recently closed, session restore | Yes | Phase 6 |
| Privacy dashboard (blocked request counts) | Yes | Counts from `webRequest` |
| Windows `.exe` installer, macOS `.dmg` | Build config in Phase 8 | Signing needs certificates |
| Extensions support, sync, built-in VPN, fingerprint randomization | **No** | Out of scope |

## 4. Technical Limitations and Risks

1. **Electron is not a full browser**: no Chrome extension store, limited extension APIs, no built-in PDF/print parity with Chrome in all cases.
2. **Fingerprinting is not defeated.** We will not claim otherwise.
3. **Proxy auth**: handled through the app `login` event; credentials stored in the vault, never in plaintext.
4. **DNS leakage**: Chromium resolves hostnames remotely for SOCKS5 proxies and through the proxy for HTTP CONNECT. In strict mode we configure explicit proxy rules with no `direct://` fallback and verify with packet-level tests. WebRTC is restricted via `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` per web contents. Claims are limited to what tests prove.
5. **Fail closed**: explicit proxy rules without a direct fallback produce `ERR_PROXY_CONNECTION_FAILED` instead of leaking. Verified by automated test (Phase 5).
6. **Password autofill security**: must be bound to exact origin (scheme + host + port), run only from the isolated preload, never injected into iframes of different origin. Highest-risk module, gets its own review.
7. **Signing and notarization costs**: Apple Developer Program (about USD 99/year), a Windows code-signing certificate (OV/EV, roughly USD 100 to 400/year; EV gives instant SmartScreen reputation). Without them, users see security warnings. Unsigned builds are for testing only.
8. **Cross-platform builds**: macOS builds must be produced on macOS (or macOS CI runner). Windows builds on Windows or CI. This sandbox can build the source and run unit tests, but cannot produce signed installers.
9. **Auto-update** requires a hosted release feed (e.g. GitHub Releases) and signed artifacts.
10. **Policy boundary**: no features to evade platform enforcement, fabricate identities or location, or bypass account restrictions. The UI will state that containers and proxies do not make sessions unrelated in the eyes of a website, and that users must follow each platform's terms.

## 5. Project Folder Structure

```
bluesky-browser/
├─ package.json
├─ tsconfig.json
├─ electron-builder.yml            (Phase 8)
├─ assets/                         logo.svg, logo.png, icons
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ SECURITY.md                  (Phase 7)
│  ├─ PRIVACY-LIMITATIONS.md       (Phase 5)
│  ├─ RELEASE.md                   (Phase 8)
│  ├─ TROUBLESHOOTING.md
│  └─ QA-CHECKLIST.md              (Phase 7)
├─ src/
│  ├─ main/
│  │  ├─ main.ts                   app bootstrap, secure window
│  │  ├─ containers.ts             container store + partitions
│  │  ├─ tabs.ts                   WebContentsView tab manager
│  │  ├─ network.ts                proxy config, strict mode
│  │  ├─ privacy.ts                tracker blocking, permissions
│  │  ├─ vault.ts                  password vault + crypto
│  │  ├─ db.ts                     SQLite access
│  │  └─ ipc.ts                    validated IPC handlers
│  ├─ preload/
│  │  ├─ shell.ts                  contextBridge API for UI
│  │  └─ autofill.ts               origin-bound autofill helper
│  └─ renderer/                    React UI (toolbar, tabs, containers)
├─ tests/
│  ├─ unit/                        vault crypto, URL parsing, proxy rules
│  └─ e2e/                         isolation, proxy fail-closed (Playwright)
└─ scripts/                        build, license inventory
```

## 6. Step-by-Step Implementation Plan

| Phase | Deliverable | Exit test |
|---|---|---|
| 1 | This document, threat model | Reviewed |
| 2 | Shell: window, tabs, address bar, navigation | Navigate real sites, multi-tab |
| 3 | Containers + partitions | Login in A does not appear in B; cookie/localStorage separation test |
| 4 | Vault + autofill | No plaintext in DB (test greps DB file); origin-bound fill test |
| 5 | Privacy + proxy | Strict mode proxy-down test blocks traffic; permissions test |
| 6 | Bookmarks, history, downloads, settings, session restore | Restart restores tabs |
| 7 | Security and QA | Electron security checklist, dependency audit, manual QA |
| 8 | Installers | `.exe` and `.dmg` built on proper runners; sign/notarize steps documented |

## 7. Threat Model (summary)

| Threat | Mitigation |
|---|---|
| Malicious page accesses OS APIs | Sandbox on, `nodeIntegration` off, `contextIsolation` on, no shell preload in tab views |
| Cross-container session leak | Separate persistent partitions, tested |
| Vault theft from disk | `safeStorage` key + optional master password, AES-256-GCM, no plaintext |
| Autofill to wrong origin | Exact-origin match, no cross-origin iframe fill |
| Proxy fallback to direct | Explicit rules, no direct fallback in strict mode, tested |
| Malicious external links (`file:`, custom protocols) | Scheme allowlist, confirmation for external protocol handlers |
| Compromised update | Signed artifacts, HTTPS feed |
| Telemetry privacy | None by default, crash reporting opt-in only |
