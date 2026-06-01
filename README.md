# Claude Screen Control — GNOME Shell extension

> **Repo:** `github.com/pippsza/claude-screen-gnome` ·
> **Companion to** [tg-claude-bot](https://github.com/pippsza/tg-claude-bot) (its `SCREEN_CONTROL` feature).
>
> **Platform: Linux + GNOME Shell 48–49 only.** It's a GNOME extension, so it
> does not run on macOS/Windows — there the bot's Screen feature is simply
> hidden. Built for Wayland (where `grim`/`ydotool`/Screenshot-D-Bus are
> blocked); also loads under GNOME on X11.

A tiny **local bridge** so the [tg-claude-bot](https://github.com/pippsza/tg-claude-bot)
WebApp can view the screen and click on it from a phone — on **Wayland**, where
external tools (`grim`, `ydotool`) and the `Shell.Screenshot` D-Bus are blocked.

Only code running *inside* gnome-shell can screenshot + synthesize input, so
this extension does both and exposes them over a **unix socket** (owner-only,
`0600`, in `$XDG_RUNTIME_DIR`). The bot's backend is the only client.

## Protocol (line-delimited JSON over the socket)

| Request | Effect |
|---|---|
| `{"cmd":"ping"}` | `{"ok":true,"pong":true}` |
| `{"cmd":"frame","path":"/tmp/x.png"}` | writes a full-res PNG screenshot |
| `{"cmd":"move","x":0.5,"y":0.5}` | move pointer (monitor fractions) |
| `{"cmd":"click","x":0.5,"y":0.5,"button":1}` | move + click (button 1/2/3) |

`x`/`y` are `[0..1]` fractions of the **primary monitor**.

## Install

```sh
make install        # copies to ~/.local/share/gnome-shell/extensions/claude-screen@pippsza
```
Then **log out and back in** (Wayland can't load a new extension without a
relogin) and enable it:
```sh
gnome-extensions enable claude-screen@pippsza
```

## Safety

`enable()` never throws and the virtual input device is created lazily — a
failure leaves the shell untouched (the socket just doesn't come up). The
socket is the whole attack surface: it's `0600` and the bot gates every call
behind Telegram auth + a per-user allowlist (`SCREEN_CONTROL_USER_IDS`).

GNOME 48/49, Wayland.
