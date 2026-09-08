from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "apps/server/src/author-task-package.ts"
text = path.read_text(encoding="utf-8")
old = '''    format: AUTHOR_TASK_PACKAGE_FORMAT,\n    schemaVersion: AUTHOR_TASK_PACKAGE_SCHEMA_VERSION,'''
new = '''    format: AUTHOR_TASK_PACKAGE_FORMAT as typeof AUTHOR_TASK_PACKAGE_FORMAT,\n    schemaVersion: AUTHOR_TASK_PACKAGE_SCHEMA_VERSION as typeof AUTHOR_TASK_PACKAGE_SCHEMA_VERSION,'''
if text.count(old) != 1:
    raise SystemExit(f"expected one task package literal anchor, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
