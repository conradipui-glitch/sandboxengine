from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:120]!r}"
    return text.replace(old, new, 1)

app = Path("apps/studio/src/app.ts")
text = app.read_text()

text = replace_once(
    text,
    'import type { DraftChange } from "@living-history/control";\n',
    'import type { DraftChange } from "@living-history/control";\nimport {\n  loadConflictState,\n  renderConflictPanel,\n  type ConflictState\n} from "./conflict.js";\n',
)

old_interface = '''interface ConflictState {\n  readonly changes: readonly DraftChange[];\n  readonly previousRevision: number;\n  readonly currentRevision: number;\n}\n\n'''
assert old_interface in text
text = text.replace(old_interface, "", 1)

old_state = '''        this.state.conflict = Object.freeze({\n          changes,\n          previousRevision: draft.draftRevision,\n          currentRevision: fresh.draftRevision\n        });'''
new_state = '''        this.state.conflict = await loadConflictState(\n          this.api,\n          projectId,\n          questId,\n          changes,\n          draft.draftRevision,\n          fresh.draftRevision\n        );'''
text = replace_once(text, old_state, new_state)

text = replace_once(
    text,
    '${this.state.conflict ? conflictPanel(this.state.conflict) : ""}',
    '${this.state.conflict ? renderConflictPanel(this.state.conflict) : ""}',
)

old_panel = '''function conflictPanel(conflict: ConflictState): string {\n  return `<section class="conflict-panel" role="alert">\n    <div><strong>Обнаружена новая server revision</strong><p>Локальная правка была подготовлена для r${conflict.previousRevision}, но сервер уже на r${conflict.currentRevision}. Автоматического overwrite не было.</p></div>\n    <div class="button-row"><button class="primary" data-action="retry-conflict">Повторить правку на r${conflict.currentRevision}</button><button data-action="cancel-conflict">Отменить локальную правку</button></div>\n  </section>`;\n}\n\n'''
assert old_panel in text
text = text.replace(old_panel, "", 1)
app.write_text(text)

css = Path("apps/studio/styles.css")
text = css.read_text()
marker = '.conflict-panel p { margin: 5px 0 0; color: #805a54; font-size: 13px; line-height: 1.5; }\n'
assert text.count(marker) == 1
styles = '''.conflict-diff {\n  margin-top: 12px;\n  padding: 10px 11px;\n  border: 1px solid #eccfc9;\n  border-radius: 8px;\n  background: #fffaf9;\n  color: #6f504b;\n  font-size: 12px;\n}\n.conflict-diff.error { color: #8d382e; }\n.conflict-diff-title { font-weight: 700; color: #75433b; }\n.conflict-diff ul { margin: 7px 0 0; padding-left: 18px; display: grid; gap: 3px; }\n.conflict-diff-empty { margin-top: 6px; color: #806861; }\n'''
text = text.replace(marker, marker + styles, 1)
css.write_text(text)
