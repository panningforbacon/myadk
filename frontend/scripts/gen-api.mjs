// Regenerate src/api/schema.d.ts from FastAPI's OpenAPI schema, so a renamed
// Pydantic field fails `tsc` instead of silently rendering undefined.
//
// The schema is dumped by importing the app, not by hitting a running server: a
// codegen step that needs a live backend is a codegen step that breaks on CI.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(frontend, "..");

const DUMP = "import json; from app.main import app; print(json.dumps(app.openapi()))";
const [cmd, ...args] = (process.env.PYTHON_CMD ?? "uv run python").split(" ");

const schema = execFileSync(cmd, [...args, "-c", DUMP], { cwd: repo, encoding: "utf8", maxBuffer: 64e6 });

const schemaPath = resolve(frontend, "openapi.json");
writeFileSync(schemaPath, schema);
mkdirSync(resolve(frontend, "src/api"), { recursive: true });
execFileSync("npx", ["openapi-typescript", schemaPath, "-o", "src/api/schema.d.ts"], { cwd: frontend, stdio: "inherit" });
