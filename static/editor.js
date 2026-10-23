// Monaco 编辑器、标签页、保存/冲突处理
(function () {
    'use strict';

    const MONACO_BASE = '/code/static/vendor/monaco/min/vs';
    const LANG_MAP = {
        py: 'python', pyw: 'python',
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
        ts: 'typescript', tsx: 'typescript',
        json: 'json', jsonc: 'json',
        html: 'html', htm: 'html',
        css: 'css', scss: 'scss', less: 'less',
        md: 'markdown', markdown: 'markdown',
        c: 'c', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
        java: 'java',
        sh: 'shell', bash: 'shell',
        ps1: 'powershell', psm1: 'powershell',
        xml: 'xml', svg: 'xml',
        yml: 'yaml', yaml: 'yaml',
        sql: 'sql',
        go: 'go',
        rs: 'rust',
        php: 'php',
        rb: 'ruby',
        txt: 'plaintext', log: 'plaintext', ini: 'ini', toml: 'ini'
    };

    const state = {
        monaco: null,
        editor: null,
        ready: false,
        tabs: [],
        active: null,
        preview: false,
        uid: 0
    };

    const dom = {};

    function cacheDom() {
        dom.host = document.getElementById('editor-host');
        dom.tabbar = document.getElementById('tabbar');
        dom.breadcrumbs = document.getElementById('breadcrumbs');
        dom.breadcrumbPath = document.getElementById('breadcrumb-path');
        dom.previewButton = document.getElementById('btn-preview');
        dom.preview = document.getElementById('markdown-preview');
        dom.welcome = document.getElementById('welcome');
    }

    function languageFor(path) {
        const name = String(path || '').split('/').pop();
        const ext = name.indexOf('.') >= 0 ? name.split('.').pop().toLowerCase() : '';
        return LANG_MAP[ext] || 'plaintext';
    }

    function encodingLabel(encoding) {
        if (encoding === 'utf-8-sig') { return 'UTF-8 BOM'; }
        if (encoding === 'gbk') { return 'GBK'; }
        return 'UTF-8';
    }

    function emit(name, detail) {
        document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    }

    function emitStatus() {
        if (!state.active || !state.editor) { return; }
        const position = state.editor.getPosition();
        const selection = state.editor.getSelection();
        emit('code:status', {
            path: state.active.path,
            language: languageFor(state.active.path),
            encoding: encodingLabel(state.active.encoding),
            eol: state.active.eol || 'LF',
            line: position ? position.lineNumber : 1,
            column: position ? position.column : 1,
            selected: selection ? !selection.isEmpty() : false
        });
    }

    function emitTabs() {
        emit('code:tabs-changed', {
            tabs: state.tabs.map(function (tab) {
                return {
                    path: tab.path,
                    name: tab.name,
                    dirty: tab.dirty,
                    active: tab === state.active
                };
            }),
            active: state.active ? state.active.path : null
        });
    }

    function showEditor() {
        if (dom.welcome) { dom.welcome.classList.add('hidden'); }
        if (dom.host) { dom.host.classList.remove('hidden'); }
    }

    function showWelcome() {
        if (dom.host) { dom.host.classList.add('hidden'); }
        if (dom.preview) { dom.preview.classList.add('hidden'); }
        if (dom.welcome) { dom.welcome.classList.remove('hidden'); }
    }

    function layout() {
        if (state.editor) {
            try { state.editor.layout(); } catch (err) { /* ignore */ }
        }
    }

    function init() {
        cacheDom();
        if (!dom.host) { return Promise.reject(new Error('缺少编辑器容器')); }

        window.MonacoEnvironment = {
            getWorkerUrl: function () {
                return MONACO_BASE + '/base/worker/workerMain.js';
            }
        };

        return new Promise(function (resolve, reject) {
            if (!window.require) {
                reject(new Error('Monaco Loader 未加载'));
                return;
            }
            window.require.config({ paths: { vs: MONACO_BASE } });
            window.require(['vs/editor/editor.main'], function () {
                state.monaco = window.monaco;
                state.editor = state.monaco.editor.create(dom.host, {
                    theme: 'vs-dark',
                    automaticLayout: false,
                    fontFamily: 'Consolas, "Courier New", monospace',
                    fontSize: 14,
                    lineHeight: 21,
                    tabSize: 4,
                    insertSpaces: true,
                    detectIndentation: false,
                    minimap: { enabled: true, maxColumn: 80 },
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    cursorBlinking: 'smooth',
                    renderLineHighlight: 'all',
                    renderWhitespace: 'selection',
                    wordWrap: 'off',
                    mouseWheelZoom: true,
                    fixedOverflowWidgets: true,
                    padding: { top: 8, bottom: 8 },
                    bracketPairColorization: { enabled: true },
                    guides: { bracketPairs: true },
                    overviewRulerBorder: false,
                    scrollbar: {
                        verticalScrollbarSize: 10,
                        horizontalScrollbarSize: 10,
                        useShadows: false
                    }
                });

                state.editor.onDidChangeCursorPosition(emitStatus);
                state.editor.onDidChangeCursorSelection(emitStatus);
                if (typeof ResizeObserver !== 'undefined') {
                    new ResizeObserver(layout).observe(dom.host);
                }
                window.addEventListener('resize', layout);
                if (dom.previewButton) {
                    dom.previewButton.addEventListener('click', function () {
                        window.CodeEditor.togglePreview();
                    });
                }
                if (dom.preview) {
                    dom.preview.addEventListener('click', function (event) {
                        const link = event.target.closest('a[data-code-path]');
                        if (!link) { return; }
                        event.preventDefault();
                        const path = link.getAttribute('data-code-path');
                        if (path) {
                            window.CodeEditor.openFile(path).catch(function (err) {
                                if (window.CodeUI) { window.CodeUI.alert('打开失败', err.message); }
                            });
                        }
                    });
                }

                state.ready = true;
                resolve();
            }, function (err) {
                reject(err || new Error('Monaco 加载失败'));
            });
        });
    }

    function renderTabs() {
        if (!dom.tabbar) { return; }
        if (!state.tabs.length) {
            dom.tabbar.classList.add('hidden');
            dom.tabbar.innerHTML = '';
            return;
        }
        dom.tabbar.classList.remove('hidden');
        dom.tabbar.innerHTML = '';

        state.tabs.forEach(function (tab) {
            const item = document.createElement('div');
            item.className = 'tab' + (tab === state.active ? ' active' : '');
            item.title = tab.path;
            item.dataset.path = tab.path;

            const icon = document.createElement('span');
            icon.className = 'codicon codicon-file-code tab-icon';

            const name = document.createElement('span');
            name.className = 'tab-name';
            name.textContent = tab.name;

            item.appendChild(icon);
            item.appendChild(name);

            if (tab.dirty) {
                const dirty = document.createElement('span');
                dirty.className = 'tab-dirty';
                dirty.title = '未保存';
                item.appendChild(dirty);
            }

            const close = document.createElement('button');
            close.className = 'tab-close';
            close.title = '关闭';
            close.innerHTML = '<span class="codicon codicon-close"></span>';
            close.addEventListener('click', function (event) {
                event.stopPropagation();
                window.CodeEditor.closeTab(tab);
            });
            item.appendChild(close);

            item.addEventListener('click', function () {
                activate(tab);
            });
            item.addEventListener('auxclick', function (event) {
                if (event.button === 1) {
                    event.preventDefault();
                    window.CodeEditor.closeTab(tab);
                }
            });
            dom.tabbar.appendChild(item);
        });

        const activeItem = dom.tabbar.querySelector('.tab.active');
        if (activeItem && activeItem.scrollIntoView) {
            activeItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }

    function renderBreadcrumbs() {
        if (!dom.breadcrumbs || !dom.breadcrumbPath) { return; }
        if (!state.active) {
            dom.breadcrumbs.classList.add('hidden');
            dom.breadcrumbPath.innerHTML = '';
            if (dom.previewButton) { dom.previewButton.classList.add('hidden'); }
            return;
        }
        dom.breadcrumbs.classList.remove('hidden');
        dom.breadcrumbPath.innerHTML = '';
        const parts = state.active.path.split('/');
        parts.forEach(function (part, index) {
            if (index > 0) {
                const separator = document.createElement('span');
                separator.className = 'breadcrumb-separator';
                separator.textContent = '›';
                dom.breadcrumbPath.appendChild(separator);
            }
            const segment = document.createElement('span');
            segment.className = 'breadcrumb-segment';
            segment.textContent = part;
            dom.breadcrumbPath.appendChild(segment);
        });

        if (dom.previewButton) {
            const isMarkdown = languageFor(state.active.path) === 'markdown';
            dom.previewButton.classList.toggle('hidden', !isMarkdown);
            dom.previewButton.classList.toggle('active', state.preview);
        }
    }

    function setPreviewVisible(visible) {
        state.preview = !!visible;
        if (dom.host) { dom.host.classList.toggle('hidden', state.preview); }
        if (dom.preview) { dom.preview.classList.toggle('hidden', !state.preview); }
        if (dom.welcome) { dom.welcome.classList.add('hidden'); }
        if (dom.previewButton) { dom.previewButton.classList.toggle('active', state.preview); }
        if (state.preview) { refreshPreview(); } else { layout(); }
    }

    function refreshPreview() {
        if (!state.preview || !state.active || !dom.preview) { return; }
        try {
            dom.preview.innerHTML = window.CodeMarkdown.render(
                state.active.model.getValue(),
                state.active.path
            );
        } catch (err) {
            dom.preview.innerHTML = '';
            const message = document.createElement('p');
            message.className = 'markdown-error';
            message.textContent = '预览失败：' + err.message;
            dom.preview.appendChild(message);
        }
    }

    function activate(tab) {
        if (!tab || !state.editor) { return; }
        if (state.active && state.active !== tab && state.active.model) {
            state.active.viewState = state.editor.saveViewState();
        }
        state.active = tab;
        setPreviewVisible(false);
        state.editor.setModel(tab.model);
        state.editor.updateOptions({ readOnly: !!tab.readOnly });
        if (tab.viewState) {
            state.editor.restoreViewState(tab.viewState);
        }
        showEditor();
        renderTabs();
        renderBreadcrumbs();
        emitTabs();
        emitStatus();
        layout();
        state.editor.focus();
    }

    function createTab(data) {
        const path = data.path;
        const name = path.split('/').pop();
        const uri = state.monaco.Uri.parse(
            'inmemory://rc/' + path.split('/').map(encodeURIComponent).join('/')
        );
        const model = state.monaco.editor.createModel(
            data.content,
            languageFor(path),
            uri
        );
        if (data.eol === 'CRLF') {
            model.setEOL(state.monaco.editor.EndOfLineSequence.CRLF);
        } else {
            model.setEOL(state.monaco.editor.EndOfLineSequence.LF);
        }

        const tab = {
            path: path,
            name: name,
            model: model,
            viewState: null,
            dirty: false,
            encoding: data.encoding || 'utf-8',
            eol: data.eol === 'mixed' ? 'LF' : (data.eol || 'LF'),
            etag: data.etag || '',
            mtimeNs: data.mtimeNs || '',
            readOnly: data.writable === false
        };

        model.onDidChangeContent(function () {
            if (!tab.dirty) {
                tab.dirty = true;
                renderTabs();
                emitTabs();
            }
            if (state.preview && state.active === tab) { refreshPreview(); }
        });

        state.tabs.push(tab);
        return tab;
    }

    async function openFile(path) {
        if (!state.ready) { throw new Error('编辑器尚未就绪'); }
        const existing = state.tabs.find(function (tab) { return tab.path === path; });
        if (existing) {
            activate(existing);
            return existing;
        }
        const data = await window.CodeAPI.readFile(path);
        const tab = createTab(data);
        activate(tab);
        return tab;
    }

    async function saveTab(tab, baseEtag) {
        const version = tab.model.getVersionId();
        const result = await window.CodeAPI.writeFile({
            path: tab.path,
            content: tab.model.getValue(),
            encoding: tab.encoding,
            eol: tab.eol,
            baseEtag: baseEtag === undefined ? tab.etag : baseEtag
        });
        tab.etag = result.etag;
        tab.mtimeNs = result.mtimeNs;
        tab.encoding = result.encoding || tab.encoding;
        tab.eol = result.eol || tab.eol;
        if (tab.model.getVersionId() === version) {
            tab.dirty = false;
        }
        renderTabs();
        emitTabs();
        emitStatus();
        return true;
    }

    async function reloadTab(tab) {
        const data = await window.CodeAPI.readFile(tab.path);
        tab.model.setValue(data.content);
        if (data.eol === 'CRLF') {
            tab.model.setEOL(state.monaco.editor.EndOfLineSequence.CRLF);
        } else {
            tab.model.setEOL(state.monaco.editor.EndOfLineSequence.LF);
        }
        tab.dirty = false;
        tab.etag = data.etag;
        tab.mtimeNs = data.mtimeNs;
        tab.encoding = data.encoding || 'utf-8';
        tab.eol = data.eol === 'mixed' ? 'LF' : (data.eol || 'LF');
        tab.readOnly = data.writable === false;
        renderTabs();
        emitTabs();
        emitStatus();
        if (state.preview) { refreshPreview(); }
        return true;
    }

    async function reloadPath(path) {
        const tab = state.tabs.find(function (item) { return item.path === path; });
        if (!tab) { return false; }
        if (tab.dirty) { return false; }
        await reloadTab(tab);
        return true;
    }

    function getSelectionText() {
        if (!state.editor) { return ''; }
        const model = state.editor.getModel();
        const selection = state.editor.getSelection();
        if (!model || !selection || selection.isEmpty()) { return ''; }
        return model.getValueInRange(selection);
    }

    async function saveActive() {
        const tab = state.active;
        if (!tab) { return false; }
        if (tab.readOnly) {
            if (window.CodeUI) { window.CodeUI.alert('只读文件', '当前文件没有写入权限。'); }
            return false;
        }
        if (!tab.dirty) { return true; }
        try {
            await saveTab(tab);
            emit('code:saved', { path: tab.path });
            return true;
        } catch (err) {
            if (err && err.status === 409) {
                return handleConflict(tab, err);
            }
            if (window.CodeUI) {
                await window.CodeUI.alert('保存失败', err.message || String(err));
            }
            return false;
        }
    }

    async function handleConflict(tab, err) {
        const remoteEtag = err.extra && err.extra.etag;
        if (window.CodeUI && window.CodeUI.choose) {
            const choice = await window.CodeUI.choose({
                title: '文件已被外部修改',
                message: '“' + tab.path + '”在打开后已被其他程序修改。要如何处理？',
                options: [
                    { label: '重新加载', value: 'reload' },
                    { label: '覆盖保存', value: 'overwrite', kind: 'danger' },
                    { label: '取消', value: 'cancel' }
                ]
            });
            if (choice === 'reload') {
                try {
                    await reloadTab(tab);
                    return false;
                } catch (reloadError) {
                    await window.CodeUI.alert('重新加载失败', reloadError.message);
                    return false;
                }
            }
            if (choice === 'overwrite') {
                try {
                    await saveTab(tab, remoteEtag);
                    emit('code:saved', { path: tab.path });
                    return true;
                } catch (saveError) {
                    await window.CodeUI.alert('保存失败', saveError.message);
                    return false;
                }
            }
            return false;
        }
        if (window.confirm('文件已被外部修改，是否覆盖保存？')) {
            await saveTab(tab, remoteEtag);
            emit('code:saved', { path: tab.path });
            return true;
        }
        return false;
    }

    async function closeTab(tab, force) {
        if (!tab) { return; }
        if (tab.dirty && !force) {
            const ok = window.CodeUI
                ? await window.CodeUI.confirm({
                    title: '未保存的更改',
                    message: '“' + tab.name + '”有未保存的更改，确定关闭吗？',
                    confirmText: '关闭',
                    danger: true
                })
                : window.confirm('“' + tab.name + '”有未保存的更改，确定关闭吗？');
            if (!ok) { return; }
        }
        const index = state.tabs.indexOf(tab);
        if (index < 0) { return; }
        if (state.active === tab) {
            state.active = null;
            state.editor.setModel(null);
        }
        state.tabs.splice(index, 1);
        try { tab.model.dispose(); } catch (err) { /* ignore */ }
        if (!state.active) {
            const next = state.tabs[Math.min(index, state.tabs.length - 1)];
            if (next) {
                activate(next);
            } else {
                state.preview = false;
                showWelcome();
                renderTabs();
                renderBreadcrumbs();
                emitTabs();
            }
        } else {
            renderTabs();
            emitTabs();
        }
    }

    function closeActive() {
        return closeTab(state.active);
    }

    function hasDirty() {
        return state.tabs.some(function (tab) { return tab.dirty; });
    }

    function togglePreview() {
        if (!state.active) { return; }
        if (languageFor(state.active.path) !== 'markdown') { return; }
        setPreviewVisible(!state.preview);
    }

    function handleRenamed(oldPath, newPath) {
        const prefix = oldPath + '/';
        state.tabs.forEach(function (tab) {
            if (tab.path === oldPath) {
                tab.path = newPath;
            } else if (tab.path.indexOf(prefix) === 0) {
                tab.path = newPath + tab.path.slice(oldPath.length);
            } else {
                return;
            }
            tab.name = tab.path.split('/').pop();
            try { state.monaco.editor.setModelLanguage(tab.model, languageFor(tab.path)); } catch (err) { /* ignore */ }
        });
        renderTabs();
        renderBreadcrumbs();
        emitTabs();
        emitStatus();
    }

    async function handleDeleted(path) {
        const prefix = path + '/';
        const affected = state.tabs.filter(function (tab) {
            return tab.path === path || tab.path.indexOf(prefix) === 0;
        });
        if (!affected.length) { return; }
        if (affected.some(function (tab) { return tab.dirty; })) {
            const ok = window.CodeUI
                ? await window.CodeUI.confirm({
                    title: '文件已被删除',
                    message: '删除的路径下还有未保存的标签，是否关闭这些标签？',
                    confirmText: '关闭标签',
                    danger: true
                })
                : window.confirm('删除的路径下还有未保存的标签，是否关闭这些标签？');
            if (!ok) { return; }
        }
        for (const tab of affected) {
            await closeTab(tab, true);
        }
    }

    function reset() {
        state.tabs.forEach(function (tab) {
            try { tab.model.dispose(); } catch (err) { /* ignore */ }
        });
        state.tabs = [];
        state.active = null;
        state.preview = false;
        if (state.editor) { state.editor.setModel(null); }
        showWelcome();
        renderTabs();
        renderBreadcrumbs();
        emitTabs();
    }

    async function revealPosition(path, line, column) {
        if (!state.ready) { throw new Error('编辑器尚未就绪'); }
        const existing = state.tabs.find(function (tab) { return tab.path === path; });
        const tab = existing || await openFile(path);
        if (!existing) { activate(tab); }
        const lineNumber = Math.max(1, Math.min(parseInt(line, 10) || 1, tab.model.getLineCount()));
        const col = Math.max(1, parseInt(column, 10) || 1);
        if (state.editor) {
            state.editor.revealLineInCenter(lineNumber);
            state.editor.setPosition({ lineNumber: lineNumber, column: col });
            state.editor.focus();
        }
        return tab;
    }

    window.CodeEditor = {
        init: init,
        openFile: openFile,
        revealPosition: revealPosition,
        reloadPath: reloadPath,
        getSelectionText: getSelectionText,
        saveActive: saveActive,
        saveTab: saveTab,
        closeTab: closeTab,
        closeActive: closeActive,
        handleRenamed: handleRenamed,
        handleDeleted: handleDeleted,
        hasDirty: hasDirty,
        togglePreview: togglePreview,
        refreshPreview: refreshPreview,
        reset: reset,
        layout: layout,
        focus: function () { if (state.editor) { state.editor.focus(); } },
        getActiveTab: function () { return state.active; },
        getActivePath: function () { return state.active ? state.active.path : null; },
        getLanguage: function (path) { return languageFor(path); },
        isReady: function () { return state.ready; }
    };
})();
