// Локальное хранилище позиций узлов доски.
//
// ВНИМАНИЕ (честная граница V02): серверный BoardDocument API ещё не
// реализован (endpoints /board — проектируемые, см. ТЗ §9). Пока позиции
// сохраняются в localStorage браузера по ключу questId. Это даёт сохранение
// layout после reload для одного автора/браузера, но НЕ общий доступ:
// второй участник увидит свою раскладку. Перемещение узлов НИКОГДА не
// меняет contentHash/валидацию (позиции не входят в canonical draft).

const KEY_PREFIX = "lhs-board-positions-v1:";

export function loadBoardPositions(questId: string): Map<string, { readonly x: number; readonly y: number }> {
  const result = new Map<string, { readonly x: number; readonly y: number }>();
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + questId);
    if (!raw) return result;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const { x, y } = value as Record<string, unknown>;
        if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
          result.set(id, { x, y });
        }
      }
    }
  } catch {
    // повреждённые данные localStorage не должны ломать доску
  }
  return result;
}

export function saveBoardPosition(questId: string, nodeId: string, x: number, y: number): void {
  try {
    const current = loadBoardPositions(questId);
    current.set(nodeId, { x, y });
    writePositions(questId, current);
  } catch {
    // отсутствие localStorage не должно ломать перетаскивание
  }
}

export function saveBoardPositions(questId: string, positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>): void {
  try {
    writePositions(questId, positions);
  } catch {
    // ignore
  }
}

function writePositions(questId: string, positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>): void {
  const serialized: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of positions) {
    serialized[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  }
  window.localStorage.setItem(KEY_PREFIX + questId, JSON.stringify(serialized));
}

export function clearBoardPositions(questId: string): void {
  try {
    window.localStorage.removeItem(KEY_PREFIX + questId);
  } catch {
    // ignore
  }
}

export function boardPositionsKey(questId: string): string {
  return KEY_PREFIX + questId;
}