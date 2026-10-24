// Code 页内嵌终端 — 自研实现, 不依赖主程序 /term/static/term.js
// 直接对接 /terminal/api/ws (mode=single: WS 断开即杀进程, 每次连接都是新会话)
// 帧协议: 文本帧=原始 IO; JSON 控制帧 resize/ping/close; 服务端 hello/exit/error/pong
(function () {
    'use strict';

    const PING_INTERVAL = 15000;

    const state = {
        visible: false,
        initialized: false,
        pending: null,
        runtimes: null,
        term: null,
        fit: null,
        ws: null,
        ready: false,
        closing: false,
        pingTimer: 0,
        pending: null,
        pendingResolve: null
    };

    const dom = {};

    function cacheDom() {
        dom.panel = document.getElementById('terminal-panel');
        dom.newButton = document.getElementById('btn-term-new');
        dom.killButton = document.getElementById('btn-term-kill');
        dom.hideButton = document.getElementById('btn-term-hide');
        dom.host = document.getElementById('terminal');
    }

    function setStatus(message, kind) {
        if (window.CodeUI && window.CodeUI.status) {
            window.CodeUI.status(message, kind);
        }
    }

    function notify(message, kind) {
        document.dispatchEvent(new CustomEvent('code:terminal-message', {
            detail: { message: message, kind: kind || '' }
        }));
    }

    async function loadRuntimes() {
        if (state.runtimes) { return state.runtimes; }
        try {
            state.runtimes = await window.CodeAPI.runtimes();
        } catch (err) {
            state.runtimes = {};
        }
        return state.runtimes;
    }

    function shellCommand() {
        if (state.runtimes && state.runtimes.powershell && state.runtimes.powershell.available) {
            return state.runtimes.powershell.path;
        }
        return 'powershell.exe';
    }

    function clearPing() {
        if (state.pingTimer) {
            clearInterval(state.pingTimer);
            state.pingTimer = 0;
        }
    }

    function sendFrame(payload) {
        if (state.ws && state.ws.readyState === 1) {
            state.ws.send(JSON.stringify(payload));
        }
    }

    function sendResize() {
        if (state.term && state.ready) {
            sendFrame({ type: 'resize', cols: state.term.cols, rows: state.term.rows });
        }
    }

    function teardown(keepDisplay) {
        clearPing();
        if (state.ws) {
            state.closing = true;
            try { state.ws.close(); } catch (err) { /* ignore */ }
            state.ws = null;
        }
        state.ready = false;
        if (state.term && keepDisplay) {
            try { state.term.reset(); } catch (err) { /* ignore */ }
        }
    }

    function buildTerminal() {
        if (state.term) { return; }
        const term = new Terminal({
            cursorBlink: true,
            fontFamily: 'Consolas, "Courier New", monospace',
            fontSize: 13,
            theme: {
                background: '#0d1117',
                foreground: '#c9d1d9',
                cursor: '#58a6ff',
                selectionBackground: '#264f78'
            }
        });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(dom.host);
        term.onData(function (data) {
            if (state.ready && state.ws && state.ws.readyState === 1) {
                state.ws.send(data);
            }
        });
        term.onResize(function () { sendResize(); });
        state.term = term;
        state.fit = fit;
    }

    function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = proto + '://' + location.host +
            '/terminal/api/ws?cmd=' + encodeURIComponent(shellCommand()) +
            '&cwd=' + encodeURIComponent(window.CodeAPI.workspaceRoot || '') +
            '&mode=single';
        const ws = new WebSocket(url);
        state.ws = ws;
        state.closing = false;

        ws.onmessage = function (event) {
            if (state.ws !== ws) { return; }
            if (typeof event.data !== 'string') { return; }
            const head = event.data.charAt(0);
            if (head !== '{') {
                if (state.term) { state.term.write(event.data); }
                return;
            }
            let frame = null;
            try { frame = JSON.parse(event.data); } catch (err) { return; }
            if (!frame || !frame.type) { return; }
            if (frame.type === 'hello') {
                state.ready = true;
                sendResize();
                clearPing();
                state.pingTimer = setInterval(function () { sendFrame({ type: 'ping' }); }, PING_INTERVAL);
                if (state.pendingResolve) {
                    const resolve = state.pendingResolve;
                    state.pending = null;
                    state.pendingResolve = null;
                    resolve(true);
                }
            } else if (frame.type === 'exit') {
                setStatus('终端已退出', '');
                teardown(true);
            } else if (frame.type === 'error') {
                setStatus('终端错误: ' + (frame.msg || ''), 'error');
                notify('终端错误: ' + (frame.msg || ''), 'error');
                teardown(true);
            }
        };
        ws.onclose = function () {
            if (state.ws !== ws) { return; }
            clearPing();
            const wasReady = state.ready;
            state.ready = false;
            state.ws = null;
            if (state.pendingResolve && !state.closing) {
                const resolve = state.pendingResolve;
                state.pending = null;
                state.pendingResolve = null;
                resolve(false);
            }
            if (wasReady && !state.closing) {
                setStatus('终端连接断开', 'error');
            }
        };
        ws.onerror = function () { /* onclose 会跟随触发 */ };
    }

    function waitReady(timeout) {
        if (state.ready) { return Promise.resolve(true); }
        if (state.pending) { return state.pending; }
        state.pending = new Promise(function (resolve) {
            state.pendingResolve = resolve;
            setTimeout(function () {
                if (state.pendingResolve === resolve) {
                    state.pending = null;
                    state.pendingResolve = null;
                    resolve(false);
                }
            }, timeout || 15000);
        });
        return state.pending;
    }

    async function ensureSession() {
        if (!window.CodeAPI.workspaceId) {
            throw new Error('请先打开文件夹');
        }
        if (state.ready) { return true; }
        if (!window.Terminal || !window.FitAddon) {
            throw new Error('终端组件未加载');
        }
        buildTerminal();
        teardown(false);
        connect();
        const ready = await waitReady(15000);
        if (!ready) {
            throw new Error('终端启动超时');
        }
        try { state.fit.fit(); } catch (err) { /* ignore */ }
        return true;
    }

    async function show() {
        if (!dom.panel) { return; }
        dom.panel.classList.remove('hidden');
        state.visible = true;
        try {
            await ensureSession();
            requestAnimationFrame(function () {
                try {
                    state.fit.fit();
                    state.term.focus();
                    sendResize();
                } catch (err) { /* ignore */ }
            });
            setStatus('终端已连接', 'ok');
        } catch (err) {
            setStatus('终端不可用：' + err.message, 'error');
            notify('终端不可用：' + err.message, 'error');
        }
    }

    function hide() {
        if (!dom.panel) { return; }
        dom.panel.classList.add('hidden');
        state.visible = false;
    }

    function toggle() {
        if (state.visible) {
            hide();
        } else {
            show();
        }
    }

    async function refresh() {
        if (!window.CodeAPI.workspaceId) {
            setStatus('请先打开文件夹', 'error');
            return;
        }
        try {
            teardown(true);
            await ensureSession();
            requestAnimationFrame(function () {
                try { state.fit.fit(); state.term.focus(); sendResize(); } catch (err) { /* ignore */ }
            });
            setStatus('终端已重启', 'ok');
        } catch (err) {
            setStatus('终端重启失败：' + err.message, 'error');
        }
    }

    function kill() {
        if (state.ws && state.ws.readyState <= 1) {
            sendFrame({ type: 'close' });
        }
        teardown(true);
        setStatus('终端已终止', '');
    }

    async function runCommand(command) {
        if (!window.CodeAPI.workspaceId) {
            throw new Error('请先打开文件夹');
        }
        await show();
        await ensureSession();
        if (!state.ready || !state.ws || state.ws.readyState !== 1) {
            throw new Error('终端尚未就绪');
        }
        state.ws.send(String(command) + '\r');
    }

    async function setWorkspace() {
        kill();
        if (state.visible) {
            try {
                await ensureSession();
                requestAnimationFrame(function () {
                    try { state.fit.fit(); } catch (err) { /* ignore */ }
                });
            } catch (err) {
                setStatus('终端不可用：' + err.message, 'error');
            }
        }
    }

    function init() {
        if (state.initialized) { return; }
        state.initialized = true;
        cacheDom();
        if (dom.newButton) {
            dom.newButton.addEventListener('click', refresh);
        }
        if (dom.killButton) {
            dom.killButton.addEventListener('click', kill);
        }
        if (dom.hideButton) {
            dom.hideButton.addEventListener('click', hide);
        }
        document.addEventListener('code:workspace-changed', setWorkspace);
        window.addEventListener('resize', function () {
            if (state.visible && state.term) {
                try { state.fit.fit(); sendResize(); } catch (err) { /* ignore */ }
            }
        });
        loadRuntimes();
    }

    window.CodeTerminal = {
        init: init,
        show: show,
        hide: hide,
        toggle: toggle,
        refresh: refresh,
        kill: kill,
        runCommand: runCommand,
        setWorkspace: setWorkspace,
        isVisible: function () { return state.visible; },
        getRuntimes: function () { return state.runtimes || {}; },
        _debug: function () {
            return {
                visible: state.visible,
                ready: state.ready,
                hasWs: !!state.ws,
                wsState: state.ws ? state.ws.readyState : -1,
                hasPending: !!state.pending,
                closing: state.closing
            };
        }
    };
})();
