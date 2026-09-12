import * as sdk from "@hermes/plugin-sdk";
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

const ID = "hermes-ssh";
const VERSION = "0.3.3";
// Public verification key only. The release signing key never ships to users.
const UPDATE_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdDcg2pf4qQg4y89ZLfoIhfJqyKP+bJMA0Q0YVDK0VAbAgyVi5CaodDuUgibOqTx1zQg9xrXdzYbCvpgMjIFBCw==";
const UPDATE_REPO = "Adolanium/hermes-ssh";
const UPDATE_LIMIT = 500_000;
const updateState = sdk.atom({ busy: false, message: "", error: "", backup: null, available: null, restoreAvailable: null });
const UPDATE_LOCK = Symbol.for("hermes-ssh.update-lock");

function updatePatch(value) {
  if (!disposed) updateState.set({ ...updateState.get(), ...value });
}
function versionParts(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("The release has an invalid version.");
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Invalid release version.");
  return parts;
}
function newerVersion(next, current) {
  const a = versionParts(next), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function decode64(value) {
  if (typeof value !== "string" || value.length > 12_000)
    throw new Error("Invalid update signature.");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifyRelease(release) {
  if (release.draft || release.prerelease) throw new Error("This is not a stable release.");
  const match = String(release.body || "").match(/```hermes-ssh-update\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("This release has no signed update. The installed version is unchanged.");
  const envelope = JSON.parse(match[1]);
  const payload = decode64(envelope.payload);
  const key = await crypto.subtle.importKey("spki", decode64(UPDATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
    decode64(envelope.signature), payload))
    throw new Error("The update signature is invalid. Nothing was installed.");
  const info = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  versionParts(info.version);
  if (info.schema !== 1 || info.plugin !== ID || release.tag_name !== `v${info.version}` ||
      !/^[a-f0-9]{40}$/.test(info.commit) || !/^[a-f0-9]{64}$/.test(info.sha256) ||
      !Number.isInteger(info.bytes) || info.bytes < 1 || info.bytes > UPDATE_LIMIT)
    throw new Error("The signed release metadata is invalid.");
  return info;
}
async function fetchUpdateText(url, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit",
      referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    if (response.status === 404) {
      const error = new Error("The release file is unavailable on GitHub. Try again later.");
      error.status = 404;
      throw error;
    }
    if (response.status === 403 || response.status === 429)
      throw new Error("GitHub is limiting update checks. Try again later.");
    if (!response.ok) throw new Error(`Update download failed (${response.status}). Try again later.`);
    if (Number(response.headers.get("content-length")) > limit || !response.body)
      throw new Error("The update download is too large or empty.");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error("The update download is too large."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Update check timed out. Try again.");
    throw error;
  } finally { clearTimeout(timeout); }
}
function updateDesktop() {
  const desktop = globalThis.window?.hermesDesktop;
  if (!desktop?.desktopPluginsRoot || !desktop?.readFileText || !desktop?.writeTextFile || !desktop?.renamePath)
    throw new Error("Open this plugin in Hermes Desktop to update it. This Desktop must support local plugin files.");
  return desktop;
}
async function readUpdateFile(desktop, path) {
  const result = await desktop.readFileText(path);
  if (result.truncated || typeof result.text !== "string" || new TextEncoder().encode(result.text).length > UPDATE_LIMIT)
    throw new Error("The plugin file could not be read completely.");
  return result.text;
}
async function updateLocation(desktop) {
  const root = await desktop.desktopPluginsRoot();
  if (typeof root !== "string" || !root.trim()) throw new Error("Desktop's local plugin folder is unavailable.");
  return root.replace(/[\\/]+$/, "") + "/" + ID;
}
function backupKey(dir) { return "updater:backup:" + dir; }
function validBackup(record) {
  return record && /^plugin\.backup-[a-f0-9-]{36}\.js$/.test(record.name) && /^[a-f0-9]{64}$/.test(record.sha256);
}
async function loadUpdateBackup() {
  try {
    const dir = await updateLocation(updateDesktop());
    const record = await context?.storage.get(backupKey(dir), null);
    updatePatch({ backup: validBackup(record) ? record : null });
  } catch { /* SSH remains usable on Desktop versions without updater APIs. */ }
}
// Only Electron-local filesystem APIs are used here, never shell.exec or an SSH profile.
// Stage and verify first. Renaming preserves the old file if the final step fails.
async function replacePlugin(desktop, dir, before, next, storage) {
  const file = dir + "/plugin.js";
  const stage = "plugin.staged-" + crypto.randomUUID() + ".js";
  const backup = { name: "plugin.backup-" + crypto.randomUUID() + ".js", sha256: await digest(before) };
  await desktop.writeTextFile(dir + "/" + stage, next);
  if (await readUpdateFile(desktop, dir + "/" + stage) !== next)
    throw new Error("The staged update could not be verified. The installed version is unchanged.");
  if (disposed || state.get().busy || state.get().panel || await updateLocation(desktop) !== dir || await readUpdateFile(desktop, file) !== before)
    throw new Error("The Desktop profile or installed plugin changed. Reload Desktop and check again.");
  const previousRecord = await storage.get(backupKey(dir), null);
  let moved = false;
  try {
    await storage.set(backupKey(dir), backup);
    await desktop.renamePath(file, backup.name);
    moved = true;
    await desktop.renamePath(dir + "/" + stage, "plugin.js");
  } catch (error) {
    try { if (moved) await desktop.renamePath(dir + "/" + backup.name, "plugin.js"); }
    catch { throw new Error(`Update failed. Restore ${backup.name} to plugin.js in ${dir}, then reload Desktop.`); }
    await storage.set(backupKey(dir), previousRecord);
    throw new Error("Update failed. The previous plugin was restored. " + error.message);
  }
  return backup;
}
function dismissUpdate() {
  if (!updateState.get().busy) updatePatch({ available: null, restoreAvailable: null, message: "", error: "" });
}
async function runUpdate() {
  updatePatch({ busy: false, available: null, restoreAvailable: null, error: '', message: "This package uses Hermes updates. Run hermes plugins update hermes-ssh, then rescan Desktop plugins." });
}
const ROUTE = "/ssh-connections";
const host = sdk.host;
const state = sdk.atom({
  machines: [],
  origin: "",
  loading: true,
  error: "",
  selected: null,
  panel: false,
  busy: "",
  notice: "",
});
let context = null;
let disposed = false;
let routeVersion = 0;
let managementRoute = null;
let returnFocus = null;

function ownerKey() {
  const owner = host.state.focusedSessionOwner?.get();
  return JSON.stringify(
    owner || {
      connectionId: host.state.connectionId?.get(),
      profile: host.state.profile?.get(),
    },
  );
}
// All operations use stock gateway methods. Users install only this file.
let platformPromise;
const endpoint = (m) => JSON.stringify([m.host, m.user, m.port, m.key, m.cwd]);
async function rpc(method, params = {}) {
  const route = await managementRoute;
  if (!route)
    throw new Error(
      "Reconnect the originating Hermes host before managing SSH.",
    );
  return host.requestProfile(route, method, params, 100000);
}
async function scope() {
  const route = await managementRoute;
  if (!route) throw new Error("The originating Hermes host is unavailable.");
  return JSON.stringify([route.connectionId, route.targetProfile]);
}
async function records() {
  return context.storage.get("machines:" + (await scope()), []);
}
async function persist(list) {
  context.storage.set("machines:" + (await scope()), list);
}
async function getMachine(id) {
  const value = (await records()).find((m) => m.id === id);
  if (!value)
    throw new Error(
      "Machine no longer exists. Open Connections and select it again.",
    );
  return value;
}
async function replaceMachine(m, expected) {
  const list = await records();
  const old = list.find((x) => x.id === m.id);
  if (expected && JSON.stringify(old) !== JSON.stringify(expected))
    throw new Error("This connection changed during setup. Select it again.");
  await persist([...list.filter((x) => x.id !== m.id), m]);
  return m;
}
async function shell(command) {
  const r = await rpc("shell.exec", { command });
  if (r.code !== 0)
    throw new Error(
      r.stderr ||
        r.stdout ||
        "SSH command failed. Check access and your SSH agent.",
    );
  return String(r.stdout || "").trim();
}
async function windows() {
  platformPromise ||= shell("echo %OS%").then((s) => s === "Windows_NT");
  return platformPromise;
}
function quote(value, win) {
  value = String(value);
  if (/[\r\n\0]/.test(value))
    throw new Error("Line breaks are not allowed in SSH settings.");
  if (win) {
    if (/["%!^&|<>]/.test(value))
      throw new Error(
        "This Windows path contains unsupported shell characters. Choose a simple path.",
      );
    return '"' + value + '"';
  }
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function validateMachine(m) {
  const record = Object.fromEntries(
    ["name", "host", "user", "cwd", "key"].map((k) => [
      k,
      String(m[k] || "").trim(),
    ]),
  );
  record.cwd ||= "~";
  record.port = Number(m.port || 22);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(record.name))
    throw new Error(
      "Use a name with letters, numbers, hyphens or underscores, up to 48 characters.",
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:%-]*$/.test(record.host))
    throw new Error("Enter a hostname, SSH alias or IP address.");
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]*$/.test(record.user))
    throw new Error("Enter the remote account's username.");
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535)
    throw new Error("Port must be between 1 and 65535.");
  if (!/^(\/|~\/|~$)/.test(record.cwd) || /[\r\n\0]/.test(record.cwd))
    throw new Error("Use an absolute remote folder or ~/folder.");
  if (record.key && !/^(\/|[a-zA-Z]:[\\/])/.test(record.key))
    throw new Error("Use an absolute private-key path on the Hermes host.");
  return record;
}
async function testConnection(m) {
  if (!m.trusted)
    throw new Error(
      "Review first-use host trust and file synchronization before connecting.",
    );
  const win = await windows();
  const args = [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    "-p",
    String(m.port),
  ];
  if (m.key) args.push("-i", m.key);
  args.push("-l", m.user, m.host, "bash", "-c", "pwd");
  const cwd = await shell(args.map((x) => quote(x, win)).join(" "));
  if (!cwd.startsWith("/"))
    throw new Error(
      "The remote machine did not return a Bash working directory.",
    );
  const resolved =
    m.cwd === "~" ? cwd : m.cwd.startsWith("~/") ? cwd + m.cwd.slice(1) : m.cwd;
  const folderArgs = args.slice(0, -3);
  folderArgs.push("test", "-d", quote(resolved, false), "-a", "-x", quote(resolved, false));
  await shell(folderArgs.map((x) => quote(x, win)).join(" "));
  return replaceMachine(
    {
      ...m,
      last_test: { at: Date.now() / 1000, os: "Bash available", cwd: resolved },
    },
    m,
  );
}
async function api(operation, payload = {}) {
  if (operation === "list")
    return { machines: await records(), origin: "the originating Hermes host" };
  if (operation === "save") {
    const list = await records(),
      old = list.find((x) => x.id === payload.id);
    const clean = validateMachine(payload);
    if (
      list.some(
        (x) =>
          x.id !== old?.id && x.name.toLowerCase() === clean.name.toLowerCase(),
      )
    )
      throw new Error("A machine already uses that name.");
    if (payload.id && !old)
      throw new Error("This connection was removed. Add it again.");
    const same = old && endpoint(old) === endpoint(clean);
    return replaceMachine(
      {
        ...clean,
        id: old?.id || crypto.randomUUID(),
        trusted: !!(same && old.trusted),
        last_test: same ? old.last_test : null,
      },
      old,
    );
  }
  if (operation === "remove") {
    await persist((await records()).filter((x) => x.id !== payload.id));
    return {};
  }
  if (operation === "scan") return { token: payload.id, fingerprints: [] };
  if (operation === "trust") {
    const m = await getMachine(payload.token);
    return replaceMachine({ ...m, trusted: true }, m);
  }
  if (operation === "test") return testConnection(await getMachine(payload.id));
  if (operation === "keys")
    return {
      keys: context.storage.get("keys:" + (await scope()), []),
      agent_ready: false,
    };
  if (operation === "public-key") {
    const win = await windows();
    const path = payload.path;
    if (!path || !/^(\/|[a-zA-Z]:[\\/])/.test(path))
      throw new Error("Enter an absolute key path first.");
    const key = await shell(
      (win ? "type " : "cat ") + quote(path + ".pub", win),
    );
    if (!/^(ssh-|ecdsa-)/.test(key) || key.includes("PRIVATE KEY"))
      throw new Error("The matching .pub file is not an SSH public key.");
    return key;
  }
  if (operation === "keygen") {
    if (payload.confirm_unencrypted !== true)
      throw new Error("Confirm creation of a key without a passphrase.");
    const win = await windows();
    const home = await shell(
      win ? "echo %USERPROFILE%" : "printf '%s' \"$HOME\"",
    );
    const folder = home + (win ? "\\.ssh" : "/.ssh");
    const q = quote(folder, win);
    await shell(win ? `if not exist ${q} mkdir ${q}` : `mkdir -p ${q}`);
    const path =
      folder +
      (win ? "\\" : "/") +
      "hermes_desktop_" +
      crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    await shell(`ssh-keygen -q -t ed25519 -N "" -f ${quote(path, win)}`);
    const public_key = await api("public-key", { path });
    const key = { name: path.split(/[\\/]/).at(-1), path, public_key };
    const sk = "keys:" + (await scope());
    context.storage.set(sk, [...context.storage.get(sk, []), key]);
    return key;
  }
  if (operation === "prepare") {
    const machine = await testConnection(await getMachine(payload.id));
    const profile =
      "ssh-" +
      machine.name.slice(0, 18).toLowerCase() +
      "-" +
      crypto.randomUUID().slice(0, 8);
    const created = await rpc("profiles.create", {
      name: profile,
      description: `SSH: ${machine.name} (${machine.host})`,
      no_skills: true,
      mirror_credentials: true,
    });
    if (!created.ok)
      throw new Error("Hermes could not create the SSH workspace.");
    const terminal = {
      backend: "ssh",
      ssh_host: machine.host,
      ssh_user: machine.user,
      ssh_port: machine.port,
      ssh_key: machine.key,
      cwd: machine.last_test.cwd,
      timeout: 120,
    };
    // This is a newly created profile. Replace its default terminal section as
    // one mapping before Desktop starts any task on it.
    const result = await rpc("cli.exec", {
      argv: [
        "--profile",
        profile,
        "config",
        "set",
        "--force",
        "terminal",
        JSON.stringify(terminal),
      ],
    });
    if (result.blocked || result.code !== 0)
      throw new Error(
        result.hint ||
          result.output ||
          "Workspace configuration failed. The task was not opened.",
      );
    const current = await getMachine(machine.id);
    if (endpoint(current) !== endpoint(machine))
      throw new Error(
        "The machine changed during connection. Select it again.",
      );
    return { profile, machine };
  }
  throw new Error("Unknown SSH operation.");
}

function patch(value) {
  if (!disposed) state.set({ ...state.get(), ...value });
}
async function refresh() {
  const version = ++routeVersion;
  try {
    const data = await api("list");
    if (version === routeVersion) patch({ ...data, loading: false, error: "" });
  } catch (e) {
    if (version === routeVersion) patch({ loading: false, error: e.message });
  }
}
function openPanel(machine = null) {
  returnFocus = typeof document === "undefined" ? null : document.activeElement;
  patch({ selected: machine, panel: true, error: "", notice: "" });
  host.navigate(ROUTE);
}
function closePanel() {
  patch({ panel: false, selected: null });
  requestAnimationFrame(() => {
    if (returnFocus?.isConnected) returnFocus.focus();
    else document.querySelector(".hssh-heading button")?.focus();
  });
}
async function connect(machine) {
  if (state.get().busy) return;
  const origin = ownerKey();
  patch({
    busy: machine.id,
    error: "",
    notice: `Connecting to ${machine.name}…`,
  });
  try {
    const ready = await api("prepare", { id: machine.id });
    if (disposed || origin !== ownerKey())
      throw new Error(
        "The active Hermes connection changed. Select the machine again to open it.",
      );
    const routes = await host.profileRoutes();
    const connection = (await managementRoute)?.connectionId;
    const route = routes.find(
      (r) =>
        r.profile === ready.profile &&
        (!connection || r.connectionId === connection),
    );
    if (!route)
      throw new Error(
        "The SSH profile was created. Restart Hermes Desktop to discover it, then connect again.",
      );
    host.newChat(route);
    patch({ notice: `Workspace ready on ${machine.name}`, panel: false });
  } catch (e) {
    patch({ error: e.message, notice: "" });
    host.navigate(ROUTE);
  } finally {
    patch({ busy: "" });
  }
}
async function middleware(draft) {
  const match = /^\/ssh(?:\s+(.*))?\s*$/i.exec(draft.text.trim());
  if (!match) return draft;
  // Always consume our command, including errors. Throwing middleware is
  // passed to the model by core; a connection failure must not do that.
  try {
    if (draft.attachments?.length)
      throw new Error("Send attachments after opening the SSH workspace.");
    host.navigate(ROUTE);
    const name = (match[1] || "").trim();
    const data = await api("list");
    patch({ ...data, loading: false, error: "" });
    if (!name) {
      patch({ panel: !data.machines.length });
      return null;
    }
    const machine = data.machines.find(
      (x) => x.name.toLowerCase() === name.toLowerCase(),
    );
    if (!machine) {
      openPanel({ name });
      return null;
    }
    if (!machine.trusted) {
      openPanel(machine);
      return null;
    }
    await connect(machine);
  } catch (e) {
    patch({ error: e.message, loading: false });
    host.navigate(ROUTE);
  }
  return null;
}

const CSS = `
.hssh{--ssh-bg:var(--ui-surface-background,Canvas);--ssh-raised:var(--ui-bg-secondary,Canvas);--ssh-text:var(--ui-text-primary,CanvasText);--ssh-muted:var(--ui-text-secondary,GrayText);--ssh-line:var(--ui-stroke-secondary,ButtonBorder);color:var(--ssh-text);background:var(--ssh-bg);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;height:100%;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--ssh-line) transparent;container-type:inline-size}
.hssh *{box-sizing:border-box}.hssh ::selection{background:var(--ui-accent);color:var(--ssh-bg)}.hssh button,.hssh input,.hssh select{font:inherit}.hssh button{cursor:pointer}.hssh button:disabled{cursor:default;opacity:.48}.hssh :focus-visible{outline:2px solid var(--ui-accent);outline-offset:4px}.hssh input{caret-color:var(--ui-accent)}
.hssh-main{max-width:1160px;margin:auto;padding:52px 48px 32px}.hssh-heading{display:flex;align-items:center;justify-content:space-between;gap:24px}.hssh h1{font-size:30px;line-height:1.2;letter-spacing:-.035em;font-weight:600;margin:0}.hssh-subtitle{color:var(--ssh-muted);margin:9px 0 0;max-width:60ch}.hssh-tabs{display:flex;gap:24px;border-bottom:1px solid var(--ssh-line);margin:30px 0 30px}.hssh-tab{padding:0 1px 13px;border-bottom:2px solid var(--ssh-text);display:flex;align-items:center;gap:8px;font-weight:600}.hssh-tab small{font-size:11px;font-weight:400;color:var(--ssh-muted);margin-left:3px}
.hssh-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:8px 14px;border:1px solid var(--ssh-line);border-radius:8px;background:transparent;color:var(--ssh-text);white-space:nowrap;transition:background .16s ease,border-color .16s ease}.hssh-btn:hover:not(:disabled){background:var(--ssh-raised);border-color:var(--ssh-muted)}.hssh-btn.primary{background:var(--ssh-text);color:var(--ssh-bg);border-color:transparent;font-weight:600}.hssh-btn.primary:hover:not(:disabled){opacity:.88;background:var(--ssh-text)}.hssh-btn.quiet{border-color:transparent;padding:6px 8px}.hssh-btn.danger{color:var(--ui-red)}.hssh-icon{width:17px;height:17px;display:inline-block;flex:none}.hssh-icon svg{display:block;width:100%;height:100%}
.hssh-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:28px;align-items:start}.hssh-grid.editing{grid-template-columns:minmax(230px,.8fr) minmax(330px,1.2fr)}.hssh-section-line{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.hssh-section-line h2{font-size:13px;font-weight:600;margin:0}.hssh-section-line span{font-size:12px;color:var(--ssh-muted)}
.hssh-empty{border:1px solid var(--ssh-line);border-radius:14px;min-height:330px;display:flex;align-items:center;justify-content:center;padding:35px 25px;text-align:center}.hssh-empty h2{font-size:21px;letter-spacing:-.025em;font-weight:550;margin:24px 0 8px}.hssh-empty p{max-width:39ch;color:var(--ssh-muted);margin:0 auto 23px}.hssh-empty .hssh-diagram{width:206px;height:72px;margin:0 auto;color:var(--ssh-muted)}.hssh-diagram .endpoint{color:var(--ssh-text)}.hssh-diagram .signal{stroke-dasharray:3 5;animation:ssh-flow 3s linear infinite}@keyframes ssh-flow{to{stroke-dashoffset:-32}}.hssh-grid.editing .hssh-empty{min-height:230px}.hssh-grid.editing .hssh-empty .hssh-diagram{width:155px}.hssh-grid.editing .hssh-empty h2{font-size:18px}
.hssh-machine{display:flex;align-items:center;gap:17px;padding:22px 2px;border-bottom:1px solid var(--ssh-line);min-width:0}.hssh-machine:first-child{border-top:1px solid var(--ssh-line)}.hssh-machine-icon{width:42px;height:42px;display:grid;place-items:center;background:var(--ssh-raised);border-radius:10px;flex:none}.hssh-machine-icon .hssh-icon{width:22px;height:22px}.hssh-machine-info{min-width:0;flex:1}.hssh-machine-name{font-size:15px;font-weight:600;letter-spacing:-.015em;overflow-wrap:anywhere}.hssh-machine-address{font-size:12px;color:var(--ssh-muted);overflow-wrap:anywhere;margin-top:2px}.hssh-machine-status{font-size:11px;margin-top:7px;display:flex;gap:5px;align-items:center;color:var(--ssh-muted)}.hssh-machine-status .hssh-icon{width:13px;height:13px}.hssh-machine-actions{display:flex;gap:5px;align-items:center}.hssh-grid.editing .hssh-machine{flex-wrap:wrap;padding:18px 0;gap:12px}.hssh-grid.editing .hssh-machine-actions{margin-left:54px}.hssh-folder{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--ssh-muted);margin-top:5px;overflow-wrap:anywhere}
.hssh-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;color:var(--ssh-muted);font-size:12px;padding:22px 0;margin-top:12px}.hssh-footer code,.hssh-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:var(--ssh-raised);padding:4px 7px;border-radius:4px;color:var(--ssh-text)}.hssh-footer span{display:flex;gap:7px;align-items:center}.hssh-note{font-size:12px;color:var(--ssh-muted);max-width:65ch}.hssh-notice{padding:12px 15px;border:1px solid var(--ssh-line);border-radius:8px;margin:0 0 22px;display:flex;align-items:flex-start;gap:10px;overflow-wrap:anywhere}.hssh-notice.error{color:var(--ui-red)}.hssh-notice p{margin:0;flex:1}.hssh-notice .hssh-btn{min-height:24px;padding:0 3px}
.hssh-panel{border:1px solid var(--ssh-line);border-radius:14px;overflow:hidden;animation:ssh-panel .22s cubic-bezier(.16,1,.3,1)}@keyframes ssh-panel{from{clip-path:inset(0 0 5% 0);opacity:.5}to{clip-path:inset(0);opacity:1}}.hssh-panel-head{padding:22px 24px 18px;display:flex;justify-content:space-between;gap:12px;align-items:flex-start;background:var(--ssh-raised)}.hssh-panel-head h2{font-size:19px;font-weight:600;letter-spacing:-.025em;margin:0}.hssh-panel-head p{font-size:12px;color:var(--ssh-muted);margin:4px 0 0}.hssh-panel-body{padding:24px}.hssh-steps{display:flex;gap:18px;align-items:center;margin:0 0 25px;font-size:12px;color:var(--ssh-muted)}.hssh-step{display:flex;gap:6px;align-items:center}.hssh-step.current{color:var(--ssh-text);font-weight:600}.hssh-step .hssh-icon{width:14px;height:14px}.hssh-form{display:flex;flex-direction:column;gap:18px}.hssh-field{display:flex;flex-direction:column;gap:6px;min-width:0}.hssh-field>span{font-weight:550;font-size:12px}.hssh-field input,.hssh-field select{width:100%;min-height:39px;border:1px solid var(--ssh-line);border-radius:7px;padding:8px 11px;background:var(--ssh-bg);color:var(--ssh-text);min-width:0}.hssh-field input::placeholder{color:var(--ssh-muted);opacity:.85}.hssh-field small{font-size:11px;color:var(--ssh-muted)}.hssh-fields{display:grid;grid-template-columns:1fr 90px;gap:12px}.hssh-input-row{display:flex;gap:8px;align-items:center}.hssh-input-row .hssh-field{flex:1}.hssh-panel-foot{margin-top:25px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--ssh-line);padding-top:20px}.hssh-inline-link{border:0;background:none;padding:0;text-decoration:underline;text-underline-offset:3px;color:var(--ssh-muted);font-size:12px}.hssh-key-actions{display:flex;flex-wrap:wrap;gap:12px}.hssh-key-copy{background:var(--ssh-raised);border-radius:8px;padding:12px;overflow-wrap:anywhere;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;margin:12px 0}.hssh-fingerprint{font:11px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;padding:13px 0;border-bottom:1px solid var(--ssh-line)}.hssh-fingerprint span{display:block;color:var(--ssh-muted);font:11px/1.8 inherit}.hssh-check{display:flex;gap:9px;align-items:flex-start;font-size:12px;cursor:pointer;margin-top:16px}.hssh-check input{margin-top:4px;accent-color:var(--ui-accent)}.hssh-success{display:flex;align-items:center;gap:12px;margin-bottom:20px}.hssh-success .hssh-icon{width:26px;height:26px;color:var(--ui-green)}.hssh-success h3{font-size:17px;font-weight:550;margin:0}.hssh-success p{margin:2px 0 0;color:var(--ssh-muted);font-size:12px}.hssh-details{margin:0}.hssh-details>div{display:flex;justify-content:space-between;gap:18px;border-bottom:1px solid var(--ssh-line);padding:11px 0}.hssh-details dt{font-size:12px;color:var(--ssh-muted)}.hssh-details dd{margin:0;font-size:12px;text-align:right;overflow-wrap:anywhere}.hssh-remove{margin-top:18px;padding-top:17px;border-top:1px solid var(--ssh-line)}.hssh-remove p{font-size:12px;color:var(--ssh-muted)}.hssh-loading{padding:80px 0;color:var(--ssh-muted);text-align:center}.hssh-origin{font-size:11px;color:var(--ssh-muted)}
@container(max-width:850px){.hssh-main{padding:32px 25px}.hssh-grid.editing{grid-template-columns:1fr}.hssh-grid.editing>section:first-child{display:none}.hssh-panel{max-width:580px;width:100%;justify-self:center}.hssh-heading{gap:12px}.hssh h1{font-size:27px}}
@container(max-width:480px){.hssh-main{padding:24px 18px}.hssh-heading{align-items:flex-start}.hssh-heading>.hssh-btn{padding:8px 10px}.hssh-subtitle{font-size:12px}.hssh-footer{flex-direction:column;align-items:flex-start;gap:9px}.hssh-machine{flex-wrap:wrap}.hssh-machine-actions{margin-left:59px}.hssh-panel-head,.hssh-panel-body{padding:18px}.hssh-empty{min-height:300px}.hssh-steps{gap:12px}}
.hssh-updates{border-top:1px solid var(--ssh-line);margin-top:28px;padding-top:20px}.hssh-update-row{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}.hssh-update-row strong{font-size:12px;font-weight:600}.hssh-update-row p,.hssh-update-status{font-size:12px;color:var(--ssh-muted);margin:4px 0;overflow-wrap:anywhere}.hssh-update-status{margin-top:12px}.hssh-update-status.error{color:var(--ui-red)}.hssh-updates>.hssh-btn{margin-top:10px}
@media(prefers-reduced-motion:reduce){.hssh *{animation:none!important;transition:none!important}}
`;

// Geometry only: a consistent set of small interface symbols.
const paths = {
  server: [
    "M4 3h16v7H4z",
    "M4 14h16v7H4z",
    "M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5",
  ],
  plus: ["M12 5v14M5 12h14"],
  arrow: ["M5 12h14M13 6l6 6-6 6"],
  close: ["M6 6l12 12M18 6L6 18"],
  check: ["M5 12l4 4L19 6"],
  shield: ["M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z", "M8 12l3 3 5-6"],
  key: ["M14 10a5 5 0 1 0-4 4l9 7 3-3-3-3 1-2-3-1z"],
  folder: ["M3 6h7l2 3h9v11H3z"],
  terminal: ["M5 6l6 6-6 6M13 18h6"],
  more: ["M5 12h.01M12 12h.01M19 12h.01"],
  copy: ["M9 9h12v12H9zM15 5V3H3v12h2"],
  refresh: ["M20 7v5h-5M4 17v-5h5", "M6 6a8 8 0 0 1 13 1M18 18A8 8 0 0 1 5 17"],
  alert: ["M12 3L2 21h20zM12 9v5M12 17h.01"],
  back: ["M19 12H5M11 6l-6 6 6 6"],
};
function Icon({ name }) {
  return jsx("span", {
    className: "hssh-icon",
    "aria-hidden": true,
    children: jsx("svg", {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      children: (paths[name] || paths.server).map((d, i) =>
        jsx("path", { d }, i),
      ),
    }),
  });
}
function Button({ children, icon, variant = "", ...props }) {
  return jsxs("button", {
    type: "button",
    className: `hssh-btn ${variant}`,
    ...props,
    children: [icon && jsx(Icon, { name: icon }), children],
  });
}
function Field({ label, hint, ...props }) {
  return jsxs("label", {
    className: "hssh-field",
    children: [
      jsx("span", { children: label }),
      jsx("input", props),
      hint && jsx("small", { children: hint }),
    ],
  });
}
function Diagram() {
  return jsxs("svg", {
    className: "hssh-diagram",
    viewBox: "0 0 206 72",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": true,
    children: [
      jsx("path", {
        className: "endpoint",
        d: "M10 17h44v31H10zM5 54h54M20 54l2-6h20l2 6M152 12h44v20h-44zM152 40h44v20h-44zM158 22h2M158 50h2M169 22h19M169 50h19",
      }),
      jsx("path", { d: "M69 36h65", className: "signal" }),
      jsx("path", { d: "M126 31l8 5-8 5" }),
    ],
  });
}
function Notice({ error, children, dismiss }) {
  return jsxs("div", {
    className: `hssh-notice ${error ? "error" : ""}`,
    role: error ? "alert" : "status",
    children: [
      jsx(Icon, { name: error ? "alert" : "check" }),
      jsx("p", { children }),
      dismiss &&
        jsx(Button, {
          icon: "close",
          variant: "quiet",
          "aria-label": "Dismiss message",
          onClick: dismiss,
        }),
    ],
  });
}
function Empty({ onAdd }) {
  return jsx("div", {
    className: "hssh-empty",
    children: jsxs("div", {
      children: [
        jsx(Diagram, {}),
        jsx("h2", { children: "Your next workspace is out there." }),
        jsx("p", {
          children:
            "Connect a machine once. Let Hermes work with its files, tools, and terminal whenever you need it.",
        }),
        jsx(Button, {
          variant: "primary",
          icon: "plus",
          onClick: onAdd,
          children: "Add your first machine",
        }),
      ],
    }),
  });
}
function Machine({ machine, busy }) {
  return jsxs("article", {
    className: "hssh-machine",
    children: [
      jsx("div", {
        className: "hssh-machine-icon",
        children: jsx(Icon, { name: "server" }),
      }),
      jsxs("div", {
        className: "hssh-machine-info",
        children: [
          jsx("div", {
            className: "hssh-machine-name",
            children: machine.name,
          }),
          jsx("div", {
            className: "hssh-machine-address",
            children: `${machine.user ? machine.user + "@" : ""}${machine.host}${machine.port !== 22 ? ":" + machine.port : ""}`,
          }),
          jsx("div", { className: "hssh-folder", children: machine.cwd }),
          jsxs("div", {
            className: "hssh-machine-status",
            children: [
              jsx(Icon, { name: machine.last_test ? "check" : "shield" }),
              machine.last_test
                ? `Connected ${new Date(machine.last_test.at * 1000).toLocaleDateString()}`
                : machine.trusted
                  ? "Ready to test access"
                  : "Setup required",
            ],
          }),
        ],
      }),
      jsxs("div", {
        className: "hssh-machine-actions",
        children: [
          jsx(Button, {
            onClick: () =>
              machine.trusted ? connect(machine) : openPanel(machine),
            disabled: !!busy,
            children: busy === machine.id ? "Connecting…" : "Connect",
          }),
          jsx(Button, {
            variant: "quiet",
            icon: "more",
            "aria-label": `Edit ${machine.name}`,
            onClick: () => openPanel(machine),
            disabled: !!busy,
          }),
        ],
      }),
    ],
  });
}

function Setup({ selected, onClose }) {
  const [form, setForm] = useState({
    name: "",
    host: "",
    user: "",
    port: 22,
    cwd: "~",
    key: "",
    ...selected,
  });
  const [stage, setStage] = useState("details");
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [scan, setScan] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [keyInfo, setKeyInfo] = useState({ keys: [], agent_ready: false });
  const [publicKey, setPublicKey] = useState("");
  const [createKey, setCreateKey] = useState(false);
  const [remove, setRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const stepFocus = useRef(null);
  useEffect(() => {
    api("keys")
      .then(setKeyInfo)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (stage !== "details") stepFocus.current?.focus();
  }, [stage]);
  function field(name) {
    return {
      value: form[name],
      onChange: (e) => {
        setForm({ ...form, [name]: e.target.value });
        setError("");
      },
    };
  }
  async function perform(label, fn) {
    setWorking(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking("");
    }
  }
  async function save() {
    await perform("Saving…", async () => {
      const saved = await api("save", form);
      setForm(saved);
      await refresh();
      if (saved.trusted) {
        const tested = await api("test", { id: saved.id });
        setForm(tested);
        setStage("ready");
        await refresh();
      } else {
        setScan(await api("scan", { id: saved.id }));
        setStage("trust");
      }
    });
  }
  async function trust() {
    await perform("Testing connection…", async () => {
      const trusted = await api("trust", { token: scan.token });
      setForm(trusted);
      const tested = await api("test", { id: trusted.id });
      setForm(tested);
      setStage("ready");
      await refresh();
    });
  }
  async function copyKey() {
    const ok = await context.os.writeClipboard(publicKey);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else
      setError("Clipboard unavailable. Select and copy the public key below.");
  }
  const details = jsxs("form", {
    className: "hssh-form",
    onSubmit: (e) => {
      e.preventDefault();
      save();
    },
    children: [
      jsx(Field, {
        label: "Machine name",
        placeholder: "my-machine-1",
        ...field("name"),
        autoFocus: true,
        required: true,
        maxLength: 48,
        hint: "The name you use with /ssh.",
      }),
      jsx(Field, {
        label: "Host",
        placeholder: "192.168.1.42 or devbox.example.com",
        ...field("host"),
        required: true,
      }),
      jsxs("div", {
        className: "hssh-fields",
        children: [
          jsx(Field, {
            label: "Username",
            placeholder: "Remote account username",
            required: true,
            ...field("user"),
          }),
          jsx(Field, {
            label: "Port",
            type: "number",
            min: 1,
            max: 65535,
            ...field("port"),
            required: true,
          }),
        ],
      }),
      jsx(Field, {
        label: "Remote folder",
        placeholder: "~/projects",
        ...field("cwd"),
        required: true,
      }),
      jsxs("label", {
        className: "hssh-field",
        children: [
          jsx("span", { children: "Authentication" }),
          jsx("select", {
            value: form.key || "",
            onChange: (e) => {
              setForm({ ...form, key: e.target.value });
              setPublicKey(
                keyInfo.keys.find((k) => k.path === e.target.value)
                  ?.public_key || "",
              );
            },
            children: [
              jsx("option", {
                value: "",
                children: "SSH agent / existing SSH configuration",
              }),
              ...keyInfo.keys.map((k) =>
                jsx("option", { value: k.path, children: k.name }, k.path),
              ),
              ...(form.key && !keyInfo.keys.some((k) => k.path === form.key)
                ? [
                    jsx(
                      "option",
                      { value: form.key, children: form.key },
                      "custom",
                    ),
                  ]
                : []),
            ],
          }),
          jsx("small", {
            children: keyInfo.agent_ready
              ? "Your SSH agent has an identity loaded."
              : "For encrypted keys, unlock your SSH agent before connecting.",
          }),
        ],
      }),
      jsx(Field, {
        label: "Private key path",
        placeholder: "Optional · use SSH agent",
        ...field("key"),
        hint: "Path on the originating Hermes host. Private keys never enter chat.",
      }),
      jsxs("div", {
        className: "hssh-key-actions",
        children: [
          jsx("button", {
            type: "button",
            className: "hssh-inline-link",
            onClick: () => setCreateKey(!createKey),
            children: "Create a dedicated key",
          }),
          form.key &&
            jsx("button", {
              type: "button",
              className: "hssh-inline-link",
              onClick: () =>
                perform("Reading public key…", async () => {
                  setPublicKey(await api("public-key", { path: form.key }));
                }),
              children: "Show public key",
            }),
        ],
      }),
      createKey &&
        jsxs("div", {
          children: [
            jsx("p", {
              className: "hssh-note",
              children:
                "Creates an Ed25519 key without a passphrase using OpenSSH. To use a passphrase or hardware key, choose an existing key instead.",
            }),
            jsx(Button, {
              disabled: !!working,
              onClick: () =>
                perform("Creating key…", async () => {
                  const k = await api("keygen", { confirm_unencrypted: true });
                  setForm({ ...form, key: k.path });
                  setPublicKey(k.public_key);
                  setKeyInfo(await api("keys"));
                  setCreateKey(false);
                }),
              icon: "key",
              children: "Create key without passphrase",
            }),
          ],
        }),
      publicKey &&
        jsxs("div", {
          children: [
            jsx("p", {
              className: "hssh-note",
              children:
                "Add this public key to the remote account's authorized_keys or your hosting provider's SSH keys. Keep the private key on this machine.",
            }),
            jsx("div", { className: "hssh-key-copy", children: publicKey }),
            jsx(Button, {
              icon: "copy",
              onClick: copyKey,
              children: copied ? "Copied" : "Copy public key",
            }),
          ],
        }),
      jsxs("div", {
        className: "hssh-panel-foot",
        children: [
          jsx(Button, {
            onClick: onClose,
            disabled: !!working,
            variant: "quiet",
            children: "Cancel",
          }),
          jsx("button", {
            type: "submit",
            className: "hssh-btn primary",
            disabled: !!working,
            children:
              working || (form.trusted ? "Save & test connection" : "Continue"),
          }),
        ],
      }),
    ],
  });
  const trustView = jsxs("div", {
    children: [
      jsx("h3", {
        ref: stepFocus,
        tabIndex: -1,
        style: { marginTop: 0, fontSize: 16, fontWeight: 550 },
        children: `Verify ${form.name}`,
      }),
      jsx("p", {
        className: "hssh-note",
        children:
          "Add your public key through the machine’s console before continuing. Stock Hermes accepts a new host key on first connection and rejects changed keys. Its SSH backend synchronizes selected Hermes credentials, skills and cache files to this machine.",
      }),
      ...(scan?.fingerprints || []).map((f) =>
        jsxs(
          "div",
          {
            className: "hssh-fingerprint",
            children: [jsx("span", { children: f.algorithm }), f.fingerprint],
          },
          f.fingerprint,
        ),
      ),
      jsxs("label", {
        className: "hssh-check",
        children: [
          jsx("input", {
            type: "checkbox",
            checked: accepted,
            onChange: (e) => setAccepted(e.target.checked),
          }),
          "I allow first-use host trust and Hermes file synchronization to this machine.",
        ],
      }),
      jsxs("div", {
        className: "hssh-panel-foot",
        children: [
          jsx(Button, {
            variant: "quiet",
            icon: "back",
            disabled: !!working,
            onClick: () => {
              setStage("details");
              setAccepted(false);
            },
            children: "Back",
          }),
          jsx(Button, {
            variant: "primary",
            disabled: !accepted || !!working,
            onClick: form.trusted
              ? () =>
                  perform("Testing…", async () => {
                    const tested = await api("test", { id: form.id });
                    setForm(tested);
                    setStage("ready");
                    await refresh();
                  })
              : trust,
            children:
              working ||
              (form.trusted ? "Retry connection" : "Test connection"),
          }),
        ],
      }),
    ],
  });
  const readyView = jsxs("div", {
    children: [
      jsxs("div", {
        className: "hssh-success",
        children: [
          jsx(Icon, { name: "check" }),
          jsxs("div", {
            children: [
              jsx("h3", {
                ref: stepFocus,
                tabIndex: -1,
                children: "Ready when you are.",
              }),
              jsx("p", { children: `Connected to ${form.name}` }),
            ],
          }),
        ],
      }),
      jsx("dl", {
        className: "hssh-details",
        children: [
          ["Machine", form.host],
          ["System", form.last_test?.os || "Remote Bash"],
          ["Folder", form.last_test?.cwd || form.cwd],
          ["Authentication", form.key ? "Private key" : "SSH agent / config"],
        ].map(([a, b]) =>
          jsxs(
            "div",
            {
              children: [
                jsx("dt", { children: a }),
                jsx("dd", { children: b }),
              ],
            },
            a,
          ),
        ),
      }),
      jsx("p", {
        className: "hssh-note",
        style: { marginTop: 20 },
        children:
          "Terminal commands and file edits use this machine. The stock SSH backend synchronizes selected Hermes credentials, skills and caches. Your agent remains on the originating host.",
      }),
      jsxs("div", {
        className: "hssh-panel-foot",
        children: [
          jsx(Button, {
            variant: "quiet",
            onClick: () => setStage("details"),
            children: "Edit details",
          }),
          jsx(Button, {
            variant: "primary",
            icon: "arrow",
            onClick: () => connect(form),
            disabled: !!state.get().busy,
            children: "Open workspace",
          }),
        ],
      }),
    ],
  });
  return jsxs("section", {
    className: "hssh-panel",
    "aria-label": "Machine setup",
    children: [
      jsxs("div", {
        className: "hssh-panel-head",
        children: [
          jsxs("div", {
            children: [
              jsx("h2", {
                children: selected?.id ? "Machine settings" : "Add a machine",
              }),
              jsx("p", { children: "A little setup. A new place to work." }),
            ],
          }),
          jsx(Button, {
            variant: "quiet",
            icon: "close",
            "aria-label": "Close setup",
            disabled: !!working,
            onClick: onClose,
          }),
        ],
      }),
      jsxs("div", {
        className: "hssh-panel-body",
        children: [
          jsx("div", {
            className: "hssh-steps",
            children: [
              ["details", "Details", "server"],
              ["trust", "Verify", "shield"],
              ["ready", "Ready", "check"],
            ].map(([id, title, icon]) =>
              jsxs(
                "span",
                {
                  className: `hssh-step ${stage === id ? "current" : ""}`,
                  "aria-current": stage === id ? "step" : undefined,
                  children: [jsx(Icon, { name: icon }), title],
                },
                id,
              ),
            ),
          }),
          error && jsx(Notice, { error: true, children: error }),
          stage === "details"
            ? details
            : stage === "trust"
              ? trustView
              : readyView,
          selected?.id &&
            stage === "details" &&
            jsxs("div", {
              className: "hssh-remove",
              children: [
                remove
                  ? jsxs("div", {
                      children: [
                        jsx("p", {
                          children:
                            "Remove this saved connection? Existing tasks, keys, and remote files will remain.",
                        }),
                        jsx(Button, {
                          variant: "danger",
                          disabled: !!working,
                          onClick: () =>
                            perform("Removing…", async () => {
                              await api("remove", { id: selected.id });
                              await refresh();
                              onClose();
                            }),
                          children: "Remove connection",
                        }),
                        jsx(Button, {
                          variant: "quiet",
                          onClick: () => setRemove(false),
                          children: "Keep it",
                        }),
                      ],
                    })
                  : jsx("button", {
                      type: "button",
                      className: "hssh-inline-link",
                      onClick: () => setRemove(true),
                      children: "Remove saved connection",
                    }),
              ],
            }),
        ],
      }),
    ],
  });
}

function Page() {
  const s = sdk.useValue(state);
  useEffect(() => {
    refresh();
  }, []);
  return jsxs("div", {
    className: "hssh",
    children: [
      jsx("style", { children: CSS }),
      jsxs("main", {
        className: "hssh-main",
        children: [
          jsxs("header", {
            className: "hssh-heading",
            children: [
              jsxs("div", {
                children: [
                  jsx("h1", { children: "Connections" }),
                  jsx("p", {
                    className: "hssh-subtitle",
                    children: "Your machines. One place to work.",
                  }),
                ],
              }),
              jsx(Button, {
                variant: "primary",
                icon: "plus",
                onClick: () => openPanel(),
                disabled: !!s.busy,
                children: "Add machine",
              }),
            ],
          }),
          jsx("div", {
            className: "hssh-tabs",
            children: jsxs("div", {
              className: "hssh-tab",
              children: [
                jsx(Icon, { name: "terminal" }),
                "SSH",
                jsx("small", { children: "Remote workspaces" }),
              ],
            }),
          }),
          s.error &&
            jsx(Notice, {
              error: true,
              dismiss: () => patch({ error: "" }),
              children: s.error,
            }),
          s.notice &&
            jsx(Notice, {
              dismiss: () => patch({ notice: "" }),
              children: s.notice,
            }),
          s.loading
            ? jsx("div", {
                className: "hssh-loading",
                role: "status",
                children: "Loading your machines…",
              })
            : jsxs("div", {
                className: `hssh-grid ${s.panel ? "editing" : ""}`,
                children: [
                  jsxs("section", {
                    "aria-label": "Saved SSH machines",
                    children: [
                      jsxs("div", {
                        className: "hssh-section-line",
                        children: [
                          jsx("h2", {
                            children: s.origin
                              ? `SSH connections from ${s.origin}`
                              : "SSH connections",
                          }),
                          jsx(Button, {
                            variant: "quiet",
                            icon: "refresh",
                            onClick: refresh,
                            "aria-label": "Refresh connections",
                          }),
                        ],
                      }),
                      s.machines.length
                        ? s.machines.map((machine) =>
                            jsx(Machine, { machine, busy: s.busy }, machine.id),
                          )
                        : jsx(Empty, { onAdd: () => openPanel() }),
                    ],
                  }),
                  s.panel &&
                    jsx(
                      Setup,
                      {
                        selected: s.selected,
                        onClose: closePanel,
                      },
                      s.selected?.id || s.selected?.name || "new",
                    ),
                ],
              }),
          jsxs("footer", {
            className: "hssh-footer",
            children: [
              jsxs("span", {
                children: [
                  jsx(Icon, { name: "terminal" }),
                  "Next time, just type",
                  jsx("code", { children: "/ssh machine-name" }),
                ],
              }),
              jsxs("span", {
                children: [
                  jsx(Icon, { name: "shield" }),
                  "SSH private keys stay on this host",
                ],
              }),
            ],
          }),
          jsx("p", {
            className: "hssh-note",
            children:
              "Requires SSH access and Bash on the remote machine. Browsers and other integrations keep their current location.",
          }),
          jsx(UpdateControls, { disabled: !!s.busy || s.panel }),
        ],
      }),
    ],
  });
}

function UpdateControls({ disabled = false }) {
  const update = sdk.useValue(updateState);
  return jsxs("section", {
    className: "hssh-updates",
    "aria-label": "Plugin updates",
    children: [
      jsxs("div", {
        className: "hssh-update-row",
        children: [
          jsxs("div", {
            children: [
              jsx("strong", { children: `Hermes SSH v${VERSION}` }),
              jsx("p", { children: disabled ? "Finish machine setup before updating." : "Check for a new version. You choose when to install it." }),
            ],
          }),
          jsx(Button, {
            icon: "refresh", disabled: disabled || update.busy,
            onClick: () => runUpdate(),
            children: update.busy ? "Please wait…" : "Check for updates",
          }),
        ],
      }),
      (update.message || update.error) && jsx("p", {
        className: `hssh-update-status${update.error ? " error" : ""}`,
        role: update.error ? "alert" : "status",
        children: update.error || update.message,
      }),
      update.available && jsxs("div", {
        className: "hssh-key-actions",
        role: "group",
        "aria-label": `Install Hermes SSH v${update.available.version}?`,
        children: [
          jsx(Button, { variant: "primary", disabled: disabled || update.busy,
            onClick: () => runUpdate("install"), children: "Update now" }),
          jsx(Button, { variant: "quiet", disabled: update.busy,
            onClick: dismissUpdate, children: "Later" }),
        ],
      }),
      update.restoreAvailable && jsxs("div", {
        className: "hssh-key-actions",
        role: "group",
        "aria-label": "Confirm restore",
        children: [
          jsx(Button, { variant: "primary", disabled: disabled || update.busy,
            onClick: () => runUpdate("restore-confirm"), children: "Restore now" }),
          jsx(Button, { variant: "quiet", disabled: update.busy,
            onClick: dismissUpdate, children: "Cancel" }),
        ],
      }),
      update.backup && !update.restoreAvailable && jsx(Button, {
        variant: "quiet", disabled: disabled || update.busy,
        onClick: () => runUpdate("restore"), children: "Restore previous version",
      }),
    ],
  });
}

export default {
  id: ID,
  name: "SSH",
  description: "Saved machines. Remote workspaces. Connect with /ssh.",
  register(ctx) {
    context = ctx;
    disposed = false;
    loadUpdateBackup();
    platformPromise = null;
    const profile = host.state.profile?.get() || "default";
    const connection = host.state.connectionId?.get();
    managementRoute = host.profileRoutes
      ? host
          .profileRoutes()
          .then((routes) =>
            routes.find(
              (r) =>
                r.profile === profile &&
                (!connection || r.connectionId === connection),
            ),
          )
          .catch(() => null)
      : Promise.resolve(null);
    const contributions = [
      {
        id: "page",
        area: sdk.ROUTES_AREA,
        data: { path: ROUTE },
        render: () => jsx(Page, {}),
      },
      {
        id: "nav",
        area: sdk.SIDEBAR_NAV_AREA,
        order: 56,
        data: { path: ROUTE, label: "SSH", codicon: "remote" },
      },
      {
        id: "open",
        area: sdk.PALETTE_AREA,
        data: {
          id: "hermes-ssh.open",
          label: "SSH: Open connections",
          keywords: ["ssh", "remote", "machines"],
          run: () => host.navigate(ROUTE),
        },
      },
    ];
    if (
      sdk.COMPOSER_AREAS?.middleware &&
      host.profileRoutes &&
      host.requestProfile &&
      host.newChat
    ) {
      contributions.push({
        id: "ssh-command",
        area: sdk.COMPOSER_AREAS.middleware,
        order: -100,
        data: { handler: middleware },
      });
    } else
      patch({
        loading: false,
        error:
          "This Desktop version lacks the plugin routing APIs required by SSH. Update Hermes Desktop.",
      });
    ctx.registerMany(contributions);
    ctx.onDispose(() => {
      disposed = true;
      ++routeVersion;
      context = null;
    });
  },
};
export const __test = {
  VERSION,
  UPDATE_KEY,
  updateState,
  newerVersion,
  verifyRelease,
  fetchUpdateText,
  replacePlugin,
  runUpdate,
  dismissUpdate,
  UpdateControls,
  quote,
  validateMachine,
  testConnection,
  middleware,
  connect,
  api,
  CSS,
  Page,
  Setup,
  state,
};
