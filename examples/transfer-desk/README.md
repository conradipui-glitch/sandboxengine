# Transfer Desk real quest — B11

This is the second real example required by B11. It intentionally has a different causal shape from Florence.

Player goal: resolve a disputed lost-property return without treating a request as permission and without moving the item before the clerk accepts the claim.

The package exercises existing generic mechanisms:

- `core.social.request` stays `conditional`;
- explicit clerk response records consent without performing the physical transfer;
- `resource.change` spends a claim ticket;
- `item.transfer` moves the umbrella only in the final accepted handoff;
- an over-budget handoff is an atomic blocked batch, so the umbrella remains in storage.

`narrative-beats.json` is example-owned authored data rather than a new Core schema.
