# Runtime

B04 начинается здесь с семантики сохранения операций вокруг уже принятого Core.

В B04-01 пакет содержит:

- `RuntimeStorage` — связанный domain contract для session/operation lifecycle;
- `MemoryRuntimeStorage` — in-process reference semantics для T10/T11 и fencing foundation T12;
- `ServiceClock` / `ManualServiceClock` — отдельное служебное время lease, не связанное с `WorldState.clock`.

Важно: Runtime не пересчитывает последствия, scheduler priority или terminal semantics. Он либо атомарно сохраняет уже рассчитанный candidate transition, turn record, public response и completion операции, либо не сохраняет ничего.

SQLite/restart persistence и HTTP/API в B04-01 намеренно отсутствуют.
