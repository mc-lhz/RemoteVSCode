// 文件资源管理器
(function () {
    'use strict';

    const state = {
        workspace: null,
        rootNodes: [],
        selectedPath: '',
        selectedDir: '',
        activePath: ''
    };

    const dom = {};
    let contextMenu = null;

    function cacheDom() {
        dom.tree = document.getElementById('file-tree');
        dom.empty = document.getElementById('tree-empty');
        dom.path = document.getElementById('workspace-path');
        dom.name = document.getElementById('workspace-name');
        dom.row = document.getElementById('btn-workspace-row');
        dom.openFolder = document.getElementById('btn-open-folder-sidebar');
        dom.newFile = document.getElementById('btn-new-file');
        dom.newFolder = document.getElementById('btn-new-folder');
        dom.upload = document.getElementById('btn-upload');
        dom.collapse = document.getElementById('btn-collapse');
    }

    function joinPath(dir, name) {
        return dir ? dir + '/' + name : name;
    }

    function parentPath(path) {
        const index = String(path || '').lastIndexOf('/');
        return index >= 0 ? path.slice(0, index) : '';
    }

    function makeNode(entry) {
        return {
            path: entry.path,
            name: entry.name,
            type: entry.type,
            size: entry.size,
            etag: entry.etag,
            children: null,
            loaded: false,
            expanded: false,
            loading: false,
            error: ''
        };
    }

    function findNode(path, nodes) {
        const list = nodes || state.rootNodes;
        for (const node of list) {
            if (node.path === path) { return node; }
            if (node.children && path.indexOf(node.path + '/') === 0) {
                const found = findNode(path, node.children);
                if (found) { return found; }
            }
        }
        return null;
    }

    function collectExpanded(nodes, result) {
        const list = nodes || state.rootNodes;
        const out = result || [];
        list.forEach(function (node) {
            if (node.type === 'dir' && node.expanded) {
                out.push(node.path);
                if (node.children) { collectExpanded(node.children, out); }
            }
        });
        return out;
    }

    function setToolbarEnabled(enabled) {
        [dom.newFile, dom.newFolder, dom.upload].forEach(function (button) {
            if (button) { button.disabled = !enabled; }
        });
    }

    function updateWorkspaceSummary() {
        const workspace = state.workspace;
        if (dom.name) {
            dom.name.textContent = workspace ? (workspace.name || workspace.root) : '';
            dom.name.title = workspace ? workspace.root : '';
        }
        if (dom.row) {
            dom.row.classList.toggle('hidden', !workspace);
        }
        if (dom.openFolder) {
            dom.openFolder.classList.toggle('hidden', !!workspace);
        }
        if (dom.path) {
            dom.path.textContent = workspace ? workspace.root : '';
            dom.path.title = workspace ? workspace.root : '';
            dom.path.classList.add('hidden');
        }
    }

    function render() {
        if (!dom.tree) { return; }
        const hasWorkspace = !!state.workspace;
        if (dom.empty) { dom.empty.classList.toggle('hidden', hasWorkspace); }
        dom.tree.classList.toggle('hidden', !hasWorkspace);
        setToolbarEnabled(hasWorkspace);
        updateWorkspaceSummary();

        if (!hasWorkspace) {
            dom.tree.innerHTML = '';
            return;
        }

        dom.tree.innerHTML = '';
        if (!state.rootNodes.length) {
            const empty = document.createElement('div');
            empty.className = 'tree-loading';
            empty.textContent = '文件夹为空';
            dom.tree.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.rootNodes.forEach(function (node) {
            fragment.appendChild(renderNode(node, 0));
        });
        dom.tree.appendChild(fragment);
    }

    function renderNode(node, depth) {
        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node';
        wrapper.dataset.path = node.path;

        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingLeft = (depth * 12 + 6) + 'px';
        row.setAttribute('role', 'treeitem');
        row.title = node.path;
        if (node.path === state.selectedPath) { row.classList.add('selected'); }
        if (node.path === state.activePath) { row.classList.add('active'); }

        const chevron = document.createElement('span');
        chevron.className = 'tree-chevron codicon codicon-chevron-right';
        if (node.type !== 'dir') {
            chevron.classList.add('placeholder');
        } else if (node.expanded) {
            chevron.classList.add('expanded');
        }
        row.appendChild(chevron);

        const icon = document.createElement('span');
        icon.className = 'tree-icon codicon ' + (node.type === 'dir' ? 'codicon-folder folder' : 'codicon-file file');
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'tree-name';
        name.textContent = node.name;
        row.appendChild(name);

        row.addEventListener('click', function () {
            selectNode(node);
            if (node.type === 'dir') {
                toggleDir(node);
            } else {
                openPath(node.path);
            }
        });
        row.addEventListener('contextmenu', function (event) {
            event.preventDefault();
            event.stopPropagation();
            selectNode(node);
            showContextMenu(event.clientX, event.clientY, node);
        });

        wrapper.appendChild(row);

        if (node.type === 'dir' && node.expanded) {
            if (node.loading) {
                const loading = document.createElement('div');
                loading.className = 'tree-loading';
                loading.textContent = '加载中…';
                wrapper.appendChild(loading);
            } else if (node.error) {
                const error = document.createElement('div');
                error.className = 'tree-error';
                error.textContent = node.error;
                wrapper.appendChild(error);
            } else if (node.children) {
                node.children.forEach(function (child) {
                    wrapper.appendChild(renderNode(child, depth + 1));
                });
            }
        }
        return wrapper;
    }

    function selectNode(node) {
        state.selectedPath = node ? node.path : '';
        state.selectedDir = !node
            ? ''
            : (node.type === 'dir' ? node.path : parentPath(node.path));
    }

    function setActivePath(path) {
        state.activePath = path || '';
        render();
    }

    async function loadChildren(node, silent) {
        node.loading = true;
        node.error = '';
        if (!silent) { render(); }
        try {
            const data = await window.CodeAPI.tree(node.path);
            node.children = (data.entries || []).map(makeNode);
            node.loaded = true;
        } catch (err) {
            node.error = err.message || '加载失败';
        } finally {
            node.loading = false;
            if (!silent) { render(); }
        }
    }

    async function toggleDir(node) {
        if (node.expanded) {
            node.expanded = false;
            render();
            return;
        }
        node.expanded = true;
        if (!node.loaded) {
            await loadChildren(node);
        } else {
            render();
        }
    }

    async function loadRoot(silent) {
        const data = await window.CodeAPI.tree('');
        state.rootNodes = (data.entries || []).map(makeNode);
        if (!silent) { render(); }
    }

    async function setWorkspace(workspace) {
        state.workspace = workspace || null;
        state.rootNodes = [];
        state.selectedPath = '';
        state.selectedDir = '';
        state.activePath = '';
        render();
        if (!state.workspace) { return; }
        try {
            await loadRoot();
        } catch (err) {
            state.rootNodes = [];
            render();
            await alertError('打开文件夹失败', err.message);
        }
    }

    async function refresh() {
        if (!state.workspace) { return; }
        const expandedPaths = collectExpanded();
        try {
            await loadRoot(true);
            for (const path of expandedPaths) {
                const node = findNode(path);
                if (node && node.type === 'dir') {
                    node.expanded = true;
                    await loadChildren(node, true);
                }
            }
            render();
        } catch (err) {
            await alertError('刷新失败', err.message);
        }
    }

    function collapseAll() {
        state.rootNodes.forEach(function collapse(node) {
            if (node.children) { node.children.forEach(collapse); }
            node.expanded = false;
        });
        render();
    }

    function alertError(title, message) {
        if (window.CodeUI && window.CodeUI.alert) {
            return window.CodeUI.alert(title, message || String(message));
        }
        window.alert(title + '\n' + (message || ''));
        return Promise.resolve();
    }

    function ask(options) {
        if (window.CodeUI && window.CodeUI.prompt) {
            return window.CodeUI.prompt(options);
        }
        return Promise.resolve(window.prompt(options.label || options.title, options.value || ''));
    }

    async function confirmAction(title, message, danger) {
        if (window.CodeUI && window.CodeUI.confirm) {
            return window.CodeUI.confirm({
                title: title,
                message: message,
                confirmText: danger ? '删除' : '确定',
                danger: !!danger
            });
        }
        return window.confirm(message);
    }

    async function openPath(path) {
        try {
            await window.CodeEditor.openFile(path);
            state.activePath = path;
            render();
        } catch (err) {
            await alertError('打开失败', err.message);
        }
    }

    async function newFile(dir) {
        const name = await ask({
            title: '新建文件',
            label: '文件名',
            placeholder: 'example.py',
            value: ''
        });
        if (!name) { return; }
        const path = joinPath(dir || state.selectedDir || '', name.trim());
        try {
            await window.CodeAPI.writeFile({
                path: path,
                content: '',
                encoding: 'utf-8',
                eol: 'CRLF',
                create: true
            });
            state.selectedDir = dir || state.selectedDir || '';
            await refresh();
            await openPath(path);
        } catch (err) {
            await alertError('新建文件失败', err.message);
        }
    }

    async function newFolder(dir) {
        const name = await ask({
            title: '新建文件夹',
            label: '文件夹名',
            placeholder: 'src',
            value: ''
        });
        if (!name) { return; }
        const path = joinPath(dir || state.selectedDir || '', name.trim());
        try {
            await window.CodeAPI.mkdir(path);
            state.selectedDir = path;
            await refresh();
        } catch (err) {
            await alertError('新建文件夹失败', err.message);
        }
    }

    async function renameNode(node) {
        if (!node) { return; }
        const name = await ask({
            title: '重命名',
            label: '新名称',
            value: node.name
        });
        if (!name || name.trim() === node.name) { return; }
        const newPath = joinPath(parentPath(node.path), name.trim());
        try {
            await window.CodeAPI.rename(node.path, newPath);
            window.CodeEditor.handleRenamed(node.path, newPath);
            state.selectedPath = newPath;
            state.selectedDir = node.type === 'dir' ? newPath : parentPath(newPath);
            await refresh();
        } catch (err) {
            await alertError('重命名失败', err.message);
        }
    }

    async function deleteNode(node) {
        if (!node) { return; }
        const message = node.type === 'dir'
            ? '确定删除文件夹“' + node.name + '”及其全部内容吗？'
            : '确定删除文件“' + node.name + '”吗？';
        if (!await confirmAction('删除', message, true)) { return; }
        try {
            await window.CodeAPI.remove(node.path, node.type === 'dir');
            await window.CodeEditor.handleDeleted(node.path);
            state.selectedPath = '';
            state.selectedDir = parentPath(node.path);
            await refresh();
        } catch (err) {
            await alertError('删除失败', err.message);
        }
    }

    function downloadNode(node) {
        if (!node || node.type !== 'file') { return; }
        const link = document.createElement('a');
        link.href = window.CodeAPI.rawUrl(node.path, false);
        link.download = node.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function requestUpload(dir) {
        document.dispatchEvent(new CustomEvent('code:upload-request', {
            detail: { dir: dir || state.selectedDir || '' }
        }));
    }

    function closeContextMenu() {
        if (contextMenu && contextMenu.parentNode) {
            contextMenu.parentNode.removeChild(contextMenu);
        }
        contextMenu = null;
    }

    function contextItem(label, icon, action, kind) {
        const button = document.createElement('button');
        button.className = 'context-menu-item' + (kind ? ' ' + kind : '');
        const iconEl = document.createElement('span');
        iconEl.className = 'codicon ' + icon;
        const text = document.createElement('span');
        text.textContent = label;
        button.appendChild(iconEl);
        button.appendChild(text);
        button.addEventListener('click', function () {
            closeContextMenu();
            Promise.resolve(action()).catch(function (err) {
                alertError('操作失败', err.message || String(err));
            });
        });
        return button;
    }

    function contextSeparator() {
        const separator = document.createElement('div');
        separator.className = 'context-menu-separator';
        return separator;
    }

    function showContextMenu(x, y, node) {
        closeContextMenu();
        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';

        if (!node) {
            if (!state.workspace) {
                contextMenu.appendChild(contextItem('打开文件夹...', 'codicon-folder-opened', function () {
                    document.dispatchEvent(new CustomEvent('code:open-folder-request'));
                }));
            } else {
                contextMenu.appendChild(contextItem('新建文件', 'codicon-new-file', function () {
                    return newFile(state.selectedDir || '');
                }));
                contextMenu.appendChild(contextItem('新建文件夹', 'codicon-new-folder', function () {
                    return newFolder(state.selectedDir || '');
                }));
                contextMenu.appendChild(contextItem('上传文件', 'codicon-cloud-upload', function () {
                    requestUpload(state.selectedDir || '');
                }));
                contextMenu.appendChild(contextSeparator());
                contextMenu.appendChild(contextItem('折叠文件夹', 'codicon-collapse-all', collapseAll));
                contextMenu.appendChild(contextItem('刷新', 'codicon-refresh', refresh));
            }
        } else if (node.type === 'dir') {
            contextMenu.appendChild(contextItem('新建文件', 'codicon-new-file', function () {
                return newFile(node.path);
            }));
            contextMenu.appendChild(contextItem('新建文件夹', 'codicon-new-folder', function () {
                return newFolder(node.path);
            }));
            contextMenu.appendChild(contextItem('上传到此处', 'codicon-cloud-upload', function () {
                requestUpload(node.path);
            }));
            contextMenu.appendChild(contextSeparator());
            contextMenu.appendChild(contextItem('重命名', 'codicon-edit', function () {
                return renameNode(node);
            }));
            contextMenu.appendChild(contextItem('删除', 'codicon-trash', function () {
                return deleteNode(node);
            }, 'danger'));
            contextMenu.appendChild(contextSeparator());
            contextMenu.appendChild(contextItem('刷新', 'codicon-refresh', refresh));
        } else {
            contextMenu.appendChild(contextItem('打开', 'codicon-go-to-file', function () {
                return openPath(node.path);
            }));
            contextMenu.appendChild(contextItem('下载', 'codicon-cloud-download', function () {
                downloadNode(node);
            }));
            contextMenu.appendChild(contextSeparator());
            contextMenu.appendChild(contextItem('重命名', 'codicon-edit', function () {
                return renameNode(node);
            }));
            contextMenu.appendChild(contextItem('删除', 'codicon-trash', function () {
                return deleteNode(node);
            }, 'danger'));
        }

        document.body.appendChild(contextMenu);
        const rect = contextMenu.getBoundingClientRect();
        const left = Math.min(x, window.innerWidth - rect.width - 8);
        const top = Math.min(y, window.innerHeight - rect.height - 8);
        contextMenu.style.left = Math.max(4, left) + 'px';
        contextMenu.style.top = Math.max(4, top) + 'px';
    }

    function showMenuAt(x, y) {
        showContextMenu(x, y, null);
    }

    function init() {
        cacheDom();
        if (dom.newFile) {
            dom.newFile.addEventListener('click', function () { newFile(state.selectedDir); });
        }
        if (dom.newFolder) {
            dom.newFolder.addEventListener('click', function () { newFolder(state.selectedDir); });
        }
        if (dom.upload) {
            dom.upload.addEventListener('click', function () { requestUpload(state.selectedDir); });
        }
        if (dom.collapse) {
            dom.collapse.addEventListener('click', collapseAll);
        }
        if (dom.tree) {
            dom.tree.addEventListener('contextmenu', function (event) {
                if (event.target.closest('.tree-row')) { return; }
                event.preventDefault();
                showContextMenu(event.clientX, event.clientY, null);
            });
        }
        document.addEventListener('click', function (event) {
            if (contextMenu && !contextMenu.contains(event.target)) { closeContextMenu(); }
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') { closeContextMenu(); }
        });
        window.addEventListener('blur', closeContextMenu);
        document.addEventListener('code:active-changed', function (event) {
            setActivePath(event.detail ? event.detail.path : '');
        });
        document.addEventListener('code:open-file', function (event) {
            if (event.detail && event.detail.path) { openPath(event.detail.path); }
        });
        render();
    }

    window.CodeExplorer = {
        init: init,
        setWorkspace: setWorkspace,
        refresh: refresh,
        collapseAll: collapseAll,
        setActivePath: setActivePath,
        newFile: function (dir) { return newFile(dir); },
        newFolder: function (dir) { return newFolder(dir); },
        requestUpload: function (dir) { requestUpload(dir); },
        showMenuAt: showMenuAt,
        getSelectedDir: function () { return state.selectedDir || ''; },
        getWorkspace: function () { return state.workspace; }
    };
})();
