import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";

/** Load only named pure declarations from the pinned Git object, never the working tree.
 * This is a component-contract helper, NOT a sandbox for running Spock workflows.
 */
export function loadShippingReference(repository, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Immutable reference required");
  const source = execFileSync("git", ["show", revision + ":src/component/salesorder.ts"], {
    cwd: resolve(repository),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = ts.createSourceFile("reference.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "getGpsLogisticsChannel",
    "EXPEDITED_SHIPPING_TAG",
    "GPS_UK_WAREHOUSE_NAME",
    "GPS_STANDARD_CHANNEL_UK",
    "GPS_STANDARD_CHANNEL",
    "GPS_EXPEDITED_CHANNEL_UK",
  ]);
  const selected = [];
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text))
      selected.push(node.getText(parsed));
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) => names.has(d.name.getText(parsed)))
    ) {
      selected.push(node.getText(parsed));
    }
  }
  if (selected.length !== names.size) throw new Error("Reference declaration inventory changed");
  const output = ts.transpileModule(selected.join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext(
    { exports: {} },
    { codeGeneration: { strings: false, wasm: false } }
  );
  vm.runInContext(output, context, { timeout: 1000 });
  return (tags, warehouse) => {
    context.tags = tags;
    context.warehouse = warehouse;
    return vm.runInContext("exports.getGpsLogisticsChannel({ tags }, warehouse)", context, {
      timeout: 1000,
    });
  };
}

export function readWorkflowRegistry() {
  return JSON.parse(
    readFileSync(new URL("../../config/spock-workflows.json", import.meta.url), "utf8")
  );
}

export function checkProcessorCoverage(repository, registry) {
  const source = execFileSync(
    "git",
    ["show", registry.spockRevision + ":src/component/taskprocessor.ts"],
    { cwd: resolve(repository), encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
  );
  const parsed = ts.createSourceFile("processors.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => node.name.getText(parsed) === "processors");
  const entries = declaration?.initializer?.arguments?.[0];
  if (!entries || !ts.isArrayLiteralExpression(entries))
    throw new Error("Processor registry shape changed");
  const symbols = {
    READ_EUROPA_STORE_SHIPPING_TASK_TYPE: "read.europastore.fulfilment",
    READ_EUROPA_STORE_INVENTORY_TASK_TYPE: "read.europastore.inventory",
    READ_EUROPA_STORE_TASK_TYPE: "read.europastore",
    INDEFINITELY_LOCKED_TASK_TYPE: "test.locked-indefinitely",
  };
  const registered = new Set(registry.workflows.map((w) => w.task));
  for (const entry of entries.elements) {
    if (!ts.isArrayLiteralExpression(entry)) throw new Error("Unexpected processor entry");
    const key = entry.elements[0];
    const task = ts.isStringLiteral(key) ? key.text : symbols[key.getText(parsed)];
    if (!task) throw new Error("Unknown processor symbol: " + key.getText(parsed));
    if (!registered.has(task) && !registry.excludedTasks[task])
      throw new Error("Untracked Spock capability: " + task);
  }
}
