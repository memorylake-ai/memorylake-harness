// ml-recall's entry point; bin/ml-recall and bin/ml-recall.cmd start it.
import { recall } from "./lib/recall.mjs";

const result = recall(process.argv.slice(2));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
