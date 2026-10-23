# -*- coding: utf-8 -*-
"""Code 插件文件服务。

只依赖标准库，供 code_bp.py 调用。所有对外路径都是工作区相对路径，
绝对路径只在打开工作区时出现一次。
"""

import codecs
import mimetypes
import os
import re
import shutil
import stat
import string
import threading
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple


MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_DIR_ENTRIES = 2000

MAX_SEARCH_FILE_BYTES = 512 * 1024
MAX_SEARCH_RESULTS = 500
MAX_SEARCH_MATCHES_PER_FILE = 100
MAX_SEARCH_FILES = 20000
_SEARCH_SKIP_DIR_NAMES = {'node_modules', '__pycache__', 'site-packages', 'venv', '.venv'}

_TEXT_ENCODINGS = ('utf-8', 'gbk')
_WINDOWS_RESERVED = re.compile(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$', re.I)
_INVALID_NAME_CHARS = set('<>:"/\\|?*')


class FileServiceError(Exception):
    """带 HTTP 状态码的文件服务错误。"""

    def __init__(self, status: int, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def toDict(self) -> Dict[str, Any]:
        data = {'code': self.code, 'message': self.message}
        data.update(self.extra)
        return data


class Workspace:
    def __init__(self, workspaceID: str, root: str, name: str):
        self.id = workspaceID
        self.root = root
        self.name = name
        self.createdAt = time.time()

    def toDict(self) -> Dict[str, Any]:
        return {'id': self.id, 'root': self.root, 'name': self.name}


class WorkspaceRegistry:
    """进程内工作区注册表。工作区 id 不持久化，重启后由前端重新注册。"""

    def __init__(self, maxWorkspaces: int = 64):
        self._lock = threading.Lock()
        self._items: Dict[str, Workspace] = {}
        self._byRoot: Dict[str, str] = {}
        self._maxWorkspaces = maxWorkspaces

    def create(self, root: str) -> Workspace:
        if not root or not str(root).strip():
            raise FileServiceError(400, 'invalid_root', '请选择文件夹')
        rootPath = os.path.abspath(os.path.expanduser(str(root).strip()))
        if not os.path.exists(rootPath):
            raise FileServiceError(404, 'root_not_found', '文件夹不存在')
        if not os.path.isdir(rootPath):
            raise FileServiceError(400, 'not_directory', '所选路径不是文件夹')
        rootPath = os.path.realpath(rootPath)
        rootKey = os.path.normcase(rootPath)

        with self._lock:
            existingID = self._byRoot.get(rootKey)
            if existingID:
                existing = self._items.get(existingID)
                if existing is not None:
                    return existing
            if len(self._items) >= self._maxWorkspaces:
                oldestID = min(self._items, key=lambda k: self._items[k].createdAt)
                old = self._items.pop(oldestID, None)
                if old is not None:
                    self._byRoot.pop(os.path.normcase(old.root), None)
            workspaceID = uuid.uuid4().hex
            workspace = Workspace(workspaceID, rootPath, os.path.basename(rootPath.rstrip('\\/')) or rootPath)
            self._items[workspaceID] = workspace
            self._byRoot[rootKey] = workspaceID
            return workspace

    def get(self, workspaceID: str) -> Workspace:
        with self._lock:
            workspace = self._items.get(workspaceID or '')
        if workspace is None:
            raise FileServiceError(404, 'workspace_not_found', '工作区不存在或已失效，请重新打开文件夹')
        return workspace

    def drop(self, workspaceID: str) -> None:
        with self._lock:
            workspace = self._items.pop(workspaceID or '', None)
            if workspace is not None:
                self._byRoot.pop(os.path.normcase(workspace.root), None)


registry = WorkspaceRegistry()


def listDrives() -> List[Dict[str, str]]:
    drives = []
    for letter in string.ascii_uppercase:
        path = letter + ':\\'
        if os.path.exists(path):
            drives.append({'name': letter + ':', 'path': path})
    return drives


def browseDirectories(path: Optional[str]) -> Dict[str, Any]:
    """文件夹选择器专用：只列目录，不读文件。"""
    if not path or not str(path).strip():
        return {'path': '', 'parent': None, 'dirs': [], 'drives': listDrives()}

    raw = os.path.expanduser(str(path).strip())
    if raw == '/':
        return {'path': '', 'parent': None, 'dirs': [], 'drives': listDrives()}
    full = os.path.abspath(raw)
    if not os.path.exists(full):
        raise FileServiceError(404, 'path_not_found', '路径不存在')
    if not os.path.isdir(full):
        raise FileServiceError(400, 'not_directory', '不是文件夹')
    full = os.path.realpath(full)

    dirs = []
    try:
        with os.scandir(full) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append({'name': entry.name, 'path': entry.path})
                except OSError:
                    continue
    except PermissionError:
        raise FileServiceError(403, 'permission_denied', '没有权限读取该文件夹')
    except OSError as exc:
        raise FileServiceError(400, 'browse_failed', str(exc))

    dirs.sort(key=lambda item: item['name'].casefold())
    parent = os.path.dirname(full)
    if parent == full:
        parent = None
    return {'path': full, 'parent': parent, 'dirs': dirs, 'drives': []}


def _checkText(value: str) -> None:
    if not isinstance(value, str):
        raise FileServiceError(400, 'invalid_path', '路径必须是字符串')
    if '\x00' in value or '\r' in value or '\n' in value:
        raise FileServiceError(400, 'invalid_path', '路径包含非法字符')


def _splitRel(relPath: Optional[str]) -> List[str]:
    _checkText(relPath or '')
    raw = (relPath or '').replace('\\', '/')
    if raw.startswith('/') or raw.startswith('//'):
        raise FileServiceError(400, 'invalid_path', '只允许工作区相对路径')
    if re.match(r'^[A-Za-z]:', raw):
        raise FileServiceError(400, 'invalid_path', '只允许工作区相对路径')
    parts = []
    for part in raw.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            raise FileServiceError(400, 'invalid_path', '路径不能包含 ..')
        parts.append(part)
    return parts


def _isInside(root: str, full: str) -> bool:
    try:
        return os.path.normcase(os.path.commonpath([root, full])) == os.path.normcase(root)
    except ValueError:
        return False


def resolvePath(workspace: Workspace, relPath: Optional[str], mustExist: bool = False) -> Tuple[str, str]:
    parts = _splitRel(relPath)
    full = os.path.join(workspace.root, *parts) if parts else workspace.root
    real = os.path.realpath(full)
    if not _isInside(workspace.root, real):
        raise FileServiceError(403, 'outside_workspace', '路径超出工作区范围')
    if mustExist and not os.path.exists(real):
        raise FileServiceError(404, 'not_found', '文件或文件夹不存在')
    rel = '/'.join(parts)
    return real, rel


def _etag(st: os.stat_result) -> str:
    return '{}-{}'.format(st.st_mtime_ns, st.st_size)


def _meta(full: str, rel: str, st: Optional[os.stat_result] = None) -> Dict[str, Any]:
    if st is None:
        st = os.stat(full)
    isDir = stat.S_ISDIR(st.st_mode)
    return {
        'path': rel,
        'name': os.path.basename(full.rstrip('\\/')) or os.path.basename(full),
        'type': 'dir' if isDir else 'file',
        'size': st.st_size,
        'mtimeNs': str(st.st_mtime_ns),
        'etag': _etag(st),
        'writable': os.access(full, os.W_OK),
        'isSymlink': os.path.islink(full),
    }


def _looksText(text: str) -> bool:
    sample = text[:8192]
    if not sample:
        return True
    bad = 0
    for ch in sample:
        code = ord(ch)
        if code < 32 and ch not in '\n\r\t\f\b':
            bad += 1
    return (bad / len(sample)) < 0.05


def decodeText(data: bytes) -> Tuple[str, str]:
    if not data:
        return '', 'utf-8'
    if b'\x00' in data[:8192]:
        raise FileServiceError(415, 'binary_file', '二进制文件不能以文本方式打开')
    if data.startswith(codecs.BOM_UTF8):
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise FileServiceError(415, 'binary_file', '文件编码无法识别')
        if not _looksText(text):
            raise FileServiceError(415, 'binary_file', '二进制文件不能以文本方式打开')
        return text, 'utf-8-sig'

    for encoding in _TEXT_ENCODINGS:
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        if _looksText(text):
            return text, encoding
    raise FileServiceError(415, 'binary_file', '文件编码无法识别或不是文本文件')


def detectEol(text: str) -> str:
    crlf = text.count('\r\n')
    lf = text.count('\n') - crlf
    cr = text.count('\r') - crlf
    if crlf and not lf and not cr:
        return 'CRLF'
    if lf and not crlf and not cr:
        return 'LF'
    if cr and not crlf and not lf:
        return 'CR'
    if crlf or lf or cr:
        return 'mixed'
    return 'LF'


def normalizeEol(text: str, eol: Optional[str]) -> str:
    if eol not in ('LF', 'CRLF', 'CR'):
        return text
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    if eol == 'CRLF':
        return text.replace('\n', '\r\n')
    if eol == 'CR':
        return text.replace('\n', '\r')
    return text


def listDirectory(workspace: Workspace, relPath: Optional[str]) -> Dict[str, Any]:
    full, rel = resolvePath(workspace, relPath, mustExist=True)
    if not os.path.isdir(full):
        raise FileServiceError(400, 'not_directory', '不是文件夹')
    entries = []
    truncated = False
    try:
        with os.scandir(full) as iterator:
            for entry in iterator:
                if len(entries) >= MAX_DIR_ENTRIES:
                    truncated = True
                    break
                try:
                    isLink = entry.is_symlink()
                    isDir = entry.is_dir(follow_symlinks=False)
                    isFile = entry.is_file(follow_symlinks=False)
                    if isLink:
                        try:
                            targetStat = entry.stat(follow_symlinks=True)
                            isDir = stat.S_ISDIR(targetStat.st_mode)
                            isFile = stat.S_ISREG(targetStat.st_mode)
                        except OSError:
                            isDir = False
                            isFile = False
                    if not isDir and not isFile:
                        continue
                    st = entry.stat(follow_symlinks=False)
                    childRel = (rel + '/' + entry.name) if rel else entry.name
                    item = _meta(entry.path, childRel, st)
                    item['name'] = entry.name
                    item['type'] = 'dir' if isDir else 'file'
                    item['isSymlink'] = isLink
                    entries.append(item)
                except OSError:
                    continue
    except PermissionError:
        raise FileServiceError(403, 'permission_denied', '没有权限读取该文件夹')
    except OSError as exc:
        raise FileServiceError(400, 'list_failed', str(exc))

    entries.sort(key=lambda item: (0 if item['type'] == 'dir' else 1, item['name'].casefold()))
    return {'path': rel, 'entries': entries, 'truncated': truncated}


def _walkWorkspaceFiles(root: str, cap: int) -> Tuple[List[str], bool]:
    """按名称顺序稳定遍历工作区文件（跳过隐藏目录/依赖目录，不跟随符号链接）。"""
    files: List[str] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(
            (d for d in dirnames if not d.startswith('.') and d not in _SEARCH_SKIP_DIR_NAMES),
            key=str.casefold,
        )
        for fname in sorted(filenames, key=str.casefold):
            if len(files) >= cap:
                truncated = True
                return files, truncated
            files.append(os.path.join(dirpath, fname))
    return files, truncated


def searchWorkspace(
    workspace: Workspace,
    query: Optional[str],
    caseSensitive: bool = False,
    regex: bool = False,
) -> Dict[str, Any]:
    if not isinstance(query, str) or len(query.strip()) < 2:
        raise FileServiceError(400, 'invalid_query', '搜索关键词至少需要 2 个字符')
    query = query.strip()
    if len(query) > 200:
        raise FileServiceError(400, 'invalid_query', '搜索关键词过长')
    flags = 0 if caseSensitive else re.IGNORECASE
    try:
        pattern = re.compile(query if regex else re.escape(query), flags)
    except re.error as exc:
        raise FileServiceError(400, 'invalid_regex', '正则表达式无效: {}'.format(exc))

    files, filesTruncated = _walkWorkspaceFiles(workspace.root, MAX_SEARCH_FILES)
    results: List[Dict[str, Any]] = []
    totalMatches = 0
    filesScanned = 0
    truncated = filesTruncated
    for full in files:
        if os.path.islink(full):
            continue
        try:
            st = os.stat(full)
        except OSError:
            continue
        if st.st_size <= 0 or st.st_size > MAX_SEARCH_FILE_BYTES:
            continue
        filesScanned += 1
        try:
            with open(full, 'rb') as handle:
                data = handle.read(MAX_SEARCH_FILE_BYTES + 1)
        except OSError:
            continue
        if len(data) > MAX_SEARCH_FILE_BYTES:
            continue
        try:
            text, _encoding = decodeText(data)
        except FileServiceError:
            continue
        matches: List[Dict[str, Any]] = []
        for lineno, line in enumerate(text.splitlines(), 1):
            found = pattern.search(line)
            if not found:
                continue
            # 预览是 strip+截断后的文本，高亮列需换算到预览坐标系
            stripped = line.strip()
            preview = stripped[:240]
            lead = len(line) - len(line.lstrip())
            previewCol = found.start() - lead + 1
            previewLength = 0
            if 1 <= previewCol <= len(preview):
                previewLength = min(found.end() - found.start(), len(preview) - (previewCol - 1))
            else:
                previewCol = 1
            matches.append({
                'line': lineno,
                'col': found.start() + 1,
                'length': found.end() - found.start(),
                'previewCol': previewCol,
                'previewLength': previewLength,
                'text': preview,
            })
            if len(matches) >= MAX_SEARCH_MATCHES_PER_FILE:
                truncated = True
                break
        if matches:
            rel = os.path.relpath(full, workspace.root).replace('\\', '/')
            results.append({'path': rel, 'name': os.path.basename(full), 'matches': matches})
            totalMatches += len(matches)
            if totalMatches >= MAX_SEARCH_RESULTS:
                truncated = True
                break

    return {
        'query': query,
        'results': results,
        'fileCount': len(results),
        'matchCount': totalMatches,
        'filesScanned': filesScanned,
        'truncated': truncated,
    }


def listWorkspaceFiles(workspace: Workspace) -> Dict[str, Any]:
    files, truncated = _walkWorkspaceFiles(workspace.root, MAX_SEARCH_FILES)
    rels = []
    for full in files:
        if os.path.islink(full):
            continue
        rels.append(os.path.relpath(full, workspace.root).replace('\\', '/'))
    return {'files': rels, 'truncated': truncated}


def replaceInWorkspace(
    workspace: Workspace,
    query: Optional[str],
    replacement: Optional[str],
    caseSensitive: bool = False,
    regex: bool = False,
) -> Dict[str, Any]:
    """按当前搜索语义做全工作区文本替换。

    逐文件 读取→替换→带 etag 写回，文件被并发修改时跳过并计入 conflicts。
    替换内容始终按字面量处理（不做反向引用展开）。
    """
    if not isinstance(query, str) or len(query.strip()) < 2:
        raise FileServiceError(400, 'invalid_query', '搜索关键词至少需要 2 个字符')
    query = query.strip()
    if len(query) > 200:
        raise FileServiceError(400, 'invalid_query', '搜索关键词过长')
    if replacement is None:
        replacement = ''
    if not isinstance(replacement, str) or len(replacement) > 1000:
        raise FileServiceError(400, 'invalid_replacement', '替换内容无效或过长')
    flags = 0 if caseSensitive else re.IGNORECASE
    try:
        pattern = re.compile(query if regex else re.escape(query), flags)
    except re.error as exc:
        raise FileServiceError(400, 'invalid_regex', '正则表达式无效: {}'.format(exc))

    def literalRepl(_match):
        return replacement

    files, filesTruncated = _walkWorkspaceFiles(workspace.root, MAX_SEARCH_FILES)
    changed = []
    conflicts = []
    totalReplacements = 0
    truncated = filesTruncated
    for full in files:
        if totalReplacements >= MAX_SEARCH_RESULTS:
            truncated = True
            break
        if os.path.islink(full):
            continue
        try:
            st = os.stat(full)
        except OSError:
            continue
        if st.st_size <= 0 or st.st_size > MAX_SEARCH_FILE_BYTES:
            continue
        rel = os.path.relpath(full, workspace.root).replace('\\', '/')
        try:
            data = readTextFile(workspace, rel)
        except FileServiceError:
            continue
        newText, count = pattern.subn(literalRepl, data['content'])
        if not count:
            continue
        try:
            writeTextFile(
                workspace,
                rel,
                newText,
                encoding=data['encoding'] if data['encoding'] in ('utf-8', 'utf-8-sig', 'gbk') else None,
                eol=data['eol'] if data['eol'] in ('LF', 'CRLF', 'CR') else None,
                baseEtag=data['etag'],
            )
        except FileServiceError as exc:
            if exc.status == 409:
                conflicts.append({'path': rel, 'reason': 'conflict'})
            else:
                conflicts.append({'path': rel, 'reason': exc.message})
            continue
        changed.append({'path': rel, 'count': count})
        totalReplacements += count

    return {
        'query': query,
        'files': changed,
        'fileCount': len(changed),
        'totalReplacements': totalReplacements,
        'conflicts': conflicts,
        'truncated': truncated,
    }


def readTextFile(workspace: Workspace, relPath: Optional[str]) -> Dict[str, Any]:
    full, rel = resolvePath(workspace, relPath, mustExist=True)
    if os.path.isdir(full):
        raise FileServiceError(400, 'is_directory', '不能以文本方式打开文件夹')
    st = os.stat(full)
    if st.st_size > MAX_TEXT_BYTES:
        raise FileServiceError(413, 'file_too_large', '文件超过 2MB，无法以文本方式打开', size=st.st_size)
    try:
        with open(full, 'rb') as handle:
            data = handle.read(MAX_TEXT_BYTES + 1)
    except PermissionError:
        raise FileServiceError(403, 'permission_denied', '没有权限读取该文件')
    except OSError as exc:
        raise FileServiceError(400, 'read_failed', str(exc))
    if len(data) > MAX_TEXT_BYTES:
        raise FileServiceError(413, 'file_too_large', '文件超过 2MB，无法以文本方式打开', size=len(data))
    content, encoding = decodeText(data)
    meta = _meta(full, rel, st)
    meta.update({
        'content': content,
        'encoding': encoding,
        'eol': detectEol(content),
        'mime': mimetypes.guess_type(full)[0] or 'text/plain',
    })
    return meta


def _currentEncoding(full: str) -> str:
    try:
        with open(full, 'rb') as handle:
            data = handle.read(MAX_TEXT_BYTES + 1)
    except OSError:
        return 'utf-8'
    try:
        _, encoding = decodeText(data)
        return encoding
    except FileServiceError:
        return 'utf-8'


def writeTextFile(
    workspace: Workspace,
    relPath: Optional[str],
    content: str,
    encoding: Optional[str] = None,
    eol: Optional[str] = None,
    baseEtag: Optional[str] = None,
    create: bool = False,
) -> Dict[str, Any]:
    if not isinstance(content, str):
        raise FileServiceError(400, 'invalid_content', 'content 必须是字符串')
    full, rel = resolvePath(workspace, relPath)
    parent = os.path.dirname(full)
    if not os.path.isdir(parent):
        raise FileServiceError(404, 'parent_not_found', '上级文件夹不存在')
    parentReal = os.path.realpath(parent)
    if not _isInside(workspace.root, parentReal):
        raise FileServiceError(403, 'outside_workspace', '路径超出工作区范围')

    exists = os.path.exists(full)
    if exists and os.path.isdir(full):
        raise FileServiceError(400, 'is_directory', '不能写入文件夹')
    if exists:
        st = os.stat(full)
        if create:
            raise FileServiceError(409, 'already_exists', '文件已存在', etag=_etag(st), mtimeNs=str(st.st_mtime_ns))
        if not baseEtag:
            raise FileServiceError(428, 'precondition_required', '保存时必须提供 baseEtag')
        if baseEtag != _etag(st):
            raise FileServiceError(409, 'conflict', '文件已被外部修改', etag=_etag(st), mtimeNs=str(st.st_mtime_ns))
        if not encoding:
            encoding = _currentEncoding(full)
    else:
        if not create:
            raise FileServiceError(404, 'not_found', '文件不存在')
        if not encoding:
            encoding = 'utf-8'

    if encoding not in ('utf-8', 'utf-8-sig', 'gbk'):
        raise FileServiceError(400, 'invalid_encoding', '不支持的编码')
    text = normalizeEol(content, eol)
    try:
        data = text.encode(encoding)
    except UnicodeEncodeError as exc:
        raise FileServiceError(422, 'encode_failed', '当前文件编码无法保存这些字符: {}'.format(exc))
    if len(data) > MAX_TEXT_BYTES:
        raise FileServiceError(413, 'file_too_large', '保存后超过 2MB')

    tempPath = os.path.join(parent, '.{}.{}.tmp'.format(os.path.basename(full), uuid.uuid4().hex))
    try:
        with open(tempPath, 'wb') as handle:
            handle.write(data)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(tempPath, full)
    except PermissionError:
        raise FileServiceError(403, 'permission_denied', '没有权限写入该文件')
    except OSError as exc:
        raise FileServiceError(500, 'write_failed', str(exc))
    finally:
        if os.path.exists(tempPath):
            try:
                os.remove(tempPath)
            except OSError:
                pass

    meta = _meta(full, rel)
    meta.update({'encoding': encoding, 'eol': detectEol(text)})
    return meta


def makeDirectory(workspace: Workspace, relPath: Optional[str]) -> Dict[str, Any]:
    full, rel = resolvePath(workspace, relPath)
    if not rel:
        raise FileServiceError(400, 'invalid_path', '不能创建根目录')
    parent = os.path.dirname(full)
    if not os.path.isdir(parent):
        raise FileServiceError(404, 'parent_not_found', '上级文件夹不存在')
    if os.path.exists(full):
        raise FileServiceError(409, 'already_exists', '文件或文件夹已存在')
    try:
        os.mkdir(full)
    except PermissionError:
        raise FileServiceError(403, 'permission_denied', '没有权限创建文件夹')
    except OSError as exc:
        raise FileServiceError(400, 'mkdir_failed', str(exc))
    return _meta(full, rel)


def validateName(name: str) -> str:
    if not isinstance(name, str) or not name:
        raise FileServiceError(400, 'invalid_name', '名称不能为空')
    if name in ('.', '..'):
        raise FileServiceError(400, 'invalid_name', '名称不能是 . 或 ..')
    if any(ch in _INVALID_NAME_CHARS for ch in name) or '\x00' in name or '\r' in name or '\n' in name:
        raise FileServiceError(400, 'invalid_name', '名称包含非法字符')
    if name != name.strip() or name.endswith('.'):
        raise FileServiceError(400, 'invalid_name', '名称不能以空格或点结尾')
    if _WINDOWS_RESERVED.match(name):
        raise FileServiceError(400, 'invalid_name', 'Windows 保留名称不能使用')
    return name


def renameEntry(workspace: Workspace, relPath: Optional[str], newRelPath: Optional[str]) -> Dict[str, Any]:
    src, srcRel = resolvePath(workspace, relPath, mustExist=True)
    if not srcRel:
        raise FileServiceError(400, 'invalid_path', '不能重命名工作区根目录')
    dst, dstRel = resolvePath(workspace, newRelPath)
    if not dstRel:
        raise FileServiceError(400, 'invalid_path', '目标路径不能是根目录')
    validateName(os.path.basename(dst))
    if os.path.exists(dst):
        raise FileServiceError(409, 'already_exists', '目标已存在')
    parent = os.path.dirname(dst)
    if not os.path.isdir(parent):
        raise FileServiceError(404, 'parent_not_found', '目标上级文件夹不存在')
    try:
        os.rename(src, dst)
    except PermissionError:
        raise FileServiceError(403, 'permission_denied', '没有权限重命名')
    except OSError as exc:
        raise FileServiceError(400, 'rename_failed', str(exc))
    return _meta(dst, dstRel)


def deleteEntry(workspace: Workspace, relPath: Optional[str], recursive: bool = False) -> Dict[str, Any]:
    full, rel = resolvePath(workspace, relPath, mustExist=True)
    if not rel:
        raise FileServiceError(400, 'invalid_path', '不能删除工作区根目录')
    if os.path.isdir(full):
        try:
            if recursive:
                shutil.rmtree(full)
            else:
                os.rmdir(full)
        except OSError as exc:
            if not recursive:
                raise FileServiceError(409, 'directory_not_empty', '文件夹非空，需要递归删除', detail=str(exc))
            raise FileServiceError(400, 'delete_failed', str(exc))
    else:
        try:
            os.remove(full)
        except PermissionError:
            raise FileServiceError(403, 'permission_denied', '没有权限删除该文件')
        except OSError as exc:
            raise FileServiceError(400, 'delete_failed', str(exc))
    return {'deleted': True, 'path': rel}


def rawFile(workspace: Workspace, relPath: Optional[str]) -> Tuple[str, str, os.stat_result]:
    full, rel = resolvePath(workspace, relPath, mustExist=True)
    if os.path.isdir(full):
        raise FileServiceError(400, 'is_directory', '文件夹不能下载')
    st = os.stat(full)
    return full, rel, st


def saveUpload(workspace: Workspace, relDir: Optional[str], filename: str, stream, overwrite: bool = False) -> Dict[str, Any]:
    name = validateName(os.path.basename(filename or ''))
    dirFull, dirRel = resolvePath(workspace, relDir, mustExist=True)
    if not os.path.isdir(dirFull):
        raise FileServiceError(400, 'not_directory', '上传目标不是文件夹')
    targetRel = (dirRel + '/' + name) if dirRel else name
    target, targetRel = resolvePath(workspace, targetRel)
    if os.path.exists(target) and not overwrite:
        raise FileServiceError(409, 'already_exists', '目标文件已存在')
    tempPath = os.path.join(dirFull, '.{}.{}.upload'.format(name, uuid.uuid4().hex))
    try:
        if hasattr(stream, 'save'):
            stream.save(tempPath)
        else:
            with open(tempPath, 'wb') as handle:
                shutil.copyfileobj(stream, handle, 1024 * 1024)
        if os.path.getsize(tempPath) > MAX_UPLOAD_BYTES:
            raise FileServiceError(413, 'file_too_large', '上传文件超过 100MB')
        os.replace(tempPath, target)
    except FileServiceError:
        raise
    except PermissionError:
        raise FileServiceError(403, 'permission_denied', '没有权限写入该文件')
    except OSError as exc:
        raise FileServiceError(500, 'upload_failed', str(exc))
    finally:
        if os.path.exists(tempPath):
            try:
                os.remove(tempPath)
            except OSError:
                pass
    return _meta(target, targetRel)


def _findExecutable(names: Iterable[str], known: Iterable[str]) -> Optional[str]:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    for path in known:
        if path and os.path.isfile(path):
            return path
    return None


def getRuntimes() -> Dict[str, Any]:
    pythonPath = _findExecutable(
        ('python.exe', 'python3.exe'),
        (r'F:\Python3.9\python.exe',),
    )
    nodePath = _findExecutable(
        ('node.exe',),
        (r'F:\Nodejs\node.exe',),
    )
    gppPath = _findExecutable(
        ('g++.exe',),
        (r'D:\programfiles\Dev-Cpp\MinGW64\bin\g++.exe',),
    )
    powershellPath = _findExecutable(
        ('powershell.exe',),
        (r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',),
    )
    return {
        'python': {'available': bool(pythonPath), 'path': pythonPath},
        'node': {'available': bool(nodePath), 'path': nodePath},
        'gpp': {'available': bool(gppPath), 'path': gppPath},
        'powershell': {'available': bool(powershellPath), 'path': powershellPath},
    }
