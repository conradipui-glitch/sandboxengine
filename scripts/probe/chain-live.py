#!/usr/bin/env python3
"""Живая приёмка ИИ-помощника на стенде: диалог -> цепочка -> документ.

Печатает только форму ответов (стадии, коды, счётчики), без секретов.
"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8740"
HEADERS = {
    "Content-Type": "application/json",
    "Host": "127.0.0.1:8740",
    "x-lh-local-settings": "1",
}
IDEA = "Квест: пропавший маяк на острове, три свидетеля, два финала"
# Проект и квест стенда: помощник пишет документ миссии в реальные идентификаторы,
# иначе писатель честно отказывается (пустой projectId — не идентификатор).
PROJECT = os.environ.get("LHP_PROJECT", "c18-isbavg")
QUEST = os.environ.get("LHP_QUEST", "c18-2aymmp")


# Таймаут probe выше окна писателя (900 с) и сборки цепочки (420 с): иначе сам
# probe обрывает ответ раньше, чем это сделает сервер, и «сбой» виден только здесь.
def post(path, payload, timeout=1500):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=body, headers=HEADERS)
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8")
        status = error.code
    elapsed = time.time() - started
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = {"raw": text[:400]}
    return status, parsed, elapsed


def shape(view):
    if not isinstance(view, dict):
        return view
    session = view.get("session") if isinstance(view.get("session"), dict) else view
    out = {
        "stage": session.get("stage"),
        "questionsAnswered": session.get("questionsAnswered"),
        "questionsMin": session.get("questionsMin"),
        "messages": len(session.get("messages") or []),
        "error": (session.get("error") or {}).get("message") if isinstance(session.get("error"), dict) else session.get("error"),
        "errorCode": (session.get("error") or {}).get("code") if isinstance(session.get("error"), dict) else None,
        "hasSummary": session.get("summary") is not None,
    }
    summary = session.get("summary")
    if isinstance(summary, dict):
        chain = summary.get("chain") or {}
        out["chainScenes"] = len(chain.get("scenes") or [])
        out["chainEndings"] = len(chain.get("endings") or [])
        out["narrative"] = (summary.get("narrative") or "").strip()[:60]
    stats = session.get("stats")
    if isinstance(stats, dict):
        out["stats"] = {k: stats.get(k) for k in ("scenes", "endings", "choices", "sceneCount", "endingCount", "choiceCount")}
    return out


print("=== 1. СТАРТ ДИАЛОГА ===", flush=True)
status, parsed, elapsed = post("/local/mission-chain", {"idea": IDEA, "projectId": PROJECT, "questId": QUEST})
print(f"HTTP {status} за {elapsed:.1f} с")
print(json.dumps(shape(parsed), ensure_ascii=False, indent=2), flush=True)
session_id = ""
if isinstance(parsed, dict):
    session = parsed.get("session") if isinstance(parsed.get("session"), dict) else parsed
    session_id = str(session.get("sessionId") or parsed.get("sessionId") or "")

if session_id == "":
    print("НЕТ sessionId — дальше идти некуда")
    raise SystemExit(2)
print(f"sessionId={session_id[:24]}…", flush=True)

print("\n=== 2. ОТВЕТ АВТОРА (1) ===", flush=True)
status, parsed, elapsed = post("/local/mission-chain", {"sessionId": session_id, "text": "Маяк гаснет третью ночь, смотритель пропал, на острове трое: рыбак, дочь смотрителя и инспектор."})
print(f"HTTP {status} за {elapsed:.1f} с")
print(json.dumps(shape(parsed), ensure_ascii=False, indent=2), flush=True)

print("\n=== 3. ОТВЕТ АВТОРА (2) ===", flush=True)
status, parsed, elapsed = post("/local/mission-chain", {"sessionId": session_id, "text": "Финал первый: маяк зажигают и узнают правду. Финал второй: маяк остаётся тёмным, но остров спасают."})
print(f"HTTP {status} за {elapsed:.1f} с")
print(json.dumps(shape(parsed), ensure_ascii=False, indent=2), flush=True)

print("\n=== 4. СБОРКА МИССИИ (по просьбе автора) ===", flush=True)
status, parsed, elapsed = post("/local/mission-chain", {"sessionId": session_id})
print(f"HTTP {status} за {elapsed:.1f} с")
print(json.dumps(shape(parsed), ensure_ascii=False, indent=2), flush=True)

print("\n=== 5. ДОКУМЕНТ МИССИИ ===", flush=True)
status, parsed, elapsed = post("/local/mission-chain/document", {"sessionId": session_id})
document = parsed.get("document") if isinstance(parsed, dict) else None
print(f"HTTP {status} за {elapsed:.1f} с | ok={parsed.get('ok') if isinstance(parsed, dict) else None}")
if isinstance(document, dict):
    # Документ держит сюжет внутри story: сцены, выборы и финалы лежат там,
    # а не на верхнем уровне (раньше probe печатал нули и это путало).
    story = document.get("story") if isinstance(document.get("story"), dict) else {}
    scenes = story.get("scenes") or []
    endings = story.get("endings") or []
    choices = sum(len(scene.get("choices") or []) for scene in scenes if isinstance(scene, dict))
    # Название и логлайн миссии живут в listing — это то, что автор видит
    # в списке миссий; раньше probe печатал пустые строки и это путало.
    listing = document.get("listing") if isinstance(document.get("listing"), dict) else {}
    print("title:", str(story.get("title") or listing.get("title") or document.get("title") or "")[:80])
    print("logline:", str(story.get("logline") or listing.get("logline") or document.get("logline") or "")[:120])
    print("scenes:", len(scenes), "| choices:", choices, "| endings:", len(endings))
    print("endingTitles:", [str(e.get("title") or "")[:40] for e in endings if isinstance(e, dict)][:4])
    print("keys:", sorted(document.keys())[:14])
else:
    print("document:", str(document)[:200])
