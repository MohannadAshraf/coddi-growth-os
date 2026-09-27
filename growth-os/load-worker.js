// Loads src/worker.js into a vm context the same way test/baseline.test.js does, so
// the generator builds fixtures with the Worker's own code — never a copy of it.
// Top-level consts stay in the context's global lexical scope; read them with
// vm.runInContext("NAME", context).

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const workerPath = path.join(root, "src", "worker.js");

function loadWorker(overrides = {}) {
  const source = fs
    .readFileSync(workerPath, "utf8")
    .replace(/^import\s+.*?;\r?\n/gm, "")
    .replace(/\bexport\s+class\s+WeeklySyncWorkflow\s+extends\s+WorkflowEntrypoint\s+\{/, "globalThis.WeeklySyncWorkflow = class WeeklySyncWorkflow extends WorkflowEntrypoint {")
    .replace(/\bexport\s+default\s+\{/, "globalThis.__workerDefault = {");

  const context = {
    console,
    URL,
    URLSearchParams,
    Intl,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    JSON,
    RegExp,
    Error,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    AbortController,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    crypto: globalThis.crypto,
    WorkflowEntrypoint: class WorkflowEntrypoint {},
    NonRetryableError: class NonRetryableError extends Error {},
    fetch: async () => {
      throw new Error("Unexpected network call: Growth OS reads are D1-only.");
    },
    Response: {
      json(data, init = {}) {
        return { data, init };
      }
    },
    ...overrides
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: workerPath });
  context.__get = (name) => vm.runInContext(name, context);
  return context;
}

module.exports = { loadWorker, root };
