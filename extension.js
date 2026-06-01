/* Claude Screen Control — GNOME Shell extension (GNOME 48/49, ESM)
 *
 * A tiny local bridge. It listens on a unix socket and answers line-delimited
 * JSON requests from the tg-claude-bot WebApp backend (same machine only):
 *
 *   {"cmd":"ping"}                              -> {"ok":true,"pong":true}
 *   {"cmd":"frame","path":"/tmp/x.png"}         -> writes a PNG, {"ok":true}
 *   {"cmd":"move","x":0.5,"y":0.5}              -> move pointer (monitor fractions)
 *   {"cmd":"click","x":0.5,"y":0.5,"button":1}  -> move + click (button 1/2/3)
 *
 * Why an extension: on Wayland the Shell.Screenshot D-Bus + grim/ydotool are
 * blocked/unavailable; only code running *inside* gnome-shell can screenshot
 * and synthesize input. So this does both, in-process.
 *
 * SAFETY: nothing here may crash the shell. enable() never throws — socket
 * setup is fully wrapped; the virtual input device is created lazily on first
 * use; every handler is guarded. Worst case: the socket doesn't come up and
 * the feature is unavailable, shell unaffected.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

function log_(msg) {
    console.log(`[claude-screen] ${msg}`);
}

export default class ClaudeScreenExtension extends Extension {
    enable() {
        this._service = null;
        this._virtual = null;
        this._sockPath = null;
        try {
            this._startSocket();
        } catch (e) {
            // Never propagate — a throw here would take down gnome-shell.
            log_(`enable failed (feature off, shell unaffected): ${e}`);
        }
    }

    disable() {
        try {
            if (this._service) {
                this._service.stop();
                this._service.close();
            }
        } catch (e) {
            log_(`service stop error: ${e}`);
        }
        this._service = null;
        if (this._sockPath) {
            try { GLib.unlink(this._sockPath); } catch (_e) {}
        }
        this._sockPath = null;
        this._virtual = null;
    }

    _socketPath() {
        // get_user_runtime_dir() == $XDG_RUNTIME_DIR (e.g. /run/user/1000);
        // must match the backend's SCREEN_CONTROL_SOCKET default.
        return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'claude-screen.sock']);
    }

    _startSocket() {
        const path = this._socketPath();
        try { GLib.unlink(path); } catch (_e) {} // drop stale socket

        const service = new Gio.SocketService();
        const addr = new Gio.UnixSocketAddress({path});
        service.add_address(addr, Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
        service.connect('incoming', (_svc, conn) => {
            this._onConnection(conn);
            return false;
        });
        service.start();
        try { GLib.chmod(path, 0o600); } catch (_e) {} // owner-only

        this._service = service;
        this._sockPath = path;
        log_(`listening on ${path}`);
    }

    _onConnection(conn) {
        let din, dout;
        try {
            din = new Gio.DataInputStream({base_stream: conn.get_input_stream()});
            dout = conn.get_output_stream();
        } catch (e) {
            log_(`conn setup error: ${e}`);
            return;
        }
        din.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            let req = null;
            try {
                const [line] = stream.read_line_finish_utf8(res);
                if (line)
                    req = JSON.parse(line);
            } catch (e) {
                this._reply(conn, dout, {ok: false, error: `parse: ${e}`});
                return;
            }
            this._dispatch(req, conn, dout);
        });
    }

    _dispatch(req, conn, dout) {
        const cmd = req && req.cmd;
        try {
            if (cmd === 'ping') {
                this._reply(conn, dout, {ok: true, pong: true});
            } else if (cmd === 'move') {
                this._move(req.x, req.y);
                this._reply(conn, dout, {ok: true});
            } else if (cmd === 'click') {
                this._click(req.x, req.y, req.button || 1, !!req.double);
                this._reply(conn, dout, {ok: true});
            } else if (cmd === 'frame') {
                // async: reply from the screenshot callback
                this._captureTo(req.path, (r) => this._reply(conn, dout, r));
            } else {
                this._reply(conn, dout, {ok: false, error: `unknown cmd: ${cmd}`});
            }
        } catch (e) {
            this._reply(conn, dout, {ok: false, error: String(e)});
        }
    }

    _reply(conn, dout, obj) {
        try {
            const bytes = new TextEncoder().encode(JSON.stringify(obj) + '\n');
            dout.write_all(bytes, null);
            dout.flush(null);
        } catch (e) {
            log_(`reply error: ${e}`);
        }
        try { conn.close(null); } catch (_e) {}
    }

    // ── pointer ──────────────────────────────────────────────────────────
    _seat() {
        if (!this._virtual) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._virtual = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        }
        return this._virtual;
    }

    _toStage(x, y) {
        // x,y are fractions [0..1] of the primary monitor.
        const disp = global.display;
        const idx = disp.get_primary_monitor();
        const geo = disp.get_monitor_geometry(idx);
        const cx = Math.max(0, Math.min(1, Number(x) || 0));
        const cy = Math.max(0, Math.min(1, Number(y) || 0));
        return [geo.x + geo.width * cx, geo.y + geo.height * cy];
    }

    _move(fx, fy) {
        const v = this._seat();
        const [x, y] = this._toStage(fx, fy);
        v.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    }

    _click(fx, fy, button, double) {
        const v = this._seat();
        const [x, y] = this._toStage(fx, fy);
        v.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        const press = () => {
            v.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED);
            v.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
        };
        press();
        if (double)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => { press(); return GLib.SOURCE_REMOVE; });
    }

    // ── screenshot (PNG to a file the backend then reads + downscales) ─────
    _captureTo(path, done) {
        try {
            const file = Gio.File.new_for_path(path);
            const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const shooter = new Shell.Screenshot();
            shooter.screenshot(false, stream, (obj, res) => {
                let ok = false, err = null;
                try {
                    obj.screenshot_finish(res);
                    ok = true;
                } catch (e) {
                    err = String(e);
                }
                try { stream.close(null); } catch (_e) {}
                done(ok ? {ok: true, path} : {ok: false, error: err || 'screenshot failed'});
            });
        } catch (e) {
            done({ok: false, error: String(e)});
        }
    }
}
