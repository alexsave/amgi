# The 4-space indent rule, checked: make lint runs it, and it exits 1 and lists every offender.
#
#   python3 -I tools/indent4.py            the files git ls-files lists (see SCOPE below)
#   python3 -I tools/indent4.py FILE...    those files, whether tracked or not (the test uses this)
#
# The rules, Makefiles excepted (make needs its tabs):
#   - no tab in a line's leading whitespace;
#   - a line that ends by opening a block ({, ( or [, and : in Python and YAML) is followed by a line exactly 4 deeper
#     or not deeper at all. That is the step a 2-space or 8-space file gets wrong on every block, while a continuation
#     line aligned under an opening bracket follows a line that ends in a comma or an operator, and is never judged.
# Lines inside a /* */ comment, a Python triple-quoted string or a JavaScript template literal are not judged: they are
# prose, or another program's text (a script a test hands the browser). A C macro's trailing \ is not part of its line.
# A third rule catches a closing line left behind: a line that starts with }, ) or ] sits on the 4-space grid.
import re
import subprocess
import sys

EXTS = ('.c', '.h', '.js', '.mjs', '.ts', '.py', '.sh', '.css', '.html', '.json', '.yml', '.yaml')
# Recorded bytes (expect, golden, fixtures, recordings), other repos' trees, and files npm writes.
SKIP_DIRS = ('third_party', 'node_modules', 'out', 'build', 'results', 'expect', 'golden', 'fixtures', 'recordings')
SKIP_FILES = ('package-lock.json',)
OPENS = ('{', '(', '[')


def in_scope(path):
    parts = path.split('/')
    return path.endswith(EXTS) and parts[-1] not in SKIP_FILES and not any(p in SKIP_DIRS for p in parts[:-1])


def backticks(s):
    return len(re.findall(r'(?<!\\)`', s))


def problems(path, text):
    colon = path.endswith(('.py', '.yml', '.yaml'))
    js = path.endswith(('.js', '.mjs', '.ts', '.html'))
    hashes = path.endswith(('.py', '.sh', '.yml', '.yaml'))  # where # starts a comment (in C it starts #define)
    out, prev, in_block, in_doc, in_tpl = [], None, False, None, False
    for n, line in enumerate(text.split('\n'), 1):
        body = line.strip()
        if in_tpl:
            in_tpl = backticks(body) % 2 == 0
            continue
        if in_block:
            in_block = '*/' not in body
            continue
        if in_doc:
            if body.count(in_doc) % 2:
                in_doc = None
            continue
        if not body:
            continue
        ws = line[:len(line) - len(line.lstrip(' \t'))]
        if '\t' in ws:
            out.append((n, 'a tab in the indent'))
        elif prev is not None and prev[1] and len(ws) > prev[0] and len(ws) != prev[0] + 4:
            out.append((n, '%d deeper than the line that opens its block (4 is the step)' % (len(ws) - prev[0])))
        elif body[0] in '})]' and len(ws) % 4:
            out.append((n, 'a closing line off the 4-space grid'))
        if body.startswith('/*') and '*/' not in body:
            in_block = True
            continue
        if colon and path.endswith('.py'):
            m = re.match(r'^[rRbBuU]?("""|\'\'\')', body)
            if m and body.count(m.group(1)) == 1:
                in_doc = m.group(1)
                continue
        if body.startswith(('//', '*', '/*')) or (hashes and body.startswith('#')):
            continue
        if js and backticks(body) % 2:
            in_tpl = True
        code = body[:-1].rstrip() if body.endswith('\\') else body
        prev = (len(ws), code.endswith(OPENS) or (colon and code.endswith(':')))
    return out


def main(argv):
    paths = argv or [p for p in subprocess.run(['git', 'ls-files'], capture_output=True, text=True, check=True).stdout.splitlines()
                     if in_scope(p)]
    bad = 0
    for path in paths:
        with open(path, encoding='utf-8') as f:
            for n, why in problems(path, f.read()):
                print('%s:%d: %s' % (path, n, why))
                bad += 1
    print('indent4: %d files, %d problems' % (len(paths), bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
