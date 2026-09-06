<div align="center">

<a href="https://github.com/NousResearch/hermes-agent">
  <img src="https://github.com/user-attachments/assets/ac2f5702-c842-4b2e-9340-737481fa0ece" width="96" height="96" alt="Nous Research Hermes mark" />
</a>

# Hermes SSH

### Pick a machine. Give Hermes a task.

Save your Raspberry Pi, development server, or build machine in Hermes Desktop. Open its workspace with a click or `/ssh machine-name`, then ask Hermes to work with its terminal and files.

**Built for [Hermes Desktop](https://github.com/NousResearch/hermes-agent) · Community plugin · v0.2.0**

[What it does](#your-machines-inside-hermes) · [Install](#install) · [Connect a machine](#connect-a-machine) · [Authentication and data](#authentication-and-data)

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
