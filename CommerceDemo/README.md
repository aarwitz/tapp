# CommerceDemo

This owned browser fixture proves a business effect rather than simple reachability: completing
checkout must create a durable order that remains visible after leaving confirmation and opening
order history. The release contract composes two reusable Tasks and uses deterministic same-origin
reset setup/teardown.

Run the clean target with `npm start`. Set `COMMERCE_DEMO_FAULT=drop-order-history` to seed a defect
where confirmation still succeeds but the resulting order disappears from history. The unchanged
critical contract must fail and block the portable gate; Tapp must not retry or rewrite it into a
pass.
