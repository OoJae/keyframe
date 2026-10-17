// Entry point: `node src/cli.ts <command> [...]`. See README.md or `node src/cli.ts help`.
import "./register.ts";

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
