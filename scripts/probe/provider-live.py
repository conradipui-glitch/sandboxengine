#!/usr/bin/env python3
"""Живая диагностика провайдера ИИ: почему цепочка «нечитаемая».

Печатает адрес, модель, длину ключа (не сам ключ), затем прямой запрос к
провайдеру с требованием JSON и бюджетом вывода как у цепочки (4000 токенов):
finish_reason, длину ответа, попытку разбора JSON и первые/последние символы.
"""
import json
import sqlite3
import urllib.error
import urllib.request

DB = "/var/lib/docker/volumes/vps_engine-data/_data/living-history.sqlite"

connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute("SELECT * FROM control_provider_connections").fetchall()
print(f"строк подключения: {len(rows)}")
for row in rows:
    keys = row.keys()
    base_url = row["base_url"] if "base_url" in keys else ""
    model = row["model"] if "model" in keys else ""
    key = (row["api_key"] if "api_key" in keys else "") or ""
    print(f"  project={row['project_id'] if 'project_id' in keys else '?'} base_url={base_url} model={model} key_len={len(str(key))}")
connection.close()

if not rows:
    raise SystemExit("нет сохранённого подключения")

row = rows[0]
base_url = str(row["base_url"]).rstrip("/")
model = str(row["model"])
api_key = str(row["api_key"])

payload = {
    "model": model,
    "messages": [
        {
            "role": "system",
            "content": (
                "Ты помощник автора квестов. Отвечай ТОЛЬКО JSON-объектом без пояснений "
                "и без markdown-обёрток. Схема: {\"kind\":\"chain\",\"scenes\":[{\"id\":string,"
                "\"title\":string,\"text\":string}],\"choices\":[{\"from\":string,\"to\":string,"
                "\"label\":string}],\"endings\":[{\"id\":string,\"title\":string,\"kind\":\"win\"|\"lose\"}]}"
            ),
        },
        {
            "role": "user",
            "content": (
                "Собери цепочку миссии по идее: «Квест: пропавший маяк на острове, три свидетеля, "
                "два финала». Дай 6 сцен, 7 выборов и 2 финала. Ответ — один JSON-объект."
            ),
        },
    ],
    "max_tokens": 4000,
    "temperature": 0.4,
}

request = urllib.request.Request(
    f"{base_url}/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
)
try:
    with urllib.request.urlopen(request, timeout=240) as response:
        body = json.loads(response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    print(f"HTTP {error.code}: {error.read().decode('utf-8')[:300]}")
    raise SystemExit(3)

choice = (body.get("choices") or [{}])[0]
message = choice.get("message") or {}
content = message.get("content") or ""
reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
usage = body.get("usage") or {}
print("finish_reason:", choice.get("finish_reason"))
print("длина content:", len(content), "| длина reasoning:", len(reasoning))
print("usage:", {k: usage.get(k) for k in ("prompt_tokens", "completion_tokens", "total_tokens")})
print("HEAD:", content[:200].replace("\n", "\\n"))
print("TAIL:", content[-200:].replace("\n", "\\n"))
try:
    parsed = json.loads(content)
    print("JSON.parse: OK, ключи:", sorted(parsed.keys())[:10])
except Exception as error:
    print("JSON.parse: FAIL", type(error).__name__, str(error)[:160])
    stripped = content.strip()
    if stripped.startswith("```"):
        print("признак markdown-обёртки: да")
    print("есть фигурная скобка:", "{" in content)
