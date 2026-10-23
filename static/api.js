// Code 插件 API 客户端
(function () {
    'use strict';

    class CodeApiError extends Error {
        constructor(status, code, message, extra) {
            super(message || '请求失败');
            this.name = 'CodeApiError';
            this.status = status;
            this.code = code || 'http_error';
            this.extra = extra || {};
        }
    }

    let workspace = null;

    function qs(params) {
        const parts = [];
        Object.keys(params || {}).forEach(function (key) {
            const value = params[key];
            if (value === undefined || value === null || value === '') { return; }
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        });
        return parts.join('&');
    }

    async function parseResponse(response) {
        const text = await response.text();
        if (!text) { return null; }
        try {
            return JSON.parse(text);
        } catch (err) {
            return { error: { code: 'invalid_response', message: text.slice(0, 300) } };
        }
    }

    async function request(url, options) {
        const opts = Object.assign({}, options || {});
        opts.headers = Object.assign({}, opts.headers || {});
        if (opts.body !== undefined && opts.body !== null
            && !(opts.body instanceof FormData)
            && typeof opts.body !== 'string') {
            opts.body = JSON.stringify(opts.body);
            opts.headers['Content-Type'] = 'application/json';
        }
        let response;
        try {
            response = await fetch(url, opts);
        } catch (err) {
            throw new CodeApiError(0, 'network_error', '无法连接服务器');
        }
        const data = await parseResponse(response);
        if (!response.ok) {
            const detail = (data && data.error) || {};
            throw new CodeApiError(
                response.status,
                detail.code || 'http_error',
                detail.message || ('请求失败 (' + response.status + ')'),
                detail
            );
        }
        return data;
    }

    function requireWorkspace() {
        if (!workspace || !workspace.id) {
            throw new CodeApiError(400, 'no_workspace', '请先打开文件夹');
        }
        return workspace;
    }

    const api = {
        get workspace() { return workspace; },
        get workspaceId() { return workspace ? workspace.id : null; },
        get workspaceRoot() { return workspace ? workspace.root : ''; },

        setWorkspace(value) {
            workspace = value || null;
        },

        async openWorkspace(root) {
            const data = await request('/code/api/workspaces', {
                method: 'POST',
                body: { root: root }
            });
            workspace = data.workspace;
            return workspace;
        },

        drives() {
            return request('/code/api/drives');
        },

        browse(path) {
            return request('/code/api/browse?' + qs({ path: path || '' }));
        },

        tree(path) {
            const ws = requireWorkspace();
            return request('/code/api/fs/tree?' + qs({
                workspaceId: ws.id,
                path: path || ''
            }));
        },

        search(query, options) {
            const ws = requireWorkspace();
            const opts = options || {};
            return request('/code/api/fs/search?' + qs({
                workspaceId: ws.id,
                query: query,
                case: opts.caseSensitive ? '1' : '',
                regex: opts.regex ? '1' : ''
            }));
        },

        replace(query, replacement, options) {
            const ws = requireWorkspace();
            const opts = options || {};
            return request('/code/api/fs/replace', {
                method: 'POST',
                body: {
                    workspaceId: ws.id,
                    query: query,
                    replacement: replacement || '',
                    case: !!opts.caseSensitive,
                    regex: !!opts.regex
                }
            });
        },

        listFiles() {
            const ws = requireWorkspace();
            return request('/code/api/fs/list?' + qs({ workspaceId: ws.id }));
        },

        readFile(path) {
            const ws = requireWorkspace();
            return request('/code/api/fs/file?' + qs({
                workspaceId: ws.id,
                path: path
            }));
        },

        writeFile(payload) {
            const ws = requireWorkspace();
            const body = Object.assign({}, payload || {}, { workspaceId: ws.id });
            return request('/code/api/fs/file', { method: 'PUT', body: body });
        },

        mkdir(path) {
            const ws = requireWorkspace();
            return request('/code/api/fs/mkdir', {
                method: 'POST',
                body: { workspaceId: ws.id, path: path }
            });
        },

        rename(path, newPath) {
            const ws = requireWorkspace();
            return request('/code/api/fs/rename', {
                method: 'POST',
                body: { workspaceId: ws.id, path: path, newPath: newPath }
            });
        },

        remove(path, recursive) {
            const ws = requireWorkspace();
            return request('/code/api/fs/entry?' + qs({
                workspaceId: ws.id,
                path: path,
                recursive: recursive ? '1' : ''
            }), { method: 'DELETE' });
        },

        rawUrl(path, inline) {
            const ws = requireWorkspace();
            return '/code/api/fs/raw?' + qs({
                workspaceId: ws.id,
                path: path,
                inline: inline ? '1' : ''
            });
        },

        runtimes() {
            return request('/code/api/runtimes');
        },

        upload(file, dir, onProgress, overwrite) {
            const ws = requireWorkspace();
            return new Promise(function (resolve, reject) {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/code/api/fs/upload');
                xhr.upload.onprogress = function (event) {
                    if (event.lengthComputable && onProgress) {
                        onProgress(event.loaded, event.total);
                    }
                };
                xhr.onerror = function () {
                    reject(new CodeApiError(0, 'network_error', '上传失败：无法连接服务器'));
                };
                xhr.onload = function () {
                    let data = null;
                    try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (err) { data = null; }
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(data);
                        return;
                    }
                    const detail = (data && data.error) || {};
                    reject(new CodeApiError(
                        xhr.status,
                        detail.code || 'upload_failed',
                        detail.message || ('上传失败 (' + xhr.status + ')'),
                        detail
                    ));
                };
                const form = new FormData();
                form.append('workspaceId', ws.id);
                form.append('path', dir || '');
                form.append('file', file);
                form.append('overwrite', overwrite ? 'true' : 'false');
                xhr.send(form);
            });
        }
    };

    window.CodeApiError = CodeApiError;
    window.CodeAPI = api;
})();
