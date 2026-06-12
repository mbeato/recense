// Intentionally empty — the renderer (Phase 15 frontend at http://127.0.0.1:7810)
// is a D-102 shell-agnostic web client that communicates exclusively over
// HTTP/SSE. It requires zero Node.js or IPC access from the Electron shell.
// This file must exist because webPreferences.preload references it, but it
// exposes nothing — no native bridge APIs are forwarded to the renderer.
export {};
