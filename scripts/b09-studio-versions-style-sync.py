from pathlib import Path

path = Path("apps/studio/styles.css")
text = path.read_text()
marker = "\n@media (max-width: 900px) {"
assert text.count(marker) == 1
styles = r'''

.versions-section {
  margin-top: 22px;
  padding: 20px;
  border: 1px solid #e0e4ea;
  border-radius: 12px;
  background: #fff;
}
.versions-section > .section-title {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
}
.versions-current {
  display: grid;
  justify-items: end;
  gap: 5px;
  color: #687386;
  font-size: 12px;
}
.versions-current code,
.version-row code,
.versions-card .form-hint code {
  padding: 4px 6px;
  border-radius: 6px;
  background: #f0f2f5;
  color: #465166;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.versions-current small { color: #7b8493; }
.versions-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 18px;
}
.versions-card {
  min-width: 0;
  padding: 14px;
  border: 1px solid #e5e8ed;
  border-radius: 10px;
  background: #fbfcfd;
}
.versions-card-title {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.versions-card-title h3 { margin: 0; font-size: 14px; }
.versions-card-title span { color: #8b94a3; font-size: 12px; }
.version-list { display: grid; gap: 7px; }
.version-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid #e4e8ee;
  border-radius: 8px;
  background: #fff;
}
.version-row.current { border-color: #bfd0fa; background: #f3f6ff; }
.version-row > div { display: grid; gap: 3px; min-width: 0; }
.version-row strong { font-size: 12px; color: #334057; }
.version-row small { color: #7d8797; font-size: 11px; overflow-wrap: anywhere; }
.version-row code { flex: 0 0 auto; }
.versions-card .form-hint { margin: 10px 0 0; line-height: 1.45; }
.versions-loading {
  margin-top: 16px;
  padding: 12px;
  border: 1px dashed #d7dce4;
  border-radius: 8px;
  background: #fafbfc;
  color: #818b9a;
  font-size: 13px;
}
.versions-loading.error { border-color: #efc7c1; background: #fff5f3; color: #8d4137; }
'''
text = text.replace(marker, styles + marker, 1)
text = text.replace(
    "  .editor-grid { grid-template-columns: 1fr; }",
    "  .editor-grid, .versions-grid { grid-template-columns: 1fr; }",
    1,
)
text = text.replace(
    "  .draft-header { display: grid; }",
    "  .draft-header, .versions-section > .section-title { display: grid; }",
    1,
)
text = text.replace(
    "  .draft-meta { justify-items: start; }",
    "  .draft-meta, .versions-current { justify-items: start; }",
    1,
)
path.write_text(text)
