from pathlib import Path

path = Path("packages/contracts/registry/endpoints.json")
text = path.read_text()
old = '"summary": "Owner/editor экспорт точной immutable draft revision как deterministic inert .lhquest.zip package"'
new = '"summary": "Owner/editor экспорт точной immutable draft revision или exact immutable release как deterministic inert .lhquest.zip package"'
assert text.count(old) == 1
path.write_text(text.replace(old, new, 1))
