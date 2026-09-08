from pathlib import Path

path = Path(__file__).resolve().parents[1] / "packages/ai/src/codex-app-server-account.ts"
text = path.read_text(encoding="utf-8")
text = text.replace(
    "export type CodexTransportSimpleResult = { readonly ok: true } | CodexTransportFailure;",
    "export type CodexAccountTransportSimpleResult = { readonly ok: true } | CodexTransportFailure;"
)
text = text.replace("Promise<CodexTransportSimpleResult>;", "Promise<CodexAccountTransportSimpleResult>;")
path.write_text(text, encoding="utf-8")
