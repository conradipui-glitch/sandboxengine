from pathlib import Path

source_path = Path("scripts/b10-b9-bounded-context-sync.py")
source = source_path.read_text()
start_marker = "assistant = replace_once(assistant, '''          content: `Instruction:"
end_marker = "assistant_path.write_text(assistant)"
start = source.find(start_marker)
end = source.find(end_marker, start)
if start < 0 or end < 0:
    raise RuntimeError("bounded prompt staging block not found")
replacement = '''assistant = replace_once(
    assistant,
    "Exact quest draft snapshot:",
    "Bounded quest authoring context:",
    "bounded user prompt"
)
'''
patched = source[:start] + replacement + source[end:]
exec(compile(patched, str(source_path), "exec"), {"__name__": "__main__"})
