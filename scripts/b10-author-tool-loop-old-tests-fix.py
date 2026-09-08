from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one anchor in {path}, found {count}: {old!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "apps/server/test/author-assistant.test.mjs",
    '    "author.draft.read", "author.proposal.apply", "author.proposal.preview", "docs.agent-kit.read", "docs.reference.read"\n',
    '    "author.draft.read", "author.proposal.apply", "author.proposal.preview", "docs.agent-kit.read"\n'
)

replace_once(
    "apps/server/test/author-mcp.test.mjs",
    '    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],',
    '    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"],'
)
