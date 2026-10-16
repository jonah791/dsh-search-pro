#!/usr/bin/env python3
"""
统一文档抽取：任意附件 → 统一文档模型（JSON 到 stdout）。

存在理由（2026-10-16）：深网内容大量藏在附件里（公示公告的 docx/xlsx/pdf），
而抓取层只认 HTML。本脚本把附件变成可读文本 + 结构化表格。

载体选择：WSL Python —— lxml / beautifulsoup4 / python-docx / openpyxl / pypdf
本机已装，零安装成本。

边界（如实声明）：
  · 扫描件 PDF 无文本层时只报 warnings，**不做 OCR**（未验证）
  · 老式 .doc/.xls/.ppt（OLE 复合文档）**未支持**，会明确报出
  · 大表有行数上界（防一次吐爆上下文）

用法：python3 extract_document.py <file> [--max-rows N]
"""
import csv
import io
import json
import os
import sys
import zipfile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
DEFAULT_MAX_ROWS = 2000


def sniff(data: bytes, path: str) -> str:
    """按魔数优先、扩展名兜底识别格式（魔数比扩展名可信）。"""
    head = data[:8]
    if head.startswith(b'%PDF'):
        return 'pdf'
    if head.startswith(b'PK\x03\x04'):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = set(z.namelist())
                if any(n.startswith('word/') for n in names):
                    return 'docx'
                if any(n.startswith('xl/') for n in names):
                    return 'xlsx'
                if any(n.startswith('ppt/') for n in names):
                    return 'pptx'
                if 'mimetype' in names:
                    mt = z.read('mimetype').decode('ascii', 'ignore')
                    if 'opendocument.text' in mt:
                        return 'odt'
                    if 'opendocument.spreadsheet' in mt:
                        return 'ods'
        except Exception:
            pass
        return 'zip'
    if head.startswith(b'\xd0\xcf\x11\xe0'):
        # OLE 复合文档：doc/xls/ppt 文件头完全相同，只能靠扩展名细分
        ext = os.path.splitext(path)[1].lower().lstrip('.')
        if ext in ('xls', 'doc', 'ppt'):
            return ext
        return 'ole'
    ext = os.path.splitext(path)[1].lower().lstrip('.')
    if ext in ('csv', 'tsv'):
        return ext
    if ext in ('html', 'htm', 'xhtml'):
        return 'html'
    if ext in ('txt', 'md', 'json', 'xml', 'log'):
        return 'text'
    return 'unknown'


def decode_best(data: bytes) -> str:
    """编码回退链（中文站常见 gbk）。"""
    for enc in ('utf-8-sig', 'utf-8', 'gbk', 'latin-1'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return ''


def extract_docx(data: bytes, max_rows: int) -> dict:
    import docx
    d = docx.Document(io.BytesIO(data))
    paras = [p.text.strip() for p in d.paragraphs if p.text.strip()]
    tables = []
    warnings = []
    for ti, t in enumerate(d.tables):
        rows = []
        for ri, row in enumerate(t.rows):
            if ri >= max_rows:
                warnings.append(f'表 {ti} 超 {max_rows} 行，已截断')
                break
            rows.append([c.text.strip() for c in row.cells])
        if rows:
            tables.append(rows)
    return {'text': '\n'.join(paras), 'tables': tables, 'warnings': warnings}


def extract_xlsx(data: bytes, max_rows: int) -> dict:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    tables = []
    warnings = []
    sheets = []
    for ws in wb.worksheets:
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= max_rows:
                warnings.append(f'sheet「{ws.title}」超 {max_rows} 行，已截断')
                break
            rows.append(['' if v is None else str(v) for v in row])
        sheets.append({'name': ws.title, 'rows': len(rows)})
        if rows:
            tables.append({'sheet': ws.title, 'rows': rows})
    return {'text': '', 'tables': tables, 'meta': {'sheets': sheets}, 'warnings': warnings}


def extract_pdf(data: bytes, max_rows: int) -> dict:
    warnings = []
    text = ''
    meta = {}
    try:
        import pypdf
        r = pypdf.PdfReader(io.BytesIO(data))
        meta['pages'] = len(r.pages)
        pages = []
        for i, p in enumerate(r.pages):
            if i >= 300:
                warnings.append(f'页数超 300，只取前 300（共 {meta["pages"]}）')
                break
            pages.append(p.extract_text() or '')
        text = '\n\n'.join(pages)
    except Exception as e:
        warnings.append(f'pypdf 解析失败: {e}')
    if len(text.strip()) < 50:
        warnings.append('文本层几乎为空——可能是扫描件；本脚本不做 OCR（未验证）')
    return {'text': text, 'tables': [], 'meta': meta, 'warnings': warnings}


def extract_xls(data: bytes, max_rows: int) -> dict:
    """老式 .xls（BIFF，OLE 复合文档）：走 xlrd。实测上工程 23 个附件里 3 个是 xls。"""
    import xlrd
    wb = xlrd.open_workbook(file_contents=data)
    tables = []
    warnings = []
    sheets = []
    for sh in wb.sheets():
        rows = []
        for r in range(sh.nrows):
            if r >= max_rows:
                warnings.append(f'sheet「{sh.name}」超 {max_rows} 行，已截断')
                break
            rows.append([str(sh.cell_value(r, c)) for c in range(sh.ncols)])
        sheets.append({'name': sh.name, 'rows': len(rows)})
        if rows:
            tables.append({'sheet': sh.name, 'rows': rows})
    return {'text': '', 'tables': tables, 'meta': {'sheets': sheets}, 'warnings': warnings}


def extract_doc(data: bytes, max_rows: int) -> dict:
    """老式 .doc（OLE）：走外部程序 antiword。

    本机实测（2026-10-16）：antiword 因 apt 依赖冲突（libc6 版本不匹配）**未装上**
    ⇒ 如实报「未验证」，不假装能读。装上后本分支自动生效。
    """
    import shutil
    import subprocess
    import tempfile
    if not shutil.which('antiword'):
        return {
            'text': '',
            'tables': [],
            'warnings': ['老式 .doc 需要 antiword，本机未安装（apt 依赖冲突）——未验证，不假装能读'],
        }
    tmp_path = ''
    try:
        with tempfile.NamedTemporaryFile(suffix='.doc', delete=False) as f:
            f.write(data)
            tmp_path = f.name
        out = subprocess.run(['antiword', '-m', 'UTF-8', tmp_path], capture_output=True, timeout=90)
        txt = out.stdout.decode('utf-8', 'ignore')
        warn = [] if txt.strip() else ['antiword 无输出（可能是空文档或格式异常）']
        if out.returncode != 0:
            warn.append(f'antiword 退出码 {out.returncode}')
        return {'text': txt, 'tables': [], 'warnings': warn}
    except Exception as e:
        return {'text': '', 'tables': [], 'warnings': [f'antiword 调用失败: {e}']}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def extract_csv(data: bytes, max_rows: int) -> dict:
    s = decode_best(data)
    warnings = []
    rows = []
    for i, row in enumerate(csv.reader(io.StringIO(s))):
        if i >= max_rows:
            warnings.append(f'超 {max_rows} 行，已截断')
            break
        rows.append(row)
    return {'text': '', 'tables': [rows], 'warnings': warnings}


def extract_text(data: bytes, max_rows: int) -> dict:
    return {'text': decode_best(data), 'tables': [], 'warnings': []}


def extract_html(data: bytes, max_rows: int) -> dict:
    s = decode_best(data)
    warnings = []
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(s, 'lxml')
        for t in soup(['script', 'style', 'noscript']):
            t.decompose()
        raw = soup.get_text('\n')
        text = '\n'.join(l.strip() for l in raw.split('\n') if l.strip())
        tables = []
        for tb in soup.find_all('table'):
            rows = []
            for tr in tb.find_all('tr'):
                cells = [td.get_text(' ', strip=True) for td in tr.find_all(['td', 'th'])]
                if cells:
                    rows.append(cells)
            if rows:
                tables.append(rows)
        return {'text': text, 'tables': tables, 'warnings': warnings}
    except Exception as e:
        return {'text': s, 'tables': [], 'warnings': [f'bs4 解析失败，退回原文: {e}']}


DISPATCH = {
    'docx': extract_docx,
    'xlsx': extract_xlsx,
    'xls': extract_xls,
    'doc': extract_doc,
    'pdf': extract_pdf,
    'csv': extract_csv,
    'tsv': extract_csv,
    'text': extract_text,
    'html': extract_html,
}


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': '用法: extract_document.py <file> [--max-rows N]'}, ensure_ascii=False))
        return 2
    path = sys.argv[1]
    max_rows = DEFAULT_MAX_ROWS
    if '--max-rows' in sys.argv:
        try:
            max_rows = int(sys.argv[sys.argv.index('--max-rows') + 1])
        except (IndexError, ValueError):
            pass
    if not os.path.isfile(path):
        print(json.dumps({'ok': False, 'error': f'文件不存在: {path}'}, ensure_ascii=False))
        return 2
    with open(path, 'rb') as f:
        data = f.read()
    kind = sniff(data, path)
    fn = DISPATCH.get(kind)
    if fn is None:
        out = {
            'kind': kind,
            'bytes': len(data),
            'text': '',
            'tables': [],
            'warnings': [f'暂不支持的格式: {kind}（老式 OLE 文档与 pptx/odt/ods 未实现）'],
        }
    else:
        try:
            out = {'kind': kind, 'bytes': len(data), **fn(data, max_rows)}
        except Exception as e:
            out = {'kind': kind, 'bytes': len(data), 'text': '', 'tables': [], 'warnings': [f'抽取失败: {e}']}
    out['path'] = path
    out['ok'] = True
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
