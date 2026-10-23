// Markdown 渲染 + 相对资源解析
(function () {
    'use strict';

    function dirname(path) {
        const index = String(path || '').lastIndexOf('/');
        return index >= 0 ? path.slice(0, index) : '';
    }

    function resolvePath(baseFile, relative) {
        if (!relative) { return null; }
        let src = String(relative).trim();
        if (!src || src.charAt(0) === '#') { return null; }
        if (/^(https?:|mailto:|data:)/i.test(src)) { return null; }
        src = src.split('#')[0].split('?')[0];
        try { src = decodeURIComponent(src); } catch (err) { /* 保留原样 */ }

        const parts = src.charAt(0) === '/'
            ? []
            : dirname(baseFile).split('/').filter(Boolean);
        if (src.charAt(0) === '/') { src = src.slice(1); }
        src.split('/').forEach(function (part) {
            if (!part || part === '.') { return; }
            if (part === '..') {
                if (parts.length) { parts.pop(); }
                return;
            }
            parts.push(part);
        });
        return parts.join('/');
    }

    function isExternal(href) {
        return /^(https?:|mailto:)/i.test(String(href || ''));
    }

    function render(markdown, filePath) {
        if (!window.marked || !window.DOMPurify) {
            throw new Error('Markdown 渲染库未加载');
        }
        const raw = window.marked.parse(markdown || '', {
            gfm: true,
            breaks: false
        });
        const clean = window.DOMPurify.sanitize(raw, {
            USE_PROFILES: { html: true },
            ADD_ATTR: ['target']
        });
        const wrapper = document.createElement('div');
        wrapper.innerHTML = clean;

        wrapper.querySelectorAll('a[href]').forEach(function (link) {
            const href = link.getAttribute('href');
            if (isExternal(href)) {
                link.setAttribute('target', '_blank');
                link.setAttribute('rel', 'noopener noreferrer');
                return;
            }
            const target = resolvePath(filePath, href);
            if (target) {
                link.setAttribute('href', '#');
                link.setAttribute('data-code-path', target);
            }
        });

        wrapper.querySelectorAll('img[src]').forEach(function (image) {
            const src = image.getAttribute('src');
            if (/^(https?:|data:image\/)/i.test(src)) {
                image.setAttribute('loading', 'lazy');
                return;
            }
            const target = resolvePath(filePath, src);
            if (target) {
                image.src = window.CodeAPI.rawUrl(target, true);
            }
            image.setAttribute('loading', 'lazy');
        });

        return wrapper.innerHTML;
    }

    window.CodeMarkdown = {
        render: render,
        resolvePath: resolvePath
    };
})();
