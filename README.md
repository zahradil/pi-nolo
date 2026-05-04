# pi-nolo

No-YOLO mode for [pi-coding-agent](https://github.com/nichochar/pi-mono). Gates `write`, `edit`, and `bash` tool calls behind user confirmation — press Enter to allow, Escape to block.

Read-safe bash commands (`ls`, `grep`, `git status`, etc.) are auto-approved via a configurable allowlist, so you only get prompted for commands that could mutate state.

Sensitive paths (`.env`, `.git/`, `node_modules/`, etc.) are **always blocked** regardless of mode.

## Install

From git (this fork):

```bash
pi install git:github.com/zahradil/pi-nolo
```

### Note

There will be a keybinding conflict with `ctrl+y` for cycling YOLO mode and `tui.editor.yank`, so I recommend changing `~/.pi/agent/keybindings.json` to include `"tui.editor.yank": "ctrl+shift+y"`.

## What it does

Every time the agent tries to:

- **Write a file** — confirms with the file path and line count
- **Edit a file** — confirms with the file path; shows a pre-rendered diff preview before the tool finishes executing
- **Run a bash command** — auto-approves safe read-only commands; confirms everything else (long commands are truncated to 12 visual lines in the dialog)

You get a dialog: Enter to allow, Escape to block.

In non-interactive mode (no UI), all mutations are blocked by default.

## Pre-rendered edit diffs

As of pi ~0.63.0, the built-in edit tool only shows diffs after execution. This extension includes a built-in pre-renderer (ported from [pi-pre-render-edit](https://github.com/burneikis/pi-pre-render-edit)) that computes and displays the diff as soon as the tool arguments are complete — before the edit is applied. This means you can see exactly what will change while the confirmation dialog is open.

If you previously installed `pi-pre-render-edit` separately, you can remove it — the functionality is now bundled here.

## Modes

Use `/yolo` (or `ctrl+y`) to cycle through four modes at any time during a session:

| Mode            | Footer label | Write/Edit inside project | Write/Edit outside project | Bash                              |
| --------------- | ------------ | ------------------------- | -------------------------- | --------------------------------- |
| `off` (default) | `nolo`       | confirm                   | confirm                    | confirm (safe cmds auto-approved) |
| `writes`        | `writes`     | **auto-allow**            | confirm                    | confirm (safe cmds auto-approved) |
| `roam`          | `roam`       | **auto-allow**            | **auto-allow**             | confirm (safe cmds auto-approved) |
| `yolo`          | `yolo`       | **auto-allow**            | **auto-allow**             | **auto-allow**                    |

Cycle order:

```
off → writes → roam → yolo → off → …
```

The current mode is shown in the footer status bar and persisted in the session so it survives a `/reload`.

### When to use each mode

- **`writes`** — working inside a project; edits are auto-approved but the agent can't silently escape the project root, and bash is still gated.
- **`roam`** — you want the agent to freely edit files anywhere (e.g. updating dotfiles or global config), while keeping bash confirmations.
- **`yolo`** — fully hands-free. The agent can do anything. Use with caution.

> **Note:** Protected paths (`.env`, `.git/`, `node_modules/`, etc.) are **always blocked** in every mode, including `yolo`.

## Bash Command Allowlist

Safe commands are auto-approved without a confirmation dialog. A command is considered safe when:

1. It starts with a recognized safe prefix (e.g., `ls`, `grep`, `git status`)
2. It does **not** contain any dangerous patterns (command substitution, stdout redirects, etc.)

### Default safe prefixes

```
ls, cat, head, tail, wc, find, grep, rg, fd, tree,
file, stat, du, df, which, whoami, pwd, echo, date, uname,
env, printenv, git status, git log, git diff, git show,
git branch, git remote, git tag, git rev-parse,
npm list, npm outdated, npm view, node --version,
python --version, cargo --version, rustc --version, go version
```

### Dangerous pattern guard

Even if a command starts with a safe prefix, it will still require confirmation if it contains:

- Command substitution (`` ` ``, `$()`)
- Stdout redirections (`>`, `>>`)
- Dangerous commands (`rm`, `sudo`, `eval`, `exec`, `source`, `sh`, `bash`)
- Dangerous flags on otherwise safe commands (e.g. `git branch -d`, `sort -o`)

Pipes (`|`), `&&`, and `;` are handled at the segment level — each segment is checked individually, so `ls | grep foo` is safe while `ls | rm -rf /` is not.

## Protected Paths

The following paths are always hard-blocked, regardless of mode:

```
.env, .env.local, .env.production, .git/, node_modules/, .venv/
```

The agent gets a clear error message and the write is rejected. This list can be extended via config (see below).

## Configuration

Customize the allowlist and protected paths with a `nolo.json` config file:

- **Project-level:** `.pi/nolo.json` (takes precedence)
- **Global:** `~/.pi/agent/nolo.json`

### Config format

```json
{
  "safePrefixes": ["make build", "docker ps", "kubectl get"],
  "dangerousPatterns": ["\\brm\\b", "\\bsudo\\b"],
  "protectedPaths": [".env", ".secrets/"]
}
```

### Merge behavior

- **`safePrefixes`** — merged (union of defaults + global + project)
- **`protectedPaths`** — merged (union of defaults + global + project)
- **`dangerousPatterns`** — overridden (project overrides global overrides defaults)

If no config files exist, the hardcoded defaults are used. See [`nolo.example.json`](nolo.example.json) for the full default configuration.

### Example: add custom safe commands

Create `.pi/nolo.json` in your project:

```json
{
  "safePrefixes": ["make build", "docker ps", "kubectl get pods"]
}
```

These will be added to the defaults — you don't need to re-list the built-in prefixes.

### Example: add extra protected paths

```json
{
  "protectedPaths": [".secrets/", "config/credentials.yml"]
}
```

## License

MIT
