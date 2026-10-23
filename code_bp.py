# -*- coding: utf-8 -*-
"""Code 插件 — 浏览器内代码编辑器。

路由:
    GET  /code                         工作台页面
    GET  /code/api/drives              盘符列表
    GET  /code/api/browse              文件夹选择器
    POST /code/api/workspaces          打开工作区
    GET  /code/api/fs/tree             目录列表
    GET  /code/api/fs/file             读取文本
    PUT  /code/api/fs/file             保存文本
    POST /code/api/fs/mkdir            新建文件夹
    POST /code/api/fs/rename           重命名/移动
    DELETE /code/api/fs/entry          删除文件/文件夹
    GET  /code/api/fs/raw              原始文件下载/图片预览
    POST /code/api/fs/upload           上传文件
    GET  /code/api/runtimes            Python/Node/g++ 探测
"""

import json
import mimetypes
import os
import sys

from flask import Blueprint, jsonify, render_template, request, send_file

pluginDir = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(pluginDir, 'plugin.json'), encoding='utf-8-sig') as manifestFile:
    pluginID = json.load(manifestFile)['id']

try:
    from rc_code_fs import (
        FileServiceError,
        MAX_UPLOAD_BYTES,
        browseDirectories,
        deleteEntry,
        getRuntimes,
        listDirectory,
        listDrives,
        makeDirectory,
        rawFile,
        readTextFile,
        registry,
        renameEntry,
        saveUpload,
        writeTextFile,
    )
except ImportError:
    # 直接运行/测试时 pluginHost 可能还没把 lib 加入 sys.path。
    libDir = os.path.join(pluginDir, 'lib')
    if libDir not in sys.path:
        sys.path.insert(0, libDir)
    from rc_code_fs import (
        FileServiceError,
        MAX_UPLOAD_BYTES,
        browseDirectories,
        deleteEntry,
        getRuntimes,
        listDirectory,
        listDrives,
        makeDirectory,
        rawFile,
        readTextFile,
        registry,
        renameEntry,
        saveUpload,
        writeTextFile,
    )


code_bp = Blueprint(
    '{}_bp'.format(pluginID),
    __name__,
    template_folder='templates',
    static_folder='static',
    static_url_path='/{}/static'.format(pluginID),
)

_SAFE_INLINE_IMAGE_TYPES = {
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
}


def _jsonBody():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise FileServiceError(400, 'invalid_json', '请求体必须是 JSON 对象')
    return payload


def _workspaceFromPayload(payload):
    workspaceID = payload.get('workspaceId') or request.args.get('workspaceId')
    return registry.get(workspaceID)


def _boolValue(value):
    return str(value).lower() in ('1', 'true', 'yes', 'on')


@code_bp.errorhandler(FileServiceError)
def _handleFileServiceError(exc):
    return jsonify({'error': exc.toDict()}), exc.status


@code_bp.after_request
def _noStore(response):
    if request.path.startswith('/code/api/'):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@code_bp.route('/code')
def codePage():
    return render_template('code.html', pluginID=pluginID)


@code_bp.route('/code/api/drives')
def apiDrives():
    return jsonify({'drives': listDrives()})


@code_bp.route('/code/api/browse')
def apiBrowse():
    return jsonify(browseDirectories(request.args.get('path')))


@code_bp.route('/code/api/workspaces', methods=['POST'])
def apiOpenWorkspace():
    payload = _jsonBody()
    workspace = registry.create(payload.get('root'))
    return jsonify({'workspace': workspace.toDict()})


@code_bp.route('/code/api/fs/tree')
def apiTree():
    payload = request.args
    workspace = registry.get(payload.get('workspaceId'))
    return jsonify(listDirectory(workspace, payload.get('path')))


@code_bp.route('/code/api/fs/file', methods=['GET'])
def apiReadFile():
    workspace = registry.get(request.args.get('workspaceId'))
    return jsonify(readTextFile(workspace, request.args.get('path')))


@code_bp.route('/code/api/fs/file', methods=['PUT'])
def apiWriteFile():
    payload = _jsonBody()
    workspace = _workspaceFromPayload(payload)
    result = writeTextFile(
        workspace,
        payload.get('path'),
        payload.get('content', ''),
        encoding=payload.get('encoding'),
        eol=payload.get('eol'),
        baseEtag=payload.get('baseEtag'),
        create=_boolValue(payload.get('create')),
    )
    return jsonify(result)


@code_bp.route('/code/api/fs/mkdir', methods=['POST'])
def apiMkdir():
    payload = _jsonBody()
    workspace = _workspaceFromPayload(payload)
    return jsonify(makeDirectory(workspace, payload.get('path')))


@code_bp.route('/code/api/fs/rename', methods=['POST'])
def apiRename():
    payload = _jsonBody()
    workspace = _workspaceFromPayload(payload)
    return jsonify(renameEntry(workspace, payload.get('path'), payload.get('newPath')))


@code_bp.route('/code/api/fs/entry', methods=['DELETE'])
def apiDelete():
    workspace = registry.get(request.args.get('workspaceId'))
    recursive = _boolValue(request.args.get('recursive'))
    return jsonify(deleteEntry(workspace, request.args.get('path'), recursive=recursive))


@code_bp.route('/code/api/fs/raw')
def apiRaw():
    workspace = registry.get(request.args.get('workspaceId'))
    full, rel, st = rawFile(workspace, request.args.get('path'))
    mime = mimetypes.guess_type(full)[0] or 'application/octet-stream'
    inline = _boolValue(request.args.get('inline'))
    asAttachment = (not inline) or (mime not in _SAFE_INLINE_IMAGE_TYPES)
    response = send_file(
        full,
        mimetype=mime,
        as_attachment=asAttachment,
        download_name=os.path.basename(full),
        conditional=True,
        max_age=0,
    )
    if inline and not asAttachment:
        response.headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@code_bp.route('/code/api/fs/upload', methods=['POST'])
def apiUpload():
    workspace = registry.get(request.form.get('workspaceId'))
    file = request.files.get('file')
    if file is None or not file.filename:
        raise FileServiceError(400, 'no_file', '没有选择文件')
    return jsonify(saveUpload(
        workspace,
        request.form.get('path', ''),
        file.filename,
        file.stream,
        overwrite=_boolValue(request.form.get('overwrite')),
    ))


@code_bp.route('/code/api/runtimes')
def apiRuntimes():
    return jsonify(getRuntimes())
