const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const source = path.resolve(__dirname, "..", "src", "worker.js");
const tempFile = path.join(os.tmpdir(), `coddi-worker-check-${process.pid}.mjs`);

try {
  fs.writeFileSync(tempFile, fs.readFileSync(source, "utf8"));
  childProcess.execFileSync(process.execPath, ["--check", tempFile], {
    stdio: "inherit"
  });
} finally {
  fs.rmSync(tempFile, { force: true });
}
