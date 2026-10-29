import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const producerFiles = [
  "src/inngest/functions/cron-gps-sync.ts",
  "src/inngest/functions/process-shopify-fulfillment.ts",
  "src/inngest/functions/process-shopify-order.ts",
  "src/inngest/functions/process-subscription-order.ts",
  "src/lib/services/order-segments/reporting.ts",
];

function property(
  node: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | undefined {
  return node.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText().replace(/["']/g, "") === name
  );
}

function stringValue(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression)) return expression.text;
  return ts.isAsExpression(expression) ? stringValue(expression.expression) : undefined;
}

describe("backorder producer store scope", () => {
  it("puts a canonical Shopify store on every backorder/created event", () => {
    const producers: Array<{ file: string; line: number; storeExpression: string }> = [];

    for (const relativeFile of producerFiles) {
      const absoluteFile = path.join(process.cwd(), relativeFile);
      const sourceText = fs.readFileSync(absoluteFile, "utf8");
      const source = ts.createSourceFile(
        absoluteFile,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );

      const visit = (node: ts.Node) => {
        if (ts.isObjectLiteralExpression(node)) {
          const name = property(node, "name");
          const data = property(node, "data");
          if (
            name &&
            stringValue(name.initializer) === "backorder/created" &&
            data &&
            ts.isObjectLiteralExpression(data.initializer)
          ) {
            const store = property(data.initializer, "shopifyStore");
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            expect(store, `${relativeFile}:${line} is missing shopifyStore`).toBeDefined();
            producers.push({
              file: relativeFile,
              line,
              storeExpression: store?.initializer.getText() || "",
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(producers).toHaveLength(13);
    for (const producer of producers) {
      expect(
        ["canonicalShopifyStore", "config.shopify.im8.shopDomain", "shop"],
        `${producer.file}:${producer.line} must use a canonical store source`
      ).toContain(producer.storeExpression);
    }
  });
});
