"""Read-only offline comparison with the existing workspace baseline archive."""
from pathlib import Path
import re, sys, zipfile
from jsx_scan import Scanner

archive = zipfile.ZipFile('.i18n-work/baseline.zip')
failures = []
counts = {'audit_calls': 0, 'api_calls': 0, 'option_values': 0, 'unchanged_files': 0, 'datev_functions': 0}

def calls(source, pattern):
    return [source[m.start():Scanner(source).code(m.end(), ')')] for m in re.finditer(pattern, source)]

def normalize_audit(s):
    return s.replace('auditformat', 'format').replace('${exportMonthLabel}', '${monthLabel}')

for name in archive.namelist():
    p = Path(name)
    if not p.is_file():
        continue
    # No configuration/secrets are inspected. Compare source-only protected files.
    protected = (name.startswith('supabase/') or name in ['package.json', 'package-lock.json', 'src/lib/constants.js', 'src/lib/activityLog.js', 'src/lib/privacyNotice.js'])
    if protected:
        counts['unchanged_files'] += 1
        if p.read_bytes() != archive.read(name): failures.append(name + ': protected file differs')
    if p.suffix not in ('.js', '.jsx') or name == 'src/lib/supabase.js': continue
    a, b = archive.read(name).decode(), p.read_text()
    for label, pattern in [('audit_calls', r'\blogActivity\s*\('), ('api_calls', r'(?<!Array)\.(?:from|rpc|invoke|insert|update|upsert|delete|eq|neq|select)\s*\(')]:
        aa, bb = calls(a, pattern), calls(b, pattern)
        if label == 'audit_calls': bb = list(map(normalize_audit, bb))
        counts[label] += len(aa)
        if aa != bb: failures.append(name + ': ' + label + ' differ')
    options = lambda s: re.findall(r'<option\b[^>]*\bvalue=("[^"]*"|\{[^}]*\})', s)
    counts['option_values'] += len(options(a))
    if options(a) != options(b): failures.append(name + ': option values differ')
    if name == 'src/pages/Payroll.jsx':
        def datev(source):
            m = re.search(r'function exportDATEV\([^)]*\)\s*\{', source)
            return source[m.start():Scanner(source).code(m.end(), '}')]
        counts['datev_functions'] += 1
        if datev(a) != datev(b): failures.append(name + ': DATEV function differs')
print('Baseline invariants:', counts)
for failure in failures: print(failure)
print(f'{len(failures)} failures')
sys.exit(bool(failures))
