import { execFileSync } from "node:child_process";
import { readWorkflowRegistry } from "./spock-source.mjs";
const repository = process.env.SPOCK_REFERENCE_DIR;
if (!repository) throw new Error("SPOCK_REFERENCE_DIR is required; a skipped reference test is not parity evidence");
execFileSync("git", ["cat-file", "-e", readWorkflowRegistry().spockRevision + "^{commit}"], {
  cwd: repository, stdio: "ignore",
});
