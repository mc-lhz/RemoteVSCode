// Code 工作台编排：UI、打开文件夹、保存、F5、上传、快捷键
(function () {
    'use strict';

    const RECENT_KEY = 'rc-code-recent-root';
    const state = {
        statusTimer: null,
        uploadDir: '',
        runtimes: null,
        menu: null,
        menuDocHandler: null,
        palette: null
    };

    const dom = {};
    let activeModalClose = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
    }

    function cacheDom() {
        dom.workspaceName = document.getElementById('workspace-name');
        dom.workspaceRow = document.getElementById('btn-workspace-row');
        dom.openFolderSidebar = document.getElementById('btn-open-folder-sidebar');
        dom.statusWorkspace = document.getElementById('status-workspace');
        dom.statusPosition = document.getElementById('status-position');
        dom.statusEncoding = document.getElementById('status-encoding');
        dom.statusEol = document.getElementById('status-eol');
        dom.statusMessage = document.getElementById('status-message');
        dom.sidebar = document.getElementById('sidebar');
        dom.fileUpload = document.getElementById('file-upload');
        dom.modalRoot = document.getElementById('modal-root');
    }

    function psQuote(value) {
        return "'" + String(value === undefined || value === null ? '' : value).replace(/'/g, "''") + "'";
    }

    function status(message, kind) {
        if (!dom.statusMessage) { cacheDom(); }
        if (!dom.statusMessage) { return; }
        dom.statusMessage.textContent = message || '';
        dom.statusMessage.className = 'status-item status-message' + (kind ? ' ' + kind : '');
        if (state.statusTimer) { clearTimeout(state.statusTimer); }
        if (message) {
            state.statusTimer = setTimeout(function () {
                dom.statusMessage.textContent = '';
                dom.statusMessage.className = 'status-item status-message';
            }, 6000);
        }
    }

    // -----------------------------------------------------------------------
    // 模态框
    // -----------------------------------------------------------------------

    function openModal(options) {
        const root = dom.modalRoot || document.getElementById('modal-root');
        if (!root) {
            if (options.onClose) { options.onClose(); }
            return null;
        }
        if (activeModalClose) { activeModalClose(); }
        root.innerHTML = '';

        const backdrop = el('div', 'modal-backdrop');
        const modal = el('div', 'modal');
        if (options.width) { modal.style.width = options.width; }

        const header = el('div', 'modal-header');
        header.appendChild(el('span', '', options.title || ''));
        const closeButton = el('button', 'icon-button small');
        closeButton.title = '关闭';
        closeButton.innerHTML = '<span class="codicon codicon-close"></span>';
        header.appendChild(closeButton);

        const body = el('div', 'modal-body');
        if (typeof options.body === 'string') {
            body.textContent = options.body;
        } else if (options.body) {
            body.appendChild(options.body);
        }

        const footer = el('div', 'modal-footer');
        if (options.footer) { footer.appendChild(options.footer); }

        modal.appendChild(header);
        modal.appendChild(body);
        modal.appendChild(footer);
        backdrop.appendChild(modal);
        root.appendChild(backdrop);

        let closed = false;
        function close() {
            if (closed) { return; }
            closed = true;
            document.removeEventListener('keydown', onKeydown);
            root.innerHTML = '';
            if (activeModalClose === close) { activeModalClose = null; }
            if (options.onClose) { options.onClose(); }
        }
        function onKeydown(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
        }
        closeButton.addEventListener('click', close);
        backdrop.addEventListener('mousedown', function (event) {
            if (event.target === backdrop) { close(); }
        });
        document.addEventListener('keydown', onKeydown);
        activeModalClose = close;

        setTimeout(function () {
            const focusable = modal.querySelector('input, button.primary, button');
            if (focusable) { focusable.focus(); }
        }, 0);

        return { close: close, body: body, footer: footer, modal: modal };
    }

    function alert(title, message) {
        return new Promise(function (resolve) {
            let settled = false;
            const modal = openModal({
                title: title,
                body: message || '',
                onClose: function () {
                    if (!settled) { settled = true; resolve(); }
                }
            });
            if (!modal) { settled = true; resolve(); return; }
            const ok = el('button', 'modal-button primary', '确定');
            ok.addEventListener('click', function () { modal.close(); });
            modal.footer.appendChild(ok);
            setTimeout(function () { ok.focus(); }, 0);
        });
    }

    function confirm(options) {
        return new Promise(function (resolve) {
            let settled = false;
            const modal = openModal({
                title: options.title || '确认',
                body: options.message || '',
                onClose: function () {
                    if (!settled) { settled = true; resolve(false); }
                }
            });
            if (!modal) { settled = true; resolve(false); return; }
            const cancel = el('button', 'modal-button', options.cancelText || '取消');
            const ok = el('button', 'modal-button ' + (options.danger ? 'danger' : 'primary'),
                options.confirmText || '确定');
            cancel.addEventListener('click', function () { modal.close(); });
            ok.addEventListener('click', function () {
                if (!settled) { settled = true; resolve(true); }
                modal.close();
            });
            modal.footer.appendChild(cancel);
            modal.footer.appendChild(ok);
            setTimeout(function () { ok.focus(); }, 0);
        });
    }

    function choose(options) {
        return new Promise(function (resolve) {
            let settled = false;
            const modal = openModal({
                title: options.title || '请选择',
                body: options.message || '',
                onClose: function () {
                    if (!settled) { settled = true; resolve(null); }
                }
            });
            if (!modal) { settled = true; resolve(null); return; }
            (options.options || []).forEach(function (option) {
                const button = el('button', 'modal-button ' + (option.kind === 'danger' ? 'danger' : 'primary'),
                    option.label);
                button.addEventListener('click', function () {
                    if (!settled) { settled = true; resolve(option.value); }
                    modal.close();
                });
                modal.footer.appendChild(button);
            });
        });
    }

    function prompt(options) {
        return new Promise(function (resolve) {
            let settled = false;
            const wrapper = el('div');
            wrapper.appendChild(el('label', 'modal-label', options.label || ''));
            const input = el('input', 'modal-input');
            input.type = 'text';
            input.value = options.value || '';
            input.placeholder = options.placeholder || '';
            wrapper.appendChild(input);

            const modal = openModal({
                title: options.title || '输入',
                body: wrapper,
                onClose: function () {
                    if (!settled) { settled = true; resolve(null); }
                }
            });
            if (!modal) { settled = true; resolve(null); return; }
            const cancel = el('button', 'modal-button', '取消');
            const ok = el('button', 'modal-button primary', '确定');
            function submit() {
                const value = input.value;
                if (!value) { input.focus(); return; }
                if (!settled) { settled = true; resolve(value); }
                modal.close();
            }
            cancel.addEventListener('click', function () { modal.close(); });
            ok.addEventListener('click', submit);
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') { event.preventDefault(); submit(); }
            });
            modal.footer.appendChild(cancel);
            modal.footer.appendChild(ok);
            setTimeout(function () {
                input.focus();
                input.select();
            }, 0);
        });
    }

    function openFolderDialog() {
        return new Promise(function (resolve) {
            let settled = false;
            let currentData = null;
            let selectedPath = '';

            const body = el('div');
            const toolbar = el('div', 'folder-toolbar');
            const input = el('input', 'modal-input');
            input.type = 'text';
            input.placeholder = '输入远程文件夹绝对路径，例如 D:\\project';
            const go = el('button', 'modal-button', '转到');
            const up = el('button', 'modal-button', '上一级');
            toolbar.appendChild(input);
            toolbar.appendChild(go);
            toolbar.appendChild(up);

            const list = el('div', 'folder-list');
            const error = el('div', 'modal-error');
            body.appendChild(toolbar);
            body.appendChild(list);
            body.appendChild(error);

            const footer = document.createElement('div');
            const cancel = el('button', 'modal-button', '取消');
            const open = el('button', 'modal-button primary', '打开');
            open.disabled = true;
            footer.appendChild(cancel);
            footer.appendChild(open);

            let modal = null;
            function finish(value) {
                if (settled) { return; }
                settled = true;
                if (modal) { modal.close(); }
                resolve(value);
            }

            modal = openModal({
                title: '打开远程文件夹',
                body: body,
                footer: footer,
                width: '580px',
                onClose: function () {
                    if (!settled) { settled = true; resolve(null); }
                }
            });
            if (!modal) { settled = true; resolve(null); return; }

            function addRow(item, isDrive) {
                const row = el('div', 'folder-row');
                const icon = el('span', 'codicon ' + (isDrive ? 'codicon-folder-opened folder-drive' : 'codicon-folder'));
                const name = el('span', '', item.name || item.path);
                row.appendChild(icon);
                row.appendChild(name);
                row.addEventListener('click', function () {
                    list.querySelectorAll('.folder-row.selected').forEach(function (node) {
                        node.classList.remove('selected');
                    });
                    row.classList.add('selected');
                    selectedPath = item.path;
                    open.disabled = false;
                });
                row.addEventListener('dblclick', function () {
                    navigate(item.path);
                });
                list.appendChild(row);
            }

            function renderData(data) {
                currentData = data;
                const currentPath = data.path || '';
                selectedPath = currentPath;
                input.value = currentPath;
                open.disabled = !currentPath;
                up.disabled = !data.parent;
                list.innerHTML = '';

                if (!currentPath && data.drives && data.drives.length) {
                    data.drives.forEach(function (drive) { addRow(drive, true); });
                } else if (data.dirs && data.dirs.length) {
                    data.dirs.forEach(function (dir) { addRow(dir, false); });
                } else {
                    list.appendChild(el('div', 'folder-empty', '当前文件夹下没有子文件夹'));
                }
            }

            async function navigate(path) {
                if (settled) { return; }
                error.textContent = '';
                list.innerHTML = '';
                list.appendChild(el('div', 'folder-empty', '加载中…'));
                try {
                    const data = await window.CodeAPI.browse(path);
                    if (settled) { return; }
                    renderData(data);
                } catch (err) {
                    if (settled) { return; }
                    list.innerHTML = '';
                    error.textContent = err.message || '读取失败';
                }
            }

            function openSelected() {
                if (selectedPath) {
                    finish(selectedPath);
                } else if (currentData && currentData.path) {
                    finish(currentData.path);
                } else {
                    error.textContent = '请选择文件夹';
                }
            }

            cancel.addEventListener('click', function () { finish(null); });
            open.addEventListener('click', openSelected);
            go.addEventListener('click', function () { navigate(input.value.trim()); });
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    navigate(input.value.trim());
                }
            });
            up.addEventListener('click', function () {
                if (currentData && currentData.parent) { navigate(currentData.parent); }
            });

            navigate('');
            setTimeout(function () { input.focus(); }, 0);
        });
    }

    // -----------------------------------------------------------------------
    // 工作区 / 状态栏
    // -----------------------------------------------------------------------

    function updateWorkspaceUI() {
        const workspace = window.CodeAPI.workspace;
        if (dom.workspaceName) {
            dom.workspaceName.textContent = workspace ? workspace.name : '';
            dom.workspaceName.title = workspace ? workspace.root : '';
        }
        if (dom.workspaceRow) {
            dom.workspaceRow.classList.toggle('hidden', !workspace);
        }
        if (dom.openFolderSidebar) {
            dom.openFolderSidebar.classList.toggle('hidden', !!workspace);
        }
        if (dom.statusWorkspace) {
            dom.statusWorkspace.textContent = workspace ? workspace.name : '无工作区';
            dom.statusWorkspace.title = workspace ? workspace.root : '';
        }
        document.title = workspace ? 'Code - ' + workspace.name : 'Code - RemoteConnecter';
    }

    function closeMobileSidebar() {
        if (dom.sidebar) { dom.sidebar.classList.remove('open'); }
    }

    function toggleSidebar() {
        if (!dom.sidebar) { return; }
        if (window.innerWidth <= 760) {
            dom.sidebar.classList.toggle('open');
        } else {
            dom.sidebar.classList.toggle('collapsed');
        }
    }

    function resetEditorStatus() {
        if (dom.statusPosition) { dom.statusPosition.textContent = 'Ln 1, Col 1'; }
        if (dom.statusEncoding) { dom.statusEncoding.textContent = 'UTF-8'; }
        if (dom.statusEol) { dom.statusEol.textContent = 'LF'; }
    }

    function updateEditorStatus(detail) {
        if (!detail) { return; }
        if (dom.statusPosition) {
            dom.statusPosition.textContent = 'Ln ' + (detail.line || 1) + ', Col ' + (detail.column || 1);
        }
        if (dom.statusEncoding) { dom.statusEncoding.textContent = detail.encoding || 'UTF-8'; }
        if (dom.statusEol) { dom.statusEol.textContent = detail.eol || 'LF'; }
    }

    async function loadRuntimes() {
        try {
            state.runtimes = await window.CodeAPI.runtimes();
        } catch (err) {
            state.runtimes = {};
        }
    }

    async function openWorkspace(root, options) {
        const opts = options || {};
        if (window.CodeEditor.hasDirty()) {
            const ok = await confirm({
                title: '切换文件夹',
                message: '当前有未保存的标签，切换文件夹会关闭它们。继续吗？',
                confirmText: '切换',
                danger: true
            });
            if (!ok) { return false; }
        }
        try {
            const workspace = await window.CodeAPI.openWorkspace(root);
            window.CodeEditor.reset();
            resetEditorStatus();
            await window.CodeExplorer.setWorkspace(workspace);
            updateWorkspaceUI();
            closeMobileSidebar();
            try { localStorage.setItem(RECENT_KEY, workspace.root); } catch (err) { /* ignore */ }
            document.dispatchEvent(new CustomEvent('code:workspace-changed', {
                detail: { workspace: workspace }
            }));
            status('已打开：' + workspace.root, 'ok');
            return true;
        } catch (err) {
            if (opts.silent) {
                status('上次文件夹不可用：' + err.message, 'error');
            } else {
                await alert('打开文件夹失败', err.message || String(err));
            }
            return false;
        }
    }

    async function chooseWorkspace() {
        const path = await openFolderDialog();
        if (path) { await openWorkspace(path); }
    }

    async function refreshExplorer() {
        if (!window.CodeAPI.workspaceId) {
            await chooseWorkspace();
            return;
        }
        await window.CodeExplorer.refresh();
        window.CodeEditor.layout();
        status('资源管理器已刷新', '');
    }

    async function saveActive() {
        if (!window.CodeAPI.workspaceId) {
            status('请先打开文件夹', 'error');
            return;
        }
        const tab = window.CodeEditor.getActiveTab();
        if (!tab) {
            status('没有打开的文件', '');
            return;
        }
        const saved = await window.CodeEditor.saveActive();
        if (saved) { status('已保存：' + tab.name, 'ok'); }
    }

    function extensionOf(path) {
        const name = String(path || '').split('/').pop();
        return name.indexOf('.') >= 0 ? name.split('.').pop().toLowerCase() : '';
    }

    async function runActive() {
        const tab = window.CodeEditor.getActiveTab();
        if (!tab) {
            status('没有打开的文件', 'error');
            return;
        }
        const saved = await window.CodeEditor.saveActive();
        if (!saved) { return; }

        let runtimes = state.runtimes;
        if (!runtimes || !runtimes.python) {
            try { runtimes = await window.CodeAPI.runtimes(); } catch (err) { runtimes = {}; }
        }

        const ext = extensionOf(tab.path);
        let command = 'Set-Location -LiteralPath ' + psQuote(window.CodeAPI.workspaceRoot) + '; ';

        if (ext === 'py' || ext === 'pyw') {
            if (!runtimes.python || !runtimes.python.available) {
                await alert('无法运行 Python', '未检测到 python.exe。');
                return;
            }
            command += '& ' + psQuote(runtimes.python.path) + ' ' + psQuote(tab.path);
        } else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
            if (!runtimes.node || !runtimes.node.available) {
                await alert('无法运行 Node', '未检测到 node.exe。');
                return;
            }
            command += '& ' + psQuote(runtimes.node.path) + ' ' + psQuote(tab.path);
        } else if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'c') {
            if (!runtimes.gpp || !runtimes.gpp.available) {
                await alert('无法运行 C/C++', '未检测到 g++.exe。');
                return;
            }
            const exePath = '$env:TEMP\\rc-run-' + Date.now() + '.exe';
            const exeArg = '"' + exePath + '"';
            command += '& ' + psQuote(runtimes.gpp.path) + ' ' + psQuote(tab.path)
                + " '-std=c++17' '-O0' '-o' " + exeArg
                + '; if ($LASTEXITCODE -eq 0) { & ' + exeArg + ' }';
        } else {
            await alert('无法运行', 'F5 仅支持 .py、.js、.cpp/.c 文件。');
            return;
        }

        try {
            await window.CodeTerminal.runCommand(command);
            status('正在运行：' + tab.name, 'ok');
        } catch (err) {
            await alert('运行失败', err.message || String(err));
        }
    }

    function requestUpload(dir) {
        state.uploadDir = dir || '';
        if (dom.fileUpload) {
            dom.fileUpload.value = '';
            dom.fileUpload.click();
        }
    }

    async function uploadFiles(files) {
        if (!window.CodeAPI.workspaceId) {
            status('请先打开文件夹', 'error');
            return;
        }
        if (!files || !files.length) { return; }
        for (const file of files) {
            let uploaded = false;
            try {
                await window.CodeAPI.upload(file, state.uploadDir, function (loaded, total) {
                    status('上传中：' + file.name + ' ' + Math.round(loaded / total * 100) + '%', '');
                });
                uploaded = true;
            } catch (err) {
                if (err.status === 409) {
                    const overwrite = await confirm({
                        title: '文件已存在',
                        message: '“' + file.name + '”已存在，是否覆盖？',
                        confirmText: '覆盖',
                        danger: true
                    });
                    if (overwrite) {
                        try {
                            await window.CodeAPI.upload(file, state.uploadDir, null, true);
                            uploaded = true;
                        } catch (overwriteError) {
                            await alert('上传失败', overwriteError.message);
                        }
                    }
                } else {
                    await alert('上传失败', file.name + '：' + err.message);
                }
            }
            if (uploaded) { status('已上传：' + file.name, 'ok'); }
        }
        state.uploadDir = '';
        await window.CodeExplorer.refresh();
    }

    // -----------------------------------------------------------------------
    // 菜单 / 命令面板 / 占位功能
    // -----------------------------------------------------------------------

    function closeMenu() {
        if (state.menuDocHandler) {
            document.removeEventListener('click', state.menuDocHandler);
            state.menuDocHandler = null;
        }
        if (state.menu && state.menu.parentNode) {
            state.menu.parentNode.removeChild(state.menu);
        }
        state.menu = null;
    }

    function openMenu(items, x, y, alignBottom) {
        closeMenu();
        const menu = el('div', 'context-menu');
        items.forEach(function (item) {
            if (!item) { return; }
            if (item.separator) {
                menu.appendChild(el('div', 'context-menu-separator'));
                return;
            }
            const button = el('button', 'context-menu-item' + (item.kind ? ' ' + item.kind : ''));
            button.type = 'button';
            if (item.icon) {
                button.appendChild(el('span', 'codicon ' + item.icon));
            }
            button.appendChild(el('span', '', item.label));
            if (item.shortcut) {
                button.appendChild(el('span', 'menu-shortcut', item.shortcut));
            }
            button.addEventListener('click', function () {
                closeMenu();
                Promise.resolve().then(item.action).catch(function (err) {
                    alert('操作失败', err.message || String(err));
                });
            });
            menu.appendChild(button);
        });
        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        let left = x;
        let top = alignBottom ? y - rect.height : y;
        left = Math.max(4, Math.min(left, window.innerWidth - rect.width - 8));
        top = Math.max(4, Math.min(top, window.innerHeight - rect.height - 8));
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        state.menu = menu;
        state.menuDocHandler = function (event) {
            if (!menu.contains(event.target)) { closeMenu(); }
        };
        setTimeout(function () {
            if (state.menu === menu) {
                document.addEventListener('click', state.menuDocHandler);
            }
        }, 0);
    }

    function openMenuAtButton(button, items, alignBottom) {
        const rect = button.getBoundingClientRect();
        openMenu(items, rect.right + 2, alignBottom ? rect.bottom : rect.top, !!alignBottom);
    }

    function openSettings() {
        closeMenu();
        alert('设置', '设置页面将在后续版本提供。');
    }

    function openChat() {
        closeMenu();
        alert('聊天', '聊天面板将在后续版本提供。');
    }

    function aboutCode() {
        closeMenu();
        alert('关于 Code', 'RemoteConnecter Code 工作台\nMonaco Editor + xterm.js + Code-OSS 图标资源');
    }

    function placeholderFeature(name) {
        status(name + '功能将在后续版本提供', '');
    }

    function showLogoMenu(button) {
        openMenu([
            { label: '打开文件夹...', icon: 'codicon-folder-opened', shortcut: 'Ctrl+O', action: chooseWorkspace },
            { label: '保存', icon: 'codicon-save', shortcut: 'Ctrl+S', action: saveActive },
            { label: '刷新资源管理器', icon: 'codicon-refresh', action: refreshExplorer },
            { separator: true },
            { label: '切换终端', icon: 'codicon-terminal', shortcut: 'Ctrl+`', action: function () { window.CodeTerminal.toggle(); } },
            { label: '运行当前文件', icon: 'codicon-play', shortcut: 'F5', action: runActive },
            { separator: true },
            { label: '命令面板...', icon: 'codicon-symbol-color', shortcut: 'Ctrl+Shift+P', action: showCommandPalette },
            { label: '设置', icon: 'codicon-settings-gear', shortcut: 'Ctrl+,', action: openSettings },
            { label: '关于 Code', icon: 'codicon-info', action: aboutCode }
        ], button.getBoundingClientRect().right + 2, button.getBoundingClientRect().top, false);
    }

    function showAccountMenu(button) {
        openMenu([
            { label: '登录...', icon: 'codicon-account', action: function () { alert('账户', '账户功能将在后续版本提供。'); } },
            { label: '管理账户', icon: 'codicon-settings-gear', action: function () { alert('账户', '账户功能将在后续版本提供。'); } }
        ], button.getBoundingClientRect().right + 2, button.getBoundingClientRect().bottom, true);
    }

    function commandDefinitions() {
        return [
            { label: '打开文件夹...', detail: 'Ctrl+O', icon: 'codicon-folder-opened', action: chooseWorkspace },
            { label: '保存', detail: 'Ctrl+S', icon: 'codicon-save', action: saveActive },
            { label: '刷新资源管理器', icon: 'codicon-refresh', action: refreshExplorer },
            { label: '新建文件', icon: 'codicon-new-file', action: function () { return window.CodeExplorer.newFile(); } },
            { label: '新建文件夹', icon: 'codicon-new-folder', action: function () { return window.CodeExplorer.newFolder(); } },
            { label: '上传文件', icon: 'codicon-cloud-upload', action: function () { window.CodeExplorer.requestUpload(); } },
            { label: '折叠文件夹', icon: 'codicon-collapse-all', action: function () { window.CodeExplorer.collapseAll(); } },
            { label: '切换终端', detail: 'Ctrl+`', icon: 'codicon-terminal', action: function () { window.CodeTerminal.toggle(); } },
            { label: '运行当前文件', detail: 'F5', icon: 'codicon-play', action: runActive },
            { label: 'Markdown 预览', detail: 'Ctrl+Shift+V', icon: 'codicon-preview', action: function () { window.CodeEditor.togglePreview(); } },
            { label: '打开设置', detail: 'Ctrl+,', icon: 'codicon-settings-gear', action: openSettings },
            { label: '打开聊天', detail: 'Ctrl+Alt+I', icon: 'codicon-comment-discussion', action: openChat },
            { label: '关于 Code', icon: 'codicon-info', action: aboutCode }
        ];
    }

    function closeCommandPalette() {
        if (!state.palette) { return; }
        const palette = state.palette;
        state.palette = null;
        if (palette.backdrop && palette.backdrop.parentNode) {
            palette.backdrop.parentNode.removeChild(palette.backdrop);
        }
    }

    function showCommandPalette() {
        if (state.palette) {
            closeCommandPalette();
            return;
        }
        closeMenu();

        const backdrop = el('div', 'command-palette-backdrop');
        const palette = el('div', 'command-palette');
        const input = el('input', 'command-palette-input');
        input.type = 'text';
        input.placeholder = '输入命令名称';
        input.setAttribute('aria-label', '命令面板');
        const list = el('div', 'command-palette-list');
        palette.appendChild(input);
        palette.appendChild(list);
        backdrop.appendChild(palette);
        document.body.appendChild(backdrop);

        let matches = [];
        let selected = 0;

        function execute(index) {
            const item = matches[index];
            if (!item) { return; }
            closeCommandPalette();
            Promise.resolve().then(item.action).catch(function (err) {
                alert('命令执行失败', err.message || String(err));
            });
        }

        function render() {
            const query = input.value.trim().toLowerCase();
            matches = commandDefinitions().filter(function (item) {
                return (item.label + ' ' + (item.detail || '')).toLowerCase().indexOf(query) >= 0;
            });
            if (!matches.length) {
                selected = 0;
            } else {
                selected = Math.min(selected, matches.length - 1);
            }
            list.innerHTML = '';
            if (!matches.length) {
                list.appendChild(el('div', 'command-palette-empty', '没有匹配的命令'));
                return;
            }
            matches.forEach(function (item, index) {
                const button = el('button', 'command-palette-item' + (index === selected ? ' selected' : ''));
                button.type = 'button';
                button.appendChild(el('span', 'codicon ' + item.icon));
                button.appendChild(el('span', 'command-label', item.label));
                if (item.detail) {
                    button.appendChild(el('span', 'command-detail', item.detail));
                }
                button.addEventListener('click', function () { execute(index); });
                list.appendChild(button);
            });
            const current = list.querySelector('.command-palette-item.selected');
            if (current && current.scrollIntoView) {
                current.scrollIntoView({ block: 'nearest' });
            }
        }

        input.addEventListener('input', render);
        input.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.stopPropagation();
                if (matches.length) {
                    selected = (selected + 1) % matches.length;
                    render();
                }
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                if (matches.length) {
                    selected = (selected - 1 + matches.length) % matches.length;
                    render();
                }
            } else if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                execute(selected);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeCommandPalette();
            }
        });
        backdrop.addEventListener('mousedown', function (event) {
            if (event.target === backdrop) { closeCommandPalette(); }
        });

        state.palette = { close: closeCommandPalette, backdrop: backdrop };
        render();
        setTimeout(function () { input.focus(); }, 0);
    }

    // -----------------------------------------------------------------------
    // 事件绑定 / 启动
    // -----------------------------------------------------------------------

    function bind(id, event, handler) {
        const node = document.getElementById(id);
        if (node) { node.addEventListener(event, handler); }
    }

    function bindEvents() {
        ['btn-open-folder', 'btn-open-folder-activity', 'btn-open-folder-sidebar',
            'btn-open-folder-empty', 'welcome-open'].forEach(function (id) {
            bind(id, 'click', chooseWorkspace);
        });
        bind('btn-terminal-status', 'click', function () {
            window.CodeTerminal.toggle();
        });
        bind('btn-toggle-sidebar', 'click', toggleSidebar);
        bind('btn-activity-explorer', 'click', toggleSidebar);
        bind('btn-activity-menu', 'click', function (event) {
            showLogoMenu(event.currentTarget);
        });
        bind('btn-activity-settings', 'click', openSettings);
        bind('btn-activity-account', 'click', function (event) {
            showAccountMenu(event.currentTarget);
        });
        bind('btn-activity-search', 'click', function () { placeholderFeature('搜索'); });
        bind('btn-activity-scm', 'click', function () { placeholderFeature('源代码管理'); });
        bind('btn-activity-debug', 'click', function () { placeholderFeature('运行和调试'); });
        bind('btn-activity-extensions', 'click', function () { placeholderFeature('扩展'); });
        bind('btn-activity-remote', 'click', function () { placeholderFeature('远程资源管理器'); });
        bind('btn-explorer-more', 'click', function (event) {
            const rect = event.currentTarget.getBoundingClientRect();
            window.CodeExplorer.showMenuAt(rect.left, rect.bottom + 2);
        });
        bind('btn-workspace-row', 'click', function (event) {
            const rect = event.currentTarget.getBoundingClientRect();
            window.CodeExplorer.showMenuAt(rect.left, rect.bottom + 2);
        });
        bind('btn-status-account', 'click', function (event) {
            showAccountMenu(event.currentTarget);
        });
        bind('btn-status-bell', 'click', function () { status('没有新通知', ''); });
        bind('status-remote', 'click', function () { status('远程：当前主机', ''); });
        document.querySelectorAll('.welcome-action').forEach(function (button) {
            button.addEventListener('click', function () {
                const command = button.dataset.command;
                if (command === 'chat') { openChat(); }
                else if (command === 'palette') { showCommandPalette(); }
                else if (command === 'settings') { openSettings(); }
            });
        });
        bind('file-upload', 'change', function (event) {
            const files = Array.from(event.target.files || []);
            uploadFiles(files);
        });
        document.addEventListener('code:open-folder-request', chooseWorkspace);
        document.addEventListener('code:upload-request', function (event) {
            requestUpload(event.detail ? event.detail.dir : '');
        });
        document.addEventListener('code:active-changed', function (event) {
            const path = event.detail ? event.detail.path : '';
            window.CodeExplorer.setActivePath(path);
        });
        document.addEventListener('code:status', function (event) {
            updateEditorStatus(event.detail);
        });
        document.addEventListener('code:saved', function (event) {
            if (event.detail && event.detail.path) {
                status('已保存：' + event.detail.path.split('/').pop(), 'ok');
            }
        });
        document.addEventListener('code:terminal-message', function (event) {
            if (event.detail) { status(event.detail.message, event.detail.kind); }
        });
        document.addEventListener('code:workspace-changed', function () {
            updateWorkspaceUI();
            closeMobileSidebar();
            loadRuntimes();
        });

        window.addEventListener('keydown', function (event) {
            const ctrl = event.ctrlKey || event.metaKey;
            const key = String(event.key || '').toLowerCase();
            if (ctrl && event.shiftKey && key === 'p') {
                event.preventDefault();
                showCommandPalette();
            } else if (ctrl && key === ',') {
                event.preventDefault();
                openSettings();
            } else if (ctrl && event.altKey && key === 'i') {
                event.preventDefault();
                openChat();
            } else if (ctrl && key === 's') {
                event.preventDefault();
                saveActive();
            } else if (ctrl && key === 'o') {
                event.preventDefault();
                chooseWorkspace();
            } else if (ctrl && key === 'b') {
                event.preventDefault();
                toggleSidebar();
            } else if (ctrl && event.key === '`') {
                event.preventDefault();
                window.CodeTerminal.toggle();
            } else if (event.key === 'F5') {
                event.preventDefault();
                runActive();
            } else if (ctrl && event.shiftKey && key === 'v') {
                event.preventDefault();
                window.CodeEditor.togglePreview();
            } else if (ctrl && key === 'w') {
                if (window.CodeEditor.getActiveTab()) {
                    event.preventDefault();
                    window.CodeEditor.closeActive();
                }
            } else if (event.key === 'Escape') {
                closeMenu();
                closeCommandPalette();
            }
        });

        window.addEventListener('beforeunload', function (event) {
            if (window.CodeEditor.hasDirty()) {
                event.preventDefault();
                event.returnValue = '';
            }
        });
        window.addEventListener('resize', function () {
            window.CodeEditor.layout();
        });
    }

    async function init() {
        cacheDom();
        bindEvents();

        try {
            await window.CodeEditor.init();
        } catch (err) {
            await alert('编辑器加载失败', err.message || String(err));
        }

        window.CodeExplorer.init();
        window.CodeTerminal.init();
        updateWorkspaceUI();
        resetEditorStatus();
        loadRuntimes();

        let recent = '';
        try { recent = localStorage.getItem(RECENT_KEY) || ''; } catch (err) { recent = ''; }
        if (recent) {
            await openWorkspace(recent, { silent: true });
        }
    }

    window.CodeUI = {
        alert: alert,
        confirm: confirm,
        choose: choose,
        prompt: prompt,
        openFolderDialog: openFolderDialog,
        status: status
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
