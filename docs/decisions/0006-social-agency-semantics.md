# ADR 0006 — Request, permission и response не исполняют чужое действие

Дата: 2026-09-06  
Статус: accepted

## Контекст

Свободный ввод позже будет распознаваться моделью, но право игрока на собственное решение и согласие другого персонажа должны быть определены до AI. Иначе фразы вроде «оставьте мне копию» или «не запрещаю передать мой ответ» могут быть переосмыслены как другое физическое действие, новая просьба или уже состоявшееся согласие.

## Решение

В Core вводится strict `SocialAct` v1.0 с тремя разными discriminants:

- `request` — просьба адресату выполнить structured subject;
- `permission` — разрешение/не-запрет адресату выполнить structured subject;
- `response` — explicit `accept` или `refuse` на конкретный request ID.

Structured subject содержит только `actionType`, `targetIds`, `args`. В нём нет duration, effects или state patch.

Расчёт social semantics:

- request → `core.social.request`, status `conditional`, reason `AWAITING_RESPONSE`, effects=[];
- permission → `core.social.permission`, status `executed` только в смысле состоявшегося акта разрешения, effects=[];
- response → `core.social.response`, decision `accept|refuse`, effects=[].

Даже `accept` не выполняет предложенное физическое действие. Если оно меняет item/resource/world state, оно обязано пройти обычный resolver → CalculatedAction → GameplayEffect pipeline отдельно.

Response вычисляется только относительно конкретного известного request. `proposalId` и responder должны совпадать с request; broken/mismatched reference — resolution failure, а не consent.

## Последствия

- просьба не является соглашением;
- permission не является request;
- refusal нельзя представить как acceptance;
- acceptance не является скрытым `item.transfer`/`resource.change`;
- будущий LLM обязан классифицировать текст в эти уже существующие смыслы, а не изобретать собственную социальную семантику;
- persistent pending requests, NPC decision AI и их время жизни будут добавляться отдельными слоями; B02 доказывает только детерминированный Core-смысл.
