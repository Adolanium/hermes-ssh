<div align="center">

<a href="https://github.com/NousResearch/hermes-agent">
  <img src="https://github.com/user-attachments/assets/ac2f5702-c842-4b2e-9340-737481fa0ece" width="96" height="96" alt="Nous Research Hermes mark" />
</a>

# Hermes SSH

### Pick a machine. Give Hermes a task.

Save your Raspberry Pi, development server, or build machine in Hermes Desktop. Open its workspace with a click or `/ssh machine-name`, then ask Hermes to work with its terminal and files.

**Built for [Hermes Desktop](https://github.com/NousResearch/hermes-agent) · Community plugin · v0.3.3**

[What it does](#your-machines-inside-hermes) · [Install](#install) · [Connect a machine](#connect-a-machine) · [Authentication and data](#authentication-and-data)

https://github.com/user-attachments/assets/292680af-0158-4f94-b1bd-9d5b35d01728

</div>

## Your machines, inside Hermes

Hermes SSH adds a **Connections** page to stock Hermes Desktop. Name a machine, choose its SSH key and working folder, and test access before opening a workspace.

The agent uses its normal terminal and file tools. You don't have to ask it to type an SSH command before every operation or manually edit Hermes configuration.

| Set up | Work |
| --- | --- |
| **Save a machine.** Keep its address, username, port, key path, and remote folder together. | **Connect in one step.** Choose Connect or type `/ssh my-pi` in Desktop. |
| **Bring a key or create one.** Use an existing private key, an unlocked SSH agent, or generate a dedicated Ed25519 key. | **Use ordinary prompts.** Ask Hermes to inspect a project, run tests, or edit files on that machine. |
| **Check access first.** Test SSH authentication, Bash, and the selected folder. | **Keep tasks separate.** Each connection opens a fresh Hermes profile and task. Existing tasks keep their original target. |

## One file to install

The plugin uses the existing Desktop SDK, gateway methods, and built-in Hermes SSH backend. The same [`plugin.js`](plugin.js) is both the source and the installable plugin.

No Agent fork, upstream patch, custom Python backend, build step, or package manager is needed to install it. Your existing Hermes installation supplies the agent runtime; the originating host supplies OpenSSH.

## Install

Copy [`plugin.js`](plugin.js) into your Desktop profile's plugin directory:

```text
$HERMES_HOME/desktop-plugins/hermes-ssh/plugin.js
```

For a typical macOS or Linux installation:

```text
~/.hermes/desktop-plugins/hermes-ssh/plugin.js
```

For a Windows installation using Local AppData:

```text
%LOCALAPPDATA%\hermes\desktop-plugins\hermes-ssh\plugin.js
```

Use your actual Hermes home if it differs. A named Desktop profile uses its own `profiles/<name>/desktop-plugins/hermes-ssh/plugin.js` directory beneath that home.

Open Hermes Desktop and choose **SSH** in the sidebar. If it is missing, open the command palette and choose **Reload desktop plugins**, or restart Desktop. Restarting also clears an older copy that an open page may still be using.

Only `plugin.js` is required. This README is the installation and usage guide.

## Updates

Choose **Check for updates** at the bottom of Connections. It checks the latest stable GitHub release and shows the available version. Choose **Update now** to download and install that verified version, or **Later** to dismiss it. Checking only fetches release metadata; the plugin file is downloaded and replaced after confirmation. Finish any open machine setup before updating.

The plugin checks a release signature against its built-in public key, then checks the downloaded file's SHA-256 hash and size before replacing anything. Downloads come from this repository at the exact commit named in the signed release. Unsigned releases, altered files, and automatic downgrades are rejected. This verifies the publisher and file integrity; it does not guarantee that a release has no bugs.

Desktop normally reloads the plugin after replacement. If needed, use **Reload desktop plugins** or restart Desktop. Saved machines and SSH keys are preserved. The update always goes into the local Desktop profile's plugin folder, even while working over SSH.

**Restore previous version** checks the backup from the last replacement and asks for confirmation. Choose **Restore now** to replace the plugin, or **Cancel** to leave it unchanged. Backups are also kept beside `plugin.js` as `plugin.backup-<id>.js`. If a broken version prevents the page from opening, close Desktop, move the broken `plugin.js` aside, rename the chosen backup to `plugin.js`, and reopen Desktop. A failed final rename triggers an immediate attempt to restore the old file. Desktop's file API does not provide an atomic overwrite, so a crash between renames can require this manual recovery.

Updates require Desktop's local file APIs and access to GitHub. No extra Python, updater service, Git installation, or backend modification is needed for users. Older copies without this updater need one manual installation of v0.3.0 or later. If there is no signed release yet, the check leaves the installed copy alone.

<details>
<summary>Publishing a signed update</summary>

Only maintainers need Node.js and Git for these steps. The repository remains two files. Release metadata lives in the GitHub release description.

1. Update `VERSION` in `plugin.js` and this README, test, commit, and push. Use a stable `major.minor.patch` version.
2. Keep the ECDSA P-256 private signing key outside the repository. Set `SSH_RELEASE_KEY` to its PEM path if it is not at `~/.hermes-ssh-release/signing-key.pem`. Back it up securely. Never upload it or put it in the plugin. Existing installations trust the corresponding `UPDATE_KEY`; replacing that key requires a release signed by the old key or a manual reinstall.
3. Save the following publisher script **outside the repository**, for example as `sign-release.mjs`. Run `node /path/to/sign-release.mjs FULL_COMMIT_SHA` from the repository. It creates `hermes-ssh-release-notes.md` in your system temporary directory and prints its location. It checks that the signing key matches the public key in the committed plugin.

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const commit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(commit || "")) throw new Error("Use a full commit SHA.");
const source = execFileSync("git", ["show", `${commit}:plugin.js`]);
const code = source.toString("utf8");
const version = code.match(/const VERSION = "([0-9]+\.[0-9]+\.[0-9]+)";/)?.[1];
const pinned = code.match(/const UPDATE_KEY = "([^"]+)";/)?.[1];
const key = fs.readFileSync(process.env.SSH_RELEASE_KEY ||
  path.join(os.homedir(), ".hermes-ssh-release", "signing-key.pem"));
const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
if (!version || pinned !== publicKey) throw new Error("Version missing or signing key does not match.");
const payload = Buffer.from(JSON.stringify({ schema: 1, plugin: "hermes-ssh", version,
  commit, sha256: crypto.createHash("sha256").update(source).digest("hex"), bytes: source.length }));
const signature = crypto.sign("sha256", payload, { key, dsaEncoding: "ieee-p1363" });
const envelope = { payload: payload.toString("base64"), signature: signature.toString("base64") };
const notes = `Hermes SSH v${version}\n\n\`\`\`hermes-ssh-update\n${JSON.stringify(envelope)}\n\`\`\`\n`;
const output = path.join(os.tmpdir(), "hermes-ssh-release-notes.md");
fs.writeFileSync(output, notes);
console.log(output);
```

4. Add release notes above the signed block, without changing the block. Publish a stable GitHub release tagged `v<VERSION>`, targeting the same commit, and use that file as its description. For example, `gh release create v0.3.0 --repo Adolanium/hermes-ssh --target FULL_COMMIT_SHA --notes-file /path/to/hermes-ssh-release-notes.md`. Drafts and prereleases are not offered to users.

The release signature covers the version, commit, hash, size, and plugin identity. The private key is needed only for publishing. Do not sign an unreviewed commit. For future updates, preserve the `VERSION`, `ID`, and `UPDATE_KEY` declarations used by the publisher and updater.

</details>

## Connect a machine

1. **Add the details.** Choose Add machine. Enter a short name such as `my-pi`, the host, remote username, port, and folder. Use an absolute remote folder or `~/projects`.
2. **Choose authentication.** Enter the private key's absolute path on the host running Hermes, use its SSH agent, or create a dedicated key. For a new key, copy the public key and authorize it through the remote machine's console or hosting provider.
3. **Review and connect.** Accept the host-trust and file-synchronization behavior described below, test access, then choose Open workspace.

Next time:

```text
/ssh my-pi
```

`/ssh` opens Connections. An unknown machine name opens setup with that name filled in. These are Desktop commands, intercepted before the message reaches the model.

The agent process stays on the originating Hermes host. Its terminal and environment-backed file operations use the remote machine. Browsers and other integrations retain their existing location. You don't need Hermes installed on the target.

## Authentication and data

### Keys are supported. Interactive passwords are not.

| Authentication | How to use it |
| --- | --- |
| Existing private key without a passphrase | Enter its absolute path in Private key path. |
| Passphrase-protected or hardware key | Unlock it through the originating host's SSH agent before connecting. |
| New dedicated key | Generate it in the plugin, then authorize its public key on the remote account. Generated keys have **no passphrase**. |
| Password-only account | Log in once outside the plugin with your password and add the public key to that account's `~/.ssh/authorized_keys`, preserving existing entries. Then connect with the private key. |

OpenSSH keeps the private key on the originating host. The plugin reads only the matching `.pub` file for copying; it does not put private-key contents in chat. Creating a key does not automatically install it on the server.

If you see `Permission denied (publickey,password)`, check the username, selected key, remote authorization, and whether an encrypted key is unlocked. The word `password` in that error describes a server-supported method; it does not mean the plugin can display a password prompt.

### What the remote machine receives

```text
Hermes Desktop → existing Hermes gateway → OpenSSH → remote Bash and files
```

The stock SSH backend accepts an unknown host key on first connection and rejects changed keys. This plugin does not independently verify fingerprints.

The backend also synchronizes skills, caches, and eligible credential files registered by skills or configuration. Stock credential-file rules exclude master stores such as `.env` and `auth.json` from those mounts. This is not a blanket transfer of every credential, but the target must still be a machine you trust with the selected data. Setup asks you to accept this behavior; this version has no switch to disable synchronization.

Saved machine details and generated public-key records live in Desktop plugin storage, scoped by originating connection and backend profile. Private-key files stay on disk. Creating a workspace also asks Hermes to mirror launch credentials into the new profile on the originating host.

Removing a saved machine does not erase its keys, remote files, Hermes profiles, or existing tasks.

## Compatibility and limits

- The originating host needs OpenSSH Client and `ssh-keygen` for key creation. The target needs SSH access and Bash.
- Desktop must expose plugin storage, composer middleware, profile routing, and the stock `shell.exec`, `profiles.create`, and `cli.exec` gateway methods.
- Username and port are explicit. Existing SSH aliases can be used for the host.
- Password entry, automatic public-key installation, and a bastion setup wizard are not included.
- Connecting creates a new profile and task. It does not move the current conversation or running processes. Older SSH profiles can be managed through Hermes.
- Windows paths containing unsupported shell characters are rejected. No universal compatibility with every SSH configuration or server policy is claimed.

The plugin has been installed and used successfully with a real Raspberry Pi from Windows. Automated checks cover command routing, key generation, stock profile configuration, and connection preparation against a disposable SSH target, including rejection of a missing remote folder. macOS and Linux client paths have not received the same live-machine validation.

The repository contains the complete plugin source in `plugin.js` and this guide. No additional project files are needed to install or run it.

---

**Community project.** Hermes SSH is independently maintained and is not an official Nous Research release. Hermes, Hermes Agent, and Nous Research belong to their respective owners.


## Catalog package

The `catalog/` directory packages this Desktop plugin for the Hermes plugin catalog,
using the [combined package layout](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk#one-package-both-sdks).
Catalog admission is pending. The repository does not imply approval or endorsement.

To install the package directly before catalog admission:

```sh
hermes plugins install Adolanium/hermes-ssh/catalog
```

Restart Hermes Desktop or rescan plugins, then enable the Desktop component in
Capabilities > Plugins. This package adds no Agent tools, hooks, or middleware.
It requires Hermes Desktop with combined-package support. On a remote backend,
the Desktop component must also be installed on the machine running the app.

The existing root `plugin.js` remains the standalone distribution. Keep one
installation per Desktop plugin. Before switching from a manual install, back up
and move its folder out of the Desktop plugin directory; Hermes intentionally
does not overwrite manual installations. Keep plugin settings when migrating.

After catalog admission, use `hermes plugins update hermes-ssh` and rescan
Desktop plugins to adopt a reviewed update. The packaged copy's update and restore
actions cannot replace its files from GitHub releases. Standalone signed updates
continue to use the existing root files.

For development, edit the root files, then run `python scripts/build_catalog.py`.
Commit the resulting `catalog/` files. CI runs `python scripts/build_catalog.py --check`
to keep the package current, including any companion files. Catalog packaging
releases use `catalog-v0.3.3-1` and are not marked as the latest standalone release.
