import json
from pathlib import Path

path = Path("packages/contracts/registry/endpoints.json")
data = json.loads(path.read_text())
operations = data["operations"]
operation_id = "control.playtests.trace"
if any(item.get("id") == operation_id for item in operations):
    raise SystemExit(f"{operation_id} already present")
anchor = next(index for index, item in enumerate(operations) if item.get("id") == "control.playtests.get")
operations.insert(anchor + 1, {
    "id": operation_id,
    "method": "GET",
    "path": "/control/v1/projects/{projectId}/quests/{questId}/playtests/{playtestId}/trace",
    "readiness": "available",
    "successStatus": 200,
    "summary": "Чтение bounded persisted Runtime evidence для exact frozen playtest без replay gameplay и без guest credential/idempotency/fencing данных"
})
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
