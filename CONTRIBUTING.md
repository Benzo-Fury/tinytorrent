# Contributing

Thanks for helping. Before changing the engine, read [Development](docs/DEVELOPMENT.md): it covers the code layout, the tests, the conformance suite, the line budget and the rules a change has to follow.

Before opening a pull request, run:

```sh
bun test
bunx tsc --noEmit
bun scripts/lines.ts
```

Contributions are accepted under the [Apache License 2.0](LICENSE), the same license as the project.
