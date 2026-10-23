// Code 页内嵌终端（single 模式，随页面 WS 生命周期）
(function () {
    'use strict';

    // 必须在 term.js 之前设置；term.js 会读取这个全局配置。
    window.RC_TERM_CONFIG = {
        embedded: true,
        mode: 'single',
        terminalId: 'terminal',
        statusId: 'code-term-status',
        cwd: ''
    };

    const state = {
        visible: false,
        pending: null,
        runtimes: null,
        initialized: false
    };

    const dom = {};

    function cacheDom() {
        dom.panel = document.getElementById('terminal-panel');
        dom.newButton = document.getElementById('btn-term-new');
        dom.killButton = document.getElementById('btn-term-kill');
        dom.hideButton = document.getElementById('btn-term-hide');
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

    async function ensureSession() {
        if (!window.CodeAPI.workspaceId) {
            throw new Error('请先打开文件夹');
        }
        if (!window.rcTerm) {
            throw new Error('终端前端未加载');
        }
        if (window.rcTerm.isReady()) { return true; }
        if (state.pending) { return state.pending; }

        state.pending = (async function () {
            await loadRuntimes();
            window.rcTerm.setCwd(window.CodeAPI.workspaceRoot || '');
            window.rcTerm.createSession(shellCommand());
            const ready = await window.rcTerm.waitReady(15000);
            if (!ready) {
                throw new Error('终端启动超时');
            }
            window.rcTerm.fit();
            return true;
        })();

        try {
            return await state.pending;
        } finally {
            state.pending = null;
        }
    }

    async function show() {
        if (!dom.panel) { return; }
        dom.panel.classList.remove('hidden');
        state.visible = true;
        try {
            await ensureSession();
            requestAnimationFrame(function () {
                if (window.rcTerm) {
                    window.rcTerm.fit();
                    window.rcTerm.focus();
                }
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
            if (window.rcTerm) { window.rcTerm.closeActive(); }
            await ensureSession();
            requestAnimationFrame(function () {
                if (window.rcTerm) { window.rcTerm.fit(); window.rcTerm.focus(); }
            });
            setStatus('终端已重启', 'ok');
        } catch (err) {
            setStatus('终端重启失败：' + err.message, 'error');
        }
    }

    function kill() {
        if (window.rcTerm) {
            window.rcTerm.closeActive();
        }
        setStatus('终端已终止', '');
    }

    async function runCommand(command) {
        if (!window.CodeAPI.workspaceId) {
            throw new Error('请先打开文件夹');
        }
        await show();
        await ensureSession();
        if (!window.rcTerm || !window.rcTerm.isReady()) {
            throw new Error('终端尚未就绪');
        }
        if (!window.rcTerm.sendCommand(command)) {
            throw new Error('命令发送失败');
        }
    }

    async function setWorkspace() {
        if (window.rcTerm) {
            window.rcTerm.closeActive();
        }
        if (state.visible) {
            try {
                await ensureSession();
                requestAnimationFrame(function () {
                    if (window.rcTerm) { window.rcTerm.fit(); }
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
            dom.newButton.addEventListener('click', function () { refresh(); });
        }
        if (dom.killButton) {
            dom.killButton.addEventListener('click', kill);
        }
        if (dom.hideButton) {
            dom.hideButton.addEventListener('click', hide);
        }
        document.addEventListener('code:workspace-changed', function () {
            setWorkspace();
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
        getRuntimes: function () { return state.runtimes || {}; }
    };
})();
