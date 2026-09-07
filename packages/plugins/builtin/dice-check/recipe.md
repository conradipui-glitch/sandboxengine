# Recipe — dice-check skill check

Recipe ID: `dice-check.recipe.skill-check`  
Plugin: `dice-check@1.0.0`  
Capability: `dice-check.capability.skill-check`  
Schema: `dice-check.schema.skill-check@1.0.0`

Use this recipe when an authored quest needs one deterministic d20 skill check without changing Core.

1. Create a plugin-owned skill-check definition from the registered schema/form.
2. Set authored `difficulty` (1–40), `modifier` (-20…20) and `durationSeconds` (0–86400).
3. Add success/failure effect templates using only existing canonical `resource.change`, `entity.move` or `item.transfer` semantics.
4. Write plain-text success/failure narrative templates. Allowed placeholders: `{{roll}}`, `{{modifier}}`, `{{total}}`, `{{difficulty}}`, `{{outcome}}`.
5. Bind the Runtime/plugin host to the authored definition set. Player input selects only an existing `definitionId`; it does not submit difficulty, modifier, effects or narrative text.
6. The resolver draws exactly one d20 value from the host RNG, calculates `roll + modifier`, selects the authored effect branch and returns a generic bounded PluginActionPlan.
7. Existing Core effect/time gates apply the plan. Do not add `dice-check` branches to Core.
8. Bind the frozen/compiled artifact hash to a plugin-requirements sidecar before start/publish. Missing/incompatible `dice-check` is a blocking compatibility result, not a silent fallback.

The text projection is the baseline presentation. A custom visual widget is optional and must not change gameplay authority.
